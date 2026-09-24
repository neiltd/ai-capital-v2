#!/usr/bin/env node
// STAGE 1 — derive and publish an immutable source manifest.
//
// INERT ON IMPORT. Nothing runs, reads an environment variable, spawns a
// process or opens a session until `isDirectEntrypoint` says this module IS the
// process entry point, so the tests can import and assert its shape rather than
// execute it.
//
// WHAT IT DOES, IN ONE SENTENCE. Takes the whole source fence on a SUPERVISOR
// session, proves it from a THIRD backend, opens ONE read-only repeatable-read
// transaction as the EXPORT role, derives the schema contract and the content
// digests of the 21 reviewed tables inside that single snapshot, reads the
// three sequence positions from the supervisor only, publishes an immutable
// evidence bundle while the fence is still held, rolls the source transaction
// back, and only then releases the fence.
//
// THREE SESSIONS, AND WHY NONE OF THEM CAN BE MERGED.
//
//   SUPERVISOR  holds the fence. `LOCK TABLE ... IN SHARE MODE` needs
//               UPDATE/DELETE/TRUNCATE/MAINTAIN and `ALTER SEQUENCE` needs
//               ownership, so the fence holder is necessarily a WRITER. The
//               export role is deliberately not one, which is exactly why the
//               two cannot be the same principal.
//   PROVER      observes. A session can always see its own locks, so only a
//               different backend can show the source is held against anyone
//               else.
//   EXPORT      reads. Read-only, repeatable read, no sequence privilege, and
//               guarded so it is never even ASKED for mutable sequence state.
//
// NO TARGET IS CONTACTED. The expected target is an operator LABEL and the
// expected-target contract digest is a compile-time constant. This CLI has no
// target connection parameter and constructs no client of any kind.
//
// NO CREDENTIAL TRAVELS IN ARGV OR THE ENVIRONMENT. Every secret reaches psql
// through a PGPASSFILE PATH, and the child's environment is built from an
// allow-list, not inherited. There is no URL option, no password option and no
// fallback environment variable.

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXPORT_ROLE_NAME } from '../src/pg-copy/export-role.js'
import { openPsqlBackend, type PsqlBackend } from '../src/pg-copy/psql-backend.js'
import { newRunId } from '../src/pg-copy/evidence.js'
import {
  MANIFEST_FILE, runStage1, type OperatorInput,
} from '../src/pg-copy/source-manifest.js'

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_REFUSED = 2

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
export const INGESTION_SUBMODULE = 'apps/capital-intelligence-ingestion'
export const GIT = '/usr/bin/git'
export const DEFAULT_PSQL = '/opt/homebrew/opt/postgresql@17/bin/psql'

/** Every option this CLI accepts. Anything else is refused, never ignored. */
export const OPTIONS: readonly string[] = Object.freeze([
  '--evidence-root', '--host', '--port', '--database',
  '--export-passfile', '--supervisor-user', '--supervisor-passfile',
  '--expected-target', '--source-system', '--source-endpoint',
  '--provenance-head', '--run-id', '--psql',
])

export const REQUIRED: readonly string[] = Object.freeze([
  '--evidence-root', '--host', '--port', '--database',
  '--export-passfile', '--supervisor-user', '--supervisor-passfile',
  '--expected-target', '--source-system', '--source-endpoint', '--provenance-head',
])

export class CliRefused extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'CliRefused'
  }
}

/**
 * Parse `--name value` pairs, refusing anything unrecognised.
 *
 * An unknown option is a REFUSAL rather than something to skip: a typo in
 * `--evidence-root` that was silently ignored would fall through to a missing
 * required option at best, and to publishing somewhere unintended at worst.
 */
export function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]
    if (!OPTIONS.includes(name)) {
      throw new CliRefused(`"${name}" is not a recognised option.`)
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new CliRefused(`option "${name}" needs a value.`)
    }
    if (out[name] !== undefined) throw new CliRefused(`option "${name}" was given twice.`)
    out[name] = value
  }
  for (const r of REQUIRED) {
    if (out[r] === undefined) throw new CliRefused(`option "${r}" is required.`)
  }
  for (const p of ['--evidence-root', '--export-passfile', '--supervisor-passfile']) {
    if (!isAbsolute(out[p])) throw new CliRefused(`option "${p}" must be an absolute path.`)
  }
  return out
}

