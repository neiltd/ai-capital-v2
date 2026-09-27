// THE POST-COMMIT DISPOSITION, AND WHY IT CANNOT BE ASSERTED.
//
// A copy whose COMMIT went unanswered leaves exactly one honest question: is
// the target committed, pristine, or neither? What this file proves is that the
// answer is reachable only through an object this module minted, that the
// refusal is by IDENTITY rather than by a readable mark, and that the one case
// where both answers fit is reported as neither.

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  CommitDispositionRefused, classifyTargetDisposition, decideDisposition,
  isCommitUnknownHandoff, mintCommitUnknownHandoff,
} from '../src/pg-copy/commit-disposition.js'
import { sha256Hex } from '../src/pg-copy/schema-contract.js'

const hex = (s: string): string => sha256Hex(`disposition-fixture|${s}`)

const HANDOFF = (): Parameters<typeof mintCommitUnknownHandoff>[0] => ({
  sourceContract: { digest: hex('source-contract') } as never,
  sourceContractDigest: hex('source-contract'),
  targetContractDigest: hex('target-contract'),
  rootDigest: hex('root'),
  tables: [{ qname: 'portfolio.trade_log', rows: '10', digest: hex('t') } as never],
  sequences: [{ qname: 'portfolio.trade_log_id_seq', effectiveNext: '11' }],
  target: { systemIdentifier: '7689229024919775999', database: 'ai_capital_v3',
            role: 'ai_capital_migrator' },
  bundleName: 'source-manifest-20260925T091500Z-a1b2c3d4',
  verifierHandoff: {
    bundleName: 'source-manifest-20260925T091500Z-a1b2c3d4',
    rootDigest: hex('root'),
    sourceContractDigest: hex('source-contract'),
    targetContractDigest: hex('target-contract'),
    sourceRecognition: 'v10', targetRecognition: 'v19',
    tables: [], sequences: [], compatibility: {},
    source: { systemIdentifier: '1', database: 'ai_capital', role: 'r' },
    target: { systemIdentifier: '7689229024919775999', database: 'ai_capital_v3',
              role: 'ai_capital_migrator' },
    fence: { supervisorPid: '41512', backendStart: '2026-09-25 09:14:00+00',
             mechanism: 'S3' },
  } as never,
})

describe('a commit handoff is non-forgeable', () => {
  it('accepts only an object this module minted', () => {
    const real = mintCommitUnknownHandoff(HANDOFF())
    expect(isCommitUnknownHandoff(real)).toBe(true)
    expect(isCommitUnknownHandoff({ ...real })).toBe(false)
    expect(isCommitUnknownHandoff(HANDOFF())).toBe(false)
    expect(isCommitUnknownHandoff(null)).toBe(false)
    expect(isCommitUnknownHandoff('handoff')).toBe(false)
  })

  it('carries no mark a caller could read off it and copy', () => {
    // M18. A brand on a property - even a non-enumerable symbol - is visible to
    // `Reflect.ownKeys` and therefore copyable onto an object of somebody's
    // own. Membership of a module-private WeakSet is not readable at all.
    const real = mintCommitUnknownHandoff(HANDOFF())
    const forged: Record<string | symbol, unknown> = {}
    for (const k of Reflect.ownKeys(real)) {
      forged[k] = (real as unknown as Record<string | symbol, unknown>)[k]
    }
    const copied = Object.create(Object.getPrototypeOf(real) as object) as object
    Object.assign(copied, forged)
    expect(isCommitUnknownHandoff(forged)).toBe(false)
    expect(isCommitUnknownHandoff(copied)).toBe(false)
  })

  it('refuses to classify anything else, before a session is opened', async () => {
    let opened = 0
    await expect(classifyTargetDisposition({
      handoff: { ...mintCommitUnknownHandoff(HANDOFF()) } as never,
      openSource: async () => { opened += 1; throw new Error('unreachable') },
      openTarget: async () => { opened += 1; throw new Error('unreachable') },
    } as never)).rejects.toThrow(CommitDispositionRefused)
    expect(opened).toBe(0)
  })
})

describe('the four ways a target can look, and the three things that may be said', () => {
  it('reports INDETERMINATE when both answers fit', () => {
    // M19. A source with no rows leaves a target that is simultaneously an
    // exact copy and an untouched one. Calling that COMMITTED_EXACT would
    // assert that the COMMIT landed, when the identical picture is exactly
    // what a LOST commit leaves behind.
    const both = decideDisposition(true, true)
    expect(both.disposition).toBe('INDETERMINATE')
    expect(both.cause).toContain('indistinguishable')
  })

  it('reports each unambiguous case as itself', () => {
    expect(decideDisposition(true, false).disposition).toBe('COMMITTED_EXACT')
    expect(decideDisposition(false, true).disposition).toBe('NOT_COMMITTED_PRISTINE')
    expect(decideDisposition(false, false).disposition).toBe('INDETERMINATE')
    expect(decideDisposition(false, false).cause).toContain('neither an exact copy nor pristine')
  })

  it('never says COMMITTED without an exact match, in any combination', () => {
    for (const matched of [true, false]) {
      for (const pristine of [true, false]) {
        const d = decideDisposition(matched, pristine)
        if (d.disposition === 'COMMITTED_EXACT') {
          expect(matched && !pristine).toBe(true)
        }
        if (d.disposition === 'NOT_COMMITTED_PRISTINE') {
          expect(pristine && !matched).toBe(true)
        }
      }
    }
  })
})

