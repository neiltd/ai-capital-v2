import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    // Shared DB isolation: no test may reach the live book. See the setup file.
    setupFiles: [fileURLToPath(new URL('../../packages/db/testing/vitest-db-isolation.ts', import.meta.url))],

    environment: 'node',
    globals: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
})
