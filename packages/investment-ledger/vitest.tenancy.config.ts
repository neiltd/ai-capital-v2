import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { sharedDbTestAliases } from '../db/testing/vitest-db-resolution.js'

// THE V3 TENANCY SUITE — a separately named command, deliberately.
//
// NOT RUN IN THE SOURCE-ONLY PHASE. Every file under tests/integration/tenancy
// needs a PostgreSQL cluster carrying the seven roles from
// ops/roles/000_cluster_roles.sql, a disposable database migrated 001-017, and
// SEVEN SEPARATE LOGIN URLs — one per role. That is a materially larger
// precondition than the ordinary integration suite's single database URL, which
// is why it is its own config and its own script rather than more files under
// the existing one.
//
// WHY SEPARATE LOGINS RATHER THAN `SET ROLE`. The authorization functions
// resolve the caller from `session_user`, which SET ROLE does not change. A
// suite that switched roles inside one connection would be exercising a
// different mechanism from the one production uses, and would pass while
// production failed. That is the whole reason these tests exist, so the setup
// cost is not negotiable.
//
// Required environment (all seven URLs; each is asserted at connect time
// against `session_user`, so a mis-pointed URL fails loudly rather than
// quietly testing the wrong role):
//   TENANCY_MIGRATOR_DATABASE_URL   ai_capital_migrator
//   TENANCY_IMPORTER_DATABASE_URL   ai_capital_importer
//   TENANCY_AGENT_DATABASE_URL      ai_capital_agent
//   TENANCY_APP_DATABASE_URL        ai_capital_app
//   TENANCY_OPERATOR_DATABASE_URL   ai_capital_operator
//   TENANCY_ADMIN_DATABASE_URL      a cluster administrator, for seeding only
//   TEST_DATABASE_URL               the same disposable database, for the
//                                   support.ts allowlist check
//
// AND `TENANCY_PHASE`, which has NO DEFAULT. The suite is run TWICE against one
// database, because some facts are true only before
// ops/bootstrap/090_post_migration_lockdown.sql and the rest only after it:
//
//   TENANCY_PHASE=pre-lockdown   ... after migrations, before 090
//   TENANCY_PHASE=post-lockdown  ... after 090
//
// Files declare their phase with `describeInPhase` and are skipped in the
// other. Guessing a default would let a post-lockdown run report success on a
// database that was never locked down — the single most consequential thing
// this directory exists to detect. See tests/integration/tenancy/phase.ts.
//
// The database must be one of the explicitly authorized disposable names in
// tests/integration/support.ts. That check is made from inside each connection
// via `current_database()`, not by parsing a URL.

const envFile = fileURLToPath(new URL('../../.env', import.meta.url))
if (existsSync(envFile)) {
  const wanted = new Set([
    'TENANCY_MIGRATOR_DATABASE_URL', 'TENANCY_IMPORTER_DATABASE_URL',
    'TENANCY_AGENT_DATABASE_URL', 'TENANCY_APP_DATABASE_URL',
    'TENANCY_OPERATOR_DATABASE_URL', 'TENANCY_ADMIN_DATABASE_URL',
    'TEST_DATABASE_URL', 'TENANCY_PHASE',
  ])
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match || !wanted.has(match[1]) || process.env[match[1]]) continue
    process.env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: sharedDbTestAliases() },
  test: {
    include: ['tests/integration/tenancy/**/*.test.ts'],
    globals: true,
    environment: 'node',
    setupFiles: [fileURLToPath(new URL('../db/testing/vitest-db-isolation.ts', import.meta.url))],
    sequence: { concurrent: false },
    // These files seed and read shared identity rows and install a temporary
    // control policy. Running them one at a time keeps that deterministic.
    fileParallelism: false,
    // Role setup, migration and seeding are slower than the ordinary suite.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
