import { it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import {
  connectAs, ensurePrincipals, seedWorkspace, grantCapability, beginAuthorized,
  commit, rollback, probe, INSUFFICIENT_PRIVILEGE, RAISE_EXCEPTION,
  type Principals, type Workspace,
} from './fixture.js'
import { describeInPhase } from './phase.js'

// APPEND-ONLY: UPDATE, DELETE AND TRUNCATE ENFORCEMENT.
//
// INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// Needs a disposable cluster carrying all nine roles from
// ops/roles/000_cluster_roles.sql, a database migrated 001-018, and the six
// role-specific login URLs used directly by this suite. The database-free
// suite never executes it, so nothing here is verified until that gate runs.
//
// ROLE TOPOLOGY. ops/roles/000_cluster_roles.sql defines ALL NINE production
// roles, and a database migrated through 018 needs every one of them to exist:
// migration 018 grants privileges to ai_capital_pipeline and
// ai_capital_claim_writer, so a cluster missing either cannot complete the
// chain. ai_capital_owner and ai_capital_identity_authority are NOLOGIN and are
// never connection identities at all.
//
// This suite directly authenticates SIX identities — migrator, operator,
// importer, agent, app and a cluster administrator — and it does NOT
// authenticate or exercise the pipeline or claim-writer credentials. Those are
// reserved for the separately authorised runtime-role rehearsal.
//
// THE GUARANTEE: ledger evidence is written once. A correction is a NEW row
// that supersedes an old one in a view; it is never an edit. That is what makes
// the table an audit trail rather than a cache of the current opinion.
//
// THREE INDEPENDENT DENIALS, deliberately, because each has a plausible reason
// to be relaxed one day:
//   1. NO PRIVILEGE. No role anyone can LOG IN AS holds DELETE or TRUNCATE.
//      Stated that way on purpose. `ai_capital_owner` does hold both, because
//      PostgreSQL gives an owner the full privilege set on its own objects and
//      an owner can re-grant anything revoked from it — so an ACL entry against
//      the owner is not a boundary and never was. What makes the denial real is
//      that the owner is NOLOGIN: there is no session that can exercise it.
//   2. NO PERMISSIVE POLICY. `importer_lock_only` is `WITH CHECK (false)`, so
//      RLS refuses every real UPDATE that reaches the check. There is no DELETE
//      policy at all, so RLS is default-deny for deletion.
//
//      NOTE THE ORDER, because an earlier version of this file asserted the
//      opposite and the 2026-09-06 gate disproved it. `WITH CHECK` is NOT what
//      an importer's UPDATE hits first. PostgreSQL evaluates the UPDATE
//      policy's `USING` clause to find the row, fires BEFORE ROW triggers, and
//      only then applies `WITH CHECK` to the proposed new row. The append-only
//      trigger is a BEFORE UPDATE trigger, so it always raises first and the
//      observable error is P0001, never the policy's 42501. `WITH CHECK
//      (false)` remains a real second denial — it is what would refuse the
//      write if the trigger were ever dropped — but it is a BACKSTOP here, not
//      the front line.
//   3. THE TRIGGER. `reject_economic_mutation` raises on UPDATE and DELETE.
//
// WHY THE UPDATE PRIVILEGE IS STILL GRANTED, since that looks like a hole:
// PostgreSQL charges `SELECT ... FOR UPDATE` row locking against the UPDATE
// privilege, and the ledger's concurrency control depends on row locks.
// Revoking it would break locking; so the privilege stays and the POLICY denies
// the write.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE NON-VACUITY PROBLEM, AND WHY THE CONTROL THAT USED TO LIVE HERE IS GONE.
//
// The worry was reasonable: if an importer's UPDATE died at the RLS policy,
// then "the trigger rejects UPDATE" would pass whether or not the trigger
// existed. Two controls were tried. The first DROPPED the restrictive policy,
// which is wrong in the opposite direction — with no policy at all RLS is
// default-DENY and the statement still never reaches the trigger. The second
// ADDED a permissive UPDATE policy inside an admin transaction and then issued
// the UPDATE on that same connection under `SET LOCAL ROLE ai_capital_importer`.
//
// THAT SECOND CONTROL WAS INVALID, and the 2026-09-06 gate showed it returning
// 42501 where it demanded P0001. `SET ROLE` changes `current_user`; it does not
// change `session_user`. Every authorization function here resolves the caller
// through `identity.current_service_principal()`, which reads `session_user` —
// so the statement still ran as the unbound `gateadmin` login and was refused
// as unauthorized before any trigger could fire. That is the same fact the
// whole tenancy suite is built on: it uses SEPARATE LOGINS rather than SET ROLE
// precisely because SET ROLE exercises a different mechanism from production.
//
// The premise turned out not to hold anyway. A BEFORE UPDATE trigger runs after
// the policy's `USING` clause and BEFORE `WITH CHECK`, so an ordinary
// importer's UPDATE reaches the trigger unaided and dies there with P0001. No
// control policy is needed to get there, and the test below simply asserts the
// trigger's own error and message. What `WITH CHECK (false)` guarantees is
// asserted where it can be asserted honestly — in the catalogue.
// ─────────────────────────────────────────────────────────────────────────────

describeInPhase('post-lockdown', 'append-only enforcement', () => {
  let admin: Client
  let importer: Client
  let principals: Principals
  let workspace: Workspace
  let accountId: string

  beforeAll(async () => {
    admin = await connectAs('admin')
    importer = await connectAs('importer')
    principals = await ensurePrincipals(admin)
    workspace = await seedWorkspace(admin, 'append-only')
    await grantCapability(admin, workspace, principals.importer, 'archive-import', principals.grantor)

    await beginAuthorized(importer, workspace.id, ['archive-import'])
    const { rows } = await importer.query<{ id: string }>(
      `INSERT INTO investment_ledger.accounts
         (workspace_id, actor_principal_id, account_key, platform, display_name,
          resolution_status, unresolved_reason)
       VALUES ($1,$2,$3,'tenancy',$3,'unresolved','append-only fixture') RETURNING id`,
      [workspace.id, principals.importer.id, `append-only-${Date.now()}`])
    await commit(importer)
    accountId = rows[0].id
  })

  afterAll(async () => {
    await importer?.end()
    await admin?.end()
  })

  it('no LOGIN role holds DELETE or TRUNCATE anywhere in the ledger', async () => {
    // WHAT "RUNTIME ROLE" MEANS, and why the earlier version of this test was
    // wrong. It matched on the NAME (`grantee LIKE 'ai_capital_%'`) and so
    // indicted `ai_capital_owner`, which is a NOLOGIN object owner rather than
    // a runtime identity. PostgreSQL grants an owner the full privilege set on
    // its own objects at CREATE time; that entry is inherent to ownership, and
    // revoking it would not be a boundary because an owner may simply grant it
    // back. Nobody can authenticate as the owner (see the NOLOGIN assertion
    // below), so it cannot be the subject of a runtime privilege claim.
    //
    // The boundary that IS real is about roles someone can connect as. Those
    // are exactly the roles with `rolcanlogin`. Superusers are excluded because
    // a superuser bypasses every privilege check by definition — including this
    // one — so asserting about them would be asserting a falsehood; the suite's
    // own `admin` connection is such a role.
    //
    // The check is `has_table_privilege` over pg_class rather than
    // information_schema.role_table_grants: the information_schema view is
    // filtered by the privileges of the QUERYING role and reports only explicit
    // ACL entries, so it can neither prove absence nor see a privilege reached
    // through role membership. has_table_privilege answers the question the
    // boundary actually asks — "could this role delete this row?"
    const { rows } = await admin.query<{ rolname: string; relname: string; priv: string }>(
      `SELECT r.rolname, c.relname, v.priv
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN pg_roles r
        CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE')) AS v(priv)
        WHERE n.nspname = 'investment_ledger'
          AND c.relkind IN ('r','v')
          AND r.rolcanlogin AND NOT r.rolsuper
          AND has_table_privilege(r.rolname, c.oid, v.priv)
        ORDER BY 1, 2, 3`)
    expect(rows.map(r => `${r.rolname} -> ${r.relname} (${r.priv})`)).toEqual([])
  })

  it('...and that check was not vacuous: it examined the real LOGIN roles and every ledger table', async () => {
    // NON-VACUITY. The assertion above passes trivially if the role set or the
    // relation set is empty — a renamed role, a schema typo, or a cluster whose
    // roles were never created would all read as "no LOGIN role holds DELETE".
    // Both operands are therefore pinned positively.
    const { rows: roles } = await admin.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles
        WHERE rolcanlogin AND NOT rolsuper AND rolname LIKE 'ai_capital_%'
        ORDER BY 1`)
    expect(roles.map(r => r.rolname)).toEqual([
      'ai_capital_agent',
      'ai_capital_app',
      'ai_capital_importer',
      'ai_capital_migrator',
      'ai_capital_operator',
    ])

    // And the owner is NOT among them, which is the whole point of the change.
    const { rows: owner } = await admin.query<{ rolcanlogin: boolean }>(
      `SELECT rolcanlogin FROM pg_roles WHERE rolname = 'ai_capital_owner'`)
    expect(owner).toHaveLength(1)
    expect(owner[0].rolcanlogin, 'ai_capital_owner must remain NOLOGIN').toBe(false)

    const { rows: rels } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r'`)
    if (rels[0].n < 18) {
      throw new Error(`expected at least 18 ledger tables, scanned ${rels[0].n}`)
    }
  })

  it('no table has a DELETE policy, so RLS denies deletion independently', async () => {
    const { rows } = await admin.query<{ relname: string; polname: string }>(
      `SELECT c.relname, p.polname FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger' AND p.polcmd = 'd'`)
    expect(rows).toEqual([])
  })

  it('the UPDATE privilege IS granted — on purpose, for row locking', async () => {
    // Stated as a positive assertion so that a future "tidy-up" that revokes it
    // fails here with this explanation rather than in a concurrency test with
    // an inscrutable one.
    const { rows } = await importer.query<{ ok: boolean }>(
      `SELECT has_table_privilege(session_user, 'investment_ledger.accounts', 'UPDATE') AS ok`)
    expect(rows[0].ok).toBe(true)
  })

  it('SELECT ... FOR UPDATE works, which is why the privilege is kept', async () => {
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const result = await probe(importer, () =>
        importer.query('SELECT id FROM investment_ledger.accounts WHERE id = $1 FOR UPDATE',
          [accountId]))
      expect(result.code, `row locking must still work: ${result.message}`).toBeNull()
    } finally {
      await rollback(importer)
    }
  })

  it('an ordinary UPDATE is refused by the append-only TRIGGER, with P0001', async () => {
    // ORDER OF EVALUATION, asserted rather than assumed. For an importer that
    // may see the row, PostgreSQL evaluates the UPDATE policy's `USING` clause,
    // fires BEFORE ROW triggers, and only then applies `WITH CHECK`. The
    // append-only trigger is BEFORE UPDATE, so it raises first and the caller
    // sees P0001 — not the 42501 an earlier version of this test demanded.
    //
    // The message is asserted too. P0001 alone would also be produced by the
    // state machine and by several other bare RAISEs in this schema; naming the
    // trigger's own words is what makes this a test of the append-only rule.
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const result = await probe(importer, () =>
        importer.query(
          `UPDATE investment_ledger.accounts SET display_name = 'edited' WHERE id = $1`,
          [accountId]))
      expect(result.code, `${result.message}`).toBe(RAISE_EXCEPTION)
      expect(result.message ?? '', 'not the append-only trigger').toMatch(/append-only/)
      // ... and specifically NOT a privilege error: an importer that could not
      // even see the row would fail at 42501 and prove nothing about the rule.
      expect(result.code).not.toBe(INSUFFICIENT_PRIVILEGE)
    } finally {
      await rollback(importer)
    }
  })

  it('a DELETE is denied', async () => {
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const result = await probe(importer, () =>
        importer.query('DELETE FROM investment_ledger.accounts WHERE id = $1', [accountId]))
      expect(result.code, `${result.message}`).toBe(INSUFFICIENT_PRIVILEGE)
    } finally {
      await rollback(importer)
    }
  })

  it('a TRUNCATE is denied', async () => {
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const result = await probe(importer, () =>
        importer.query('TRUNCATE investment_ledger.accounts'))
      expect(result.code, `${result.message}`).toBe(INSUFFICIENT_PRIVILEGE)
    } finally {
      await rollback(importer)
    }
  })

  it('WITH CHECK (false) is the second denial, asserted in the catalogue', async () => {
    // WHY THIS IS A CATALOGUE ASSERTION AND NOT A RUNTIME ONE. `WITH CHECK`
    // cannot be observed at runtime while the BEFORE UPDATE trigger exists,
    // because the trigger always raises first (see the test above). Reaching it
    // would mean dropping or disabling the trigger — mutating the schema under
    // test to observe it, which is exactly the class of "control" that produced
    // the invalid SET ROLE probe this replaces.
    //
    // So the guarantee is stated where it is true and checkable: the ONLY
    // UPDATE policy on the table is `importer_lock_only`, and its WITH CHECK is
    // the constant false. That is what would refuse the write if the trigger
    // were ever dropped.
    const { rows } = await admin.query<{ polname: string; withcheck: string | null }>(
      `SELECT p.polname, pg_get_expr(p.polwithcheck, p.polrelid) AS withcheck
         FROM pg_policy p
        WHERE p.polrelid = 'investment_ledger.accounts'::regclass AND p.polcmd = 'w'
        ORDER BY p.polname`)
    expect(rows.map(r => r.polname), 'the set of UPDATE policies changed')
      .toEqual(['importer_lock_only'])
    expect(rows[0].withcheck, 'importer_lock_only must permit no real write').toBe('false')
  })

  it('no PERMISSIVE update policy exists that could let a write through', async () => {
    // The invariant the old "the control policy did NOT survive" test was
    // really protecting: a leaked permissive UPDATE policy would weaken every
    // later test in the run, and would do so invisibly. Stated generally, it no
    // longer depends on a control ever having been created — so it also catches
    // a permissive policy introduced by any other means.
    const { rows } = await admin.query<{ polname: string; permissive: string }>(
      `SELECT p.polname, p.polpermissive::text AS permissive
         FROM pg_policy p
        WHERE p.polrelid = 'investment_ledger.accounts'::regclass
          AND p.polcmd = 'w'
          AND coalesce(pg_get_expr(p.polwithcheck, p.polrelid), 'false') <> 'false'
        ORDER BY p.polname`)
    expect(rows.map(r => r.polname), 'a policy permitting a real UPDATE is present')
      .toEqual([])
  })

  it('EVERY ledger table carries BOTH guards, enabled — instruments included', async () => {
    // Both, and all eighteen. 016 installs the pair over the tables that
    // existed when it ran; `document_blobs` is created afterwards in 017 and
    // must install its own. An earlier draft of 017 installed only the
    // UPDATE/DELETE half, leaving the newest table as the single place TRUNCATE
    // was ungoverned — and a test that checked only `reject_mutation` would
    // have reported that as fine.
    const { rows } = await admin.query<{
      relname: string; mutation: string | null; truncate: string | null
    }>(
      `SELECT c.relname,
              m.tgenabled AS mutation,
              t.tgenabled AS truncate
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_trigger m ON m.tgrelid = c.oid AND NOT m.tgisinternal
                               AND m.tgname = 'reject_mutation'
         LEFT JOIN pg_trigger t ON t.tgrelid = c.oid AND NOT t.tgisinternal
                               AND t.tgname = 'reject_truncate'
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r'
        ORDER BY c.relname`)
    expect(rows).toHaveLength(18)
    for (const row of rows) {
      expect(row.mutation, `${row.relname}: reject_mutation`).toBe('O')
      expect(row.truncate, `${row.relname}: reject_truncate`).toBe('O')
    }
  })

  it('the original survives every probe above untouched', async () => {
    // The positive statement of the guarantee, and the proof that no probe in
    // this file leaked: the row is exactly as it was seeded.
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const { rows } = await importer.query<{ display_name: string }>(
        'SELECT display_name FROM investment_ledger.accounts WHERE id = $1', [accountId])
      expect(rows).toHaveLength(1)
      expect(rows[0].display_name).not.toBe('edited')
    } finally {
      await rollback(importer)
    }
  })
})
