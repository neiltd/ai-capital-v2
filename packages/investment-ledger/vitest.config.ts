import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedDbTestAliases } from '../db/testing/vitest-db-resolution.js'

// THE DEFAULT SUITE — portable, and the one `pnpm test` runs.
//
// It must pass on any machine with no environment at all: no DATABASE_URL, no
// TEST_DATABASE_URL, no TEST_RUNTIME_DATABASE_URL, no BOOTSTRAP_DATABASE_URL and
// no INVESTMENT_ARCHIVE_CSV. It opens no database and reads no private data —
// the CLI process cases run against the committed synthetic fixture.
//
// WHY THE DEFAULT LIVES IN vitest.config.ts. The workspace-wide isolation guard
// (packages/db/tests/isolation-coverage.test.ts) resolves EVERY package's
// vitest.config.ts and requires it to load the shared DB isolation setup, and it
// refuses a `test` script that names some other config — because
// `vitest run --config alt.config.ts` would satisfy every structural assertion
// while running a config that has none. Making the portable suite the default
// config, rather than a redirect target, satisfies that guard as written instead
// of asking it to make an exception. The guard is unchanged.
//
// The setup file is still loaded even though nothing here needs Postgres. It is
// a guard, not a connector: it strips any credential in the environment that
// points at a protected live database. Loading it costs nothing and means the
// default command cannot become a hole if a unit test later grows a store.
//
// The database and real-archive suites are separate, explicitly named configs:
//   vitest.integration.config.ts      ordinary PostgreSQL integration
//   vitest.master-archive.config.ts   the one suite that reads the real archive
//   vitest.archive.config.ts          file-level assertions on the real archive
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Vite resolves bare specifiers against THIS root, so the shared db harness
  // cannot find its own `pg-connection-string` from here. See
  // packages/db/testing/vitest-db-resolution.ts.
  resolve: { alias: sharedDbTestAliases() },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    globals: true,
    environment: 'node',
    setupFiles: [fileURLToPath(new URL('../db/testing/vitest-db-isolation.ts', import.meta.url))],
  },
})
