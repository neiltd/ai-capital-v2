// The source fence, proved OFFLINE: the statement set, the ordering argument,
// the value arithmetic, and every refusal in the proof. What a real server does
// with these statements is tests/pgcopy/source-fence.int.test.ts.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { COPY_SEQUENCES, COPY_TABLES } from '../src/pg-copy/schema-contract.js'
import {
  FENCE_ADVISORY_CLASSID, FENCE_ADVISORY_OBJID, FENCE_ADVISORY_SQL, FENCE_BEGIN_SQL,
  FENCE_LOCK_TIMEOUT_MS, FENCE_LOCK_TIMEOUT_SQL, FENCE_PROOF_SQL, FENCE_SEQUENCES,
  FENCE_SEQUENCE_LOCK_MODE, FENCE_TABLES, FENCE_TABLE_LOCK_MODE, FenceRefused,
  RESTATES_POSITION, SELECTED_SEQUENCE_FENCE, SEQUENCE_LAST_VALUE_SQL, SEQUENCE_STATE_SQL,
  acquireSourceFence, assertFenceProof, assertNoReissue, assertQName, candidateQualifies,
  effectiveNext, fenceRelationArray, parseLockRows, parseSequenceState, pgBool,
  readFencedSequenceState, reflectsIssuedValue, selectSequenceFence, sequenceFenceSql,
  tableFenceSql, type CandidateScore, type FencedSequenceState, type LockRow,
  type SequenceState, type UnfencedSequenceInput,
} from '../src/pg-copy/source-fence.js'

const SRC = readFileSync(
  fileURLToPath(new URL('../src/pg-copy/source-fence.ts', import.meta.url)), 'utf-8')

const state = (over: Partial<SequenceState> = {}): SequenceState => ({
  last_value: '1', is_called: false, increment_by: '1',
  min_value: '1', max_value: '2147483647', start_value: '1',
  cache_size: '1', cycle: false, data_type: 'integer',
  owned_by: 'portfolio.trade_log.id', ...over,
})

const SUP = '4242'
const PROVER = '4343'

/** A complete, granted fence held by SUP. */
function fullProof(over: LockRow[] = []): LockRow[] {
  const rows: LockRow[] = [
    { kind: 'advisory', qname: 'advisory', mode: 'ExclusiveLock', granted: true, pid: SUP },
    ...FENCE_TABLES.map(q => ({
      kind: 'relation', qname: q, mode: FENCE_TABLE_LOCK_MODE, granted: true, pid: SUP,
    })),
    ...FENCE_SEQUENCES.map(q => ({
      kind: 'relation', qname: q, mode: FENCE_SEQUENCE_LOCK_MODE, granted: true, pid: SUP,
    })),
  ]
  return [...rows, ...over]
}

describe('the fenced set comes from the one copy-set authority', () => {
  it('is exactly the 21 reviewed tables, ascending', () => {
    expect([...FENCE_TABLES]).toEqual([...COPY_TABLES].sort())
    expect(FENCE_TABLES.length).toBe(21)
    expect([...FENCE_TABLES]).toEqual([...FENCE_TABLES].sort())
  })

  it('is exactly the three reviewed sequences, ascending', () => {
    expect([...FENCE_SEQUENCES]).toEqual([...COPY_SEQUENCES].sort())
    expect([...FENCE_SEQUENCES]).toEqual(
      ['briefing.qa_id_seq', 'capital.fetch_log_id_seq', 'portfolio.trade_log_id_seq'])
  })

  it('derives the order rather than restating it', () => {
    // A hand-written list would be a second authority that drifts silently.
    expect(SRC).toContain('[...COPY_TABLES].sort(')
    expect(SRC).toContain('[...COPY_SEQUENCES].sort(')
  })

  it('covers every fenced relation in the proof array', () => {
    const arr = fenceRelationArray()
    for (const q of [...FENCE_TABLES, ...FENCE_SEQUENCES]) expect(arr).toContain(`"${q}"`)
    expect((arr.match(/","/g) ?? []).length).toBe(23)
  })
})