/** `git` output, trimmed, or a refusal. Never the git error text. */
function git(args: readonly string[]): string {
  try {
    return execFileSync(GIT, [...args], {
      cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    throw new CliRefused(`could not read repository provenance (git ${args[0]}).`)
  }
}

/**
 * The two provenance facts the REPOSITORY is authoritative for.
 *
 * Read here rather than accepted as operator input, because an operator-stated
 * implementation head is a claim about which code ran, and the code that ran is
 * the code in this checkout. The worktree must be clean for the same reason: a
 * head recorded against uncommitted edits names a tree nobody can retrieve.
 */
export function repositoryProvenance(): { implementationHead: string; ingestionGitlink: string } {
  const status = git(['status', '--porcelain', '--untracked-files=all'])
  if (status !== '') {
    throw new CliRefused(
      'the repository worktree is not clean; the recorded implementation head would name ' +
      'a tree that cannot be retrieved.')
  }
  const implementationHead = git(['rev-parse', 'HEAD'])
  const line = git(['ls-files', '-s', '--', INGESTION_SUBMODULE])
  const m = /^160000 ([0-9a-f]{40}) /.exec(line)
  if (m === null) throw new CliRefused('the ingestion gitlink could not be read.')
  return { implementationHead, ingestionGitlink: m[1] }
}

export interface CliResult {
  readonly exitCode: number
  readonly lines: readonly string[]
}

/**
 * Open the three sessions, run Stage 1, and tear everything down in the one
 * order the guarantees depend on.
 *
 * THE `finally` RELEASES THE FENCE, AND ONLY THERE. `runStage1` never ends the
 * supervisor's transaction: releasing it inside would put the release before
 * the caller could know publication succeeded. Here it runs after Stage 1 has
 * returned or thrown - so on the failure path the fence is released too, which
 * is correct, because on that path nothing was published.
 */
export async function runCli(argv: readonly string[]): Promise<CliResult> {
  const lines: string[] = []
  const say = (l: string): void => { lines.push(l) }

  let args: Record<string, string>
  try {
    args = parseArgs(argv)
  } catch (e) {
    say(e instanceof Error ? e.message : 'the arguments were refused.')
    return { exitCode: EXIT_REFUSED, lines }
  }

  const psqlPath = args['--psql'] ?? DEFAULT_PSQL
  const port = Number(args['--port'])
  const runId = args['--run-id'] ?? newRunId()

  let provenance: { implementationHead: string; ingestionGitlink: string }
  try {
    provenance = repositoryProvenance()
  } catch (e) {
    say(e instanceof Error ? e.message : 'provenance was refused.')
    return { exitCode: EXIT_REFUSED, lines }
  }

  const operator: OperatorInput = {
    runId,
    generatedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    implementationHead: provenance.implementationHead,
    provenanceHead: args['--provenance-head'],
    ingestionGitlink: provenance.ingestionGitlink,
    expectedTargetSystem: args['--expected-target'],
    sourceSystem: args['--source-system'],
    sourceEndpoint: args['--source-endpoint'],
    sourcePort: String(port),
    sourceDatabase: args['--database'],
  }

  let supervisor: PsqlBackend | null = null
  let prover: PsqlBackend | null = null
  let exportSession: PsqlBackend | null = null
  try {
    supervisor = await openPsqlBackend({
      psqlPath, host: args['--host'], port, database: args['--database'],
      user: args['--supervisor-user'], passfile: args['--supervisor-passfile'],
    })
    prover = await openPsqlBackend({
      psqlPath, host: args['--host'], port, database: args['--database'],
      user: args['--supervisor-user'], passfile: args['--supervisor-passfile'],
    })
    exportSession = await openPsqlBackend({
      psqlPath, host: args['--host'], port, database: args['--database'],
      user: EXPORT_ROLE_NAME, passfile: args['--export-passfile'],
    })

    const result = await runStage1({
      supervisor, prover, exportSession, operator, evidenceRoot: args['--evidence-root'],
    })
    say(`published ${result.published.finalPath}`)
    say(`manifest ${MANIFEST_FILE}`)
    say(`root digest ${result.rootDigest}`)
    say(`source contract digest ${result.contractDigest}`)
    say(`files ${result.published.files.join(' ')}`)
    return { exitCode: EXIT_OK, lines }
  } catch (e) {
    // BOUNDED. Stage-1 and evidence errors are already closed unions of
    // reviewed sentences; anything else is reported by its class alone,
    // because an unexpected error may carry a statement or a row.
    const name = e instanceof Error ? e.name : 'Error'
    const bounded = name === 'ManifestRefused' || name === 'EvidenceRefused' ||
                    name === 'FenceRefused' || name === 'ContractRefused' ||
                    name === 'CanonicalRefused' || name === 'CliRefused'
    say(bounded && e instanceof Error ? e.message : `stage 1 failed (${name}).`)
    say('No manifest was published under the final name.')
    return { exitCode: bounded ? EXIT_REFUSED : EXIT_FAILED, lines }
  } finally {
    // The fence is released HERE, after publication and rollback have both
    // completed - or after a failure, where nothing was published at all.
    if (supervisor !== null) {
      try { await supervisor.send('ROLLBACK') } catch { /* the close below ends it anyway */ }
    }
    for (const s of [exportSession, prover, supervisor]) {
      if (s !== null) { try { await s.close() } catch { /* bounded */ } }
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

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  runCli(process.argv.slice(2))
    .then(r => { for (const l of r.lines) console.log(l); process.exit(r.exitCode) })
    .catch(() => { process.exit(EXIT_FAILED) })
}
