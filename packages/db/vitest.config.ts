import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// THE DATABASE-FREE SUITE. This config opens no PostgreSQL connection, and it
// is the one `pnpm --filter @common/db test` uses.
//
// WHAT IT USED TO DO, AND WHY THAT WAS WRONG. This file previously called a
// `loadTestCredentialsFromDotEnv()` helper that read the root `.env` and
// repopulated TEST_RUNTIME_DATABASE_URL / BOOTSTRAP_DATABASE_URL /
// TEST_DATABASE_URL, and then registered a `globalSetup` that created and
// migrated a database. Two consequences, both bad:
//
//   1. `pnpm --filter @common/db test` was a PostgreSQL integration suite
//      wearing the name of an ordinary unit command. On 2026-09-08 it reached
//      ai_capital_test and attempted migration 011.
//   2. Because the credential came from a FILE, a caller could not opt out.
//      `env -u DATABASE_URL … pnpm --filter @common/db test` did not work and
//      could not work: the config re-read .env after the shell had scrubbed it.
//
// So: no .env read, no globalSetup, no credentials of any kind. A command that
// prepares or uses a database now says so in its name — see
// vitest.integration.config.ts and the `test:integration` script.
//
// The isolation setup file is deliberately RETAINED. It is what clears an
// inherited DATABASE_URL from every worker, and tests/isolation-coverage.test.ts
// asserts workspace-wide that every package loads it. A database-free suite
// still benefits: it proves the guard holds even where no database is expected.
export default defineConfig({
  test: {
    // EXPLICIT BOUNDARY. Only the files directly under tests/ are database-free.
    // tests/integration/** is excluded by construction, so adding a future
    // integration test cannot silently join this suite — it simply will not be
    // collected here, and tests/harness-contract.test.ts asserts that.
    include: ['tests/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/integration/**'],
    setupFiles: [fileURLToPath(new URL('./testing/vitest-db-isolation.ts', import.meta.url))],
    globals: true,
    environment: 'node',
  },
})
