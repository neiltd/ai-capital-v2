import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// ARCHIVE SUITE — explicitly run, never part of the default test command.
//
// These tests read the operator's real archive, named only through
// INVESTMENT_ARCHIVE_CSV. They require no database: every assertion is about the
// FILE, so this config deliberately loads none of the db harness. If the
// variable is absent the suite FAILS with a clear message rather than skipping,
// because a silent pass here would look exactly like verified coverage.
//
// Their assertions are PROPERTIES recomputed from the file at run time — never
// a value copied out of it — so nothing private is committed to hold them.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { globals: true, environment: 'node', include: ['tests/archive/**/*.test.ts'] },
})
