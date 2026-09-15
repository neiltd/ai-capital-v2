#!/usr/bin/env node
// THE CANONICAL LAUNCHER for direct (non-queue) PostgreSQL consumers.
//
// scripts/run-alerts.sh and scripts/refresh-prices.sh used to do this:
//
//   export DATABASE_URL="${DATABASE_URL:-<a hard-coded superuser URL>}"
//
// which is not a credential boundary. `${VAR:?}` would be an improvement and
// still not enough: it accepts surrounding whitespace, a wrong scheme, a
// malformed value, and an incomplete URL that libpq silently completes from
// PGDATABASE/PGUSER/USER. Reimplementing the real contract in shell would mean a
// second, weaker copy of security logic — exactly what slice S4C rejected.
//
// So the shell wrappers carry no policy at all. They exec this launcher with a
// FIXED command, and the launcher applies the same validation and the same
// environment builder the worker uses.
//
// It constructs no PostgreSQL pool, no Redis client and no queue. It validates a
// string, builds an environment, and execs.

import { spawn } from 'child_process'
import { realpathSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import { ensurePipelineEnv, requirePipelineCredential } from '../src/env.js'
import { buildPipelineChildEnv } from '../src/child-env.js'

/**
 * Everything after the literal `--` is the command. Nothing before it is.
 *
 * EMPTY ARGUMENTS ARE PRESERVED. An earlier version filtered them out, on the
 * theory that a shell expansion could produce a stray one. That is a silent
 * rewrite of the caller's command: `--flag ''` and `--flag` mean different
 * things to most CLIs, and dropping the empty element shifts every argument
 * after it. Only the COMMAND ITSELF may not be empty, and that is checked in
 * main(), where it can be reported.
 */
export function commandFromArgv(argv: readonly string[]): string[] {
  const i = argv.indexOf('--')
  if (i === -1) return []
  return argv.slice(i + 1)
}

/**
 * True when this module is the process entry point.
 *
 * `import.meta.url === \`file://${process.argv[1]}\`` was wrong in three ways:
 * a relative argv[1] produced no leading slash, a symlinked entry point resolved
 * to a different real path than argv[1] spelled, and any path containing a space
 * or a non-ASCII character differs from its percent-encoded URL form. Each made
 * the launcher import cleanly and then do nothing.
 *
 * The fix for the third case is fileURLToPath, NOT `new URL(url).pathname`.
 * `pathname` stays percent-ENCODED — `/private/tmp/a%20space/entry.ts` — so
 * handing it to realpathSync names a file that does not exist, the fallback
 * resolve() keeps the literal `%20`, and pathToFileURL then encodes the percent
 * sign itself into `%2520`. Measured, not reasoned: with `pathname`, both
 * `/private/tmp/a space/entry.ts` and `/private/tmp/é/entry.ts` returned false
 * for a file that WAS the entry point. fileURLToPath does the decoding the
 * filesystem needs, including the Windows and UNC rules, which is why the
 * platform ships it as a separate function from the URL parser.
 */
export function isDirectEntrypoint(
  moduleUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false
  const canonical = (p: string) => {
    try { return pathToFileURL(realpathSync(p)).href } catch { return pathToFileURL(resolve(p)).href }
  }
  const self = (() => {
    try { return canonical(fileURLToPath(moduleUrl)) } catch { return moduleUrl }
  })()
  return self === canonical(argv1)
}

export const USAGE =
  'usage: run-stage.ts -- <command> [args…]\n' +
  '  The command must follow a literal `--`. PIPELINE_DATABASE_URL must be set\n' +
  '  to an explicit PostgreSQL URL; it is validated before the child is created.'

/** Exit status for a child killed by a signal. Non-zero, and distinguishable. */
export function signalExitCode(signal: NodeJS.Signals): number {
  const table: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 }
  return 128 + (table[signal] ?? 0)
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const command = commandFromArgv(argv)
  if (command.length === 0 || command[0] === '') {
    // Refusing an empty command is not pedantry: without it, a wrapper with a
    // typo would validate a production credential and then exec nothing,
    // reporting success.
    process.stderr.write(`run-stage: no command after \`--\`\n${USAGE}\n`)
    return 64
  }

  ensurePipelineEnv()

  // Validate BEFORE the child exists. A refused credential must produce no
  // process at all, not a process that fails once it tries to connect.
  const pipelineCredential = requirePipelineCredential()

  const env = buildPipelineChildEnv(process.env, undefined, pipelineCredential, {
    PATH: process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
  })

  const [file, ...args] = command
  // shell:false with an argv array. No string is concatenated and handed to a
  // shell, so no argument can be interpreted as shell syntax.
  //
  // detached:true puts the child in its OWN PROCESS GROUP. Stage commands are
  // `npx tsx …` wrappers, so the process doing the real work is a GRANDCHILD.
  // Signalling only the immediate child left those grandchildren running —
  // orphaned tsx processes holding a database credential after the launcher had
  // already exited. Signalling the group reaches the whole tree.
  const child = spawn(file, args, { stdio: 'inherit', env, shell: false, detached: true })

  const signalTree = (signal: NodeJS.Signals) => {
    // Negative PID = the process group. ESRCH simply means the tree is already
    // gone, which is the outcome we wanted; anything else falls back to the
    // single process rather than losing the signal entirely.
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }

  const forward = (signal: NodeJS.Signals) => () => { signalTree(signal) }
  const onInt = forward('SIGINT')
  const onTerm = forward('SIGTERM')
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)

  try {
    // `settle`, not `resolve`: `resolve` is the path helper imported above and
    // shadowing it here would be a trap for the next edit.
    return await new Promise<number>((settle, reject) => {
      child.on('error', reject)
      child.on('exit', (code, signal) => {
        if (signal) settle(signalExitCode(signal))
        else settle(code ?? 1)
      })
    })
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }
}

// Only run when executed directly, so the unit tests can import the helpers.
if (isDirectEntrypoint(import.meta.url)) {
  main()
    .then(code => { process.exitCode = code })
    .catch((err: Error) => {
      // The message names the variable and the failure. It never contains the
      // credential or the environment.
      process.stderr.write(`run-stage: ${err.message}\n`)
      process.exitCode = 78
    })
}
