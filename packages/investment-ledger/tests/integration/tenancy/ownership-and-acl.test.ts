import { it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connectAs, ALL_PRODUCTION_ROLES, LOGIN_ROLES } from './fixture.js'
import { describeInPhase } from './phase.js'

// FINAL OBJECT OWNERSHIP AND POST-LOCKDOWN ACLs.
//
// INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// Requires ops/bootstrap/090_post_migration_lockdown.sql
// to have been applied to the target database.
//
// THE CLAIM UNDER TEST: after lockdown, no LOGIN role owns an application
// object, and no LOGIN role can regain control of one. Ownership is not an ACL
// — an owner may ALTER, DROP and GRANT on its own objects regardless of what
// has been revoked — so this is the assertion that makes every other privilege
// assertion in this directory meaningful.
//
// SCOPE, stated because a previous version of this test was wrong about it:
// only the APPLICATION schemas are examined. PostgreSQL's own catalogues,
// `information_schema`, and objects belonging to extensions (btree_gist,
// pgcrypto, vector) are owned by the bootstrap superuser by construction and
// are not this system's to reassign. Including them produced a failure that
// said nothing about the design.

const APP_SCHEMAS = ['identity', 'investment_ledger', 'cash_ledger', 'portfolio', 'db']

describeInPhase('post-lockdown', 'object ownership and final ACLs', () => {
  let migrator: Client
  beforeAll(async () => { migrator = await connectAs('migrator') })
  afterAll(async () => { await migrator?.end() })

  it('every table, view, sequence and index in the app schemas belongs to ai_capital_owner', async () => {
    const { rows } = await migrator.query<{ nsp: string; name: string; owner: string }>(
      `SELECT n.nspname AS nsp, c.relname AS name, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1)
          AND c.relkind IN ('r','v','m','S','i','p')
          -- Extension-owned objects are not this system's to reassign.
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.objid = c.oid AND d.deptype = 'e')
        ORDER BY n.nspname, c.relname`,
      [APP_SCHEMAS])
    expect(rows.length).toBeGreaterThan(30)
    const wrong = rows.filter(r => r.owner !== 'ai_capital_owner')
    expect(wrong.map(r => `${r.nsp}.${r.name} -> ${r.owner}`)).toEqual([])
  })

  // ── OWNERSHIP, over all three catalogues that carry it. ──────────────────
  //
  // An earlier version asked only `pg_class`. Ownership also lives in
  // `pg_namespace` (the schemas themselves) and `pg_proc` (every function), and
  // a schema owned by a LOGIN role is the worst of the three: its owner may
  // CREATE in it and DROP it whatever the table ACLs say. All three are checked
  // below, and each is checked for BOTH properties — that no LOGIN role owns
  // it, and that the role which does own it is the intended one. Either alone
  // is satisfiable by the wrong answer.

  /**
   * Functions owned by the identity authority, and the ONLY ones.
   *
   * The seven SECURITY DEFINER functions from 012 plus the resolver from 017.
   * They must be owned by the authority rather than by ai_capital_owner
   * because FORCE ROW LEVEL SECURITY removes the table owner's exemption: a
   * definer function owned by ai_capital_owner would read the identity tables
   * under default-deny and return NO ROWS — failing open-looking-closed, the
   * worst shape a security bug can take.
   */
  const AUTHORITY_FUNCTIONS = [
    'identity.assert_actor_authorized',
    'identity.authorize_service_workspace',
    'identity.authorize_service_workspace_any',
    'identity.current_service_principal',
    'identity.resolve_workspace_for_capability',
    'identity.service_has_workspace_capability',
    'identity.terminate_service_grant',
    'investment_ledger.resolve_or_create_instrument',
  ]

  it('no LOGIN role owns any application SCHEMA', async () => {
    const { rows } = await migrator.query<{ nspname: string; owner: string }>(
      `SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner
         FROM pg_namespace n
         JOIN pg_roles r ON r.oid = n.nspowner
        WHERE n.nspname = ANY($1) AND r.rolcanlogin
        ORDER BY 1`,
      [APP_SCHEMAS])
    expect(rows.map(r => `${r.nspname} -> ${r.owner}`)).toEqual([])
  })

  it('every application schema is owned by ai_capital_owner', async () => {
    const { rows } = await migrator.query<{ nspname: string; owner: string }>(
      `SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner
         FROM pg_namespace n WHERE n.nspname = ANY($1) ORDER BY 1`,
      [APP_SCHEMAS])
    // Non-vacuity: every schema must exist, or "none is misowned" is trivial.
    expect(rows.map(r => r.nspname)).toEqual([...APP_SCHEMAS].sort())
    for (const row of rows) expect(row.owner, row.nspname).toBe('ai_capital_owner')
  })

  it('no LOGIN role owns any application FUNCTION', async () => {
    const { rows } = await migrator.query<{ name: string; owner: string }>(
      `SELECT n.nspname || '.' || p.proname AS name, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = ANY($1) AND r.rolcanlogin
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY 1`,
      [APP_SCHEMAS])
    expect(rows.map(r => `${r.name} -> ${r.owner}`)).toEqual([])
  })

  it('no LOGIN role owns any application RELATION, sequence, view or index', async () => {
    const { rows } = await migrator.query<{ name: string; kind: string; owner: string }>(
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
    expect(rows.map(r => `${r.name} (${r.kind}) -> ${r.owner}`)).toEqual([])
  })

  it('the eight authority-owned functions are exactly the SECURITY DEFINER ones', async () => {
    const { rows } = await migrator.query<{ name: string; owner: string; definer: boolean }>(
      `SELECT n.nspname || '.' || p.proname AS name,
              pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY 1`,
      [APP_SCHEMAS])

    const authorityOwned = rows.filter(r => r.owner === 'ai_capital_identity_authority')
    expect(authorityOwned.map(r => r.name).sort()).toEqual([...AUTHORITY_FUNCTIONS].sort())
    for (const row of authorityOwned) {
      expect(row.definer, `${row.name} must be SECURITY DEFINER`).toBe(true)
    }

    // The set is exact in BOTH directions: every definer function is
    // authority-owned, and every authority-owned function is a definer. A
    // SECURITY DEFINER function owned by anyone else would be a privilege
    // escalation wearing the same syntax.
    const definers = rows.filter(r => r.definer)
    expect(definers.map(r => r.name).sort()).toEqual([...AUTHORITY_FUNCTIONS].sort())
  })

  it('every OTHER application function is owned by ai_capital_owner', async () => {
    // Includes `identity.grant_termination_is_one_way` and
    // `identity.reject_identity_mutation`, which 011 creates BEFORE the role
    // switch and which are deliberately NOT definer functions. An earlier
    // version of this file asserted that every function in `identity` was
    // authority-owned and a definer, which those two are not — it would have
    // failed on a correct database.
    const { rows } = await migrator.query<{ name: string; owner: string; definer: boolean }>(
      `SELECT n.nspname || '.' || p.proname AS name,
              pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY 1`,
      [APP_SCHEMAS])
    const others = rows.filter(r => !AUTHORITY_FUNCTIONS.includes(r.name))
    expect(others.length, 'no ordinary application functions were found').toBeGreaterThan(0)
    for (const row of others) {
      expect(row.owner, row.name).toBe('ai_capital_owner')
      expect(row.definer, `${row.name} must NOT be SECURITY DEFINER`).toBe(false)
    }
  })

  it('both trigger functions created by 011 are owner-owned invokers', async () => {
    // Named individually because they are the pair the previous version got
    // wrong, and because they run under FORCE RLS on tables their owner does
    // not get to bypass — which is fine, since they read only OLD and NEW.
    const { rows } = await migrator.query<{ name: string; owner: string; definer: boolean }>(
      `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'identity'
          AND p.proname IN ('grant_termination_is_one_way','reject_identity_mutation')
        ORDER BY 1`)
    expect(rows.map(r => r.name))
      .toEqual(['grant_termination_is_one_way', 'reject_identity_mutation'])
    for (const row of rows) {
      expect(row.owner, row.name).toBe('ai_capital_owner')
      expect(row.definer, row.name).toBe(false)
    }
  })

  it('the migrator has lost both role memberships', async () => {
    // REASSIGN OWNED moved the objects; these revokes stop it assuming the
    // owner again. Both halves are required: either alone leaves a path back.
    const { rows } = await migrator.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_auth_members m
         JOIN pg_roles grantee ON grantee.oid = m.member
         JOIN pg_roles granted ON granted.oid = m.roleid
        WHERE grantee.rolname = 'ai_capital_migrator'
          AND granted.rolname IN ('ai_capital_owner','ai_capital_identity_authority')`)
    expect(rows[0].n).toBe(0)
  })

  it('the migrator can no longer create anything', async () => {
    const { rows } = await migrator.query<{ ok: boolean }>(
      `SELECT has_database_privilege(session_user, current_database(), 'CREATE') AS ok`)
    expect(rows[0].ok).toBe(false)
  })

  it('the authority has lost CREATE on both schemas but KEPT USAGE', async () => {
    // Both halves, because they are revoked by adjacent lines in the same file
    // and a REVOKE ALL written in place of the two REVOKE CREATEs would look
    // tidier and would break every import — a SECURITY DEFINER function needs
    // USAGE on its schema FOR ITS OWNER at every call, forever.
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
    expect(rows[0].identity_usage).toBe(true)
    expect(rows[0].ledger_usage).toBe(true)
  })

  it('PUBLIC holds neither USAGE nor CREATE on schema public', async () => {
    // READ THE ACL, do not ask has_schema_privilege about it.
    //
    // An earlier version passed the literal 'public' as the ROLE argument.
    // PUBLIC is a pseudo-role: there is no `pg_roles` entry called `public`, so
    // that call raises `role "public" does not exist` (42704) rather than
    // answering. The test could not pass, and if the error had ever been
    // swallowed it would have looked like a privilege check.
    //
    // In the catalogue, PUBLIC is grantee OID 0. `aclexplode` turns the aclitem
    // array into rows, which is the only honest way to ask this question.
    //
    // `nspacl IS NOT NULL` is load-bearing and is asserted separately: a NULL
    // ACL means DEFAULT privileges, and the default for schema `public` grants
    // PUBLIC USAGE. So "no grantee-0 rows" is the right answer only once the
    // ACL has been materialised — which is exactly what
    // ops/bootstrap/010_database_bootstrap.sql's `REVOKE ALL ON SCHEMA public
    // FROM PUBLIC` does. Without this check, a database where that revoke never
    // ran would produce an empty result set and pass.
    const { rows } = await migrator.query<{
      nspname: string; acl_set: boolean; public_privs: string[]
    }>(
      `SELECT n.nspname,
              n.nspacl IS NOT NULL AS acl_set,
              coalesce((SELECT array_agg(a.privilege_type ORDER BY a.privilege_type)
                          FROM aclexplode(n.nspacl) a
                         WHERE a.grantee = 0), ARRAY[]::text[]) AS public_privs
         FROM pg_namespace n
        WHERE n.nspname = 'public'`)

    // NON-VACUITY: the schema row must exist. A typo'd name would otherwise
    // return zero rows and every assertion below would be skipped.
    expect(rows, 'schema public was not found in pg_namespace').toHaveLength(1)
    expect(rows[0].acl_set,
      'nspacl is NULL, so PUBLIC still holds the DEFAULT USAGE on schema public')
      .toBe(true)
    expect(rows[0].public_privs, 'PUBLIC must hold nothing on schema public').toEqual([])
  })

  it('PUBLIC holds nothing on the application schemas either', async () => {
    // Same reading, applied to the schemas this work created. `identity` and
    // `investment_ledger` were created by ai_capital_owner and never granted to
    // PUBLIC, so their ACLs should carry no grantee-0 entry at all.
    const { rows } = await migrator.query<{ nspname: string; public_privs: string[] }>(
      `SELECT n.nspname,
              coalesce((SELECT array_agg(a.privilege_type ORDER BY a.privilege_type)
                          FROM aclexplode(n.nspacl) a
                         WHERE a.grantee = 0), ARRAY[]::text[]) AS public_privs
         FROM pg_namespace n
        WHERE n.nspname = ANY($1) ORDER BY n.nspname`,
      [APP_SCHEMAS])
    expect(rows.map(r => r.nspname), 'not every application schema was found')
      .toEqual([...APP_SCHEMAS].sort())
    for (const row of rows) {
      expect(row.public_privs, `${row.nspname} is exposed to PUBLIC`).toEqual([])
    }
  })

  it('no runtime role can bypass row-level security', async () => {
    const { rows } = await migrator.query<{ rolname: string; bypass: boolean }>(
      `SELECT rolname, rolbypassrls AS bypass FROM pg_roles
        WHERE rolname LIKE 'ai_capital_%' ORDER BY rolname`)
    // NINE, and specifically WHICH nine. A bare count would pass on a cluster
    // that had the right number of wrong roles; it also stood at 7 until the
    // 2026-09-13 rehearsal met a correctly provisioned cluster and failed.
    expect(rows.map(r => r.rolname).sort()).toEqual([...ALL_PRODUCTION_ROLES].sort())
    for (const row of rows) expect(row.bypass, row.rolname).toBe(false)
  })

  it('the two authority roles cannot log in at all', async () => {
    const { rows } = await migrator.query<{ rolname: string; login: boolean }>(
      `SELECT rolname, rolcanlogin AS login FROM pg_roles
        WHERE rolname IN ('ai_capital_owner','ai_capital_identity_authority')`)
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.login, row.rolname).toBe(false)
  })

  it('trigger functions are not executable by PUBLIC — read from the CATALOGUE', async () => {
    // Deliberately an ACL read and NOT an attempt to call the function. A
    // trigger function cannot be invoked directly at all: it would fail with
    // "trigger functions can only be called as triggers" (0A000) whatever its
    // ACL says, so a call-based test would report success for the wrong reason.
    const { rows } = await migrator.query<{ name: string; acl: string | null }>(
      `SELECT p.proname AS name, array_to_string(p.proacl, ',') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE (n.nspname = 'identity'          AND p.proname = 'assert_actor_authorized')
           OR (n.nspname = 'investment_ledger' AND p.proname IN
                 ('assert_reconciliation_event_scope','reject_economic_mutation'))`)
    expect(rows.length).toBe(3)
    for (const row of rows) {
      // A NULL acl means DEFAULT privileges, which for a function INCLUDES
      // PUBLIC EXECUTE. So null is a failure here, not an absence of evidence.
      expect(row.acl, `${row.name} still has default (PUBLIC-executable) ACL`).not.toBeNull()
      expect(row.acl, `${row.name} is executable by PUBLIC`).not.toMatch(/(^|,)=X\//)
    }
  })

  it('assert_actor_authorized is executable by ai_capital_owner and nobody else', async () => {
    // DEFECT V3-3, as a runtime check. The owner needs EXECUTE because
    // CREATE TRIGGER checks it at creation time; nothing else needs it, because
    // FIRING a trigger checks no privilege at all. So the ACL should name
    // exactly one role.
    const { rows } = await migrator.query<{ acl: string | null }>(
      `SELECT array_to_string(p.proacl, ',') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'identity' AND p.proname = 'assert_actor_authorized'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].acl, 'a NULL acl means PUBLIC can execute it').not.toBeNull()
    expect(rows[0].acl).toContain('ai_capital_owner=X/')
    expect(rows[0].acl, 'PUBLIC must not be able to execute it').not.toMatch(/(^|,)=X\//)
  })

  it('no LOGIN role can execute assert_actor_authorized — OID form', async () => {
    // BY OID, NOT BY NAME. `has_function_privilege(role, 'identity.f()', ...)`
    // must RESOLVE that text, and resolving a schema-qualified name requires
    // USAGE on the schema — which the migrator does not hold after lockdown.
    // The previous version therefore died with `permission denied for schema
    // identity` and reported nothing about privileges at all. Catalogue reads
    // need no USAGE, so the OID is fetched from pg_proc/pg_namespace first.
    const fn = await migrator.query<{ oid: number }>(
      `SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'identity' AND p.proname = 'assert_actor_authorized'`)
    // NON-VACUITY: exactly one function, or the loop below examines nothing.
    expect(fn.rows, 'assert_actor_authorized was not found').toHaveLength(1)

    const roles = await migrator.query<{ rolname: string; ok: boolean }>(
      `SELECT r.rolname, has_function_privilege(r.rolname, $1::oid, 'EXECUTE') AS ok
         FROM pg_roles r
        WHERE r.rolname LIKE 'ai_capital_%' AND r.rolcanlogin
        ORDER BY 1`,
      [fn.rows[0].oid])
    // NON-VACUITY, AS AN EXACT SET RATHER THAN A FLOOR. `>= 5` was two
    // weaknesses in one line: the count was stale — it predated
    // ai_capital_pipeline and ai_capital_claim_writer, so the contract is seven
    // LOGIN roles, not five — and a floor cannot detect a role that is MISSING
    // as long as enough others are present, which is exactly the condition
    // under which "nobody can execute this" is trivially true. The queried
    // names are therefore compared to the canonical manifest as a set. Both
    // sides are sorted in JavaScript so the comparison does not depend on the
    // database's collation.
    expect(roles.rows.map(r => r.rolname).sort(), 'the examined LOGIN role set is not the contract')
      .toEqual([...LOGIN_ROLES].sort())
    expect(roles.rows.filter(r => r.ok).map(r => r.rolname)).toEqual([])
  })

  it('...and ai_capital_owner CAN execute it — the grant that lets 017 attach triggers', async () => {
    // The positive control. If the owner could not execute it, CREATE TRIGGER
    // would have failed and the migration would never have applied — so this
    // also proves the previous test is not passing because nobody can.
    const { rows } = await migrator.query<{ ok: boolean }>(
      `SELECT has_function_privilege('ai_capital_owner', p.oid, 'EXECUTE') AS ok
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'identity' AND p.proname = 'assert_actor_authorized'`)
    expect(rows[0].ok).toBe(true)
  })

  it('the seventeen attribution triggers exist — the grant did its job', async () => {
    // The consequence the grant was added for. If CREATE TRIGGER had been
    // refused the migration would have rolled back, so reaching this phase at
    // all implies it; asserting the count says WHICH thing was unblocked.
    const { rows } = await migrator.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger' AND NOT t.tgisinternal
          AND t.tgname = 'actor_is_authorized'`)
    expect(rows[0].n).toBe(17)
  })

  it('exactly ai_capital_owner and ai_capital_pipeline hold USAGE on schema public, and nobody holds CREATE (defect B3)', async () => {
    // TWO roles hold USAGE on public, for two different reasons, and both
    // grants come from ops/bootstrap/010_database_bootstrap.sql.
    //
    // ai_capital_owner needs it at DDL TIME: migration 006's `vector` type and
    // `vector_cosine_ops`, and 011's `EXCLUDE USING gist` opclass lookup, all
    // resolve names in public while the owner is running the migration.
    //
    // ai_capital_pipeline needs it at DML TIME: packages/db/src/vector-store/pg.ts
    // casts `$N::vector` and orders by `<=>`, both of which live in public.
    //
    // Neither can come from a migration. Migrations run as ai_capital_owner,
    // public is owned by pg_database_owner, and the owner's USAGE carries no
    // grant option — so such a GRANT is discarded with SQLSTATE 01007 and no
    // error. Migration 018 did exactly that until the 2026-09-13 rehearsal
    // measured the consequence: 42704, `type "vector" does not exist`.
    //
    // Every other role must still hold nothing, and NO role may hold CREATE.
    const { rows } = await migrator.query<{ rolname: string; usage: boolean; create: boolean }>(
      `SELECT r.rolname,
              has_schema_privilege(r.rolname, 'public', 'USAGE')  AS usage,
              has_schema_privilege(r.rolname, 'public', 'CREATE') AS create
         FROM pg_roles r WHERE r.rolname LIKE 'ai_capital_%' ORDER BY 1`)
    expect(rows.map(r => r.rolname).sort()).toEqual([...ALL_PRODUCTION_ROLES].sort())
    const PUBLIC_USAGE_ROLES = ['ai_capital_owner', 'ai_capital_pipeline']
    for (const row of rows) {
      const expectUsage = PUBLIC_USAGE_ROLES.includes(row.rolname)
      expect(row.usage, `${row.rolname} USAGE on public`).toBe(expectUsage)
      expect(row.create, `${row.rolname} must never hold CREATE on public`).toBe(false)
    }
  })

  it('both extensions are present, in public, provisioned by the bootstrap (defect B2)', async () => {
    const { rows } = await migrator.query<{ extname: string; nspname: string }>(
      `SELECT e.extname, n.nspname FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname IN ('btree_gist','vector') ORDER BY 1`)
    expect(rows.map(r => r.extname)).toEqual(['btree_gist', 'vector'])
    for (const row of rows) expect(row.nspname).toBe('public')
  })

  it('the resolver is executable by the importer and by nobody else', async () => {
    const { rows } = await migrator.query<{ acl: string | null }>(
      `SELECT array_to_string(p.proacl, ',') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'investment_ledger' AND p.proname = 'resolve_or_create_instrument'`)
    expect(rows[0].acl).toContain('ai_capital_importer=X/')
    expect(rows[0].acl).not.toMatch(/(^|,)=X\//)
    expect(rows[0].acl).not.toContain('ai_capital_agent=X/')
    expect(rows[0].acl).not.toContain('ai_capital_app=X/')
  })

  it('the correction validator is executable by the importer and by no other LOGIN role', async () => {
    // THE DEFECT THE 2026-09-07 FRESH GATE FOUND. `enforce_correction_integrity()`
    // is a deferred CONSTRAINT TRIGGER function; firing a trigger checks no
    // EXECUTE privilege, so 017's blanket revoke left it working. But its body
    // performs an ORDINARY call to `validate_correction_group(gid)`, and that
    // DOES check EXECUTE against the role that caused the trigger to fire.
    // The validator's ACL was owner-only, so every importer correction group
    // died at SET CONSTRAINTS with 42501 "permission denied for function
    // validate_correction_group" — reaching the trigger, then being refused
    // before the integrity rule could run.
    //
    // OID-BASED THROUGHOUT. `has_function_privilege(role, oid, ...)` needs no
    // USAGE on the schema, while the name form does — so a missing schema grant
    // would make the name form fail with 42501 BEFORE any privilege was
    // inspected, and that error reads like the defect this test exists to
    // detect. Resolving the oid once, from pg_proc, keeps the two apart.
    const { rows: fns } = await migrator.query<{
      proname: string; oid: string; prosecdef: boolean; owner: string; acl: string | null
    }>(
      `SELECT p.proname, p.oid::text AS oid, p.prosecdef,
              pg_get_userbyid(p.proowner) AS owner,
              array_to_string(p.proacl, ',') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'investment_ledger'
          AND p.proname IN ('validate_correction_group', 'enforce_correction_integrity')
        ORDER BY p.proname`)
    // Non-vacuity: both functions must exist, or every assertion below is empty.
    expect(fns.map(f => f.proname))
      .toEqual(['enforce_correction_integrity', 'validate_correction_group'])
    const validator = fns.find(f => f.proname === 'validate_correction_group')!
    const trigger = fns.find(f => f.proname === 'enforce_correction_integrity')!

    // 1. BOTH REMAIN SECURITY INVOKER. This is the property the grant exists to
    //    preserve: a SECURITY DEFINER validator would read `transactions` as
    //    the owner, escaping the caller's RLS, and could validate a correction
    //    group against rows in a workspace the caller cannot see.
    expect(validator.prosecdef, 'validate_correction_group must stay SECURITY INVOKER').toBe(false)
    expect(trigger.prosecdef, 'enforce_correction_integrity must stay SECURITY INVOKER').toBe(false)

    // 2. Ownership is unchanged.
    expect(validator.owner).toBe('ai_capital_owner')
    expect(trigger.owner).toBe('ai_capital_owner')

    // 3. EXACTLY ai_capital_importer among LOGIN roles may execute the validator.
    const { rows: who } = await migrator.query<{ rolname: string }>(
      `SELECT r.rolname FROM pg_roles r
        WHERE r.rolcanlogin AND NOT r.rolsuper
          AND has_function_privilege(r.rolname, $1::oid, 'EXECUTE')
        ORDER BY 1`,
      [validator.oid])
    expect(who.map(r => r.rolname), 'only the importer may execute the validator')
      .toEqual(['ai_capital_importer'])

    // 4. NO LOGIN role may execute the trigger function directly. A trigger
    //    needs no EXECUTE; granting it would let a runtime role call the body
    //    outside any trigger context.
    const { rows: trig } = await migrator.query<{ rolname: string }>(
      `SELECT r.rolname FROM pg_roles r
        WHERE r.rolcanlogin AND NOT r.rolsuper
          AND has_function_privilege(r.rolname, $1::oid, 'EXECUTE')
        ORDER BY 1`,
      [trigger.oid])
    expect(trig.map(r => r.rolname), 'no LOGIN role may execute the trigger function')
      .toEqual([])

    // 5. PUBLIC cannot execute the validator. PUBLIC is a pseudo-role:
    //    has_function_privilege('public', ...) raises 42704, and an empty
    //    grantee in the ACL string is how PUBLIC appears. Both the absence of
    //    `=X/` and the presence of the single intended entry are checked.
    expect(validator.acl ?? '', 'the validator is exposed to PUBLIC')
      .not.toMatch(/(^|,)=X\//)
    expect(validator.acl ?? '', 'the importer grant is missing from the ACL')
      .toContain('ai_capital_importer=X/')
    for (const role of ['ai_capital_agent', 'ai_capital_app',
                        'ai_capital_operator', 'ai_capital_migrator']) {
      expect(validator.acl ?? '', `${role} must not hold EXECUTE on the validator`)
        .not.toContain(`${role}=X/`)
    }

    // 6. Non-vacuity for the privilege probe itself: the same query shape must
    //    find a role for a function the importer really can execute, or a
    //    silently-broken has_function_privilege call would read as "denied".
    const { rows: control } = await migrator.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'investment_ledger'
          AND p.proname = 'resolve_or_create_instrument'
          AND has_function_privilege('ai_capital_importer', p.oid, 'EXECUTE')`)
    expect(control[0].n, 'the privilege probe found nothing even for the resolver').toBe(1)
  })

  it('exactly four views are readable by the importer, and by nobody else', async () => {
    const { rows } = await migrator.query<{ relname: string; acl: string | null }>(
      `SELECT c.relname, array_to_string(c.relacl, ',') AS acl
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'v'
        ORDER BY c.relname`)
    expect(rows, 'the nine views must exist').toHaveLength(9)

    const granted = rows.filter(r => (r.acl ?? '').includes('ai_capital_importer=r/'))
    expect(granted.map(r => r.relname).sort()).toEqual([
      'active_account_resolutions',
      'active_document_verification_events',
      'current_import_batches',
      'reconciliation_case_current_state',
    ])

    for (const row of rows) {
      // No view is readable by PUBLIC, and none by the agent.
      expect(row.acl ?? '', `${row.relname} exposed to PUBLIC`).not.toMatch(/(^|,)=r\//)
      expect(row.acl ?? '', `${row.relname} exposed to the agent`)
        .not.toContain('ai_capital_agent')
    }
  })

  it('the five withheld views are readable by no LOGIN role', async () => {
    // `rolname LIKE 'ai_capital_%'` used to stand in for "runtime role", and it
    // caught `ai_capital_owner` — the NOLOGIN role that OWNS these views. An
    // owner's SELECT on its own view is inherent to ownership, not a grant, and
    // cannot be revoked into a boundary: the owner may restore it at will. What
    // makes the withholding real is that nobody can authenticate as the owner.
    //
    // So the subject is roles with `rolcanlogin`, excluding superusers (who
    // bypass privilege checks by definition and are not application identities).
    const { rows } = await migrator.query<{ relname: string; rolname: string }>(
      `SELECT c.relname, r.rolname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN pg_roles r
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'v'
          AND c.relname IN ('current_transactions','economic_amount_components',
                            'effective_accounts','transaction_effective_accounts',
                            'current_document_verification')
          AND r.rolcanlogin AND NOT r.rolsuper
          AND has_table_privilege(r.rolname, c.oid, 'SELECT')
        ORDER BY 1, 2`)
    expect(rows.map(r => `${r.relname} -> ${r.rolname}`)).toEqual([])
  })

  it('...and that check was not vacuous: five views really exist and real LOGIN roles were examined', async () => {
    // The emptiness above is only meaningful if both sides were non-empty. A
    // renamed view or a missing role set would otherwise read as success.
    const { rows: views } = await migrator.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'v'
          AND c.relname IN ('current_transactions','economic_amount_components',
                            'effective_accounts','transaction_effective_accounts',
                            'current_document_verification')
        ORDER BY 1`)
    expect(views.map(v => v.relname)).toEqual([
      'current_document_verification',
      'current_transactions',
      'economic_amount_components',
      'effective_accounts',
      'transaction_effective_accounts',
    ])

    const { rows: roles } = await migrator.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles
        WHERE rolcanlogin AND NOT rolsuper AND rolname LIKE 'ai_capital_%'
        ORDER BY 1`)
    // From the canonical manifest, not a literal: the five names that stood
    // here predated ai_capital_pipeline and ai_capital_claim_writer. Both sides
    // are sorted in JS so the comparison does not depend on the database's
    // collation.
    expect(roles.map(r => r.rolname).sort()).toEqual([...LOGIN_ROLES].sort())

    // The owner is deliberately NOT in that list, and must stay unauthenticable
    // — that, not an ACL entry, is what makes withholding these views real.
    const { rows: owner } = await migrator.query<{ rolcanlogin: boolean }>(
      `SELECT rolcanlogin FROM pg_roles WHERE rolname = 'ai_capital_owner'`)
    expect(owner).toHaveLength(1)
    expect(owner[0].rolcanlogin, 'ai_capital_owner must remain NOLOGIN').toBe(false)
  })

  it('ai_capital_operator is a grant administrator and nothing more', async () => {
    // Documented as deliberately GLOBAL: it administers grants for every
    // workspace, which is why it must hold no table privilege anywhere.
    const { rows } = await migrator.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM information_schema.role_table_grants
        WHERE grantee = 'ai_capital_operator'`)
    expect(rows[0].n).toBe(0)
    const fns = await migrator.query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('identity','investment_ledger')
          AND has_function_privilege('ai_capital_operator', p.oid, 'EXECUTE')
        ORDER BY 1`)
    expect(fns.rows.map(r => r.name))
      .toEqual(['current_service_principal', 'terminate_service_grant'])
  })
})
