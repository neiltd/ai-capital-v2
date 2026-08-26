import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// This package's own tests exercise real Postgres (the claim lifecycle, the
// constraints, the immutability trigger). They must never touch the live book,
// so they run against a throwaway database.
//
// Derived from DATABASE_URL rather than hardcoded, so it follows whatever host
// and credentials the developer already uses — with the database name swapped.
// This file is evaluated before the isolation setup clears DATABASE_URL.
function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL
  const live = process.env.DATABASE_URL
  if (live) {
    try {
      const u = new URL(live)
      const name = u.pathname.replace(/^\//, '')
      if (name && !name.endsWith('_test')) {
        u.pathname = `/${name}_test`
        return u.toString()
      }
      return live
    } catch { /* fall through */ }
  }
  return 'postgres://localhost:5432/ai_capital_test'
}

export default defineConfig({
  test: {
    // Shared DB isolation: no test may reach the live book. See the setup file.
    // Runs once before any test file: creates the throwaway database if it is
    // absent, migrates it, verifies the schema, and FAILS CLOSED at every step.
    // A fresh clone therefore needs no manual `createdb`.
    globalSetup: [fileURLToPath(new URL('./testing/global-setup.ts', import.meta.url))],
    setupFiles: [fileURLToPath(new URL('./testing/vitest-db-isolation.ts', import.meta.url))],
    env: {
      // Workers get ONLY the restricted runtime credential. `test.env` is
      // applied per-worker from this config and overrides anything globalSetup
      // sets on process.env — which silently kept the privileged URL in play
      // until the privilege regression test caught it.
      TEST_DATABASE_URL: process.env.TEST_RUNTIME_DATABASE_URL ?? '',
      // NOTHING privileged goes here. `test.env` is handed to every worker, so
      // a bootstrap URL placed here would be readable by test code — which is
      // the authority problem this phase exists to remove. globalSetup runs in
      // the main process and reads the shell environment directly instead.
    },
    globals: true,
    environment: 'node',
  },
})
