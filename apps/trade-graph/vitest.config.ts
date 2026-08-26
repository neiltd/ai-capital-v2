import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Shared DB isolation: no test may reach the live book. See the setup file.
    // Present even where this app has no Postgres store today — the guard is
    // against the failure CLASS, and a future store must not silently inherit
    // the developer's DATABASE_URL.
    setupFiles: [fileURLToPath(new URL('../../packages/db/testing/vitest-db-isolation.ts', import.meta.url))],
    globals: true,
    environment: 'node',
  },
})
