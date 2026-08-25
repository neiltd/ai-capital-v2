import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Shared DB isolation: no test may reach the live book. See the setup file.
    // Present even where this app has no Postgres store today — the guard is
    // against the failure CLASS, and a future store must not silently inherit
    // the developer's DATABASE_URL.
    setupFiles: ['/Users/thanapold/Desktop/Projects.nosync/packages/db/testing/vitest-db-isolation.ts'],
    globals: true,
    environment: 'node',
  },
})
