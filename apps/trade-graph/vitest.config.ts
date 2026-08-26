import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Shared DB isolation: no test may reach the live book. See the setup file.
    // NOTE (corrected 2026-08-26): an earlier version of this comment claimed
    // this app "has no Postgres store today". It does —
    // src/store/trade-store.ts:39 writes through getPool(). The isolation
    // setup is load-bearing here, not precautionary.
    setupFiles: [fileURLToPath(new URL('../../packages/db/testing/vitest-db-isolation.ts', import.meta.url))],

    // This package has TEN source files and ZERO test files, including a
    // Postgres store. `vitest run` therefore exited 1 on every workspace run,
    // which is why `pnpm -r test` needed --no-bail to be readable — a
    // permanently-red suite trains people to ignore red.
    //
    // Passing with no tests is NOT an endorsement: it is recorded as a known
    // coverage gap in packages/db/testing/architecture-checks.ts, and the
    // meta-test fails if that list grows. Absence stays visible instead of
    // becoming either a false green or permanent noise.
    passWithNoTests: true,
    globals: true,
    environment: 'node',
  },
})
