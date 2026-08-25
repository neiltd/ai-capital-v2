import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Shared DB isolation: no test may reach the live book. See the setup file.
    setupFiles: ['/Users/thanapold/Desktop/Projects.nosync/packages/db/testing/vitest-db-isolation.ts'],

    globals: true,
    environment: 'node',
  },
})
