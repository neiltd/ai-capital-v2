import { it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Client } from 'pg'
import {
  connectAs, ensurePrincipals, seedWorkspace, grantCapability, beginAuthorized,
  rollback, probeDetached, INSUFFICIENT_PRIVILEGE,
} from './fixture.js'
import { describeInPhase } from './phase.js'

// PHASE 2 — THE MIGRATION WINDOW IS CLOSED.
//
// INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// Runs against the same database as
// migration-prelockdown.test.ts, after
// ops/bootstrap/090_post_migration_lockdown.sql has been applied.
//
// Every assertion here is the NEGATION of one in the pre-lockdown file. That is
// the point of splitting them: "the migrator holds CREATE" and "the migrator
// does not hold CREATE" are both required, and both true — at different moments
// in the database's life. A suite that tried to hold both would have to drop
// one, and the one that got dropped would be whichever was inconvenient.

const OPS = resolve(dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', '..', 'ops')

const APP_SCHEMAS = ['identity', 'investment_ledger', 'cash_ledger', 'portfolio', 'db']

describeInPhase('post-lockdown', 'lockdown closed the window', () => {
  let migrator: Client
  let admin: Client
  beforeAll(async () => {
    migrator = await connectAs('migrator')
    // The resolver proof below needs a workspace and a grant, and identity is
    // deliberately unreachable from every runtime role.
    admin = await connectAs('admin')
  })
  afterAll(async () => {
    await admin?.end()
    await migrator?.end()
  })

  it('both role memberships are gone', async () => {
    const { rows } = await migrator.query<{ granted: string }>(
      `SELECT granted.rolname AS granted
         FROM pg_auth_members m
         JOIN pg_roles granted ON granted.oid = m.roleid
         JOIN pg_roles grantee ON grantee.oid = m.member
        WHERE grantee.rolname = 'ai_capital_migrator'`)
    expect(rows.map(r => r.granted)).toEqual([])
  })

  it('the migrator can no longer assume the owner', async () => {
    // The membership row is gone; this proves the consequence rather than the
    // catalogue state, because a leftover grant elsewhere in the graph would
    // still let SET ROLE succeed.
    const result = await probeDetached(migrator, () =>
      migrator.query('SET ROLE ai_capital_owner'))
    expect(result.code).toBe('42501')
  })

  it('the migrator has lost CREATE on the database', async () => {
    const { rows } = await migrator.query<{ ok: boolean }>(
      "SELECT has_database_privilege(session_user, current_database(), 'CREATE') AS ok")
    expect(rows[0].ok).toBe(false)
  })

  it('a further migration is REFUSED: the migrator cannot create anything', async () => {
    // The concrete consequence. `runMigrations()` is not called here because
    // with all eighteen already recorded it would be a no-op and would prove
    // nothing either way; what a NEW migration would actually hit is this.
    const result = await probeDetached(migrator, () =>
      migrator.query('CREATE TABLE db.probe_after_lockdown (id int)'))
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('...and cannot create a schema either', async () => {
    const result = await probeDetached(migrator, () =>
      migrator.query('CREATE SCHEMA probe_after_lockdown'))
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('reopening the window is a DELIBERATE, documented act', async () => {
    // The refusal above is only acceptable because there is a defined way back:
    // re-running 010_database_bootstrap.sql restores CREATE and the two SET-only
    // memberships. Asserted against the ops source, so "the window can be
    // reopened" is a fact about a file somebody must choose to run — not folklore.
    const bootstrap = readFileSync(join(OPS, 'bootstrap', '010_database_bootstrap.sql'), 'utf-8')
    expect(bootstrap).toMatch(/GRANT CREATE ON DATABASE :"dbname" TO ai_capital_migrator;/)
    expect(bootstrap).toMatch(
      /GRANT ai_capital_owner\s+TO ai_capital_migrator WITH INHERIT FALSE, SET TRUE;/)
    expect(bootstrap).toMatch(
      /GRANT ai_capital_identity_authority TO ai_capital_migrator WITH INHERIT FALSE, SET TRUE;/)

    const lockdown = readFileSync(join(OPS, 'bootstrap', '090_post_migration_lockdown.sql'), 'utf-8')
    expect(lockdown).toMatch(/REVOKE CREATE ON DATABASE :"dbname" FROM ai_capital_migrator;/)
    expect(lockdown).toMatch(/REVOKE ai_capital_owner\s+FROM ai_capital_migrator;/)
    expect(lockdown).toMatch(/REVOKE ai_capital_identity_authority FROM ai_capital_migrator;/)
  })

  it('the migration ledger is still READABLE after lockdown', async () => {
    // Reading a closed ledger is not a window privilege: "which migrations are
    // applied, and with what hashes" must be answerable at any time.
    const { rows } = await migrator.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM db.schema_migrations')
    expect(rows[0].n).toBe(18)
    const readable = await migrator.query<{ ok: boolean }>(
      "SELECT has_table_privilege(session_user, 'db.schema_migrations', 'SELECT') AS ok")
    expect(readable.rows[0].ok, 'the migrator must still be able to read the ledger').toBe(true)
  })

  it('the migration ledger is NOT appendable after lockdown', async () => {
    // THE DEFECT THIS REPLACES. 010 granted `SELECT, INSERT` permanently and
    // 090 retained both, so a CLOSED window still admitted a row into
    // db.schema_migrations — a deployment login could record that a migration
    // ran when it could not have. The ledger is exactly the artefact that must
    // not be writable outside a window, because every downstream check trusts
    // it to say what the schema is.
    const priv = await migrator.query<{ ok: boolean }>(
      "SELECT has_table_privilege(session_user, 'db.schema_migrations', 'INSERT') AS ok")
    expect(priv.rows[0].ok, 'ledger INSERT must not survive lockdown').toBe(false)

    // The privilege bit alone is not the claim — the statement must actually be
    // refused, with the authorization error and not some other failure.
    const result = await probeDetached(migrator, () =>
      migrator.query(
        `INSERT INTO db.schema_migrations (filename, sha256)
         VALUES ($1, repeat('0', 64))`,
        [`999_forged_after_lockdown_${Date.now()}.sql`]))
    expect(result.code, `${result.message}`).toBe(INSUFFICIENT_PRIVILEGE)
    expect(result.message ?? '').toMatch(/permission denied/i)

    // NON-VACUITY: the row must not have landed by any path.
    const { rows } = await migrator.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM db.schema_migrations')
    expect(rows[0].n, 'the ledger row count changed').toBe(18)
  })

  it('the authority lost CREATE and KEPT USAGE on both schemas', async () => {
    // The half that is easy to get backwards, and the half that only shows up
    // at the first import after lockdown. `resolve_or_create_instrument` is
    // SECURITY DEFINER: without USAGE for its owner it can exist and never run.
    const { rows } = await migrator.query<{
      identity_create: boolean; identity_usage: boolean
      ledger_create: boolean; ledger_usage: boolean
    }>(
      `SELECT has_schema_privilege('ai_capital_identity_authority','identity','CREATE') AS identity_create,
              has_schema_privilege('ai_capital_identity_authority','identity','USAGE')  AS identity_usage,
              has_schema_privilege('ai_capital_identity_authority','investment_ledger','CREATE') AS ledger_create,
              has_schema_privilege('ai_capital_identity_authority','investment_ledger','USAGE')  AS ledger_usage`)
    expect(rows[0].identity_create).toBe(false)
    expect(rows[0].ledger_create).toBe(false)
    expect(rows[0].identity_usage, 'identity USAGE must survive lockdown').toBe(true)
    expect(rows[0].ledger_usage, 'ledger USAGE must survive lockdown').toBe(true)
  })

  it('the resolver still RUNS AND WRITES, which is what USAGE was for', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // THE PREVIOUS VERSION OF THIS TEST PROVED NOTHING.
    //
    // It called the resolver with the nil workspace and asserted 42501 with a
    // message that was not "permission denied for schema". But the resolver's
    // FIRST statement is `authorize_service_workspace_any`, which raises 42501
    // for an ungranted workspace — so the function aborted before it ever
    // touched `investment_ledger.instruments`. Removing the USAGE grant
    // entirely would not have changed the result by one character, which makes
    // it a test of the authorizer wearing the label of a test of USAGE.
    //
    // The repaired shape reaches the table. It authorizes NORMALLY in a
    // workspace the importer actually holds, then resolves a key that has never
    // existed, so the function must:
    //     resolve `investment_ledger.instruments`   → schema USAGE, for the
    //                                                 FUNCTION OWNER
    //     SELECT it                                  → the authority's column
    //                                                 SELECT grant
    //     INSERT into it                             → the authority's column
    //                                                 INSERT grant
    // Remove any one of those three and this test fails with 42501 and a
    // "permission denied for ..." message. That is the property finding 1 asked
    // for, and the assertions below name it explicitly.
    //
    // The work is rolled back. The resolver still executed — which is what the
    // privileges gate — and the global `instruments` table is append-only and
    // shared, so leaving a row behind on every run would be residue nothing can
    // ever remove.
    // ─────────────────────────────────────────────────────────────────────────
    const importer = await connectAs('importer')
    try {
      const principals = await ensurePrincipals(admin)
      const workspace = await seedWorkspace(admin, 'resolver-after-lockdown')
      await grantCapability(admin, workspace, principals.importer, 'archive-import',
        principals.grantor)

      const asset = `PROBE-${randomUUID().slice(0, 8).toUpperCase()}`
      const expectedKey = `THB:NO_EXCHANGE:${asset}`

      await beginAuthorized(importer, workspace.id, ['archive-import'])
      try {
        // Never resolved before, so the INSERT branch is the one taken.
        const pre = await importer.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM investment_ledger.instruments WHERE canonical_key = $1',
          [expectedKey])
        expect(pre.rows[0].n, 'the probe key must be genuinely new').toBe(0)

        const resolved = await importer.query<{ id: string }>(
          `SELECT investment_ledger.resolve_or_create_instrument(
                    'BUY', 'Probe Broker', 'THB', '', $2, $1::uuid) AS id`,
          [workspace.id, asset])
        expect(resolved.rows[0].id, 'the resolver returned no instrument').toBeTruthy()

        // VERIFY THE RESULT, not just the absence of an error. A function that
        // returned a uuid without writing would satisfy the call and fail here.
        const { rows } = await importer.query<{
          id: string; canonical_key: string; display_name: string; instrument_type: string
        }>(
          `SELECT id, canonical_key, display_name, instrument_type
             FROM investment_ledger.instruments WHERE canonical_key = $1`,
          [expectedKey])
        expect(rows, 'the resolver did not create the instrument').toHaveLength(1)
        expect(rows[0].id).toBe(resolved.rows[0].id)
        expect(rows[0].canonical_key).toBe(expectedKey)
        expect(rows[0].display_name).toBe(asset)
        expect(rows[0].instrument_type).toBe('equity')

        // Idempotent: the second call takes the SELECT branch and returns the
        // same row, which is the behaviour publishArchive depends on.
        const again = await importer.query<{ id: string }>(
          `SELECT investment_ledger.resolve_or_create_instrument(
                    'BUY', 'Probe Broker', 'THB', '', $2, $1::uuid) AS id`,
          [workspace.id, asset])
        expect(again.rows[0].id).toBe(resolved.rows[0].id)
      } finally {
        await rollback(importer)
      }
    } finally {
      await importer.end()
    }
  }, 60_000)

  it('the resolver refuses a workspace the caller was not granted', async () => {
    // The authorization half, stated SEPARATELY so neither test is mistaken for
    // the other. This one is about the capability check; the one above is about
    // schema and table privileges.
    const importer = await connectAs('importer')
    try {
      const ungranted = await seedWorkspace(admin, 'resolver-ungranted')
      const result = await probeDetached(importer, () =>
        importer.query(
          `SELECT investment_ledger.resolve_or_create_instrument(
                    'BUY','Probe Broker','THB','','DENIED', $1::uuid)`,
          [ungranted.id]))
      expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(result.message ?? '').toMatch(/holds none of/)
      // If USAGE were missing this would say "permission denied for schema"
      // instead — a different bug with the same SQLSTATE, which is exactly why
      // the test above cannot be replaced by this one.
      expect(result.message ?? '').not.toMatch(/permission denied for/)
    } finally {
      await importer.end()
    }
  })

  it('no LOGIN role owns anything in the application schemas', async () => {
    // REASSIGN OWNED's job, and the assertion that makes every privilege
    // assertion elsewhere meaningful: ownership outranks every ACL, because an
    // owner may ALTER, DROP and GRANT on its own objects whatever has been
    // revoked.
    //
    // ALL THREE CATALOGUES THAT CARRY OWNERSHIP. An earlier version asked only
    // `pg_class`, which would have reported a clean result on a database where
    // a LOGIN role owned the `identity` SCHEMA itself — the worst of the three,
    // since a schema's owner may CREATE in it and DROP it outright.
    // ownership-and-acl.test.ts checks the same three in detail and also
    // asserts WHICH role owns what; this is the summary, restated here so the
    // post-lockdown phase carries its own proof.
    const schemas = await migrator.query<{ name: string; owner: string }>(
      `SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner
         FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
        WHERE n.nspname = ANY($1) AND r.rolcanlogin ORDER BY 1`,
      [APP_SCHEMAS])
    expect(schemas.rows.map(r => `schema ${r.name} -> ${r.owner}`)).toEqual([])

    const functions = await migrator.query<{ name: string; owner: string }>(
      `SELECT n.nspname || '.' || p.proname AS name, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = ANY($1) AND r.rolcanlogin
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY 1`,
      [APP_SCHEMAS])
    expect(functions.rows.map(r => `function ${r.name} -> ${r.owner}`)).toEqual([])

    const relations = await migrator.query<{ name: string; kind: string; owner: string }>(
      `SELECT n.nspname || '.' || c.relname AS name, c.relkind AS kind,
              pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = ANY($1) AND r.rolcanlogin
          AND c.relkind IN ('r','v','m','S','i','p','I')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.objid = c.oid AND d.deptype = 'e')
        ORDER BY 1`,
      [APP_SCHEMAS])
    expect(relations.rows.map(r => `${r.name} (${r.kind}) -> ${r.owner}`)).toEqual([])

    // NON-VACUITY: the three queries must have had something to look at.
    const totals = await migrator.query<{ schemas: number; functions: number; relations: number }>(
      `SELECT (SELECT count(*)::int FROM pg_namespace WHERE nspname = ANY($1)) AS schemas,
              (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = ANY($1)) AS functions,
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = ANY($1) AND c.relkind = 'r') AS relations`,
      [APP_SCHEMAS])
    expect(totals.rows[0].schemas).toBe(APP_SCHEMAS.length)
    expect(totals.rows[0].functions).toBeGreaterThanOrEqual(20)
    expect(totals.rows[0].relations).toBeGreaterThan(20)
  })
})
