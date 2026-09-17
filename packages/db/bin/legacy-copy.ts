#!/usr/bin/env node
// The ONE entry point for the legacy copy.
//
// INERT ON IMPORT. Nothing below runs, reads a file, parses an environment
// variable or constructs a resource until `isDirectEntrypoint` says this module
// IS the process entry point. That is the pattern proved by bin/db-inventory.ts,
// and it is what lets tests/legacy-copy-contract.test.ts import this file and
// assert its shape rather than execute it. The two CLIs this replaces called
// `main()` at module scope: importing either one ran a migration.
//
// DEFAULT MODE CONNECTS TO NOTHING. Without `--apply` the command validates the
// credential and the snapshot root, proves the snapshot is complete,
// fingerprints it, prints the exact confirmation string the operator would have
// to supply, and exits. No pool is constructed and no SQL is sent.
//
// THE CONFIRMATION IS BOUND TO BYTES AND TO A CLUSTER. It names the destination
// database, the parent runtime commit the snapshot was taken at, the digest of
// every snapshot file, and the cluster's own system identifier, port and socket
// directory. The plan that string describes is handed to runLegacyCopy, which
// recomputes all of it and refuses on any difference - before connecting, and
// again before COMMIT.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { ConfirmedPlan } from '../src/legacy-copy.js'
import {
  CopyCommitOutcomeUnknown,
  CopyRefused,
  allSnapshotPaths,
  assertCompleteSnapshot,
  fingerprintDigest,
  readSourceHead,
  requireDatabaseName,
  resolveCredential,
  resolveSourceRoot,
  runLegacyCopy,
  sourceFingerprints,
} from '../src/legacy-copy.js'

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_REFUSED = 2
/**
 * DISTINCT, because the operator response is different. A refusal means nothing
 * happened and the command can be fixed and rerun; a failure means the
 * transaction rolled back. This one means NOBODY KNOWS, and the only safe next
 * step is to look at the target.
 */
export const EXIT_COMMIT_UNKNOWN = 3

export const COMMIT_UNKNOWN_MESSAGE =
  'COMMIT OUTCOME UNKNOWN - inspect the target and do not rerun'

export interface ParsedArgs {
  apply: boolean
  confirm: string | null
  systemIdentifier: string | null
  port: number | null
  socketDirectory: string | null
  unknown: string[]
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    apply: false, confirm: null, systemIdentifier: null, port: null,
    socketDirectory: null, unknown: [],
  }
  for (const a of argv) {
    if (a === '--apply') out.apply = true
    else if (a.startsWith('--confirm=')) out.confirm = a.slice('--confirm='.length)
    else if (a.startsWith('--expect-system-identifier=')) {
      out.systemIdentifier = a.slice('--expect-system-identifier='.length)
    } else if (a.startsWith('--expect-port=')) {
      const n = Number(a.slice('--expect-port='.length))
      out.port = Number.isInteger(n) ? n : null
    } else if (a.startsWith('--expect-socket=')) {
      out.socketDirectory = a.slice('--expect-socket='.length)
    } else out.unknown.push(a)
  }
  return out
}

/**
 * The exact string the operator must type back. It names the destination, the
 * snapshot's commit, the snapshot's digest and the cluster the copy expects to
 * land on. It carries NO credential: the role is fixed by the contract and the
 * password, if any, lives in .pgpass.
 */
export function expectedConfirmation(plan: ConfirmedPlan): string {
  return (
    `copy ${plan.database} on cluster ${plan.systemIdentifier} ` +
    `port ${plan.port} socket ${plan.socketDirectory} ` +
    `from ${plan.sourceHead} manifest ${plan.sourceDigest}`
  )
}

export interface PlanOutcome {
  plan: ConfirmedPlan | null
  database: string
  sourceRoot: string
  sourceHead: string
  sourceDigest: string
  files: number
  /** Expectations the operator still has to supply for --apply. */
  missingExpectations: string[]
}

/** Everything the command can know WITHOUT connecting. Shared by both modes. */
export function planCopy(env: NodeJS.ProcessEnv, args: ParsedArgs): PlanOutcome {
  const url = resolveCredential(env)
  const sourceRoot = resolveSourceRoot(env)
  const database = requireDatabaseName(url)
  assertCompleteSnapshot(sourceRoot)
  const sourceHead = readSourceHead(sourceRoot)
  const fingerprints = sourceFingerprints(sourceRoot, allSnapshotPaths(sourceRoot))
  const sourceDigest = fingerprintDigest(fingerprints)

  const missingExpectations: string[] = []
  if (!args.systemIdentifier) missingExpectations.push('--expect-system-identifier')
  if (args.port === null) missingExpectations.push('--expect-port')
  if (!args.socketDirectory) missingExpectations.push('--expect-socket')

  const plan: ConfirmedPlan | null = missingExpectations.length > 0
    ? null
    : {
      sourceRoot,
      sourceHead,
      sourceDigest,
      database,
      systemIdentifier: args.systemIdentifier as string,
      port: args.port as number,
      socketDirectory: args.socketDirectory as string,
    }

  return { plan, database, sourceRoot, sourceHead, sourceDigest, files: fingerprints.length, missingExpectations }
}

