// WHAT A CONTAINED CHILD ENFORCES ON ITSELF, WITH NO PARENT AT ALL.
//
// WHY THE CHILD ENFORCES ANYTHING, WHEN THE PARENT ALREADY DOES. Because the
// parent can stop existing. `contained.ts` polls from inside a Vitest worker;
// interrupt the outer command and the worker dies, the child is DETACHED so it is
// reparented to PPID 1, and every ceiling that was protecting it is gone. It then
// goes on holding its fence and publishing two bundles per iteration into a root
// no surviving process knows about. That is how forty abandoned roots came to be
// sitting in the real temporary directory.
//
// SO THE CEILINGS EXIST ON BOTH SIDES. The parent's are lower and fire first, so
// an ordinary contained run is still killed by the parent and still reports which
// ceiling it breached - the verdict every case asserts on is unchanged. These are
// the backstop for the run where there is nobody left to ask.
//
// AND THE FIRST CHECK IS NOT A CEILING AT ALL. An orphaned child is finished
// whatever its counters say: the run it belonged to is over, its result will never
// be read, and everything it does from here is residue. So losing the parent ends
// it immediately rather than after a timeout.

import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CHILD_WALL_CLOCK_ENV = 'PGCOPY_MODES_CHILD_WALL_CLOCK_MS'
export const CHILD_MAX_BUNDLES_ENV = 'PGCOPY_MODES_CHILD_MAX_BUNDLES'
export const CHILD_MAX_BYTES_ENV = 'PGCOPY_MODES_CHILD_MAX_BYTES'
export const RUNNER_PID_ENV = 'PGCOPY_MODES_RUNNER_PID'

/** Defaults, deliberately looser than the parent's, so the parent keeps winning. */
export const DEFAULT_CHILD_WALL_CLOCK_MS = 150_000
export const DEFAULT_CHILD_MAX_BUNDLES = 80
export const DEFAULT_CHILD_MAX_BYTES = 64 * 1024 * 1024

const num = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || !/^[0-9]{1,12}$/.test(raw)) return fallback
  return Number(raw)
}

export type SelfCeiling = 'orphaned' | 'wall-clock' | 'bundle-count' | 'bytes'

export interface SelfLimit {
  /** Check every ceiling now. Never returns if one has been breached. */
  readonly check: () => void
  /** Point the counters at a root once it exists. */
  readonly watch: (root: string, evidence: string) => void
}

const bytesUnder = (path: string): number => {
  let total = 0
  const walk = (p: string): void => {
    let st
    try { st = statSync(p) } catch { return }
    if (st.isDirectory()) {
      let kids: string[] = []
      try { kids = readdirSync(p) } catch { return }
      for (const k of kids) walk(join(p, k))
      return
    }
    total += st.size
  }
  walk(path)
  return total
}

/**
 * IS THE RUN THIS PROCESS BELONGS TO STILL THERE?
 *
 * Two questions, because either can fail alone. `ppid === 1` is the direct parent
 * - the Vitest worker, or whatever spawned this - having died and this process
 * having been reparented to init, which is the ^C case exactly. The runner check
 * covers the other direction: a runner that was SIGKILLed while its worker somehow
 * survived leaves nothing to remove these roots at the end, so the run is over even
 * though the direct parent is alive. Signal 0 asks whether a pid exists without
 * sending anything.
 */
export function orphaned(): boolean {
  if (process.ppid === 1) return true
  const raw = process.env[RUNNER_PID_ENV]
  if (raw === undefined || !/^[0-9]{1,10}$/.test(raw)) return false
  try { process.kill(Number(raw), 0); return false } catch { return true }
}

/**
 * ARM THE CHILD'S OWN CEILINGS.
 *
 * `outDir` receives a `self-limit` note naming the ceiling that fired, so a test -
 * and a person reading the temporary directory afterwards - can see WHICH one
 * rather than inferring it from an absence.
 */
export function installSelfLimit(outDir: string | null, over: {
  wallClockMs?: number; maxBundles?: number; maxBytes?: number
} = {}): SelfLimit {
  const wallClockMs = over.wallClockMs ?? num(CHILD_WALL_CLOCK_ENV, DEFAULT_CHILD_WALL_CLOCK_MS)
  const maxBundles = over.maxBundles ?? num(CHILD_MAX_BUNDLES_ENV, DEFAULT_CHILD_MAX_BUNDLES)
  const maxBytes = over.maxBytes ?? num(CHILD_MAX_BYTES_ENV, DEFAULT_CHILD_MAX_BYTES)
  const started = Date.now()

  let root: string | null = null
  let evidence: string | null = null

  /**
   * END THIS PROCESS IN THE ONE WAY IT CANNOT TALK ITSELF OUT OF.
   *
   * `process.exit` is not enough and neither is any signal the hold can catch: the
   * hold arms SIGINT, SIGTERM, SIGHUP and SIGQUIT handlers that deliberately do not
   * exit, because exiting is what would release the fence. SIGKILL to this pid is
   * the only thing that ends the loop, and it is exactly what the parent would have
   * sent had the parent still been there.
   */
  const hardStop = (why: SelfCeiling): never => {
    if (outDir !== null) {
      try {
        writeFileSync(join(outDir, 'self-limit'),
          `${why} after ${String(Date.now() - started)}ms\n`)
      } catch { /* the kill matters more than the note */ }
    }
    process.kill(process.pid, 'SIGKILL')
    // UNREACHABLE, and typed as such so no caller believes this can return.
    throw new Error('unreachable')
  }

  let calls = 0
  const check = (): void => {
    if (orphaned()) hardStop('orphaned')
    if (Date.now() - started > wallClockMs) hardStop('wall-clock')
    calls += 1
    // THE EXPENSIVE QUESTIONS ARE SAMPLED. A full walk of the root per call would
    // dominate the run; the wall clock and the orphan check are free and are asked
    // every time.
    if (calls % 25 !== 0) return
    if (evidence !== null) {
      let published = 0
      try { published = readdirSync(evidence).length } catch { published = 0 }
      if (published > maxBundles) hardStop('bundle-count')
    }
    if (root !== null && bytesUnder(root) > maxBytes) hardStop('bytes')
  }

  // DEFENCE IN DEPTH, FOR THE SHAPE THE SYNCHRONOUS HOOK CANNOT SEE: a hold that is
  // genuinely idle - pausing on a real timer, waiting on a resolution that never
  // comes - performs no filesystem operation at all, so nothing calls the hook. It
  // is unreferenced so it can never be the reason this process stays alive.
  setInterval(check, 250).unref()

  return Object.freeze({
    check,
    watch: (r: string, e: string): void => { root = r; evidence = e },
  })
}
