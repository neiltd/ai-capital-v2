// STAGE 2 — the parts that need no server.
//
// The copy itself is proved against two live clusters; what is proved here is
// everything that is a property of the CODE: the confirmation binding, the
// target authority's refusals, the CLI's option surface and disposition, and -
// because two of the safety claims are claims about SHAPE - the shape itself.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  CONFIRMATION_PREFIX, ConfirmationRefused, assertConfirmationMatches, bindingDocument,
  confirmationToken, copySetDigest, type ConfirmationBinding,
} from '../src/pg-copy/confirmation.js'
import {
  CommitOutcomeUnknown, Stage2Refused,
} from '../src/pg-copy/stage2.js'
import {
  COPY_TABLES, REVIEWED_CONTRACT_DIGEST,
} from '../src/pg-copy/schema-contract.js'
import {
  TARGET_EMPTY_SQL, TARGET_IDENTITY_COLUMNS, TARGET_IDENTITY_SQL, TARGET_OWNER_ROLE,
  TargetRefused, proveTargetEmpty, proveTargetIdentity, type TargetSession,
} from '../src/pg-copy/target-authority.js'
import {
  EXIT_COMMIT_UNKNOWN, EXIT_FAILED, EXIT_OK, EXIT_REFUSED, OPTIONS, REQUIRED,
  dispositionOf, isDirectEntrypoint, parseArgs,
} from '../bin/pg-copy.js'
import { DriverSessionRefused } from '../src/pg-copy/driver-session.js'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const strip = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')

const STAGE2 = strip(readFileSync(join(PKG_ROOT, 'src', 'pg-copy', 'stage2.ts'), 'utf-8'))
const CLI = strip(readFileSync(join(PKG_ROOT, 'bin', 'pg-copy.ts'), 'utf-8'))

const surfaces = (e: unknown): string => {
  const err = e as Error & Record<string, unknown>
  let json = ''
  try { json = JSON.stringify(err, Object.getOwnPropertyNames(err)) } catch { json = '' }
  return [String(err.message), String(err.stack ?? ''),
          Object.getOwnPropertyNames(err).join(','), json,
          inspect(err, { depth: 8, showHidden: true })].join('\n')
}

const BINDING: ConfirmationBinding = Object.freeze({
  bundleName: 'source-manifest-20260924T101530Z-a1b2c3d4',
  digestFileDigest: 'a'.repeat(64),
  sourceDatabase: 'ai_capital',
  sourceSystemIdentifier: '7689229024919775042',
  sourceRole: 'ai_capital_v3_export',
  sourceContractDigest: REVIEWED_CONTRACT_DIGEST,
  contentRootDigest: 'b'.repeat(64),
  copySetDigest: copySetDigest(COPY_TABLES),
  provenanceHead: 'c'.repeat(40),
  ingestionGitlink: 'd'.repeat(40),
  expectedTargetContractDigest: REVIEWED_CONTRACT_DIGEST,
  targetDatabase: 'ai_capital_v3',
  targetSystemIdentifier: '7689229024919775999',
  targetPort: '5433',
  targetEndpoint: '/Users/x/ai-capital-v3-run',
  targetRole: 'ai_capital_migrator',
  implementationHead: 'e'.repeat(40),
})

