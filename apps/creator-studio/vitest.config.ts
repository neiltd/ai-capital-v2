import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    // Shared DB isolation: no test may reach the live book. See the setup file.
    setupFiles: ['/Users/thanapold/Desktop/Projects.nosync/packages/db/testing/vitest-db-isolation.ts'],

    environment: 'node',
    globals: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
})
