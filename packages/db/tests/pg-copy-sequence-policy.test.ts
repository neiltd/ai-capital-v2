// The target sequence policy, proved OFFLINE: the authority, the arithmetic, the
// statement, the ordering of validation against mutation, and the redaction.
// What a real server does with it is tests/pgcopy/sequence-policy.int.test.ts.

import { inspect } from 'node:util'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { COPY_SEQUENCES } from '../src/pg-copy/schema-contract.js'
import {
  FENCE_SEQUENCES, effectiveNext, type FencedSequenceState, type SequenceState,
} from '../src/pg-copy/source-fence.js'
import {
  POLICY_SAVEPOINT, POLICY_SEQUENCES, RELEASE_SQL, SAVEPOINT_SQL,
  SequencePolicyFailed, SequencePolicyRefused, applySequencePolicy, restartSql,
} from '../src/pg-copy/sequence-policy.js'

const SRC = readFileSync(
  fileURLToPath(new URL('../src/pg-copy/sequence-policy.ts', import.meta.url)), 'utf-8')
/** SRC with whole-line comments removed: the bans are on code, not commentary. */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n')

const Q0 = 'briefing.qa_id_seq'
const Q1 = 'capital.fetch_log_id_seq'
const Q2 = 'portfolio.trade_log_id_seq'

const OWNER: Readonly<Record<string, string>> = {
  [Q0]: 'briefing.qa.id',
  [Q1]: 'capital.fetch_log.id',
  [Q2]: 'portfolio.trade_log.id',
}

/**
 * A fenced state, for OFFLINE use only.
 *
 * The brand is asserted here because no disposable server is running; the
 * integration suite obtains a genuine one through the fence and never
 * counterfeits it.
 */
const fenced = (q: string, over: Partial<SequenceState> = {}): FencedSequenceState => ({
  last_value: '1', is_called: false, increment_by: '1',
  min_value: '1', max_value: '9223372036854775807', start_value: '1',
  cache_size: '1', cycle: false, data_type: 'bigint', owned_by: OWNER[q],
  ...over,
} as FencedSequenceState)

const allFenced = (
  over: Partial<Record<string, Partial<SequenceState>>> = {},
): Record<string, FencedSequenceState> => Object.fromEntries(
  POLICY_SEQUENCES.map(q => [q, fenced(q, over[q] ?? {})]))

/** A target that answers state reads from a table and records every statement. */
function fakeTarget(opts: {
  state?: Record<string, Partial<SequenceState>>
  failOn?: (sql: string) => boolean
  noTransaction?: boolean
} = {}): { exec: { rows: (sql: string) => Promise<string[][]> }; sent: string[] } {
  const sent: string[] = []
  const row = (q: string): string[][] => {
    const s = { ...fenced(q), ...(opts.state?.[q] ?? {}) }
    return [[s.last_value, String(s.is_called), s.increment_by, s.min_value, s.max_value,
             s.start_value, s.cache_size, String(s.cycle), s.data_type, s.owned_by]]
  }
  const applied = new Map<string, string>()
  return {
    sent,
    exec: {
      rows: async (sql: string) => {
        sent.push(sql)
        if (sql === SAVEPOINT_SQL && opts.noTransaction === true) {
          throw new Error('SAVEPOINT can only be used in transaction blocks')
        }
        if (opts.failOn?.(sql) === true) throw new Error('driver exploded with row (1, secret)')
        const alter = /^ALTER SEQUENCE (\S+) RESTART WITH (\d+)$/.exec(sql)
        if (alter !== null) { applied.set(alter[1], alter[2]); return [] }
        const read = /CROSS JOIN pg_catalog\.pg_sequence o[\s\S]*?seqrelid = '([^']+)'/.exec(sql)
        if (read !== null) {
          const q = read[1]
          const done = applied.get(q)
          return done === undefined ? row(q) : [[done, 'false', '1', '1',
            '9223372036854775807', '1', '1', 'false', 'bigint', OWNER[q]]]
        }
        return []
      },
    },
  }
}

