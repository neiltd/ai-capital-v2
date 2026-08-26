import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Shared DB isolation: no test may reach the live book. See the setup file.
    setupFiles: [fileURLToPath(new URL('../../packages/db/testing/vitest-db-isolation.ts', import.meta.url))],

    globals: true,
    environment: 'node',
  },
})
