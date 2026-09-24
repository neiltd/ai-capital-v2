// The source fence against LIVE PostgreSQL 17, and the evaluation that SELECTS
// the sequence-fence mechanism.
//
// Nothing here assumes a candidate works. S1-S4 are each attempted against a
// real server and scored on the five required properties; the selection in
// src/pg-copy/source-fence.ts is then re-derived from those scores and must
// agree.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  FENCE_ADVISORY_SQL, FENCE_BEGIN_SQL, FENCE_LOCK_TIMEOUT_SQL, FENCE_PROOF_SQL,
  FENCE_SEQUENCES, FENCE_SEQUENCE_LOCK_MODE, FENCE_TABLES, FENCE_TABLE_LOCK_MODE,
  FenceRefused, RESTATES_POSITION, SELECTED_SEQUENCE_FENCE, SEQUENCE_LAST_VALUE_SQL,
  SEQUENCE_STATE_SQL, acquireSourceFence, assertFenceProof, effectiveNext,
  fenceRelationArray, parseLockRows, parseSequenceState, reflectsIssuedValue,
  readFencedSequenceState, selectSequenceFence, sequenceFenceSql, tableFenceSql,
  type CandidateScore, type SequenceFenceId, type SequenceState,
} from '../../src/pg-copy/source-fence.js'
import {
  startDisposableCluster, stopAllDisposableClusters, type DisposableCluster,
} from '../../testing/disposable-cluster.js'
import {
  closeAllPsqlSessions, openPsqlSession, type PsqlSession,
} from '../../testing/psql-session.js'
import { buildV19Database } from '../../testing/v19-database.js'

const SRC = 'source_v19'
const TGT = 'target_v19'
/** A reviewed table with a text primary key, used for the writer probes. */
const T = 'graph.nodes'
const SHORT_TIMEOUT = `SET lock_timeout = '1200ms'`

let C: DisposableCluster

beforeAll(async () => {
  C = await startDisposableCluster()
  await buildV19Database(C, SRC)
}, 900_000)

// EVERY session, after EVERY test. A supervisor that survives its own test
// keeps the advisory lock and all 21 SHARE locks, and the next test then fails
// for a reason that has nothing to do with what it is testing.
afterEach(async () => { await closeAllPsqlSessions() })

afterAll(async () => {
  await closeAllPsqlSessions()
  await stopAllDisposableClusters()
})

const proofRows = async (s: PsqlSession): Promise<ReturnType<typeof parseLockRows>> =>
  parseLockRows(await s.must(FENCE_PROOF_SQL.replace('$1', fenceRelationArray())))

/** Open a supervisor, take the whole fence, and hand back both. */
async function fenced(): Promise<{ sup: PsqlSession; pid: string }> {
  const sup = await openPsqlSession(C, SRC)
  const f = await acquireSourceFence(sup)
  expect(f.supervisorPid).toBe(sup.pid)
  return { sup, pid: sup.pid }
}