export interface RunResult { exitCode: number; lines: string[] }

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: { copy?: typeof runLegacyCopy } = {},
): Promise<RunResult> {
  const lines: string[] = []
  const say = (s: string) => { lines.push(s) }
  const args = parseArgs(argv)
  if (args.unknown.length > 0) {
    say(`unknown argument(s): ${args.unknown.join(', ')}`)
    say('usage: legacy-copy [--expect-system-identifier=N --expect-port=N --expect-socket=DIR]')
    say('                   [--apply --confirm="<exact confirmation>"]')
    return { exitCode: EXIT_REFUSED, lines }
  }

  let outcome: PlanOutcome
  try {
    outcome = planCopy(env, args)
  } catch (err) {
    say(err instanceof Error ? err.message : String(err))
    return { exitCode: EXIT_REFUSED, lines }
  }

  say(`target database: ${outcome.database}`)
  say(`snapshot root:   ${outcome.sourceRoot}`)
  say(`snapshot head:   ${outcome.sourceHead}`)
  say(`snapshot files:  ${outcome.files}`)
  say(`snapshot digest: ${outcome.sourceDigest}`)

  if (!args.apply) {
    say('')
    say('INSPECT ONLY - no pool was constructed and no SQL was sent.')
    if (outcome.plan === null) {
      say(`Supply the cluster expectations to see the confirmation: ${outcome.missingExpectations.join(' ')}`)
      say('  (read them from the target with: SELECT system_identifier FROM pg_control_system();')
      say('   SHOW port; SHOW unix_socket_directories;)')
      return { exitCode: EXIT_OK, lines }
    }
    say('To perform the copy, re-run with:')
    say(`  --apply --confirm=${JSON.stringify(expectedConfirmation(outcome.plan))}`)
    return { exitCode: EXIT_OK, lines }
  }

  if (outcome.plan === null) {
    say(`--apply requires the cluster expectations: ${outcome.missingExpectations.join(' ')}`)
    return { exitCode: EXIT_REFUSED, lines }
  }
  if (args.confirm === null) {
    say('--apply requires --confirm with the exact confirmation string above.')
    return { exitCode: EXIT_REFUSED, lines }
  }
  if (args.confirm !== expectedConfirmation(outcome.plan)) {
    // The supplied value is NOT echoed: it came from the command line and this
    // output is one `tee` away from a log file.
    say('the confirmation does not match this copy. Nothing was done.')
    return { exitCode: EXIT_REFUSED, lines }
  }

  const copy = deps.copy ?? runLegacyCopy
  try {
    const result = await copy({ env, plan: outcome.plan, log: say })
    say('')
    say(`migrations verified: ${result.migrationCount} (exact CURRENT_V19 recognition)`)
    for (const s of result.sequences) {
      say(`sequence ${s.sequence}: last_value=${s.lastValue} is_called=${s.isCalled}`)
    }
    // ROW COUNTS. Not a target-state manifest: two databases with identical
    // counts and different values hash the same here. The exact ordered value
    // checksums are produced by the PostgreSQL artifact.
    say(`row-count manifest digest (counts only): ${result.countManifestDigest}`)
    say('COPY COMPLETE')
    return { exitCode: EXIT_OK, lines }
  } catch (err) {
    if (err instanceof CopyCommitOutcomeUnknown) {
      // No COPY COMPLETE, and no claim that anything rolled back. The original
      // COMMIT error is printed as evidence, not swallowed.
      say('')
      say(COMMIT_UNKNOWN_MESSAGE)
      say(err.message)
      const cause = err.commitError
      say(`original COMMIT error: ${cause instanceof Error ? cause.message : String(cause)}`)
      return { exitCode: EXIT_COMMIT_UNKNOWN, lines }
    }
    say(err instanceof Error ? err.message : String(err))
    return { exitCode: err instanceof CopyRefused ? EXIT_REFUSED : EXIT_FAILED, lines }
  }
}

/**
 * True only when this module IS the process entry point. Compared on REAL
 * paths, so a symlinked bin or a `/private` vs `/tmp` spelling does not make an
 * imported module look like the entry point, or the reverse.
 */
export function isDirectEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  runCli(process.argv.slice(2), process.env)
    .then(r => {
      for (const l of r.lines) console.log(l)
      process.exit(r.exitCode)
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(EXIT_FAILED)
    })
}
