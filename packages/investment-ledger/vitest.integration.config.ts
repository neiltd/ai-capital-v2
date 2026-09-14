import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { sharedDbTestAliases } from '../db/testing/vitest-db-resolution.js'

// ORDINARY POSTGRESQL INTEGRATION — a database, and nothing private.
//
// Every test reachable from here publishes FABRICATED rows, so this suite needs
// a disposable test database and no archive at all. master-archive.test.ts is
// excluded because it is the single file that reads the operator's real
// archive; it has its own config and its own command.
//
// The exclusion is deliberate rather than incidental: it is what lets this
// command run with INVESTMENT_ARCHIVE_CSV unset, which is the property that
// keeps a private financial record out of the ordinary development loop.

const envFile = fileURLToPath(new URL('../../.env', import.meta.url))
if (existsSync(envFile)) {
  const wanted = new Set(['TEST_RUNTIME_DATABASE_URL', 'BOOTSTRAP_DATABASE_URL', 'TEST_DATABASE_URL'])
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
    include: ['tests/integration/**/*.test.ts'],
    // master-archive: the single file that reads the operator's real archive.
    // tenancy/**: the V3 suite, which needs six role-specific login URLs, all
    // ten cluster roles present, and a database migrated through 001-019.
    // (`TEST_DATABASE_URL` is optional there, not a prerequisite.) Both have
    // their own config and their own script, so this command's preconditions
    // stay exactly "a disposable database, and nothing private".
    //
    // ROLE TOPOLOGY. ops/roles/000_cluster_roles.sql defines ALL TEN production
    // roles, and a database migrated through 019 needs every one of them to exist:
    // Migration 018 grants the legacy runtime privileges to ai_capital_pipeline
    // and ai_capital_claim_writer. Migration 019 separately grants
    // ai_capital_dashboard its limited `trade` read privileges. A cluster missing
    // any of those three roles cannot complete migrations 018-019.
    // ai_capital_owner and ai_capital_identity_authority are NOLOGIN and are
    // never connection identities at all.
    //
    // This suite directly authenticates SIX identities — migrator, operator,
    // importer, agent, app and a cluster administrator — and it does NOT
    // authenticate or exercise the pipeline, claim-writer or dashboard credentials.
    // Those are covered by separately authorised runtime gates: pipeline and
    // claim-writer by the S3B rehearsal, dashboard by S4B.
    exclude: ['tests/integration/master-archive.test.ts', 'tests/integration/tenancy/**'],
    globals: true,
    environment: 'node',
    globalSetup: [fileURLToPath(new URL('../db/testing/global-setup.ts', import.meta.url))],
    setupFiles: [fileURLToPath(new URL('../db/testing/vitest-db-isolation.ts', import.meta.url))],
    env: { TEST_DATABASE_URL: process.env.TEST_RUNTIME_DATABASE_URL ?? '' },
    sequence: { concurrent: false },
    // Integration files share one database. Running them one at a time keeps
    // the residue accounting deterministic and stops a rollback-isolated file
    // from being measured while a committing race test is mid-flight.
    fileParallelism: false,
  },
})