describe('the table fence holds the reviewed 21 still', () => {
  it('is taken once, in ascending order, with a bounded timeout and no retry', async () => {
    const sup = await openPsqlSession(C, SRC)
    try {
      const f = await acquireSourceFence(sup)
      const locks = f.statements.filter(s => s.startsWith('LOCK TABLE'))
      expect(locks).toEqual(FENCE_TABLES.map(tableFenceSql))
      expect([...FENCE_TABLES]).toEqual([...FENCE_TABLES].sort())
      // Exactly one statement per lock: no statement appears twice.
      expect(new Set(f.statements).size).toBe(f.statements.length)
      expect(f.statements).toContain(FENCE_BEGIN_SQL)
      expect(f.statements).toContain(FENCE_LOCK_TIMEOUT_SQL)
      expect(f.statements).toContain(FENCE_ADVISORY_SQL)
      const prover = await openPsqlSession(C, SRC)
      try {
        assertFenceProof(await proofRows(prover), { supervisorPid: sup.pid, provingPid: prover.pid })
      } finally { await prover.close() }
    } finally { await sup.close() }
  }, 300_000)

  it('blocks INSERT, UPDATE, DELETE and TRUNCATE', async () => {
    const { sup } = await fenced()
    const w = await openPsqlSession(C, SRC)
    try {
      await w.must(SHORT_TIMEOUT)
      for (const stmt of [
        `INSERT INTO ${T} SELECT * FROM ${T} WHERE false`,
        `UPDATE ${T} SET ticker = ticker WHERE false`,
        `DELETE FROM ${T} WHERE false`,
        `TRUNCATE ${T}`,
      ]) {
        const r = await w.send(stmt)
        expect(r.error, `${stmt} was NOT blocked`).toMatch(/lock timeout/)
        await w.send('ROLLBACK')
      }
    } finally { await w.close(); await sup.close() }
  }, 300_000)

  it('leaves ordinary SELECT and binary COPY TO possible', async () => {
    const { sup } = await fenced()
    const r = await openPsqlSession(C, SRC)
    try {
      await r.must(SHORT_TIMEOUT)
      for (const q of FENCE_TABLES) {
        const rows = await r.must(`SELECT pg_catalog.count(*)::pg_catalog.text FROM ${q}`)
        expect(rows.length).toBe(1)
      }
      const copy = await r.send(`COPY ${T} TO '/dev/null' (FORMAT binary)`)
      expect(copy.error).toBeNull()
    } finally { await r.close(); await sup.close() }
  }, 300_000)

  it('refuses when a writer already holds the source', async () => {
    const w = await openPsqlSession(C, SRC)
    await w.must('BEGIN')
    await w.must(`INSERT INTO ${T} SELECT * FROM ${T} WHERE false`)
    const sup = await openPsqlSession(C, SRC)
    try {
      await expect(acquireSourceFence(sup)).rejects.toThrow(FenceRefused)
      await expect(acquireSourceFence(sup)).rejects.toThrow(/lock timeout|current transaction is aborted/)
    } finally {
      await sup.send('ROLLBACK'); await sup.close()
      await w.send('ROLLBACK'); await w.close()
    }
  }, 300_000)

  it('detects a writer that queues AFTER the fence was taken', async () => {
    const { sup } = await fenced()
    const w = await openPsqlSession(C, SRC)
    const prover = await openPsqlSession(C, SRC)
    try {
      await w.must('BEGIN')
      // Fire and do not await: this statement will never be granted.
      const queued = w.send(`INSERT INTO ${T} SELECT * FROM ${T} WHERE false`)
      let rows = await proofRows(prover)
      const deadline = Date.now() + 20_000
      while (rows.every(r => r.granted) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100))
        rows = await proofRows(prover)
      }
      expect(rows.some(r => !r.granted), 'no queued request appeared').toBe(true)
      expect(() => assertFenceProof(rows, { supervisorPid: sup.pid, provingPid: prover.pid }))
        .toThrow(/ungranted lock request/)
      await sup.send('ROLLBACK')
      await queued
    } finally {
      await prover.close(); await w.send('ROLLBACK'); await w.close(); await sup.close()
    }
  }, 300_000)

  it('releases everything when the supervisor backend dies, and the proof then fails', async () => {
    const { sup, pid } = await fenced()
    const prover = await openPsqlSession(C, SRC)
    try {
      assertFenceProof(await proofRows(prover), { supervisorPid: pid, provingPid: prover.pid })
      await sup.close()
      const deadline = Date.now() + 20_000
      let rows = await proofRows(prover)
      while (rows.some(r => r.pid === pid) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100))
        rows = await proofRows(prover)
      }
      expect(rows.some(r => r.pid === pid), 'the dead supervisor still holds locks').toBe(false)
      expect(() => assertFenceProof(rows, { supervisorPid: pid, provingPid: prover.pid }))
        .toThrow(FenceRefused)
      // And the source is writable again.
      await prover.must(SHORT_TIMEOUT)
      expect((await prover.send(`INSERT INTO ${T} SELECT * FROM ${T} WHERE false`)).error).toBeNull()
    } finally { await prover.close(); await sup.close() }
  }, 300_000)

  it('refuses a fence that omits one reviewed table', async () => {
    const sup = await openPsqlSession(C, SRC)
    const prover = await openPsqlSession(C, SRC)
    try {
      await sup.must(FENCE_BEGIN_SQL)
      await sup.must(FENCE_LOCK_TIMEOUT_SQL)
      await sup.must(FENCE_ADVISORY_SQL)
      const omitted = FENCE_TABLES[7]
      for (const q of FENCE_TABLES) if (q !== omitted) await sup.must(tableFenceSql(q))
      for (const q of FENCE_SEQUENCES) {
        const st = parseSequenceState(await sup.must(SEQUENCE_STATE_SQL(q)), q)
        await sup.must(sequenceFenceSql(SELECTED_SEQUENCE_FENCE, q, st))
      }
      const rows = await proofRows(prover)
      expect(() => assertFenceProof(rows, { supervisorPid: sup.pid, provingPid: prover.pid }))
        .toThrow(new RegExp(`does not hold ${FENCE_TABLE_LOCK_MODE}[^]*${omitted.replace('.', '\\.')}`))
      await sup.send('ROLLBACK')
    } finally { await prover.close(); await sup.close() }
  }, 300_000)

  it('refuses a proof taken on the supervisor’s own backend', async () => {
    const { sup } = await fenced()
    try {
      const rows = await proofRows(sup)
      expect(() => assertFenceProof(rows, { supervisorPid: sup.pid, provingPid: sup.pid }))
        .toThrow(/supervisor's own backend/)
    } finally { await sup.close() }
  }, 300_000)
})

