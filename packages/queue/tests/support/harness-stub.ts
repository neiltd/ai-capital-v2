// A STAND-IN FOR THE REAL SUITE, SO THE RUNNER'S CONTRACT CAN BE TESTED DIRECTLY.
//
// WHY NOT RUN VITEST INSIDE VITEST. The properties under test are the runner's:
// that an interrupt kills the whole group and removes every owned root, that an
// ordinary failure leaves no more behind than a pass, that a child with no
// surviving parent stops by itself. None of those is about Vitest, and nesting a
// second full runner would make each case a minute long and its failures a
// question about which layer broke. So the runner is given a small command that
// does exactly the interesting thing, and nothing else.
//
// NOT NAMED `*.test.ts`, so the suite never collects it: it is a command, and it
// is meant to be run BY something rather than run as a case.
//
// USAGE: `tsx tests/support/harness-stub.ts <mode>`
//   pass          make an owned root, exit 0
//   fail          make an owned root, exit 1
//   hold          make an owned root and publish into it until something stops
//                 this process - which is the runaway the ceilings exist for

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT_PREFIX_FOR, RUN_NONCE, realTmp } from './roots.js'
import { installSelfLimit } from './self-limit.js'

const mode = process.argv[2]

/** A root named exactly as the harness names its own, and owned by this run. */
const root = mkdtempSync(join(realTmp(), ROOT_PREFIX_FOR(RUN_NONCE, process.pid)))
const evidence = join(root, 'evidence')
mkdirSync(evidence, { mode: 0o700 })
// ITS OWN PID FIRST, THEN THE ROOT. A case that has to be able to kill this
// process cannot always name it: when the launcher exits so that this becomes an
// orphan, nothing that started it survives to report a pid.
process.stdout.write(`${String(process.pid)} ${root}\n`)

if (mode === 'pass') process.exit(0)
if (mode === 'fail') process.exit(1)
if (mode !== 'hold') {
  process.stderr.write(`unknown mode: ${String(mode)}\n`)
  process.exit(2)
}

// THE RUNAWAY, IN MINIATURE. The real one is `holdForIntervention` publishing an
// intent and an outcome per iteration; what matters to the containment contract
// is only that it never ends on its own and that it keeps writing. The signal
// handlers are the real hold's, and are here for the same reason: a fence that
// released itself because somebody pressed ^C would be the defect.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
  process.on(sig, () => { /* HELD, exactly as a real hold holds it */ })
}

// THE SAME SELF-LIMIT THE REAL CHILD ARMS, for the same reason and from the same
// module: if this stub had its own, a test passing here would say nothing about
// the child that actually runs the holds.
const SELF = installSelfLimit(null)
SELF.watch(root, evidence)

let n = 0
const publish = (): void => {
  SELF.check()
  n += 1
  const bundle = join(evidence, `bundle-${String(n).padStart(6, '0')}`)
  try {
    mkdirSync(bundle, { mode: 0o700 })
    writeFileSync(join(bundle, 'outcome.json'), `${JSON.stringify({ n })}\n`)
  } catch { /* the volume filling is the incident, not an error to report */ }
}
setInterval(publish, 5)
