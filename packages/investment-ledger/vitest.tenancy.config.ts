import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { sharedDbTestAliases } from '../db/testing/vitest-db-resolution.js'

// THE V3 TENANCY SUITE — a separately named command, deliberately.
//
// NOT RUN IN THE SOURCE-ONLY PHASE. Every file under tests/integration/tenancy
// needs a PostgreSQL cluster carrying all ten production roles from
// ops/roles/000_cluster_roles.sql, a disposable database migrated 001-019, and
// SIX ROLE-SPECIFIC LOGIN URLs — the six `TENANCY_*_DATABASE_URL` values, one
// per identity this suite opens a connection as. That is a materially larger
// precondition than the ordinary integration suite's single database URL, which
// is why it is its own config and its own script rather than more files under
// the existing one.
//
// ROLE TOPOLOGY. ops/roles/000_cluster_roles.sql defines ALL TEN production
// roles, and a database migrated through 019 needs every one of them to exist:
// Migration 018 grants the legacy runtime privileges to ai_capital_pipeline and
// ai_capital_claim_writer. Migration 019 separately grants ai_capital_dashboard
// its limited `trade` read privileges. A cluster missing any of those three
// roles cannot complete migrations 018-019. ai_capital_owner and
// ai_capital_identity_authority are NOLOGIN and are never connection identities
// at all.
//
// This suite directly authenticates SIX identities — migrator, operator,
// importer, agent, app and a cluster administrator — and it does NOT
// authenticate or exercise the pipeline, claim-writer or dashboard credentials.
// Those are covered by separately authorised runtime gates: pipeline and
// claim-writer by the S3B rehearsal, dashboard by S4B.
//
// WHY SEPARATE LOGINS RATHER THAN `SET ROLE`. The authorization functions
// resolve the caller from `session_user`, which SET ROLE does not change. A
// suite that switched roles inside one connection would be exercising a
// different mechanism from the one production uses, and would pass while
// production failed. That is the whole reason these tests exist, so the setup
// cost is not negotiable.
//
// Required environment — the six role-specific URLs below. `connectAs` asserts
// TWO different things about them, and the difference is deliberate:
//
//   * ALL SIX are checked, from inside the connection, to be pointing at a
//     disposable database (`current_database()`, never the URL text), so a URL
//     that resolves somewhere unexpected — a service alias, a pooler, a
//     `PGDATABASE` default — cannot slip past.
//   * THE FIVE NAMED APPLICATION ROLES are additionally checked against their
//     expected `session_user`, so a mis-pointed URL fails loudly rather than
//     quietly testing the wrong role.
//   * THE ADMINISTRATOR IS EXEMPT from that second check, on purpose: it is a
//     cluster administrator for seeding, and this suite does not require it to
//     authenticate under any fixed `ai_capital_admin` name.
//
//   TENANCY_MIGRATOR_DATABASE_URL   ai_capital_migrator
//   TENANCY_IMPORTER_DATABASE_URL   ai_capital_importer
//   TENANCY_AGENT_DATABASE_URL      ai_capital_agent
//   TENANCY_APP_DATABASE_URL        ai_capital_app
//   TENANCY_OPERATOR_DATABASE_URL   ai_capital_operator
//   TENANCY_ADMIN_DATABASE_URL      a cluster administrator, for seeding only —
//                                   no fixed username is asserted
//
// `TEST_DATABASE_URL` is OPTIONAL for this suite. The loader below preserves it
// if it is supplied, but no tenancy test requires its original value, and
// tests/integration/tenancy/migration-prelockdown.test.ts temporarily replaces
// it with the migrator URL and then restores or deletes it.
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