// ---------------------------------------------------------------------------
// Candidate evaluation
// ---------------------------------------------------------------------------

interface CandidateResult {
  accepted: boolean
  acceptError: string | null
  p1ByteIdentity: boolean
  p2NextvalBlocked: boolean
  p3ReadsTruthful: boolean
  p4DeathReleases: boolean
  p5HeldThroughCommit: boolean
  /** P6: safe against a nextval() interleaved BEFORE the locking statement. */
  p6AcquisitionSafe: boolean
  p6Notes: string[]
  qualifies: boolean
  sql: string[]
  /** Which reads succeeded/blocked under the held fence, for the record. */
  p3Notes: string[]
}

const stateOf = async (s: PsqlSession, q: string): Promise<SequenceState> =>
  parseSequenceState(await s.must(SEQUENCE_STATE_SQL(q)), q)

const sameState = (a: SequenceState, b: SequenceState): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

async function evaluate(id: SequenceFenceId): Promise<CandidateResult> {
  const r: CandidateResult = {
    accepted: true, acceptError: null,
    p1ByteIdentity: true, p2NextvalBlocked: true, p3ReadsTruthful: true,
    p4DeathReleases: true, p5HeldThroughCommit: true, p6AcquisitionSafe: true,
    p6Notes: [], qualifies: false, sql: [], p3Notes: [],
  }

  // --- acceptance, P1, P2, P3, P5 on ONE supervisor over all three sequences.
  const sup = await openPsqlSession(C, SRC)
  const other = await openPsqlSession(C, SRC)
  const reader = await openPsqlSession(C, SRC)
  const prover = await openPsqlSession(C, SRC)
  const before: Record<string, SequenceState> = {}
  try {
    for (const q of FENCE_SEQUENCES) before[q] = await stateOf(sup, q)

    await sup.must(FENCE_BEGIN_SQL)
    await sup.must(FENCE_LOCK_TIMEOUT_SQL)
    await sup.must(FENCE_ADVISORY_SQL)
    for (const q of FENCE_TABLES) await sup.must(tableFenceSql(q))

    for (const q of FENCE_SEQUENCES) {
      const sql = sequenceFenceSql(id, q, before[q])
      r.sql.push(sql)
      const res = await sup.send(sql)
      if (res.error !== null) {
        r.accepted = false
        r.acceptError = res.error.replace(/^psql:[^:]*:\d+: /, '')
        break
      }
    }

    if (r.accepted) {
      // P2: nextval from another backend must not complete.
      await other.must(SHORT_TIMEOUT)
      for (const q of FENCE_SEQUENCES) {
        const res = await other.send(`SELECT pg_catalog.nextval('${q}')`)
        if (res.error === null) r.p2NextvalBlocked = false
        await other.send('ROLLBACK')
      }

      // P3: reads from a third backend succeed AND report the pre-fence values.
      await reader.must(SHORT_TIMEOUT)
      for (const q of FENCE_SEQUENCES) {
        const live = await reader.send(SEQUENCE_STATE_SQL(q))
        if (live.error !== null) {
          r.p3ReadsTruthful = false
          r.p3Notes.push(`${q}: state read BLOCKED`)
          continue
        }
        if (!sameState(parseSequenceState(live.rows, q), before[q])) {
          r.p3ReadsTruthful = false
          r.p3Notes.push(`${q}: state read returned ALTERED values`)
        }
        // Recorded, not required: pg_sequence_last_value() takes nextval's own
        // RowExclusiveLock, so a fence that satisfies P2 necessarily blocks it.
        const lv = await reader.send(SEQUENCE_LAST_VALUE_SQL(q))
        r.p3Notes.push(`${q}: pg_sequence_last_value() ${lv.error === null ? 'succeeded' : 'blocked'}`)
      }
      for (const q of FENCE_TABLES) {
        if ((await reader.send(`SELECT pg_catalog.count(*)::pg_catalog.text FROM ${q}`)).error !== null) {
          r.p3ReadsTruthful = false
        }
      }
      if ((await reader.send(`COPY ${T} TO '/dev/null' (FORMAT binary)`)).error !== null) {
        r.p3ReadsTruthful = false
      }

      // P5: everything owned by one pid, nothing ungranted, across an
      // INDEPENDENT target transaction's COMMIT.
      const check = async (): Promise<boolean> => {
        const rows = await proofRows(prover)
        if (rows.some(x => !x.granted)) return false
        const held = (qn: string, mode: string): boolean =>
          rows.some(x => x.qname === qn && x.mode === mode && x.granted && x.pid === sup.pid)
        return FENCE_TABLES.every(q => held(q, FENCE_TABLE_LOCK_MODE)) &&
               FENCE_SEQUENCES.every(q => held(q, FENCE_SEQUENCE_LOCK_MODE)) &&
               rows.some(x => x.kind === 'advisory' && x.granted && x.pid === sup.pid)
      }
      const beforeCommit = await check()
      const target = await openPsqlSession(C, TGT)
      try {
        await target.must('BEGIN')
        await target.must(`CREATE TEMP TABLE fence_commit_probe (n integer)`)
        await target.must(`INSERT INTO fence_commit_probe VALUES (1)`)
        await target.must('COMMIT')
      } finally { await target.close() }
      const afterCommit = await check()
      r.p5HeldThroughCommit = beforeCommit && afterCommit
    }

    await sup.send('ROLLBACK')

    // P1: byte identity after rollback.
    for (const q of FENCE_SEQUENCES) {
      if (!sameState(await stateOf(sup, q), before[q])) r.p1ByteIdentity = false
    }
  } finally {
    await prover.close(); await reader.close(); await other.close(); await sup.close()
  }

  // --- P4 needs its own supervisor, because it kills it.
  if (r.accepted) {
    const sup2 = await openPsqlSession(C, SRC)
    const prover2 = await openPsqlSession(C, SRC)
    try {
      await sup2.must(FENCE_BEGIN_SQL)
      await sup2.must(FENCE_LOCK_TIMEOUT_SQL)
      await sup2.must(FENCE_ADVISORY_SQL)
      for (const q of FENCE_TABLES) await sup2.must(tableFenceSql(q))
      for (const q of FENCE_SEQUENCES) {
        await sup2.must(sequenceFenceSql(id, q, await stateOf(sup2, q)))
      }
      const pid = sup2.pid
      await sup2.close()
      const deadline = Date.now() + 20_000
      let rows = await proofRows(prover2)
      while (rows.some(x => x.pid === pid) && Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 100))
        rows = await proofRows(prover2)
      }
      if (rows.some(x => x.pid === pid)) r.p4DeathReleases = false
      let proofStillPasses = true
      try {
        assertFenceProof(rows, { supervisorPid: pid, provingPid: prover2.pid, mechanism: id })
      } catch { proofStillPasses = false }
      if (proofStillPasses) r.p4DeathReleases = false
      await prover2.must(SHORT_TIMEOUT)
      for (const q of FENCE_SEQUENCES) {
        if ((await prover2.send(`SELECT pg_catalog.nextval('${q}')`)).error !== null) {
          r.p4DeathReleases = false
        }
      }
    } finally { await prover2.close() }
  } else {
    r.p4DeathReleases = false
  }

  // --- P6: ACQUISITION SAFETY. Five post-acquisition properties say nothing
  // about the interval between reading a candidate's inputs and executing the
  // statement that takes the lock. This deliberately puts a direct nextval()
  // in that interval, on every reviewed sequence.
  if (r.accepted) {
    const sup3 = await openPsqlSession(C, SRC)
    const adversary = await openPsqlSession(C, SRC)
    try {
      await sup3.must(FENCE_BEGIN_SQL)
      await sup3.must(FENCE_LOCK_TIMEOUT_SQL)
      await sup3.must(FENCE_ADVISORY_SQL)
      for (const q of FENCE_TABLES) await sup3.must(tableFenceSql(q))

      for (const q of FENCE_SEQUENCES) {
        // 1. collect the candidate's inputs, exactly as acquisition does
        const input = await stateOf(sup3, q)
        // 2. INTERLEAVE: a direct nextval() from another backend. Nothing
        //    fences the sequence yet, so this must succeed - that is the point.
        const taken = await adversary.send(`SELECT pg_catalog.nextval('${q}')`)
        if (taken.error !== null) {
          r.p6Notes.push(`${q}: interleaved nextval() unexpectedly refused: ${taken.error}`)
          r.p6AcquisitionSafe = false
          continue
        }
        const issued = BigInt(taken.rows[0][0])
        // 3. now take the lock, using inputs collected BEFORE the interleave
        const lockRes = await sup3.send(sequenceFenceSql(id, q, input))
        if (lockRes.error !== null) {
          r.p6Notes.push(`${q}: locking statement refused: ${lockRes.error}`)
          r.p6AcquisitionSafe = false
          continue
        }
        // 4. the fenced state must account for the value already handed out
        const after = await stateOf(sup3, q)
        if (!reflectsIssuedValue(after, issued, q)) {
          r.p6AcquisitionSafe = false
          r.p6Notes.push(
            `${q}: issued ${issued.toString()} but post-acquisition state is ` +
            `last_value=${after.last_value} is_called=${String(after.is_called)} ` +
            `(next would be ${effectiveNext(after, q).toString()}) - REISSUE`)
        } else {
          r.p6Notes.push(`${q}: issued ${issued.toString()}, fenced state accounts for it`)
        }
        // and nextval must now be blocked
        await adversary.must(SHORT_TIMEOUT)
        if ((await adversary.send(`SELECT pg_catalog.nextval('${q}')`)).error === null) {
          r.p6AcquisitionSafe = false
          r.p6Notes.push(`${q}: nextval() still completed after the lock`)
        }
      }
      await sup3.send('ROLLBACK')
      // 5. rollback must leave the source in its true post-interleaving state:
      //    the adversary's nextval() is not undone by our rollback.
      for (const q of FENCE_SEQUENCES) {
        const post = await stateOf(sup3, q)
        if (!post.is_called) {
          r.p6AcquisitionSafe = false
          r.p6Notes.push(`${q}: after rollback the sequence claims nothing was ever issued`)
        }
      }
    } finally { await adversary.close(); await sup3.close() }
  } else {
    r.p6AcquisitionSafe = false
  }

  r.qualifies = r.accepted && r.p1ByteIdentity && r.p2NextvalBlocked &&
                r.p3ReadsTruthful && r.p4DeathReleases && r.p5HeldThroughCommit &&
                r.p6AcquisitionSafe
  return r
}

