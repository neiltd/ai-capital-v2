import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// THE DISPOSABLE-CLUSTER SUITE — the only @common/db command that starts a
// PostgreSQL server, and it starts one it built itself.
//
// WHY A THIRD CONFIG. `vitest.config.ts` is database-free by contract and
// `vitest.integration.config.ts` requires two credentials from the shell for a
// database somebody else prepared. Neither describes this: these tests need a
// live PostgreSQL to assert live behaviour, and must never be pointed at one
// that matters. So the suite brings its own cluster, on its own Unix socket,
// with NO TCP listener, and removes it afterwards.
//
// NO CREDENTIAL IS READ OR ACCEPTED. There is no globalSetup, no env block and
// nothing this config could be aimed at. `testing/disposable-cluster.ts` is the
// only way in, and it only knows how to build a cluster from nothing.
export default defineConfig({
  test: {
    include: ['tests/pgcopy/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    setupFiles: [fileURLToPath(new URL('./testing/vitest-db-isolation.ts', import.meta.url))],
    globals: true,
    environment: 'node',
    // initdb + start + teardown, twice, plus the fixture.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Two clusters at once is enough; more would fight for the same CPU.
    fileParallelism: false,
  },
})