const surfaces = (e: unknown): string => {
  const err = e as Error & Record<string, unknown>
  let json = ''
  try { json = JSON.stringify(err, Object.getOwnPropertyNames(err)) } catch { json = '' }
  return [String(err.message), String(err.stack ?? ''),
          Object.getOwnPropertyNames(err).join(','), json,
          inspect(err, { depth: 6 })].join('\n')
}

describe('the reviewed three, in a deterministic order', () => {
  it('is exactly the copy set, ascending', () => {
    expect([...POLICY_SEQUENCES]).toEqual([...COPY_SEQUENCES].sort())
    expect([...POLICY_SEQUENCES]).toEqual([Q0, Q1, Q2])
    expect([...POLICY_SEQUENCES]).toEqual([...FENCE_SEQUENCES])
    expect(POLICY_SEQUENCES.length).toBe(3)
  })

  it('applies them in that order, every time', async () => {
    const t = fakeTarget()
    await applySequencePolicy(t.exec, allFenced())
    const altered = t.sent.filter(s => s.startsWith('ALTER SEQUENCE'))
      .map(s => s.split(' ')[2])
    expect(altered).toEqual([Q0, Q1, Q2])
  })
})

describe('the value the target will issue next', () => {
  it('is last_value when the source has never been called', () => {
    expect(effectiveNext(fenced(Q0, { last_value: '7', is_called: false }), Q0)).toBe(7n)
  })

  it('is last_value + increment_by when it has', () => {
    expect(effectiveNext(fenced(Q0, { last_value: '7', is_called: true }), Q0)).toBe(8n)
    expect(effectiveNext(
      fenced(Q0, { last_value: '7', is_called: true, increment_by: '5' }), Q0)).toBe(12n)
  })

  it('stays a decimal string beyond 2^53, never a Number', async () => {
    const big = '9007199254740993'   // 2^53 + 1: not representable as a double
    const t = fakeTarget()
    const r = await applySequencePolicy(
      t.exec, allFenced({ [Q0]: { last_value: big, is_called: false } }))
    expect(r.effectiveNext[0]).toBe(big)
    expect(t.sent).toContain(`ALTER SEQUENCE ${Q0} RESTART WITH ${big}`)
    expect(Number(big).toString()).not.toBe(big)      // the coercion really is lossy
    for (const v of r.effectiveNext) expect(typeof v).toBe('string')
    // No Number()/parseInt anywhere in the executable module.
    expect(CODE).not.toMatch(/\bNumber\s*\(/)
    expect(CODE).not.toMatch(/parseInt|parseFloat|\+\+/)
  })
})

describe('the only statement that mutates', () => {
  it('is ALTER SEQUENCE ... RESTART WITH', () => {
    expect(restartSql(Q0, 42n)).toBe(`ALTER SEQUENCE ${Q0} RESTART WITH 42`)
    expect(() => restartSql('desk.probe', 1n)).toThrow(SequencePolicyRefused)
  })

  it('never uses setval or any lifecycle statement', () => {
    for (const banned of ['setval', 'nextval', 'currval', 'pg_sequence_last_value',
                          "'BEGIN'", "'COMMIT'", "'ROLLBACK'", 'ALTER SYSTEM']) {
      expect(CODE, banned).not.toContain(banned)
    }
    expect(CODE).not.toMatch(/\bCOMMIT\b/)
  })

  it('opens no connection', () => {
    expect(CODE).not.toMatch(/new\s+(pg\.)?(Client|Pool)|createClient|createPool|connectionString/)
    expect(SRC).not.toMatch(/^import .* from 'pg'/m)
  })

  it('proves an outer transaction with SAVEPOINT, and releases only at the end', async () => {
    const t = fakeTarget()
    await applySequencePolicy(t.exec, allFenced())
    expect(t.sent[0]).toBe(SAVEPOINT_SQL)
    expect(t.sent[t.sent.length - 1]).toBe(RELEASE_SQL)
    expect(SAVEPOINT_SQL).toBe(`SAVEPOINT ${POLICY_SAVEPOINT}`)
  })

  it('refuses, altering nothing, when no transaction is open', async () => {
    const t = fakeTarget({ noTransaction: true })
    await expect(applySequencePolicy(t.exec, allFenced()))
      .rejects.toThrow(/no outer transaction is open/)
    expect(t.sent.filter(s => s.startsWith('ALTER SEQUENCE'))).toEqual([])
  })
})

describe('validation finishes before the first ALTER', () => {
  it('reads all three target states first', async () => {
    const t = fakeTarget()
    await applySequencePolicy(t.exec, allFenced())
    const firstAlter = t.sent.findIndex(s => s.startsWith('ALTER SEQUENCE'))
    const readsBefore = t.sent.slice(0, firstAlter).filter(s => s.includes('pg_sequence o')).length
    expect(readsBefore).toBe(3)
  })

  it('refuses a non-pristine THIRD sequence without altering the first two', async () => {
    for (const [label, bad] of [
      ['already called', { is_called: true }],
      ['moved off start', { last_value: '9' }],
      ['config drift', { increment_by: '3' }],
      ['ownership drift', { owned_by: 'portfolio.trade_log.other' }],
      ['cycle drift', { cycle: true }],
    ] as Array<[string, Partial<SequenceState>]>) {
      const t = fakeTarget({ state: { [Q2]: bad } })
      await expect(applySequencePolicy(t.exec, allFenced()), label)
        .rejects.toThrow(SequencePolicyRefused)
      expect(t.sent.filter(s => s.startsWith('ALTER SEQUENCE')), label).toEqual([])
    }
  })

  it('refuses a missing, extra or malformed source set before touching the target', async () => {
    const t = fakeTarget()
    const full = allFenced()
    const { [Q2]: _omit, ...missing } = full
    void _omit
    await expect(applySequencePolicy(t.exec, missing))
      .rejects.toThrow(/the reviewed sequence set does not match/)
    await expect(applySequencePolicy(t.exec, { ...full, 'desk.probe_seq': fenced(Q0) }))
      .rejects.toThrow(/the reviewed sequence set does not match/)
    await expect(applySequencePolicy(
      t.exec, allFenced({ [Q0]: { last_value: '99', is_called: true, max_value: '99' } })))
      .rejects.toThrow(/not usable arithmetic/)
    expect(t.sent).toEqual([])
  })

  it('refuses when the post-ALTER state would not issue the fenced value', async () => {
    const t = fakeTarget({ failOn: () => false })
    // A target that ignores the ALTER: the verify step must catch it.
    const ignoring = {
      rows: async (sql: string) => {
        if (sql.startsWith('ALTER SEQUENCE')) return []
        return await t.exec.rows(sql.startsWith('ALTER SEQUENCE') ? 'x' : sql)
      },
    }
    await expect(applySequencePolicy(
      ignoring, allFenced({ [Q0]: { last_value: '5', is_called: false } })))
      .rejects.toThrow(/would not issue the value/)
  })
})

describe('failures say nothing the driver said', () => {
  it('redacts a raw executor failure across every surface', async () => {
    for (const phase of ['target-read', 'apply', 'verify', 'release'] as const) {
      const match: Record<string, (s: string) => boolean> = {
        'target-read': s => s.includes('pg_sequence o'),
        apply: s => s.startsWith('ALTER SEQUENCE'),
        verify: s => s.includes('pg_sequence o'),
        release: s => s === RELEASE_SQL,
      }
      const t = fakeTarget({ failOn: match[phase] })
      let thrown: unknown = null
      try { await applySequencePolicy(t.exec, allFenced()) } catch (e) { thrown = e }
      expect(thrown, phase).toBeInstanceOf(SequencePolicyFailed)
      const seen = surfaces(thrown)
      expect(seen, phase).not.toContain('driver exploded')
      expect(seen, phase).not.toContain('secret')
      expect(seen, phase).not.toContain('ALTER SEQUENCE')
      expect(seen, phase).not.toContain('postgresql://')
      expect((thrown as SequencePolicyFailed & { cause?: unknown }).cause).toBeUndefined()
      expect(seen).toContain('roll it back and do not continue')
    }
  })

  it('never rethrows or attaches the original', () => {
    // A bare re-throw is forbidden. Re-raising an error THIS module already
    // bounded is not - and is how the read-and-parse guards avoid double-wrapping
    // a SequencePolicyFailed the inner call just produced. So every `throw e`
    // must carry the instanceof guard.
    const rethrows = CODE.match(/throw e\b[^\n]*/g) ?? []
    for (const r of rethrows) {
      expect(r, r).toMatch(/^throw e instanceof SequencePolicyFailed \? e : new SequencePolicyFailed\(/)
    }
    expect(CODE).not.toMatch(/catch \(e[^)]*\)\s*\{\s*throw e\s*[\n}]/)
    // Precise: a bare 'cause' also matches the word 'because' in this module's
    // own explanatory string, and proves nothing.
    expect(CODE).not.toMatch(/\bcause\s*[:=]/)
    expect(CODE).not.toMatch(/\.cause\b/)
    expect(CODE).toContain('throw new SequencePolicyFailed(phase, qname)')
  })

  it('carries only a phase and an optional reviewed qname', () => {
    const f = new SequencePolicyFailed('apply', Q1)
    expect(Object.keys(f).sort()).toEqual(['name', 'phase', 'qname'])
    expect(f.phase).toBe('apply')
    expect(f.qname).toBe(Q1)
    const r = new SequencePolicyRefused('preflight', null, 'not a reviewed sequence')
    expect(Object.keys(r).sort()).toEqual(['name', 'phase', 'qname', 'reason'])
    expect(r.message).toContain('roll it back and do not continue')
  })
})

describe('no error surface reflects anything it was given', () => {
  const canary = (): string =>
    `postgresql://u:pw_${Math.random().toString(36).slice(2)}@h/db`

  it('never names an unexpected source key', async () => {
    const c = canary()
    const t = fakeTarget()
    let thrown: unknown = null
    try {
      await applySequencePolicy(t.exec, { ...allFenced(), [c]: fenced(Q0) })
    } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(SequencePolicyRefused)
    expect(surfaces(thrown)).not.toContain(c)
    expect(surfaces(thrown)).not.toContain('pw_')
    expect(t.sent).toEqual([])
  })

  it('never reflects a malformed SOURCE value', async () => {
    for (const [label, bad] of [
      ['last_value', { last_value: `${canary()}` }],
      ['increment_by', { increment_by: `${canary()}` }],
      ['min_value', { min_value: `${canary()}`, is_called: true }],
      ['max_value', { max_value: `${canary()}`, is_called: true }],
    ] as Array<[string, Partial<SequenceState>]>) {
      const t = fakeTarget()
      let thrown: unknown = null
      try { await applySequencePolicy(t.exec, allFenced({ [Q1]: bad })) } catch (e) { thrown = e }
      expect(thrown, label).toBeInstanceOf(SequencePolicyRefused)
      expect((thrown as SequencePolicyRefused).phase, label).toBe('source-state')
      expect((thrown as SequencePolicyRefused).qname, label).toBe(Q1)
      const seen = surfaces(thrown)
      expect(seen, label).not.toContain('postgresql://')
      expect(seen, label).not.toContain('pw_')
      expect(seen, label).not.toContain('SyntaxError')
      expect(t.sent, label).toEqual([])
    }
  })

  it('never reflects a malformed TARGET state during preflight', async () => {
    for (const [label, bad] of [
      ['is_called', { is_called: canary() as unknown as boolean }],
      ['numeric', { last_value: canary() }],
    ] as Array<[string, Partial<SequenceState>]>) {
      const t = fakeTarget({ state: { [Q1]: bad } })
      let thrown: unknown = null
      try { await applySequencePolicy(t.exec, allFenced()) } catch (e) { thrown = e }
      const seen = surfaces(thrown)
      expect(seen, label).not.toContain('postgresql://')
      expect(seen, label).not.toContain('pw_')
      expect(t.sent.filter(x => x.startsWith('ALTER SEQUENCE')), label).toEqual([])
    }
  })

  it('never reflects a malformed TARGET state during verification', async () => {
    const c = canary()
    // Pristine at preflight, malformed only once re-read after the ALTERs.
    let alters = 0
    const t = fakeTarget()
    const drifting = {
      rows: async (sql: string) => {
        if (sql.startsWith('ALTER SEQUENCE')) { alters += 1; return await t.exec.rows(sql) }
        if (alters === 3 && sql.includes('pg_sequence o')) {
          return [[c, c, c, c, c, c, c, c, c, c]]
        }
        return await t.exec.rows(sql)
      },
    }
    let thrown: unknown = null
    try { await applySequencePolicy(drifting, allFenced()) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(SequencePolicyFailed)
    expect((thrown as SequencePolicyFailed).phase).toBe('verify')
    const seen = surfaces(thrown)
    expect(seen).not.toContain('postgresql://')
    expect(seen).not.toContain('pw_')
  })

  it('never reflects an unreviewed qname handed to restartSql', () => {
    const c = canary()
    let thrown: unknown = null
    try { restartSql(c, 1n) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(SequencePolicyRefused)
    expect((thrown as SequencePolicyRefused).qname).toBeNull()
    expect(surfaces(thrown)).not.toContain(c)
    expect(surfaces(thrown)).not.toContain('pw_')
  })

  it('always tells the caller to roll back and stop', () => {
    for (const e of [
      new SequencePolicyRefused('preflight', Q0, 'not a reviewed sequence'),
      new SequencePolicyFailed('apply', Q1),
    ]) {
      expect(e.message).toMatch(/roll it back and do not continue/)
    }
  })
})

describe('the integration scope holds the fence through target use', () => {
  const INT = readFileSync(
    fileURLToPath(new URL('./pgcopy/sequence-policy.int.test.ts', import.meta.url)), 'utf-8')
  const scope = INT.slice(INT.indexOf('async function withHeldFence'),
                          INT.indexOf('const stateOn ='))

  it('reads state, runs the body, then RE-PROVES before releasing', () => {
    // Structural, because a removed assertion cannot fail a suite: the only way
    // to notice the re-proof going missing is to require it to be there.
    const iRead = scope.indexOf('readFencedSequenceState')
    const iBody = scope.indexOf('await body(state)')
    const iReproof = scope.indexOf('assertFenceProof', scope.indexOf('await body(state)'))
    const iRollback = scope.indexOf("sup.send('ROLLBACK')")
    expect(iRead).toBeGreaterThan(-1)
    expect(iBody).toBeGreaterThan(iRead)
    expect(iReproof, 'the fence is never re-proved after the body').toBeGreaterThan(iBody)
    expect(iRollback, 'the supervisor is released before the re-proof')
      .toBeGreaterThan(iReproof)
    // The same supervisor backend, checked explicitly.
    expect(scope).toContain('the supervisor backend changed under us')
  })

  it('never hands branded state back after its fence has ended', () => {
    // A getter that returned FencedSequenceState would let the caller use it
    // after the fence was released; the scope shape makes that unexpressible.
    expect(INT).not.toContain('Promise<Record<string, FencedSequenceState>>')
    expect(scope).toContain('body: (state: Record<string, FencedSequenceState>) => Promise<void>')
  })
})

describe('only fenced state is accepted', () => {
  it('rejects ordinary and unfenced state at compile time', () => {
    // These are the barriers; they are proved by the @ts-expect-error directives
    // below, which fail compilation if the assignment ever becomes legal.
    expect(SRC).toContain('type FencedSequenceState')
    expect(SRC).toContain('Readonly<Record<string, FencedSequenceState>>')
  })
})

// COMPILE-TIME: an ordinary or unfenced state must not reach the public API.
async function typeBarriers(): Promise<void> {
  const plain = {} as SequenceState
  const unfenced = {} as import('../src/pg-copy/source-fence.js').UnfencedSequenceInput
  const exec = {} as { rows: (sql: string) => Promise<string[][]> }
  // @ts-expect-error an ordinary SequenceState is not fenced state
  await applySequencePolicy(exec, { [Q0]: plain, [Q1]: plain, [Q2]: plain })
  // @ts-expect-error a candidate input is not fenced state
  await applySequencePolicy(exec, { [Q0]: unfenced, [Q1]: unfenced, [Q2]: unfenced })
  // @ts-expect-error nor is its inner state
  await applySequencePolicy(exec, { [Q0]: unfenced.state, [Q1]: unfenced.state, [Q2]: unfenced.state })
}
void typeBarriers