describe('sequence-fence candidates S1-S4, evaluated against live PostgreSQL 17', () => {
  const results: Partial<Record<SequenceFenceId, CandidateResult>> = {}

  beforeAll(async () => {
    await buildV19Database(C, TGT)
    for (const id of ['S1', 'S2', 'S3', 'S4'] as const) results[id] = await evaluate(id)
    // Repair whatever P4 consumed: nextval was called on every sequence after
    // the fence was released, deliberately. The remaining tests never compare
    // sequence positions across candidates.
  }, 1_800_000)

  it('records whether PostgreSQL accepts each candidate at all', () => {
    // EMITTED DELIBERATELY. The selection is only reviewable if the scores it
    // was made from are visible; a bare "S2 was chosen" is not evidence.
    for (const id of ['S1', 'S2', 'S3', 'S4'] as const) {
      const r = results[id]!
      console.info(
        `[candidate ${id}] accepted=${String(r.accepted)}` +
        (r.accepted
          ? ` P1=${String(r.p1ByteIdentity)} P2=${String(r.p2NextvalBlocked)} ` +
            `P3=${String(r.p3ReadsTruthful)} P4=${String(r.p4DeathReleases)} ` +
            `P5=${String(r.p5HeldThroughCommit)} P6=${String(r.p6AcquisitionSafe)} ` +
            `qualifies=${String(r.qualifies)}` +
            ` | acquisition: ${r.p6Notes.join(' ;; ')}` +
            ` | sql: ${r.sql.join(' ;; ')}` +
            ` | notes: ${r.p3Notes.join(' ;; ')}`
          : ` error=${String(r.acceptError)} | sql: ${r.sql.join(' ;; ')}`))
    }

    expect(results.S1!.accepted, `S1 unexpectedly accepted`).toBe(false)
    expect(results.S1!.acceptError).toMatch(/not supported for sequences|cannot lock relation/)
    expect(results.S4!.accepted, `S4 unexpectedly accepted`).toBe(false)
    expect(results.S4!.acceptError).toMatch(/cannot lock rows in sequence/)
    expect(results.S2!.accepted).toBe(true)
    expect(results.S3!.accepted).toBe(true)
  })

  it('scores every accepted candidate on the five post-acquisition properties', () => {
    for (const id of ['S2', 'S3'] as const) {
      const r = results[id]!
      expect(r.p1ByteIdentity, `${id} P1`).toBe(true)
      expect(r.p2NextvalBlocked, `${id} P2`).toBe(true)
      expect(r.p3ReadsTruthful, `${id} P3`).toBe(true)
      expect(r.p4DeathReleases, `${id} P4`).toBe(true)
      expect(r.p5HeldThroughCommit, `${id} P5`).toBe(true)
    }
  })

  it('catches S2 on ACQUISITION safety: an interleaved nextval() is overwritten', () => {
    const r = results.S2!
    expect(r.accepted).toBe(true)
    // Passing five post-acquisition properties is exactly why P6 is needed.
    expect(r.p5HeldThroughCommit).toBe(true)
    expect(r.p6AcquisitionSafe, 'S2 was expected to FAIL acquisition safety').toBe(false)
    expect(r.p6Notes.join(' ')).toMatch(/REISSUE/)
    // Every reviewed sequence, not just one.
    for (const q of FENCE_SEQUENCES) {
      expect(r.p6Notes.some(n => n.startsWith(`${q}:`) && n.includes('REISSUE')), q).toBe(true)
    }
    expect(r.qualifies).toBe(false)
  })

  it('S3 is acquisition-safe on every reviewed sequence', () => {
    const r = results.S3!
    expect(r.p6AcquisitionSafe).toBe(true)
    for (const q of FENCE_SEQUENCES) {
      expect(r.p6Notes.some(n => n.startsWith(`${q}:`) && n.includes('accounts for it')), q).toBe(true)
    }
    expect(r.p6Notes.join(' ')).not.toMatch(/REISSUE/)
    expect(r.qualifies).toBe(true)
  })

  it('selects by the acquisition-safe, position-stable rule - not by order', () => {
    const scores: Partial<Record<SequenceFenceId, CandidateScore>> = {}
    for (const id of ['S1', 'S2', 'S3', 'S4'] as const) {
      const r = results[id]!
      scores[id] = {
        accepted: r.accepted, p1ByteIdentity: r.p1ByteIdentity,
        p2NextvalBlocked: r.p2NextvalBlocked, p3ReadsTruthful: r.p3ReadsTruthful,
        p4DeathReleases: r.p4DeathReleases, p5HeldThroughCommit: r.p5HeldThroughCommit,
        p6AcquisitionSafe: r.p6AcquisitionSafe,
      }
    }
    const chosen = selectSequenceFence(scores)
    expect(chosen, 'no candidate qualified; a residual-risk STOP is required').not.toBeNull()
    expect(SELECTED_SEQUENCE_FENCE).toBe(chosen)
    expect(RESTATES_POSITION[SELECTED_SEQUENCE_FENCE]).toBe(false)
    // And the discarded first-accepted rule would have chosen differently.
    const firstAccepted = (['S1', 'S2', 'S3', 'S4'] as const).find(id => results[id]!.accepted)
    expect(firstAccepted).toBe('S2')
    expect(SELECTED_SEQUENCE_FENCE).not.toBe(firstAccepted)
  })

  it('the selected mechanism takes the lock mode the proof requires', async () => {
    const sup = await openPsqlSession(C, SRC)
    const prover = await openPsqlSession(C, SRC)
    try {
      const f = await acquireSourceFence(sup)
      expect(f.mechanism).toBe(SELECTED_SEQUENCE_FENCE)
      const rows = await proofRows(prover)
      for (const q of FENCE_SEQUENCES) {
        expect(rows.some(r => r.qname === q && r.mode === FENCE_SEQUENCE_LOCK_MODE &&
                              r.granted && r.pid === sup.pid), `${q} not fenced`).toBe(true)
      }
      assertFenceProof(rows, { supervisorPid: sup.pid, provingPid: prover.pid })
    } finally { await prover.close(); await sup.close() }
  }, 300_000)

  it('computes the effective next value from is_called, not from last_value alone', async () => {
    const s = await openPsqlSession(C, SRC)
    try {
      const q = FENCE_SEQUENCES[0]
      const st = await stateOf(s, q)
      const predicted = effectiveNext(st, q)
      await s.must('BEGIN')
      const got = (await s.must(`SELECT pg_catalog.nextval('${q}')`))[0][0]
      await s.must('ROLLBACK')
      expect(BigInt(got)).toBe(predicted)
    } finally { await s.close() }
  }, 300_000)
})