describe('the statements the supervisor issues', () => {
  it('begins once and bounds the wait', () => {
    expect(FENCE_BEGIN_SQL).toBe('BEGIN')
    expect(FENCE_LOCK_TIMEOUT_MS).toBeGreaterThan(0)
    expect(FENCE_LOCK_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
    expect(FENCE_LOCK_TIMEOUT_SQL).toBe(`SET LOCAL lock_timeout = '${FENCE_LOCK_TIMEOUT_MS}ms'`)
  })

  it('takes a FIXED advisory key, not a per-run one', () => {
    expect(FENCE_ADVISORY_SQL).toBe(
      `SELECT pg_catalog.pg_advisory_xact_lock(${FENCE_ADVISORY_CLASSID}, ${FENCE_ADVISORY_OBJID})`)
    expect(Number.isInteger(FENCE_ADVISORY_CLASSID)).toBe(true)
    expect(Number.isInteger(FENCE_ADVISORY_OBJID)).toBe(true)
    expect(SRC).not.toMatch(/pg_advisory_lock\s*\(/)  // session-scoped: outlives rollback
  })

  it('locks tables in SHARE mode, one statement each', () => {
    expect(tableFenceSql('graph.nodes')).toBe('LOCK TABLE graph.nodes IN SHARE MODE')
  })

  it('contains no retry loop and no swallowed failure', () => {
    const fn = SRC.slice(SRC.indexOf('export async function acquireSourceFence'),
                         SRC.indexOf('// ----', SRC.indexOf('export async function acquireSourceFence')))
    expect(fn).not.toMatch(/\bwhile\s*\(/)
    expect(fn).not.toMatch(/\bfor\s*\(\s*let\b/)
    expect(fn).not.toMatch(/\bcatch\b/)
    expect(fn).not.toMatch(/retry|attempt|backoff/i)
    // The only loops are `for (const q of ...)` over the reviewed sets.
    expect((fn.match(/for \(const q of FENCE_/g) ?? []).length).toBe(2)
  })

  it('issues exactly one statement per lock, in order', async () => {
    const sent: string[] = []
    const f = await acquireSourceFence({
      send: async (sql: string) => {
        sent.push(sql)
        if (sql.startsWith('SELECT pg_catalog.pg_backend_pid')) {
          return { rows: [[SUP]], error: null }
        }
        if (sql.includes('CROSS JOIN pg_catalog.pg_sequence')) {
          const s = state()
          return {
            rows: [[s.last_value, 'false', s.increment_by, s.min_value, s.max_value,
                    s.start_value, s.cache_size, 'false', s.data_type, s.owned_by]],
            error: null,
          }
        }
        return { rows: [], error: null }
      },
    })
    expect(f.supervisorPid).toBe(SUP)
    expect(f.mechanism).toBe(SELECTED_SEQUENCE_FENCE)
    expect(sent.filter(s => s.startsWith('LOCK TABLE'))).toEqual(FENCE_TABLES.map(tableFenceSql))
    expect(new Set(sent).size).toBe(sent.length)
    expect(sent.indexOf(FENCE_ADVISORY_SQL)).toBeLessThan(sent.indexOf(tableFenceSql(FENCE_TABLES[0])))
  })

  it('stops at the FIRST refusal and never reissues it', async () => {
    const sent: string[] = []
    const failing = tableFenceSql(FENCE_TABLES[3])
    await expect(acquireSourceFence({
      send: async (sql: string) => {
        sent.push(sql)
        if (sql.startsWith('SELECT pg_catalog.pg_backend_pid')) return { rows: [[SUP]], error: null }
        if (sql === failing) return { rows: [], error: 'ERROR:  canceling statement due to lock timeout' }
        return { rows: [], error: null }
      },
    })).rejects.toThrow(/lock timeout/)
    expect(sent.filter(s => s === failing).length).toBe(1)
    expect(sent[sent.length - 1]).toBe(failing)
  })
})

describe('sequence state and the candidate SQL', () => {
  it('never routes the state read through nextval’s own lock', () => {
    const sql = SEQUENCE_STATE_SQL('portfolio.trade_log_id_seq')
    expect(sql).not.toContain('pg_sequence_last_value')
    expect(sql).not.toContain('pg_sequences')
    expect(sql).toContain('pg_catalog.pg_sequence')
    // And the blocked read is named, so a test can assert it IS blocked.
    expect(SEQUENCE_LAST_VALUE_SQL('portfolio.trade_log_id_seq'))
      .toContain('pg_sequence_last_value')
  })

  it('reads both boolean spellings and refuses anything else', () => {
    expect(pgBool('t', 'x')).toBe(true)
    expect(pgBool('true', 'x')).toBe(true)
    expect(pgBool('f', 'x')).toBe(false)
    expect(pgBool('false', 'x')).toBe(false)
    expect(() => pgBool('', 'x')).toThrow(FenceRefused)
    expect(() => pgBool('TRUE', 'x')).toThrow(/neither true nor false/)
  })

  it('parses a state row, and refuses a row count that is not one', () => {
    const s = parseSequenceState(
      [['7', 'true', '1', '1', '99', '1', '1', 'false', 'integer', 'portfolio.trade_log.id']],
      'portfolio.trade_log_id_seq')
    expect(s.is_called).toBe(true)
    expect(s.cycle).toBe(false)
    expect(s.owned_by).toBe('portfolio.trade_log.id')
    expect(() => parseSequenceState([], 'x.y')).toThrow(/exactly one state row/)
  })

  it('computes the next value from is_called, not from last_value alone', () => {
    expect(effectiveNext(state({ last_value: '7', is_called: false }), 'q')).toBe(7n)
    expect(effectiveNext(state({ last_value: '7', is_called: true }), 'q')).toBe(8n)
    expect(effectiveNext(state({ last_value: '7', is_called: true, increment_by: '3' }), 'q')).toBe(10n)
    expect(effectiveNext(state({ last_value: '-1', is_called: true, increment_by: '-2',
                                 min_value: '-99', max_value: '-1' }), 'q')).toBe(-3n)
  })

  it('refuses a next value outside the sequence’s own range', () => {
    expect(() => effectiveNext(
      state({ last_value: '2147483647', is_called: true }), 'portfolio.trade_log_id_seq'))
      .toThrow(/outside \[1, 2147483647\]/)
  })

  it('renders each candidate exactly as evaluated', () => {
    const q = 'portfolio.trade_log_id_seq'
    expect(sequenceFenceSql('S1', q, state())).toBe(`LOCK TABLE ${q} IN SHARE MODE`)
    expect(sequenceFenceSql('S2', q, state({ last_value: '7', is_called: true })))
      .toBe(`ALTER SEQUENCE ${q} RESTART WITH 8`)
    expect(sequenceFenceSql('S3', q, state({ increment_by: '3' })))
      .toBe(`ALTER SEQUENCE ${q} INCREMENT BY 3`)
    expect(sequenceFenceSql('S4', q, state())).toBe(`SELECT last_value FROM ${q} FOR UPDATE`)
  })

  it('names the mechanism live PostgreSQL selected', () => {
    expect(SELECTED_SEQUENCE_FENCE).toBe('S3')
    expect(RESTATES_POSITION[SELECTED_SEQUENCE_FENCE]).toBe(false)
    expect(FENCE_SEQUENCE_LOCK_MODE).toBe('ShareRowExclusiveLock')
    // The unreviewed fallbacks are not reachable from this module at all.
    expect(SRC).not.toMatch(/\bsetval\s*\(/)
    expect(SRC).not.toMatch(/GRANT|REVOKE|ALTER SEQUENCE \$\{q\} OWNER/)
  })

  it('refuses any name that is not a bare qualified identifier', () => {
    expect(assertQName('graph.nodes')).toBe('graph.nodes')
    for (const bad of ['graph.nodes; DROP TABLE x', 'nodes', '"graph".nodes', 'graph.nodes--',
                       'graph.no des', 'Graph.Nodes', '']) {
      expect(() => assertQName(bad), bad).toThrow(FenceRefused)
    }
  })
})

describe('the proof refuses anything short of the whole fence', () => {
  it('accepts a complete, granted fence held by one other backend', () => {
    expect(() => assertFenceProof(fullProof(), { supervisorPid: SUP, provingPid: PROVER }))
      .not.toThrow()
  })

  it('refuses a proof taken on the supervisor’s own backend', () => {
    expect(() => assertFenceProof(fullProof(), { supervisorPid: SUP, provingPid: SUP }))
      .toThrow(/supervisor's own backend/)
  })

  it('refuses a missing advisory lock', () => {
    const rows = fullProof().filter(r => r.kind !== 'advisory')
    expect(() => assertFenceProof(rows, { supervisorPid: SUP, provingPid: PROVER }))
      .toThrow(/does not hold the reviewed advisory lock/)
  })

  it('refuses an advisory lock held by a DIFFERENT backend', () => {
    const rows = fullProof().map(r => (r.kind === 'advisory' ? { ...r, pid: '9999' } : r))
    expect(() => assertFenceProof(rows, { supervisorPid: SUP, provingPid: PROVER }))
      .toThrow(/does not hold the reviewed advisory lock/)
  })

  it('refuses when any ONE reviewed table is unlocked, for every table', () => {
    for (const omitted of FENCE_TABLES) {
      const rows = fullProof().filter(r => !(r.qname === omitted && r.mode === FENCE_TABLE_LOCK_MODE))
      expect(() => assertFenceProof(rows, { supervisorPid: SUP, provingPid: PROVER }), omitted)
        .toThrow(new RegExp(omitted.replace('.', '\\.')))
    }
  })

  it('refuses when any ONE reviewed sequence is unfenced', () => {
    for (const omitted of FENCE_SEQUENCES) {
      const rows = fullProof().filter(r => !(r.qname === omitted && r.mode === FENCE_SEQUENCE_LOCK_MODE))
      expect(() => assertFenceProof(rows, { supervisorPid: SUP, provingPid: PROVER }), omitted)
        .toThrow(new RegExp(`${SELECTED_SEQUENCE_FENCE}[^]*${omitted.replace('.', '\\.')}`))
    }
  })

  it('refuses a table locked in a weaker mode', () => {
    const rows = fullProof().map(r =>
      (r.qname === FENCE_TABLES[0] && r.mode === FENCE_TABLE_LOCK_MODE
        ? { ...r, mode: 'AccessShareLock' } : r))
    expect(() => assertFenceProof(rows, { supervisorPid: SUP, provingPid: PROVER }))
      .toThrow(new RegExp(FENCE_TABLES[0].replace('.', '\\.')))
  })

  it('refuses a locked-but-UNGRANTED request from anyone', () => {
    const rows = fullProof([
      { kind: 'relation', qname: FENCE_TABLES[0], mode: 'RowExclusiveLock', granted: false, pid: '777' },
    ])
    expect(() => assertFenceProof(rows, { supervisorPid: SUP, provingPid: PROVER }))
      .toThrow(/ungranted lock request/)
  })

  it('refuses a fence held by two different backends between them', () => {
    const rows = fullProof().map((r, i) => (i === 5 ? { ...r, pid: '9999' } : r))
    expect(() => assertFenceProof(rows, { supervisorPid: SUP, provingPid: PROVER }))
      .toThrow(FenceRefused)
  })

  it('refuses a proof that names a mechanism other than the selected one', () => {
    expect(() => assertFenceProof(fullProof(),
      { supervisorPid: SUP, provingPid: PROVER, mechanism: 'S2' }))
      .toThrow(/not the selected S3/)
  })

  it('refuses a pid that is not a backend pid', () => {
    expect(() => assertFenceProof(fullProof(), { supervisorPid: 'x', provingPid: PROVER }))
      .toThrow(/is not a backend pid/)
    expect(() => assertFenceProof(fullProof(), { supervisorPid: SUP, provingPid: '' }))
      .toThrow(/is not a backend pid/)
  })

  it('reads granted from the right column, in either spelling', () => {
    const rows = parseLockRows([['relation', 'graph.nodes', 'ShareLock', 'true', '1']])
    expect(rows[0].granted).toBe(true)
    expect(parseLockRows([['relation', 'graph.nodes', 'ShareLock', 'f', '1']])[0].granted).toBe(false)
    expect(() => parseLockRows([['relation', 'graph.nodes', 'ShareLock', '', '1']]))
      .toThrow(FenceRefused)
  })

  it('asks pg_locks about granted state at all', () => {
    expect(FENCE_PROOF_SQL).toContain('l.granted')
    expect(FENCE_PROOF_SQL).toContain('pg_catalog.pg_locks')
    expect(FENCE_PROOF_SQL).toContain(String(FENCE_ADVISORY_CLASSID))
  })
})

describe('acquisition safety decides the selection', () => {
  const score = (over: Partial<CandidateScore> = {}): CandidateScore => ({
    accepted: true, p1ByteIdentity: true, p2NextvalBlocked: true, p3ReadsTruthful: true,
    p4DeathReleases: true, p5HeldThroughCommit: true, p6AcquisitionSafe: true, ...over,
  })

  it('treats acquisition safety as REQUIRED, not advisory', () => {
    expect(candidateQualifies(score())).toBe(true)
    expect(candidateQualifies(score({ p6AcquisitionSafe: false }))).toBe(false)
    // ... and every other property still matters.
    for (const k of ['accepted', 'p1ByteIdentity', 'p2NextvalBlocked', 'p3ReadsTruthful',
                     'p4DeathReleases', 'p5HeldThroughCommit'] as const) {
      expect(candidateQualifies(score({ [k]: false })), k).toBe(false)
    }
  })

  it('rejects a server-incompatible candidate however it scores', () => {
    expect(selectSequenceFence({ S1: score({ accepted: false }), S3: score() })).toBe('S3')
  })

  it('never selects a candidate that fails acquisition safety', () => {
    // The measured shape: S2 accepted and post-acquisition-clean, but unsafe.
    const chosen = selectSequenceFence({
      S1: score({ accepted: false }),
      S2: score({ p6AcquisitionSafe: false }),
      S3: score(),
      S4: score({ accepted: false }),
    })
    expect(chosen).toBe('S3')
    expect(chosen).toBe(SELECTED_SEQUENCE_FENCE)
  })

  it('prefers the mechanism that does not restate position, even if both are safe', () => {
    // This is the rule that replaced "first accepted candidate".
    expect(selectSequenceFence({ S2: score(), S3: score() })).toBe('S3')
    expect(RESTATES_POSITION.S2).toBe(true)
    expect(RESTATES_POSITION.S3).toBe(false)
  })

  it('returns null when nothing qualifies, so a residual-risk STOP is reachable', () => {
    expect(selectSequenceFence({})).toBeNull()
    expect(selectSequenceFence({
      S2: score({ p6AcquisitionSafe: false }),
      S3: score({ p6AcquisitionSafe: false }),
    })).toBeNull()
  })

  it('detects that an already-issued value would be handed out again', () => {
    const issued = 7n
    // What S2 leaves behind: position restated to the value just taken.
    const restated = state({ last_value: '7', is_called: false })
    expect(reflectsIssuedValue(restated, issued, 'q')).toBe(false)
    expect(() => assertNoReissue(restated, issued, 'q')).toThrow(/would hand it out again/)
    // What S3 leaves behind: the position the adversary advanced it to.
    const untouched = state({ last_value: '7', is_called: true })
    expect(reflectsIssuedValue(untouched, issued, 'q')).toBe(true)
    expect(() => assertNoReissue(untouched, issued, 'q')).not.toThrow()
    expect(effectiveNext(untouched, 'q') > issued).toBe(true)
  })

  it('handles a descending sequence without inverting the comparison', () => {
    const desc = state({ last_value: '-7', is_called: true, increment_by: '-1',
                         min_value: '-99', max_value: '-1' })
    expect(reflectsIssuedValue(desc, -7n, 'q')).toBe(true)
    expect(reflectsIssuedValue(state({ last_value: '-5', is_called: true, increment_by: '-1',
                                       min_value: '-99', max_value: '-1' }), -7n, 'q')).toBe(false)
  })
})

describe('pre-lock inputs are not fenced state', () => {
  const fakeSend = (pid: string) => async (sql: string) => {
    if (sql.startsWith('SELECT pg_catalog.pg_backend_pid')) return { rows: [[pid]], error: null }
    if (sql.includes('CROSS JOIN pg_catalog.pg_sequence')) {
      const s = state()
      return {
        rows: [[s.last_value, 'false', s.increment_by, s.min_value, s.max_value,
                s.start_value, s.cache_size, 'false', s.data_type, s.owned_by]],
        error: null,
      }
    }
    return { rows: [] as string[][], error: null }
  }

  it('hands back candidate INPUTS, wrapped, and no field called sequenceStates', async () => {
    const f = await acquireSourceFence({ send: fakeSend(SUP) })
    expect(Object.keys(f)).not.toContain('sequenceStates')
    expect(Object.keys(f)).toContain('candidateInputs')
    for (const q of FENCE_SEQUENCES) {
      expect(f.candidateInputs[q].__unfenced).toBe('read before the lock; never source-of-truth')
      // The state is BEHIND a field, not mixed into the object.
      expect(Object.keys(f.candidateInputs[q]).sort()).toEqual(['__unfenced', 'state'])
      expect(f.candidateInputs[q].state.last_value).toBe('1')
    }
  })

  it('will not read protected state until the proof has been taken', async () => {
    const f = await acquireSourceFence({ send: fakeSend(SUP) })
    // A prover that reports an EMPTY lock table: nothing is held.
    await expect(readFencedSequenceState(
      { send: fakeSend(SUP) },
      { send: async (sql: string) => (sql.startsWith('SELECT pg_catalog.pg_backend_pid')
          ? { rows: [[PROVER]], error: null }
          : { rows: [] as string[][], error: null }) },
      f,
    )).rejects.toThrow(/does not hold the reviewed advisory lock/)
  })

  it('takes the proof BEFORE the read, on the other backend', () => {
    const fn = SRC.slice(SRC.indexOf('export async function readFencedSequenceState'))
    expect(fn.indexOf('assertFenceProof')).toBeGreaterThan(-1)
    expect(fn.indexOf('assertFenceProof')).toBeLessThan(fn.indexOf('SEQUENCE_STATE_SQL'))
    expect(fn).toContain('prover.send')
  })
})

// ---------------------------------------------------------------------------
// COMPILE-TIME barriers.
//
// These are checked by `tsc --noEmit` - the package's own typecheck - not at
// runtime. A `@ts-expect-error` line fails compilation when the error it expects
// STOPS happening, so if the wrapper or the unique-symbol brand is weakened back
// into an intersection, the build breaks here. A source-string assertion could
// not do that: the previous revision's barrier was asserted by grepping for the
// word "brand" while the assignment it was supposed to forbid compiled fine.
// ---------------------------------------------------------------------------

/** Stands in for a later manifest/copier API: it accepts ONLY proved state. */
declare function manifestConsumer(s: FencedSequenceState): void

/** The module's PUBLIC surface, as TypeScript sees it from outside. */
type SourceFenceModule = typeof import('../src/pg-copy/source-fence.js')

function typeBarriers(): void {
  // The brand key is module-private, so it is not part of the public type at
  // all. If it were re-exported, this index would resolve and the directive
  // below would become an unused-directive error - which is the point: a
  // consumer that can NAME the key can forge the branded type.
  // @ts-expect-error FENCED_SEQUENCE_STATE must not be exported
  type BrandKey = SourceFenceModule['FENCED_SEQUENCE_STATE']
  const brandProbe = undefined as unknown as BrandKey
  void brandProbe

  const unfenced = {} as UnfencedSequenceInput
  const plain = {} as SequenceState
  const fenced = {} as FencedSequenceState

  // @ts-expect-error candidate input must NOT be usable as a SequenceState
  const a: SequenceState = unfenced
  void a

  // @ts-expect-error candidate input must NOT be usable as fenced state
  const b: FencedSequenceState = unfenced
  void b

  // @ts-expect-error unwrapping does not launder it into fenced state
  const c: FencedSequenceState = unfenced.state
  void c

  // @ts-expect-error an ordinary state is not proved state
  const d: FencedSequenceState = plain
  void d

  // @ts-expect-error and the consumer refuses each of them in argument position
  manifestConsumer(plain)
  // @ts-expect-error
  manifestConsumer(unfenced.state)

  // POSITIVE direction: fenced state IS an ordinary state, and the unwrapped
  // candidate input IS one too - the wrapper restricts the object, not the
  // field, which is what makes `.state` the visible, deliberate step.
  const e: SequenceState = fenced
  void e
  const f: SequenceState = unfenced.state
  void f
  manifestConsumer(fenced)
}
void typeBarriers

/** Only the proof-gated reader can produce what the consumer requires. */
async function readerOutputFeedsConsumer(): Promise<void> {
  const produced = await readFencedSequenceState(
    { send: async () => ({ rows: [], error: null }) },
    { send: async () => ({ rows: [], error: null }) },
    {} as Parameters<typeof readFencedSequenceState>[2],
  )
  manifestConsumer(produced['portfolio.trade_log_id_seq'])
  const asPlain: Record<string, SequenceState> = produced
  void asPlain
}
void readerOutputFeedsConsumer

describe('the state type barrier is enforced by the compiler', () => {
  it('is a wrapper and a unique-symbol brand, not an intersection', () => {
    // Runtime shape only; the barrier itself is proved by the block above,
    // which the package typecheck compiles.
    expect(SRC).toContain('export interface UnfencedSequenceInput')
    expect(SRC).toContain('readonly state: SequenceState')
    expect(SRC).toContain('declare const FENCED_SEQUENCE_STATE: unique symbol')
    // Module-private: the key is never exported. The compile-time barrier in
    // `typeBarriers` is what actually enforces this; the string check only keeps
    // the two from drifting apart silently.
    expect(SRC).not.toContain('export declare const FENCED_SEQUENCE_STATE')
    expect(SRC).not.toContain("export type UnfencedSequenceInput = SequenceState &")
  })
})
