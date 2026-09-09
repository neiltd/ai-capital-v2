import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// THE POSTGRES INTEGRATION SUITE — the only ordinary @common/db command that
// prepares or touches a database, and it is named for that.
//
// PRECONDITIONS, all supplied FROM THE SHELL and never from a file:
//
//   BOOTSTRAP_DATABASE_URL      privileged; creates the database, runs
//                               ops/bootstrap/010, migrations and 090
//   TEST_RUNTIME_DATABASE_URL   restricted; the ONLY credential workers see
//
// Both must name the same explicitly disposable database. testing/global-setup.ts
// enforces every one of those conditions and fails closed otherwise.
//
// WHY NOTHING IS READ FROM .env. A privileged credential that can arrive
// implicitly cannot be refused by the caller. The 2026-09-08 incident began
// exactly there: the default config re-read .env after the shell had scrubbed
// it, so `env -u …` was powerless and an ordinary `test` invocation acquired
// bootstrap authority it never asked for.
//
// ops/roles/000_cluster_roles.sql is a CLUSTER PREREQUISITE, not something a
// test command runs. global-setup verifies the roles exist and stops if they do
// not; creating cluster roles needs authority no test suite should hold.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    globalSetup: [fileURLToPath(new URL('./testing/global-setup.ts', import.meta.url))],
    // Retained here too: workers must still have an inherited DATABASE_URL
    // cleared even when a test database is legitimately in play.
    setupFiles: [fileURLToPath(new URL('./testing/vitest-db-isolation.ts', import.meta.url))],
    env: {
      // WORKERS GET THE RESTRICTED CREDENTIAL AND NOTHING ELSE. `test.env` is
      // handed to every worker, so a bootstrap URL placed here would be
      // readable by test code — the authority leak this split exists to close.
      // globalSetup runs in the main process and reads the shell directly.
      TEST_DATABASE_URL: process.env.TEST_RUNTIME_DATABASE_URL ?? '',
    },
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
