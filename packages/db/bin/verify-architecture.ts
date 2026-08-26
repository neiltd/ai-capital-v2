#!/usr/bin/env tsx
/**
 * Standalone architectural verification — runs OUTSIDE vitest on purpose.
 *
 * The connection-centralisation property was previously enforced only by a
 * vitest meta-test. That is circular for an invariant whose whole point is to
 * hold in NON-test execution: if someone disables the suite, the property that
 * protects production disappears with it. This binary is checkable from a
 * shell, a hook, or CI with no test runner involved.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  findRawConstructions, findDeadTestFiles, CANONICAL_CONNECTION_MODULE,
} from '../testing/architecture-checks.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let failed = false

const raw = findRawConstructions(REPO)
console.log(`checking every Postgres constructor routes through ${CANONICAL_CONNECTION_MODULE}`)
if (raw.length) {
  failed = true
  console.log('  FAIL  direct construction outside the canonical connection module:')
  for (const f of raw) console.log(`          ${f}`)
} else {
  console.log('  ok    no direct pg.Pool/pg.Client construction outside the factory')
  console.log('  ok    no alternate Postgres driver imported anywhere')
}

const dead = findDeadTestFiles(REPO)
console.log('\nchecking no test file is silently dead')
if (dead.length) {
  failed = true
  console.log('  FAIL  these test files cannot load, so their tests never run:')
  for (const f of dead) console.log(`          ${f}`)
} else {
  console.log('  ok    every relative import in every test file resolves')
}

console.log(failed ? '\nArchitecture check FAILED.' : '\nConnection architecture centralized.')
process.exit(failed ? 1 : 0)