describe('the live target is the one the copy was aimed at', () => {
  /** A read-only session that answers the reviewed statements from a table. */
  const session = (rows: Record<string, string[][]>): never => ({
    pid: '9999',
    rows: async (sql: string) => {
      for (const [needle, out] of Object.entries(rows)) {
        if (sql.includes(needle)) return out
      }
      return []
    },
    close: async () => undefined,
  } as never)

  const IDENTITY = (over: Partial<Record<number, string>> = {}): string[][] => [[
    over[0] ?? '9999',
    over[1] ?? '7689229024919775999',
    over[2] ?? '170000',
    over[3] ?? 'ai_capital_v3',
    over[4] ?? '5433',
    over[5] ?? 'ai_capital_migrator',
    over[6] ?? 'ai_capital_migrator',
    over[7] ?? '',
    over[8] ?? 'true',
  ]]

  it('refuses a different cluster, database or effective role', async () => {
    // K1.1-K44. Two databases restored from the same schema have the SAME
    // contract digest - a reviewed target and its staging twin are exactly
    // that pair. Without the identity triple this would classify the twin and
    // report that the copy did or did not land, about the wrong database, with
    // the same confidence as the right one.
    // EACH MISMATCH NAMES ITSELF. Asserting only INDETERMINATE would pass with
    // the identity check removed entirely: the contract extraction that follows
    // fails against these stub sessions anyway, and every failure here is
    // INDETERMINATE. The CAUSE is what distinguishes "this is the wrong
    // database" from "this database could not be read".
    const cases: Array<[string, string[][], RegExp]> = [
      ['cluster', IDENTITY({ 1: '1111111111111111111' }),
       /not the cluster the copy was aimed at/],
      ['database', IDENTITY({ 3: 'ai_capital_staging' }),
       /not the database the copy was aimed at/],
      ['role', IDENTITY({ 5: 'someone_else' }),
       /not in the role the copy wrote as/],
      ['short row', [['9999', '7689229024919775999']],
       /identity could not be measured/],
    ]
    for (const [label, identity, cause] of cases) {
      const r = await classifyTargetDisposition({
        handoff: mintCommitUnknownHandoff(HANDOFF()),
        openSource: async () => session({ 'pg_catalog.pg_backend_pid': [['9999']] }),
        openTarget: async () => session({ 'pg_control_system': identity }),
      } as never)
      // EVERY UNAVAILABLE OR MISMATCHED PROOF IS INDETERMINATE.
      expect(r.disposition, label).toBe('INDETERMINATE')
      expect(r.cause, label).toMatch(cause)
    }
  })

  it('measures the identity BEFORE it measures any content', () => {
    const src = readFileSync(
      new URL('../src/pg-copy/commit-disposition.ts', import.meta.url), 'utf-8')
    const fn = src.slice(src.indexOf('export async function classifyTargetDisposition'))
    expect(fn.indexOf('TARGET_IDENTITY_SQL'))
      .toBeLessThan(fn.indexOf('extractContractFromSession(\n        target'))
  })
})

describe('the handoff is immutable all the way down', () => {
  it('freezes every nested value, not just the outer object', () => {
    // K1.1-K45. The handoff is the only description of what the copy was about
    // to commit, and it is consulted AFTER the doubt exists - which is exactly
    // when somebody has a motive to adjust one table's expected digest so the
    // target matches. A frozen outer object whose `tables[3]` is still mutable
    // protects nothing.
    const h = mintCommitUnknownHandoff(HANDOFF())
    expect(Object.isFrozen(h)).toBe(true)
    expect(Object.isFrozen(h.tables)).toBe(true)
    expect(Object.isFrozen(h.tables[0])).toBe(true)
    expect(Object.isFrozen(h.sequences)).toBe(true)
    expect(Object.isFrozen(h.sequences[0])).toBe(true)
    expect(Object.isFrozen(h.target)).toBe(true)
    expect(Object.isFrozen(h.verifierHandoff)).toBe(true)
    expect(Object.isFrozen(h.sourceContract)).toBe(true)

    // AND AN ATTEMPT TO CHANGE ONE IS A NO-OP RATHER THAN A QUIET SUCCESS.
    const table = h.tables[0] as unknown as Record<string, unknown>
    const before = table.digest
    try { table.digest = 'tampered' } catch { /* strict mode throws */ }
    expect(table.digest).toBe(before)
  })

  it('leaves the caller own object mutable', () => {
    // The caller keeps a mutable object; what is REGISTERED is the copy, so a
    // later change to the caller's version cannot reach the minted one.
    const input = HANDOFF() as unknown as Record<string, unknown>
    const minted = mintCommitUnknownHandoff(input as never)
    expect(Object.isFrozen(input)).toBe(false)
    expect(minted).not.toBe(input)
    expect(isCommitUnknownHandoff(input)).toBe(false)
  })
})
