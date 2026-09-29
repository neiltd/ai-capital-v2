/**
 * A PROCESS THAT DOES NOTHING BUT PUBLISH, so it can be killed mid-publication.
 *
 * Driven by `contained-report.test.ts`. It republishes a document of the reviewed
 * size continuously until the group kill arrives, which is the shape the hold
 * child dies in. `writer=plain` reproduces the pre-fix publication so the
 * regression has a control that it actually kills.
 */
import { writeFileSync } from 'node:fs'
import { publishAtomically } from './publish.js'

const [file, writer] = process.argv.slice(2)
if (file === undefined) throw new Error('usage: publish-child.ts <file> [writer]')

const publish = writer === 'plain'
  ? (f: string, t: string): void => { writeFileSync(f, t) }
  : publishAtomically

let n = 0
for (;;) {
  n += 1
  publish(file, `${JSON.stringify({ n, filler: 'x'.repeat(4096) })}\n`)
}
