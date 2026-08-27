import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Shared DB isolation: no test may reach the live book. See the setup file.
    // These tests use an in-memory SQLite database and never open Postgres, but
    // the guarantee is workspace-wide by design — a future test here must not be
    // the one exception.
    setupFiles: [fileURLToPath(new URL('../../packages/db/testing/vitest-db-isolation.ts', import.meta.url))],
    globals: true,
    environment: 'node',
  },
})
