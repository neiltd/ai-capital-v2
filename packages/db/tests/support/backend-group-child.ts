// A FIXTURE PARENT for the process-group property, and nothing else.
//
// The property under test is structural: a psql opened by `openPsqlBackend` must
// not be in the process group that a terminal signals. That cannot be shown from
// inside the test process, because the test process is not the foreground job of
// any terminal and Vitest's worker owns its own signal disposition. So this file
// stands in for the operator's node: the test spawns it `detached`, which makes
// it a group leader, and can then signal THAT group exactly as a TTY driver
// signals the foreground one.
//
// THE HANDLERS HERE ARE A FIXTURE, NOT THE PRODUCTION HOLD. They are no-ops whose
// only job is to keep this process alive through the group signal, the way
// `HELD_SIGNALS` keeps the real hold alive. Nothing here imports the ops CLI, and
// nothing here holds a fence.
//
// It opens one backend against the FAKE psql whose path it is given, prints the
// two pids the test needs on one line, and then idles under a bounded lifetime.
// The lifetime is the containment: if the test dies before it can reap this
// process, the process still goes away on its own.

import { openPsqlBackend } from '../../src/pg-copy/psql-backend.js'

/** Longer than any assertion in the case, short enough to never be residue. */
const MAX_LIFETIME_MS = 60_000

const [, , psqlPath, socketDir] = process.argv

async function main(): Promise<void> {
  if (psqlPath === undefined || socketDir === undefined) {
    process.stderr.write('usage: backend-group-child <psqlPath> <socketDir>\n')
    process.exit(2)
  }

  // DECLINE THE TERMINAL SIGNALS. Without these this process would die on the
  // group signal and the case could not distinguish "the child survived because
  // it is in another group" from "nothing was signalled at all".
  for (const sig of ['SIGINT', 'SIGHUP', 'SIGQUIT'] as const) {
    process.on(sig, () => { /* a fixture declines, exactly as the hold does */ })
  }

  const session = await openPsqlBackend({
    psqlPath, host: socketDir, port: 5432,
    database: 'fixture', user: 'fixture',
  })

  // ONE LINE, flushed before anything can block: the test parses it and every
  // later assertion needs both pids.
  process.stdout.write(`GROUP ${session.pid} ${String(process.pid)}\n`)

  // AND THEN WAIT TO BE KILLED. The session is deliberately NOT closed: the case
  // is about what happens to an open backend when its parent is signalled.
  setTimeout(() => { process.exit(0) }, MAX_LIFETIME_MS)
}

void main().catch((e: unknown) => {
  // The REASON ONLY. This fixture talks to a fake psql, but the boundary habit
  // holds everywhere: nothing from a backend failure is echoed verbatim.
  process.stderr.write(`FIXTURE-FAILED ${e instanceof Error ? e.name : 'unknown'}\n`)
  process.exit(1)
})