describe('the fenced state is the only state later slices may use', () => {
  it('does not alter position when the selected mechanism takes the lock', async () => {
    const sup = await openPsqlSession(C, SRC)
    try {
      await sup.must(FENCE_BEGIN_SQL)
      await sup.must(FENCE_LOCK_TIMEOUT_SQL)
      for (const q of FENCE_SEQUENCES) {
        const before = await stateOf(sup, q)
        await sup.must(sequenceFenceSql(SELECTED_SEQUENCE_FENCE, q, before))
        const after = await stateOf(sup, q)
        expect(after.last_value, q).toBe(before.last_value)
        expect(after.is_called, q).toBe(before.is_called)
        expect(effectiveNext(after, q), q).toBe(effectiveNext(before, q))
      }
      await sup.send('ROLLBACK')
    } finally { await sup.close() }
  }, 300_000)

  it('never reissues a value taken immediately before the lock', async () => {
    const sup = await openPsqlSession(C, SRC)
    const adversary = await openPsqlSession(C, SRC)
    try {
      await sup.must(FENCE_BEGIN_SQL)
      await sup.must(FENCE_LOCK_TIMEOUT_SQL)
      await sup.must(FENCE_ADVISORY_SQL)
      for (const q of FENCE_TABLES) await sup.must(tableFenceSql(q))
      for (const q of FENCE_SEQUENCES) {
        const input = await stateOf(sup, q)
        const issued = BigInt((await adversary.must(`SELECT pg_catalog.nextval('${q}')`))[0][0])
        await sup.must(sequenceFenceSql(SELECTED_SEQUENCE_FENCE, q, input))
        const fenced = await stateOf(sup, q)
        expect(reflectsIssuedValue(fenced, issued, q), `${q} would reissue ${issued}`).toBe(true)
        expect(effectiveNext(fenced, q) > issued, q).toBe(true)
      }
      await sup.send('ROLLBACK')
      // Rollback does not resurrect a consumed value: nextval is not undone.
      for (const q of FENCE_SEQUENCES) expect((await stateOf(sup, q)).is_called, q).toBe(true)
    } finally { await adversary.close(); await sup.close() }
  }, 300_000)

  it('reads protected state only after an independent full-fence proof', async () => {
    const sup = await openPsqlSession(C, SRC)
    const prover = await openPsqlSession(C, SRC)
    try {
      const fence = await acquireSourceFence(sup)
      const fenced = await readFencedSequenceState(sup, prover, fence)
      expect(Object.keys(fenced).sort()).toEqual([...FENCE_SEQUENCES])
      for (const q of FENCE_SEQUENCES) {
        expect(fenced[q].owned_by, q).not.toBe('')
        expect(fenced[q].data_type, q).toMatch(/^(integer|bigint|smallint)$/)
      }
      // The same call on the supervisor's own backend is refused: a session
      // proving its own locks proves nothing.
      await expect(readFencedSequenceState(sup, sup, fence)).rejects.toThrow(/own backend/)
      await sup.send('ROLLBACK')
    } finally { await prover.close(); await sup.close() }
  }, 300_000)

  it('refuses the protected read when the fence is incomplete', async () => {
    const sup = await openPsqlSession(C, SRC)
    const prover = await openPsqlSession(C, SRC)
    try {
      await sup.must(FENCE_BEGIN_SQL)
      await sup.must(FENCE_LOCK_TIMEOUT_SQL)
      await sup.must(FENCE_ADVISORY_SQL)
      const omitted = FENCE_TABLES[11]
      for (const q of FENCE_TABLES) if (q !== omitted) await sup.must(tableFenceSql(q))
      for (const q of FENCE_SEQUENCES) {
        await sup.must(sequenceFenceSql(SELECTED_SEQUENCE_FENCE, q, await stateOf(sup, q)))
      }
      const fence = {
        supervisorPid: sup.pid, mechanism: SELECTED_SEQUENCE_FENCE,
        tables: FENCE_TABLES, sequences: FENCE_SEQUENCES,
        candidateInputs: {}, statements: [],
      }
      await expect(readFencedSequenceState(sup, prover, fence))
        .rejects.toThrow(new RegExp(omitted.replace('.', '\\.')))
      await sup.send('ROLLBACK')
    } finally { await prover.close(); await sup.close() }
  }, 300_000)

  it('marks pre-lock candidate inputs so they cannot pass as fenced state', async () => {
    const sup = await openPsqlSession(C, SRC)
    const prover = await openPsqlSession(C, SRC)
    try {
      const fence = await acquireSourceFence(sup)
      expect(Object.keys(fence)).not.toContain('sequenceStates')
      for (const q of FENCE_SEQUENCES) {
        expect(fence.candidateInputs[q].__unfenced)
          .toBe('read before the lock; never source-of-truth')
      }
      const fenced = await readFencedSequenceState(sup, prover, fence)
      // Same numbers here, because S3 changes nothing - but they arrive from the
      // proved read, which is the only path later slices are allowed to use.
      for (const q of FENCE_SEQUENCES) {
        expect(fenced[q].last_value, q).toBe(fence.candidateInputs[q].state.last_value)
        expect(Object.keys(fenced[q])).not.toContain('__unfenced')
      }
      await sup.send('ROLLBACK')
    } finally { await prover.close(); await sup.close() }
  }, 300_000)

  it('restores every sequence field on rollback, and survives a target COMMIT', async () => {
    const sup = await openPsqlSession(C, SRC)
    const prover = await openPsqlSession(C, SRC)
    const before: Record<string, SequenceState> = {}
    try {
      for (const q of FENCE_SEQUENCES) before[q] = await stateOf(sup, q)
      const fence = await acquireSourceFence(sup)
      const target = await openPsqlSession(C, TGT)
      try {
        await target.must('BEGIN')
        await target.must('CREATE TEMP TABLE c11_probe (n integer)')
        await target.must('COMMIT')
      } finally { await target.close() }
      // Still whole, after an independent target transaction committed.
      assertFenceProof(await proofRows(prover), { supervisorPid: fence.supervisorPid, provingPid: prover.pid })
      await sup.send('ROLLBACK')
      for (const q of FENCE_SEQUENCES) {
        expect(await stateOf(sup, q), q).toEqual(before[q])
      }
      // ... and supervisor death releases it just as rollback does.
      const sup2 = await openPsqlSession(C, SRC)
      const f2 = await acquireSourceFence(sup2)
      const pid = sup2.pid
      await sup2.close()
      const deadline = Date.now() + 20_000
      let rows = await proofRows(prover)
      while (rows.some(r => r.pid === pid) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100))
        rows = await proofRows(prover)
      }
      expect(rows.some(r => r.pid === pid)).toBe(false)
      expect(() => assertFenceProof(rows, { supervisorPid: f2.supervisorPid, provingPid: prover.pid }))
        .toThrow(FenceRefused)
    } finally { await prover.close(); await sup.close() }
  }, 300_000)
})
