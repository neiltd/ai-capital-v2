/**
 * PUBLISHED, NEVER HALF-PUBLISHED.
 *
 * `writeFileSync` truncates and then writes, so a SIGKILL landing inside that
 * window leaves the file permanently empty or torn. A contained hold child is
 * ENDED BY SIGKILL BY DESIGN, on a group kill the parent issues at a moment it
 * chooses, so that window is not a rare accident there - it is the normal way the
 * process dies. A measurement of that exact shape left the progress file
 * unreadable in 37.5% of kills, and the parent read the result as "nothing was
 * ever observed": a hold that had recorded its request and performed its one
 * operation was reported as having done neither.
 *
 * A rename within one directory is atomic, so every reader sees either the whole
 * previous document or the whole next one, and a kill can only ever lose the
 * newest update - never the file. This is the pattern the child's final result
 * always used; every publication now goes through this one implementation.
 */
import { chmodSync, renameSync, writeFileSync } from 'node:fs'

export function publishAtomically(file: string, text: string): void {
  const tmp = `${file}.partial`
  writeFileSync(tmp, text)
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}
