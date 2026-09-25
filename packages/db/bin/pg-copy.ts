#!/usr/bin/env node
// STAGE 2 — inspect a published manifest, then copy it into an empty target.
//
// INERT ON IMPORT. Nothing runs, reads an environment variable, spawns a
// process or opens a session until `isDirectEntrypoint` says this module IS the
// process entry point.
//
// TWO MODES, AND ONLY ONE OF THEM WRITES.
//
//   (default)  INSPECT. Verifies the published bundle, takes and proves the
//              complete source fence, re-derives the contract, the 21 table
//              digests and the fenced sequence positions inside ONE read-only
//              repeatable-read snapshot, requires all of it to equal the
//              published manifest, checks the source schema against the
//              committed expected-target contract, and prints ONE confirmation
//              token. It constructs NO target client - there is no code path
//              from this mode to `openTarget`.
//
//   --apply    Requires that token back, byte for byte. Repeats every one of
//              the above steps from scratch rather than trusting what inspect
//              saw, and only then opens the first target connection.
//
// WHY THE TOKEN AND NOT A PROMPT. See `confirmation.ts`: it is a digest of the
// bundle, the source identity, the content digests, the provenance, the target
// identity and the implementation head. A source repointed, a bundle swapped, a
// different target named or a different build of this code all change it, so a
// token that still matches is a token that still describes this run.
//
// FOUR EXIT STATUSES, AND THE THIRD IS THE ONE THAT MATTERS.
//
//   0  the copy committed
//   1  something failed that this code did not anticipate
//   2  refused - the target is provably untouched, and a retry is safe
//   3  COMMIT OUTCOME UNKNOWN - the target may or may not hold the copy. It has
//      NOT been rolled back and MUST NOT be retried or cleaned up.
//
// HOW THE SECRETS TRAVEL. Each credential is an absolute path to a reviewed
// 0600 file holding the published connection URL. The URL is read into process
// memory, parsed, and its password handed to the driver as a config field. It
// never reaches argv, never reaches the environment, and is never printed.

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sha256Hex } from '../src/pg-copy/schema-contract.js'
import { CommitOutcomeUnknown, Stage2Refused, readPublishedBundle, runApply, runInspect,
  type PublishedManifest } from '../src/pg-copy/stage2.js'
import { ConfirmationRefused } from '../src/pg-copy/confirmation.js'
import { EXPORT_ROLE_NAME, parseCredentialUrl } from '../src/pg-copy/export-role.js'
import { openDriverSession, type DriverSession } from '../src/pg-copy/driver-session.js'
import { EXPORT_BEGIN_SQL, type OperatorInput } from '../src/pg-copy/source-manifest.js'
import { TARGET_OWNER_ROLE } from '../src/pg-copy/target-authority.js'
import { openPsqlBackend, type PsqlBackend } from '../src/pg-copy/psql-backend.js'

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_REFUSED = 2
/** COMMIT submitted, outcome not known. Inspect; do not retry. */
export const EXIT_COMMIT_UNKNOWN = 3

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
export const INGESTION_SUBMODULE = 'apps/capital-intelligence-ingestion'
export const GIT = '/usr/bin/git'
export const DEFAULT_PSQL = '/opt/homebrew/opt/postgresql@17/bin/psql'

/** Every option this CLI accepts. Anything else is refused, never ignored. */
export const OPTIONS: readonly string[] = Object.freeze([
  '--bundle',
  '--source-host', '--source-port', '--source-database', '--source-credential',
  '--supervisor-user', '--supervisor-passfile',
  '--target-host', '--target-port', '--target-database', '--target-credential',
  '--target-system-identifier', '--source-system-identifier',
  '--provenance-head', '--confirm', '--psql',
])

/** Options that take no value. */
export const FLAGS: readonly string[] = Object.freeze(['--apply'])

export const REQUIRED: readonly string[] = Object.freeze([
  '--bundle',
  '--source-host', '--source-port', '--source-database', '--source-credential',
  '--supervisor-user', '--supervisor-passfile',
  '--target-host', '--target-port', '--target-database', '--target-credential',
  '--target-system-identifier', '--source-system-identifier',
  '--provenance-head',
])

export class CopyCliRefused extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'CopyCliRefused'
  }
}