describe('the confirmation binds this run and no other', () => {
  it('is deterministic and shaped', () => {
    const t = confirmationToken(BINDING)
    expect(t).toBe(confirmationToken({ ...BINDING }))
    expect(t).toMatch(/^PGCOPY-APPLY-[0-9a-f]{64}$/)
    expect(t.startsWith(CONFIRMATION_PREFIX)).toBe(true)
  })

  it('EVERY bound field changes it', () => {
    const base = confirmationToken(BINDING)
    const variants: Array<Partial<ConfirmationBinding>> = [
      { bundleName: 'source-manifest-20260924T101530Z-ffffffff' },
      { digestFileDigest: 'f'.repeat(64) },
      { sourceDatabase: 'ai_capital_other' },
      { sourceSystemIdentifier: '7689229024919775043' },
      { sourceRole: 'ai_capital_migrator' },
      { sourceContractDigest: '0'.repeat(64) },
      { contentRootDigest: '1'.repeat(64) },
      { copySetDigest: copySetDigest([...COPY_TABLES].reverse()) },
      { provenanceHead: '0'.repeat(40) },
      { ingestionGitlink: '1'.repeat(40) },
      { expectedTargetContractDigest: '2'.repeat(64) },
      { targetDatabase: 'somewhere_else' },
      { targetSystemIdentifier: '1' },
      { targetPort: '5432' },
      { targetEndpoint: '/tmp/other' },
      { targetRole: 'postgres' },
      { implementationHead: '3'.repeat(40) },
    ]
    const seen = new Set([base])
    for (const v of variants) {
      const t = confirmationToken({ ...BINDING, ...v })
      expect(t, JSON.stringify(v)).not.toBe(base)
      seen.add(t)
    }
    expect(seen.size).toBe(variants.length + 1)
  })

  it('a REORDERED copy set is a different copy set', () => {
    const swapped = [...COPY_TABLES]
    ;[swapped[0], swapped[1]] = [swapped[1], swapped[0]]
    expect(copySetDigest(swapped)).not.toBe(copySetDigest(COPY_TABLES))
    expect(copySetDigest([...COPY_TABLES].slice(0, 20)))
      .not.toBe(copySetDigest(COPY_TABLES))
  })

  it('accepts its own token and refuses anything else, without echoing it', () => {
    expect(() => assertConfirmationMatches(confirmationToken(BINDING), BINDING)).not.toThrow()
    const canary = `${CONFIRMATION_PREFIX}${'9'.repeat(64)}`
    let thrown: unknown = null
    try { assertConfirmationMatches(canary, BINDING) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(ConfirmationRefused)
    expect(surfaces(thrown)).not.toContain('9'.repeat(64))
    for (const bad of ['', 'nope', 'PGCOPY-APPLY-xyz', 'a'.repeat(64),
                       `${CONFIRMATION_PREFIX}${'A'.repeat(64)}`]) {
      expect(() => assertConfirmationMatches(bad, BINDING), bad).toThrow(ConfirmationRefused)
    }
  })

  it('refuses a binding field that is not in the reviewed form', () => {
    for (const v of [{ digestFileDigest: 'short' }, { sourceDatabase: 'Not_An_Ident' },
                     { targetPort: '0' }, { provenanceHead: 'nope' },
                     { sourceSystemIdentifier: '0' }, { bundleName: 'not-a-bundle' },
                     { targetEndpoint: 'x|y' }]) {
      expect(() => confirmationToken({ ...BINDING, ...v } as ConfirmationBinding),
             JSON.stringify(v)).toThrow(ConfirmationRefused)
    }
  })

  it('the document names every group, and carries no credential', () => {
    const doc = bindingDocument(BINDING) as unknown as Record<string, unknown>
    expect(Object.keys(doc).sort()).toEqual([
      'confirmation_version', 'content', 'evidence', 'expected_target',
      'implementation_head', 'provenance', 'source',
    ])
    const text = JSON.stringify(doc)
    expect(text).not.toMatch(/password|secret|postgresql:\/\//i)
  })
})

describe('the target authority', () => {
  const IDENTITY = ['4242', '7689229024919775999', '170010', 'ai_capital_v3', '5433',
                    'ai_capital_migrator', 'ai_capital_migrator', '', 'true']
  const EXPECT = {
    systemIdentifier: '7689229024919775999', database: 'ai_capital_v3',
    port: '5433', role: 'ai_capital_migrator', endpoint: '/tmp/s',
  }
  const session = (rows: string[][]): TargetSession =>
    ({ pid: '4242', rows: async () => rows })

  it('asks for all nine identity facts in ONE statement', () => {
    expect(TARGET_IDENTITY_COLUMNS).toBe(9)
    expect(TARGET_IDENTITY_SQL.trim().split(/;/).length).toBe(1)
    expect(TARGET_IDENTITY_SQL).toContain('pg_control_system()).system_identifier')
    expect(TARGET_IDENTITY_SQL).toContain('CURRENT_USER::pg_catalog.text')
    expect(TARGET_IDENTITY_SQL).toContain('SESSION_USER::pg_catalog.text')
    expect(TARGET_IDENTITY_SQL).not.toContain('pg_catalog.CURRENT_USER')
  })

  it('accepts the expected target and refuses every deviation', async () => {
    await expect(proveTargetIdentity(session([IDENTITY]), EXPECT)).resolves.toBeTruthy()
    const cases: Array<[number, string, RegExp]> = [
      [0, '9999', /not the backend it reported/],
      [1, '1', /not the expected target cluster/],
      [1, 'nope', /usable system identifier/],
      [3, 'other_db', /not the expected database/],
      [4, '5432', /not on the expected port/],
      [5, 'postgres', /not authenticated as the expected role/],
      [6, 'ai_capital_owner', /assumed a role it did not authenticate as/],
    ]
    for (const [i, v, re] of cases) {
      const row = [...IDENTITY]
      row[i] = v
      await expect(proveTargetIdentity(session([row]), EXPECT), `${i}=${v}`).rejects.toThrow(re)
    }
    await expect(proveTargetIdentity(session([]), EXPECT))
      .rejects.toThrow(/one row of identity facts/)
  })

  it('asks for all 21 counts in one statement and refuses a non-empty table', async () => {
    for (const q of COPY_TABLES) expect(TARGET_EMPTY_SQL).toContain(q)
    expect(TARGET_EMPTY_SQL.split('UNION ALL').length).toBe(21)

    const allZero = COPY_TABLES.map(q => [q, '0'])
    await expect(proveTargetEmpty(session(allZero))).resolves.toBeUndefined()

    // A DISTINCTIVE count: a single digit would appear in a stack-trace line
    // number and the assertion below would pass for the wrong reason.
    const one = COPY_TABLES.map(q => [q, q === 'graph.edges' ? '987654321' : '0'])
    let thrown: unknown = null
    try { await proveTargetEmpty(session(one)) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(TargetRefused)
    expect((thrown as TargetRefused).qname).toBe('graph.edges')
    // The COUNT is target content and is never reported.
    expect(surfaces(thrown)).not.toContain('987654321')
    await expect(proveTargetEmpty(session(allZero.slice(0, 20))))
      .rejects.toThrow(/one count for each reviewed table/)
  })

  it('runs the copy as the reviewed owner, for the transaction only', () => {
    expect(TARGET_OWNER_ROLE).toBe('ai_capital_owner')
    expect(STAGE2).toContain('SET_LOCAL_ROLE_SQL')
  })
})

describe('the COMMIT boundary is a property of the code, so the code is asserted', () => {
  const span = (): string => {
    const start = STAGE2.indexOf('began = false')
    const end = STAGE2.indexOf('} catch (e) {', start)
    expect(start).toBeGreaterThan(-1)
    return STAGE2.slice(start, end)
  }

  it('clears `began` BEFORE the commit is submitted', () => {
    const cleared = STAGE2.indexOf('began = false\n    commitSubmitted = true')
    expect(cleared).toBeGreaterThan(-1)
    // And the submission itself comes after, in that order.
    expect(span()).toContain('commitSubmitted = true')
    expect(span().indexOf('began = false'))
      .toBeLessThan(span().indexOf('TARGET_COMMIT_SQL'))
  })

  it('never rolls back once the commit has been submitted', () => {
    // The rollback is guarded by `began`, which the line above has cleared.
    expect(STAGE2).toContain('if (commitSubmitted) {')
    expect(STAGE2).toMatch(/if \(began\) \{\s*try \{ await target\.rows\(TARGET_ROLLBACK_SQL\)/)
    const unknownBranch = STAGE2.slice(
      STAGE2.indexOf('if (commitSubmitted) {'), STAGE2.indexOf('if (began) {'))
    expect(unknownBranch).not.toContain('TARGET_ROLLBACK_SQL')
  })

  it('inspects the command TAG rather than trusting the absence of a throw', () => {
    expect(STAGE2).toContain("outcome.tag !== 'COMMIT'")
    expect(STAGE2).toContain('CommitOutcomeUnknown')
  })

  it('copies the reviewed set itself, so the order and the count are not a local list', () => {
    expect(STAGE2).toContain('for (const qname of COPY_TABLES) {')
    expect(STAGE2).not.toMatch(/COPY_TABLES\.slice|COPY_TABLES\]\.sort|COPY_TABLES\.filter/)
  })

  it('opens the target only through the injected factory, after A5', () => {
    // SCOPED TO runApply. An earlier version of this test compared file-wide
    // offsets, and `runSourceStages(i, published)` also appears in runInspect -
    // which sits above runApply, so a target opened at the very top of runApply
    // still looked "later". A mutant that did exactly that survived it.
    const body = STAGE2.slice(STAGE2.indexOf('export async function runApply'))
    const a5 = body.indexOf('runSourceStages(i, published)')
    const open = body.indexOf('await i.openTarget()')
    expect(a5).toBeGreaterThan(-1)
    expect(open).toBeGreaterThan(-1)
    expect(open).toBeGreaterThan(a5)
    // The confirmation is checked before it too.
    expect(body.indexOf('assertConfirmationMatches')).toBeLessThan(open)
    // Exactly ONE target is ever opened.
    expect(body.match(/await i\.openTarget\(\)/g)?.length).toBe(1)
    // And inspect has no route to it at all.
    const inspectFn = STAGE2.slice(
      STAGE2.indexOf('export async function runInspect'),
      STAGE2.indexOf('export interface ApplyInput'))
    expect(inspectFn).not.toContain('openTarget')
  })
})

describe('the Stage-2 CLI', () => {
  const GOOD: readonly string[] = Object.freeze([
    '--bundle', '/tmp/ev/source-manifest-20260924T101530Z-a1b2c3d4',
    '--source-host', '/tmp/src', '--source-port', '5432',
    '--source-database', 'ai_capital', '--source-credential', '/tmp/s/export.url',
    '--supervisor-user', 'thanapold', '--supervisor-passfile', '/tmp/s/admin.pgpass',
    '--target-host', '/tmp/tgt', '--target-port', '5433',
    '--target-database', 'ai_capital_v3', '--target-credential', '/tmp/s/migrator.url',
    '--target-system-identifier', '7689229024919775999',
    '--source-system-identifier', '7689229024919775042',
    '--provenance-head', 'c'.repeat(40),
  ])

  it('is inert on import and guards its entry point', () => {
    expect(isDirectEntrypoint(undefined, import.meta.url)).toBe(false)
    expect(CLI).toContain('isDirectEntrypoint(process.argv[1], import.meta.url)')
  })

  it('exits 0, 1, 2 and 3', () => {
    expect([EXIT_OK, EXIT_FAILED, EXIT_REFUSED, EXIT_COMMIT_UNKNOWN]).toEqual([0, 1, 2, 3])
  })

  it('takes no password, url or secret option', () => {
    for (const o of OPTIONS) expect(o, o).not.toMatch(/password|secret|url|passwd/i)
    expect(OPTIONS.filter(o => /credential|passfile/.test(o)).sort())
      .toEqual(['--source-credential', '--supervisor-passfile', '--target-credential'])
    expect(CLI).not.toMatch(/process\.env/)
    expect(CLI).not.toMatch(/PGPASSWORD/)
  })

  it('requires --confirm with --apply, and refuses it without', () => {
    expect(() => parseArgs(GOOD)).not.toThrow()
    expect(() => parseArgs([...GOOD, '--apply'])).toThrow(/--apply requires --confirm/)
    expect(() => parseArgs([...GOOD, '--confirm', 'x'])).toThrow(/only meaningful with --apply/)
    expect(parseArgs([...GOOD, '--apply', '--confirm', 'tok']).apply).toBe(true)
  })

  it('refuses an unknown option, a repeat, a missing value and a relative path', () => {
    expect(() => parseArgs([...GOOD, '--target-url', 'postgresql://u:p@h/db']))
      .toThrow(/not a recognised option/)
    expect(() => parseArgs([...GOOD, '--bundle', '/tmp/x'])).toThrow(/was given twice/)
    expect(() => parseArgs(['--bundle'])).toThrow(/needs a value/)
    expect(() => parseArgs(GOOD.slice(0, 2))).toThrow(/is required/)
    const rel = [...GOOD]
    rel[rel.indexOf('--source-credential') + 1] = 'relative/path'
    expect(() => parseArgs(rel)).toThrow(/must be an absolute path/)
    for (const r of REQUIRED) expect(OPTIONS).toContain(r)
  })

  it('reports an unknown commit as unknown, and never as a refusal', () => {
    const d = dispositionOf(new CommitOutcomeUnknown('ai_capital_v3'))
    const text = d.lines.join('\n')
    expect(d.exitCode).toBe(EXIT_COMMIT_UNKNOWN)
    expect(text).toContain('COMMIT OUTCOME UNKNOWN')
    expect(text).toContain('was NOT rolled back')
    expect(text).toContain('Do not retry')
    expect(text).not.toContain('The target was NOT modified')
  })

  it('reports a refusal as a refusal, and an unexpected error by its class alone', () => {
    const r = dispositionOf(new Stage2Refused('A11-copy',
      'the copy of a reviewed table did not complete', 'graph.edges'))
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toContain('The target was NOT modified')

    const d = dispositionOf(new DriverSessionRefused('the session refused a statement'))
    expect(d.exitCode).toBe(EXIT_REFUSED)

    const u = dispositionOf(new Error(
      'ERROR: relation vault.secrets; postgresql://u:pw_S2CANARY@h/db; /Users/x/secret'))
    expect(u.exitCode).toBe(EXIT_FAILED)
    const text = u.lines.join('\n')
    expect(text).toContain('stage 2 failed (Error).')
    for (const c of ['pw_S2CANARY', 'postgresql://', 'vault.secrets', '/Users/x/secret']) {
      expect(text, c).not.toContain(c)
    }
  })

  it('releases the sessions in the reviewed order, supervisor last', () => {
    const fin = CLI.slice(CLI.indexOf('} finally {', CLI.indexOf('export async function runCli')))
    expect(fin.indexOf('source.end()')).toBeLessThan(fin.indexOf('prover.close()'))
    expect(fin.indexOf('prover.close()')).toBeLessThan(fin.indexOf('supervisor.close()'))
  })
})
