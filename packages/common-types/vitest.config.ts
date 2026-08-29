import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Shared DB isolation: no test may reach the live book. These tests are pure
    // functions over provenance and open nothing, but the guarantee is
    // workspace-wide by design — a future test here must not be the exception.
    setupFiles: [fileURLToPath(new URL('../../packages/db/testing/vitest-db-isolation.ts', import.meta.url))],
    globals: true,
    environment: 'node',
  },
})