export interface ParsedArgs {
  readonly values: Record<string, string>
  readonly apply: boolean
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values: Record<string, string> = {}
  let apply = false
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i]
    if (FLAGS.includes(name)) { apply = true; continue }
    if (!OPTIONS.includes(name)) {
      throw new CopyCliRefused(`"${name}" is not a recognised option.`)
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new CopyCliRefused(`option "${name}" needs a value.`)
    }
    if (values[name] !== undefined) throw new CopyCliRefused(`option "${name}" was given twice.`)
    values[name] = value
    i += 1
  }
  for (const r of REQUIRED) {
    if (values[r] === undefined) throw new CopyCliRefused(`option "${r}" is required.`)
  }
  for (const p of ['--bundle', '--source-credential', '--target-credential',
                   '--supervisor-passfile']) {
    if (!isAbsolute(values[p])) {
      throw new CopyCliRefused(`option "${p}" must be an absolute path.`)
    }
  }
  if (apply && values['--confirm'] === undefined) {
    throw new CopyCliRefused('--apply requires --confirm with the token --inspect printed.')
  }
  if (!apply && values['--confirm'] !== undefined) {
    throw new CopyCliRefused('--confirm is only meaningful with --apply.')
  }
  return { values, apply }
}

function git(args: readonly string[]): string {
  try {
    return execFileSync(GIT, [...args], {
      cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    throw new CopyCliRefused(`could not read repository provenance (git ${args[0]}).`)
  }
}

/** The implementation head and the ingestion gitlink, from the checkout itself. */
export function repositoryProvenance(): { implementationHead: string; ingestionGitlink: string } {
  if (git(['status', '--porcelain', '--untracked-files=all']) !== '') {
    throw new CopyCliRefused(
      'the repository worktree is not clean; the recorded implementation head would name ' +
      'a tree that cannot be retrieved.')
  }
  const implementationHead = git(['rev-parse', 'HEAD'])
  const m = /^160000 ([0-9a-f]{40}) /.exec(git(['ls-files', '-s', '--', INGESTION_SUBMODULE]))
  if (m === null) throw new CopyCliRefused('the ingestion gitlink could not be read.')
  return { implementationHead, ingestionGitlink: m[1] }
}

export interface CliResult {
  readonly exitCode: number
  readonly lines: readonly string[]
}

/**
 * What a failure MEANS, and what is true about the target.
 *
 * Separated so it can be exercised on real error instances. The ONE thing this
 * must never do is describe an unknown commit as a refusal: a refusal says the
 * target is untouched and a retry is safe, and neither is known to be true.
 */
export function dispositionOf(e: unknown): CliResult {
  const lines: string[] = []
  if (e instanceof CommitOutcomeUnknown) {
    lines.push(e.message)
    lines.push('COMMIT OUTCOME UNKNOWN. The target was NOT rolled back.')
    lines.push('Do not retry, re-copy, truncate or "clean up". Inspect the target first.')
    return { exitCode: EXIT_COMMIT_UNKNOWN, lines }
  }
  const name = e instanceof Error ? e.name : 'Error'
  const bounded = name === 'Stage2Refused' || name === 'ConfirmationRefused' ||
                  name === 'TargetRefused' || name === 'CopyCliRefused' ||
                  name === 'DriverSessionRefused'
  lines.push(bounded && e instanceof Error ? e.message : `stage 2 failed (${name}).`)
  // TRUE ON THIS PATH ONLY, and the unknown-commit branch has already returned:
  // every error that reaches here was raised before COMMIT was submitted, so
  // the target transaction was rolled back or never opened.
  lines.push('The target was NOT modified: no transaction was committed.')
  return { exitCode: bounded ? EXIT_REFUSED : EXIT_FAILED, lines }
}

/** Read a reviewed 0600 credential file and keep its parts in memory only. */
function credential(path: string): { user: string; password: string; database: string;
  host: string; port: string } {
  try {
    return parseCredentialUrl(readFileSync(path, 'utf-8').trim())
  } catch {
    throw new CopyCliRefused('a credential file could not be read or is not the reviewed form.')
  }
}

export async function runCli(argv: readonly string[]): Promise<CliResult> {
  const lines: string[] = []
  const say = (l: string): void => { lines.push(l) }

  let parsed: ParsedArgs
  try { parsed = parseArgs(argv) } catch (e) {
    return dispositionOf(e)
  }
  const a = parsed.values

  let provenance: { implementationHead: string; ingestionGitlink: string }
  let sourceCred: ReturnType<typeof credential>
  let targetCred: ReturnType<typeof credential>
  try {
    provenance = repositoryProvenance()
    sourceCred = credential(a['--source-credential'])
    targetCred = credential(a['--target-credential'])
  } catch (e) {
    return dispositionOf(e)
  }

  const operator: OperatorInput = {
    runId: '00000000',
    generatedAtUtc: '2026-01-01T00:00:00Z',
    implementationHead: provenance.implementationHead,
    provenanceHead: a['--provenance-head'],
    ingestionGitlink: provenance.ingestionGitlink,
    expectedTargetLabel: 'stage-2-target',
    expectedSystemIdentifier: a['--source-system-identifier'],
    sourceLabel: 'stage-2-source',
    requestedEndpoint: a['--source-host'],
    sourcePort: a['--source-port'],
    sourceDatabase: a['--source-database'],
  }
  const targetExpectation = {
    systemIdentifier: a['--target-system-identifier'],
    database: a['--target-database'],
    port: a['--target-port'],
    role: targetCred.user,
    endpoint: a['--target-host'],
  }

  let supervisor: PsqlBackend | null = null
  let prover: PsqlBackend | null = null
  let source: DriverSession | null = null
  const psqlPath = a['--psql'] ?? DEFAULT_PSQL

  try {
    const published: PublishedManifest = readPublishedBundle(
      a['--bundle'], p => readFileSync(p, 'utf-8'), sha256Hex)

    supervisor = await openPsqlBackend({
      psqlPath, host: a['--source-host'], port: Number(a['--source-port']),
      database: a['--source-database'], user: a['--supervisor-user'],
      passfile: a['--supervisor-passfile'],
    })
    prover = await openPsqlBackend({
      psqlPath, host: a['--source-host'], port: Number(a['--source-port']),
      database: a['--source-database'], user: a['--supervisor-user'],
      passfile: a['--supervisor-passfile'],
    })
    source = await openDriverSession({
      host: sourceCred.host, port: Number(sourceCred.port), database: sourceCred.database,
      user: sourceCred.user, password: sourceCred.password,
    })

    const stageInput = {
      supervisor, prover, source, operator, sourceBeginSql: EXPORT_BEGIN_SQL,
    }

    if (!parsed.apply) {
      // INSPECT. There is no `openTarget` in scope on this path at all.
      const r = await runInspect(stageInput, published, targetExpectation)
      say(`bundle ${r.bundleName}`)
      say(`source contract digest ${r.contractDigest}`)
      say(`content root digest ${r.rootDigest}`)
      say(`expected target ${targetExpectation.database} on ${targetExpectation.endpoint}:` +
          `${targetExpectation.port} as ${targetExpectation.role}`)
      say('')
      say('To apply this exact copy, re-run with --apply and:')
      say(`  --confirm ${r.confirmation}`)
      return { exitCode: EXIT_OK, lines }
    }

    const r = await runApply({
      ...stageInput,
      targetExpectation,
      confirmation: a['--confirm'],
      // Constructed ONLY when Stage 2 calls it, which is after A5.
      openTarget: async () => await openDriverSession({
        host: targetCred.host, port: Number(targetCred.port), database: targetCred.database,
        user: targetCred.user, password: targetCred.password,
      }),
    }, published)

    say(`COMMITTED. ${r.tablesCopied} tables copied from bundle ${r.bundleName}.`)
    say(`content root digest ${r.rootDigest}`)
    return { exitCode: EXIT_OK, lines }
  } catch (e) {
    const d = dispositionOf(e)
    for (const l of d.lines) say(l)
    return { exitCode: d.exitCode, lines }
  } finally {
    // THE REVIEWED CLEANUP ORDER. The target transaction and session are owned
    // by `runApply` and are already gone by the time this runs; what is left is
    // the source, then the prover, then the SUPERVISOR - whose transaction is
    // the fence, and which therefore goes last.
    if (source !== null) {
      try { await source.rows('ROLLBACK') } catch { /* the end below covers it */ }
      try { await source.end() } catch { /* bounded */ }
    }
    if (prover !== null) { try { await prover.close() } catch { /* bounded */ } }
    if (supervisor !== null) {
      try { await supervisor.send('ROLLBACK') } catch { /* the close below ends it */ }
      try { await supervisor.close() } catch { /* bounded */ }
    }
  }
}

export function isDirectEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

/** Re-exported for tests that assert the reviewed role names. */
export { EXPORT_ROLE_NAME, TARGET_OWNER_ROLE, ConfirmationRefused, Stage2Refused }

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  runCli(process.argv.slice(2))
    .then(r => { for (const l of r.lines) console.log(l); process.exit(r.exitCode) })
    .catch(() => { process.exit(EXIT_FAILED) })
}
