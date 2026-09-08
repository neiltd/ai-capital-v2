import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { sharedDbTestAliases } from '../db/testing/vitest-db-resolution.js'

// THE ONE SUITE THAT NEEDS BOTH A DATABASE AND THE REAL ARCHIVE.
//
// master-archive.test.ts publishes the operator's full archive into a
// disposable test database to prove the full-scale path: it inserts every row
// once, is idempotent on an identical rerun, leaves the legacy portfolio tables
// untouched, and rolls back completely.
//
// It is separated from the ordinary integration command precisely so that
// command can run with INVESTMENT_ARCHIVE_CSV unset. Running THIS one requires
// both the two-principal test-database configuration and that variable, and it
// fails loudly rather than skipping when the variable is absent — a silent pass
// here would be indistinguishable from verified coverage.

const envFile = fileURLToPath(new URL('../../.env', import.meta.url))
if (existsSync(envFile)) {
  const wanted = new Set(['TEST_RUNTIME_DATABASE_URL', 'BOOTSTRAP_DATABASE_URL', 'TEST_DATABASE_URL'])
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match || !wanted.has(match[1]) || process.env[match[1]]) continue
    process.env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: sharedDbTestAliases() },
  test: {
    include: ['tests/integration/master-archive.test.ts'],
    globals: true,
    environment: 'node',
    globalSetup: [fileURLToPath(new URL('../db/testing/global-setup.ts', import.meta.url))],
    setupFiles: [fileURLToPath(new URL('../db/testing/vitest-db-isolation.ts', import.meta.url))],
    env: { TEST_DATABASE_URL: process.env.TEST_RUNTIME_DATABASE_URL ?? '' },
    sequence: { concurrent: false },
    fileParallelism: false,
  },
})
