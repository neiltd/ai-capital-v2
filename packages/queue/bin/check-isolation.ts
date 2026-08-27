#!/usr/bin/env tsx
/**
 * Decide the environment mode for a shell entry point, or refuse.
 *
 * Prints one word — `production` or `isolated` — and exits 0. Exits non-zero
 * with an explanation when the environment is PARTIALLY isolated, which is
 * forbidden.
 *
 * Shell scripts call this BEFORE doing anything, so a partially isolated
 * watchdog cannot reach the point of loading a real LINE token.
 */
import { decideIsolation } from '../src/isolation.js'

async function main() {
  try {
    const d = await decideIsolation()
    if (process.argv.includes('--verbose')) for (const r of d.reasons) console.error(`  ${r}`)
    console.log(d.mode)
    process.exit(0)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(2)
  }
}
main()
