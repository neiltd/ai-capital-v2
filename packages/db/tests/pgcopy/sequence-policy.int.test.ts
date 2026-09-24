// The target sequence policy against LIVE PostgreSQL 17: a fenced source, a
// separate target, and the two properties that matter - a rollback leaves the
// target exactly as it was, and a commit makes the target issue the value the
// source would have issued next.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  FENCE_PROOF_SQL, FENCE_SEQUENCES, SEQUENCE_STATE_SQL, acquireSourceFence,
  assertFenceProof, effectiveNext, fenceRelationArray, parseLockRows, parseSequenceState,
  readFencedSequenceState, type FencedSequenceState, type SequenceState,
} from '../../src/pg-copy/source-fence.js'
import {
  POLICY_SEQUENCES, SequencePolicyFailed, SequencePolicyRefused, applySequencePolicy,
} from '../../src/pg-copy/sequence-policy.js'
import {
  startDisposableCluster, stopAllDisposableClusters, type DisposableCluster,
} from '../../testing/disposable-cluster.js'
import {
  closeAllPsqlSessions, openPsqlSession, type PsqlSession,
} from '../../testing/psql-session.js'
import { buildV19Database } from '../../testing/v19-database.js'

const DB = 'seq_v19'

let SRC: DisposableCluster
let TGT: DisposableCluster

beforeAll(async () => {
  SRC = await startDisposableCluster()
  TGT = await startDisposableCluster()
  await buildV19Database(SRC, DB)
  await buildV19Database(TGT, DB)
}, 900_000)

afterAll(async () => {
  await closeAllPsqlSessions()
  await stopAllDisposableClusters()
})

/** An executor over a psql session, shaped for the policy's one parameter. */
const exec = (s: PsqlSession): { rows: (sql: string) => Promise<string[][]> } =>
  ({ rows: async (sql: string) => await s.must(sql) })

/**
 * A GENUINE fenced state: acquire the whole fence, prove it from an independent
 * backend, then read. The brand is never counterfeited on this path - that is
 * the entire point of the type.
 */
async function fencedSourceState(): Promise<Record<string, FencedSequenceState>> {
  const sup = await openPsqlSession(SRC, DB)
  const prover = await openPsqlSession(SRC, DB)
  try {
    const fence = await acquireSourceFence(sup)
    assertFenceProof(
      parseLockRows(await prover.must(FENCE_PROOF_SQL.replace('$1', fenceRelationArray()))),
      { supervisorPid: fence.supervisorPid, provingPid: prover.pid })
    const state = await readFencedSequenceState(sup, prover, fence)
    await sup.send('ROLLBACK')
    return state
  } finally {
    await prover.close()
    await sup.close()
  }
}

const stateOn = async (c: DisposableCluster, q: string): Promise<SequenceState> =>
  parseSequenceState(await c.rows(SEQUENCE_STATE_SQL(q), DB), q)

const allStatesOn = async (
  c: DisposableCluster,
): Promise<Record<string, SequenceState>> => Object.fromEntries(
  await Promise.all(POLICY_SEQUENCES.map(async q => [q, await stateOn(c, q)] as const)))

/** Put the target's sequences back to pristine between cases. */
async function resetTarget(): Promise<void> {
  for (const q of POLICY_SEQUENCES) {
    const s = await stateOn(TGT, q)
    await TGT.sql(`ALTER SEQUENCE ${q} RESTART WITH ${s.start_value}`, DB)
  }
}

describe('a rollback leaves the target exactly as it was', () => {
  it('restores every field of all three sequences', async () => {
    await resetTarget()
    const source = await fencedSourceState()
    const before = await allStatesOn(TGT)
    const t = await openPsqlSession(TGT, DB)
    try {
      await t.must('BEGIN')
      const r = await applySequencePolicy(exec(t), source)
      expect(r.qnames).toEqual([...POLICY_SEQUENCES])
      expect(r.effectiveNext.length).toBe(3)
      // Inside the transaction the change IS visible.
      for (const q of POLICY_SEQUENCES) {
        const inTx = parseSequenceState(await t.must(SEQUENCE_STATE_SQL(q)), q)
        expect(effectiveNext(inTx, q)).toBe(effectiveNext(source[q], q))
      }
      await t.must('ROLLBACK')
    } finally { await t.close() }

    // ... and after rollback every field is back. This is what setval() would
    // fail: its effect survives a rollback.
    const after = await allStatesOn(TGT)
    for (const q of POLICY_SEQUENCES) {
      expect(after[q], q).toEqual(before[q])
    }
  }, 900_000)
})

describe('a commit makes the target issue what the source would have issued', () => {
  it('matches a never-called source and an already-called, gapped source', async () => {
    for (const [label, burn] of [['never called', 0], ['called and gapped', 3]] as const) {
      await resetTarget()
      // Advance the SOURCE on a throwaway basis: this is a disposable cluster,
      // never a live one, and the target is never consumed from.
      for (let i = 0; i < burn; i += 1) {
        await SRC.sql(`SELECT pg_catalog.nextval('${POLICY_SEQUENCES[0]}')`, DB)
      }
      const source = await fencedSourceState()
      const expected = Object.fromEntries(
        POLICY_SEQUENCES.map(q => [q, effectiveNext(source[q], q)]))

      const t = await openPsqlSession(TGT, DB)
      try {
        await t.must('BEGIN')
        await applySequencePolicy(exec(t), source)
        await t.must('COMMIT')
      } finally { await t.close() }

      // On the TARGET, an INSERT that leaves the owning column to its DEFAULT
      // must receive exactly that value - the property the policy exists to
      // produce. Every sequence is checked, not just the first.
      //
      // The other NOT NULL columns have no defaults, so each owning table needs
      // a minimal valid row; the id is the only column deliberately omitted.
      const MINIMAL: Readonly<Record<string, string>> = {
        'briefing.qa':
          `(date, asked_at, mode, exchanges) ` +
          `VALUES (DATE '2026-01-01', now(), 'probe', '{}'::pg_catalog.jsonb)`,
        'capital.fetch_log':
          `(ticker, source, fetched_at, doc_count, chunk_count) ` +
          `VALUES ('PROBE', 'probe', now(), 0, 0)`,
        'portfolio.trade_log':
          `(trade_date, ticker, action, shares, price) ` +
          `VALUES (DATE '2026-01-01', 'PROBE', 'buy', 1, 1)`,
      }
      for (const q of POLICY_SEQUENCES) {
        const [schema, table, column] = source[q].owned_by.split('.')
        const rel = `${schema}.${table}`
        const got = await TGT.rows(
          `INSERT INTO ${rel} ${MINIMAL[rel]} RETURNING ${column}::pg_catalog.text`, DB)
        expect(got.length, `${label} ${q}`).toBe(1)
        expect(BigInt(got[0][0]), `${label} ${q}`).toBe(expected[q])
        await TGT.sql(`DELETE FROM ${rel}`, DB)
      }
    }
  }, 900_000)
})

describe('nothing is altered unless everything can be', () => {
  it('refuses without an outer transaction, leaving all three unchanged', async () => {
    await resetTarget()
    const source = await fencedSourceState()
    const before = await allStatesOn(TGT)
    const t = await openPsqlSession(TGT, DB)
    try {
      // No BEGIN: psql is in autocommit, so SAVEPOINT is refused by the server.
      await expect(applySequencePolicy(exec(t), source))
        .rejects.toThrow(SequencePolicyRefused)
      await expect(applySequencePolicy(exec(t), source))
        .rejects.toThrow(/no outer transaction is open/)
    } finally { await t.close() }
    expect(await allStatesOn(TGT)).toEqual(before)
  }, 900_000)

  it('refuses a non-pristine THIRD sequence before altering the first two', async () => {
    await resetTarget()
    const source = await fencedSourceState()
    // Consume one value from the THIRD reviewed sequence on the target.
    await TGT.sql(`SELECT pg_catalog.nextval('${POLICY_SEQUENCES[2]}')`, DB)
    const before = await allStatesOn(TGT)
    const t = await openPsqlSession(TGT, DB)
    try {
      await t.must('BEGIN')
      await expect(applySequencePolicy(exec(t), source))
        .rejects.toThrow(/already issued a value/)
      // The first two are untouched INSIDE the transaction, before any rollback.
      for (const q of [POLICY_SEQUENCES[0], POLICY_SEQUENCES[1]]) {
        const inTx = parseSequenceState(await t.must(SEQUENCE_STATE_SQL(q)), q)
        expect(inTx, q).toEqual(before[q])
      }
      await t.must('ROLLBACK')
    } finally { await t.close() }
    expect(await allStatesOn(TGT)).toEqual(before)
    await resetTarget()
  }, 900_000)

  it('leaves a mid-apply failure fully recoverable by the caller ROLLBACK', async () => {
    await resetTarget()
    const source = await fencedSourceState()
    const before = await allStatesOn(TGT)
    const t = await openPsqlSession(TGT, DB)
    try {
      await t.must('BEGIN')
      // Fail the SECOND ALTER, so the first has already been applied.
      let alters = 0
      const failing = {
        rows: async (sql: string) => {
          if (sql.startsWith('ALTER SEQUENCE')) {
            alters += 1
            if (alters === 2) throw new Error('injected mid-apply failure')
          }
          return await t.must(sql)
        },
      }
      let thrown: unknown = null
      try { await applySequencePolicy(failing, source) } catch (e) { thrown = e }
      expect(thrown).toBeInstanceOf(SequencePolicyFailed)
      expect((thrown as SequencePolicyFailed).phase).toBe('apply')
      expect(String((thrown as Error).message)).not.toContain('injected')
      expect(alters).toBe(2)
      // The caller rolls back - production code never committed.
      await t.must('ROLLBACK')
    } finally { await t.close() }
    expect(await allStatesOn(TGT)).toEqual(before)
  }, 900_000)
})

describe('nothing survives', () => {
  it('leaves no session, and both clusters still answer', async () => {
    await closeAllPsqlSessions()
    for (const [label, c] of [['source', SRC], ['target', TGT]] as const) {
      const n = await c.rows(
        `SELECT pg_catalog.count(*)::pg_catalog.text FROM pg_catalog.pg_stat_activity
          WHERE datname = '${DB}' AND pid <> pg_catalog.pg_backend_pid()`, DB)
      expect(Number(n[0][0]), `${label} has leftover sessions`).toBe(0)
    }
    expect(FENCE_SEQUENCES.length).toBe(3)
  }, 300_000)
})
