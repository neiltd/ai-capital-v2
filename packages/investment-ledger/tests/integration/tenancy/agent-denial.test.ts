import { it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import {
  connectAs, ensurePrincipals, seedWorkspace, grantCapability,
  rollback, probe, probeDetached, INSUFFICIENT_PRIVILEGE,
  type Principals, type Workspace,
} from './fixture.js'
import { describeInPhase } from './phase.js'

// ai_capital_agent HAS NO INVESTMENT-LEDGER ACCESS AT ALL.
//
// INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// WHAT CHANGED, AND WHY. An earlier design gave the agent SELECT on ten base
// tables plus an `agent_read` policy on each, on the reasoning that an analysis
// stage needs conclusions but not evidence. Two things broke that:
//
//   1. `transactions` had to be withdrawn. It carries superseded, reversed and
//      corrected rows with nothing distinguishing them from current holdings,
//      and the only correct projection — `current_transactions` — is
//      unreachable for the agent because it reads raw import evidence. A role
//      that can silently report a reversed trade as a holding is worse than a
//      role that can read nothing, in a system where real money decisions ride
//      on the output.
//   2. With transactions gone, none of the remaining eight carries standalone
//      analytical value — and three of them leak: `import_batches.source_name`
//      and `transaction_groups.group_key` are derived from archive filenames,
//      and `reconciliation_case_events` carries free-text notes and evidence.
//      The agent's boundary forbids source-document paths.
//
// So the agent is now treated exactly as `ai_capital_app` is: no access until a
// gate designs one. Analytical access is DEFERRED pending a capability-coherent
// current-state projection, which is explicitly out of scope here.
//
// This file therefore asserts an ABSENCE, in every form it could return: no
// schema usage, no table or view privilege, no policy, no write, and no way to
// obtain one by granting the principal a capability.

const ALL_TENANT_TABLES = [
  'accounts', 'instrument_aliases', 'import_batches', 'raw_import_rows',
  'logical_documents', 'document_file_variants', 'document_extractions',
  'document_blobs', 'document_verification_events', 'transaction_groups',
  'transactions', 'transaction_amount_components', 'transaction_document_links',
  'validation_findings', 'reconciliation_cases', 'reconciliation_case_events',
  'account_resolutions',
] as const

const ALL_VIEWS = [
  'active_account_resolutions', 'active_document_verification_events',
  'current_document_verification', 'current_import_batches',
  'current_transactions', 'economic_amount_components', 'effective_accounts',
  'reconciliation_case_current_state', 'transaction_effective_accounts',
] as const

describeInPhase('post-lockdown', 'the agent holds nothing in the ledger', () => {
  let admin: Client
  let agent: Client
  let importer: Client
  let principals: Principals
  let workspace: Workspace
  /** A row the agent must fail to read. Seeded so no denial can pass merely
   *  because the relation is empty. */
  let seededAccountKey: string

  beforeAll(async () => {
    admin = await connectAs('admin')
    agent = await connectAs('agent')
    importer = await connectAs('importer')
    principals = await ensurePrincipals(admin)
    workspace = await seedWorkspace(admin, 'agent-denial')
    await grantCapability(admin, workspace, principals.importer, 'archive-import', principals.grantor)

    // NON-VACUITY SEED. An RLS predicate is never evaluated against an empty
    // relation, and a privilege check on an empty table returns the same
    // "nothing" as a working denial. Every assertion below runs against a
    // database that really does hold a row in this workspace.
    seededAccountKey = `agent-denial-${Date.now()}`
    const { beginAuthorized, commit } = await import('./fixture.js')
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    await importer.query(
      `INSERT INTO investment_ledger.accounts
         (workspace_id, actor_principal_id, account_key, platform, display_name,
          resolution_status, unresolved_reason)
       VALUES ($1,$2,$3,'tenancy',$3,'unresolved','agent denial seed')`,
      [workspace.id, principals.importer.id, seededAccountKey])
    await commit(importer)
  }, 60_000)

  afterAll(async () => {
    await importer?.end()
    await agent?.end()
    await admin?.end()
  })

  it('the seed really exists — otherwise every denial below is vacuous', async () => {
    const { rows } = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM investment_ledger.accounts WHERE workspace_id = $1',
      [workspace.id])
    expect(rows[0].n).toBeGreaterThan(0)
  })

  // ── The role itself is unchanged: a LOGIN with no memberships. ────────────

  it('is a LOGIN role with zero memberships and no bypass', async () => {
    const { rows } = await admin.query<{ login: boolean; bypass: boolean; sup: boolean; n: number }>(
      `SELECT r.rolcanlogin AS login, r.rolbypassrls AS bypass, r.rolsuper AS sup,
              (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS n
         FROM pg_roles r WHERE r.rolname = 'ai_capital_agent'`)
    expect(rows[0].login).toBe(true)
    expect(rows[0].bypass).toBe(false)
    expect(rows[0].sup).toBe(false)
    expect(rows[0].n, 'zero memberships is what makes session_user trustworthy').toBe(0)
  })

  // ── Absence, in every form. ───────────────────────────────────────────────

  it('holds no USAGE on the investment_ledger schema — asserted separately', async () => {
    // Schema USAGE is its own gate: without it every relation privilege is
    // unusable regardless, so proving it here keeps the relation checks from
    // being the only thing standing between the agent and the data.
    const self = await agent.query<{ ok: boolean }>(
      "SELECT has_schema_privilege(session_user, 'investment_ledger', 'USAGE') AS ok")
    expect(self.rows[0].ok).toBe(false)

    const catalogue = await admin.query<{ usage: boolean; create: boolean; acl: string[] }>(
      `SELECT has_schema_privilege('ai_capital_agent','investment_ledger','USAGE')  AS usage,
              has_schema_privilege('ai_capital_agent','investment_ledger','CREATE') AS create,
              coalesce((SELECT array_agg(a.privilege_type)
                          FROM pg_namespace n2, LATERAL aclexplode(n2.nspacl) a
                         WHERE n2.nspname = 'investment_ledger'
                           AND a.grantee = 'ai_capital_agent'::regrole),
                       ARRAY[]::text[]) AS acl`)
    expect(catalogue.rows[0].usage).toBe(false)
    expect(catalogue.rows[0].create).toBe(false)
    expect(catalogue.rows[0].acl).toEqual([])
  })

  // ── AUTHORITATIVE ACL INSPECTION. ────────────────────────────────────────
  //
  // NOT information_schema.role_table_grants. That view is itself filtered by
  // the privileges of the role RUNNING the query: it shows only grants where
  // the current user is the grantor or a member of the grantee. Asking it
  // "which grants does ai_capital_agent hold" from a third role can return an
  // empty set whether or not the grants exist — an absence proved by a view
  // that hides things is no proof at all.
  //
  // `has_table_privilege(role, oid, priv)` answers the real question against
  // pg_class directly, and the OID form needs no schema USAGE.

  const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES'] as const

  it('the schema really contains the relations under test', async () => {
    // NON-VACUITY: 18 tables (17 tenant + instruments) and 9 views. If the
    // count is wrong the per-relation checks below are testing the wrong set.
    const { rows } = await admin.query<{ kind: string; n: number }>(
      `SELECT c.relkind AS kind, count(*)::int AS n
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger' AND c.relkind IN ('r','v')
        GROUP BY 1 ORDER BY 1`)
    const byKind = new Map(rows.map(r => [r.kind, r.n]))
    expect(byKind.get('r'), 'expected 17 tenant tables + instruments').toBe(18)
    expect(byKind.get('v'), 'expected the nine views').toBe(9)
    expect(ALL_TENANT_TABLES).toHaveLength(17)
    expect(ALL_VIEWS).toHaveLength(9)
  })

  it('ai_capital_agent holds NO privilege on ANY ledger relation — catalogue truth', async () => {
    // Every relation, every privilege, in one authoritative pass.
    const { rows } = await admin.query<{ relname: string; kind: string; priv: string }>(
      `SELECT c.relname, c.relkind AS kind, p.priv
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest($1::text[]) AS p(priv)
        WHERE n.nspname = 'investment_ledger'
          AND c.relkind IN ('r','v')
          AND has_table_privilege('ai_capital_agent', c.oid, p.priv)
        ORDER BY 1, 3`,
      [PRIVILEGES])
    expect(rows.map(r => `${r.relname}(${r.kind}) ${r.priv}`)).toEqual([])
  })

  it('...and its OID appears in no relacl entry in the schema', async () => {
    // The second, independent reading: the stored ACL itself, exploded. A grant
    // could in principle reach the agent through a role it is a member of;
    // `has_table_privilege` would catch that and this would not, and vice versa
    // for an ACL entry that grants nothing. Both are checked.
    const { rows } = await admin.query<{ relname: string; priv: string }>(
      `SELECT c.relname, a.privilege_type AS priv
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) a
        WHERE n.nspname = 'investment_ledger'
          AND c.relkind IN ('r','v')
          AND a.grantee = 'ai_capital_agent'::regrole
        ORDER BY 1, 2`)
    expect(rows.map(r => `${r.relname} ${r.priv}`)).toEqual([])
  })

  it.each(ALL_TENANT_TABLES)('holds no privilege of any kind on %s', async table => {
    const { rows } = await admin.query<{ priv: string }>(
      `SELECT p.priv FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest($2::text[]) AS p(priv)
        WHERE n.nspname = 'investment_ledger' AND c.relname = $1
          AND has_table_privilege('ai_capital_agent', c.oid, p.priv)`,
      [table, PRIVILEGES])
    expect(rows.map(r => r.priv)).toEqual([])
  })

  it.each(ALL_VIEWS)('holds no privilege on view %s', async view => {
    // TRUNCATE and REFERENCES are not applicable to views, so they are dropped
    // rather than asserted as absent for the wrong reason.
    const { rows } = await admin.query<{ priv: string }>(
      `SELECT p.priv FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(priv)
        WHERE n.nspname = 'investment_ledger' AND c.relname = $1 AND c.relkind = 'v'
          AND has_table_privilege('ai_capital_agent', c.oid, p.priv)`,
      [view])
    expect(rows.map(r => r.priv)).toEqual([])
  })

  it('the importer DOES hold privileges — proving the query can see grants at all', async () => {
    // The control for the three checks above. If has_table_privilege returned
    // false for everything, they would all pass vacuously.
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger' AND c.relkind IN ('r','v')
          AND has_table_privilege('ai_capital_importer', c.oid, 'SELECT')`)
    // 17 tenant tables + instruments + 4 granted views.
    expect(rows[0].n).toBe(22)
  })

  it('is named by no policy anywhere in the schema', async () => {
    // The second, independent denial. A future "the agent just needs to count
    // rows" grant would still hit default-deny.
    const { rows } = await admin.query<{ relname: string; polname: string }>(
      `SELECT c.relname, p.polname FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger'
          AND 'ai_capital_agent'::regrole = ANY (p.polroles)`)
    expect(rows).toEqual([])
  })

  it('cannot read the global instruments table either', async () => {
    const result = await probeDetached(agent, () =>
      agent.query('SELECT count(*) FROM investment_ledger.instruments'))
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it.each(ALL_TENANT_TABLES)('a direct SELECT on %s is refused at runtime', async table => {
    const result = await probeDetached(agent, () =>
      agent.query(`SELECT * FROM investment_ledger.${table} LIMIT 1`))
    expect(result.code, `${table}: ${result.message}`).toBe(INSUFFICIENT_PRIVILEGE)
    // MISSING SQL PRIVILEGE, not a missing capability and not a hidden row.
    // The three are different failures and this file must not conflate them.
    expect(result.message ?? '').toMatch(/permission denied/)
    expect(result.message ?? '').not.toMatch(/holds none of/)
  })

  it.each(ALL_VIEWS)('a direct SELECT on view %s is refused at runtime', async view => {
    const result = await probeDetached(agent, () =>
      agent.query(`SELECT * FROM investment_ledger.${view} LIMIT 1`))
    expect(result.code, `${view}: ${result.message}`).toBe(INSUFFICIENT_PRIVILEGE)
    expect(result.message ?? '').toMatch(/permission denied/)
  })

  it.each(['transactions', 'transaction_amount_components'] as const)(
    'CANNOT read %s — the withdrawal that motivated this change', async table => {
      const result = await probeDetached(agent, () =>
        agent.query(`SELECT count(*) FROM investment_ledger.${table}`))
      expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
    })

  it('holds no write privilege on any ledger relation', async () => {
    const { rows } = await admin.query<{ relname: string; priv: string }>(
      `SELECT c.relname, p.priv
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) AS p(priv)
        WHERE n.nspname = 'investment_ledger' AND c.relkind IN ('r','v')
          AND has_table_privilege('ai_capital_agent', c.oid, p.priv)
        ORDER BY 1, 2`)
    expect(rows.map(r => `${r.relname} ${r.priv}`)).toEqual([])
  })

  // ── A capability is not a privilege. ──────────────────────────────────────

  it.each(['reconciliation', 'document-verification', 'ledger-read'] as const)(
    'granting its principal %s does NOT make the login writable', async capability => {
      // THE POINT OF THE WHOLE FILE. Capabilities and SQL privileges are
      // different axes: a capability decides what a principal may do in a
      // workspace, a grant decides what a login may do at all. The agent has no
      // grant and no policy, so no capability can produce a write.
      await grantCapability(admin, workspace, principals.agent, capability, principals.grantor)

      const held = await admin.query<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM identity.workspace_service_grants
                         WHERE workspace_id = $1 AND principal_id = $2
                           AND capability = $3::identity.service_capability
                           AND effective_range @> now()) AS ok`,
        [workspace.id, principals.agent.id, capability])
      expect(held.rows[0].ok, 'the capability must really be granted').toBe(true)

      const result = await probeDetached(agent, async () => {
        await agent.query("SELECT set_config('app.workspace_id', $1, true)", [workspace.id])
        await agent.query(
          `INSERT INTO investment_ledger.accounts
             (workspace_id, actor_principal_id, account_key, platform, display_name,
              resolution_status, unresolved_reason)
           VALUES ($1,$2,$3,'tenancy',$3,'unresolved','agent write attempt')`,
          [workspace.id, principals.agent.id, `agent-write-${capability}-${Date.now()}`])
      })
      expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(result.message ?? '', 'must fail on the missing GRANT, not the capability')
        .toMatch(/permission denied/)
    })

  it('...and still cannot read, capability or not', async () => {
    const result = await probeDetached(agent, () =>
      agent.query('SELECT count(*) FROM investment_ledger.accounts'))
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('the agent CAN still authorize a workspace — the identity layer is untouched', async () => {
    // Deliberate: the denial is in investment_ledger, not in identity. The
    // agent remains a first-class principal for whatever it is granted next;
    // it simply reaches no ledger data today.
    const result = await probeDetached(agent, () =>
      agent.query(
        'SELECT identity.authorize_service_workspace($1, $2::identity.service_capability)',
        [workspace.id, 'ledger-read']))
    expect(result.code, `${result.message}`).toBeNull()
  })

  it('the importer is unaffected by the agent’s removal', async () => {
    // A control: the withdrawal must not have narrowed the writer.
    const { beginAuthorized } = await import('./fixture.js')
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const result = await probe(importer, () =>
        importer.query(
          'SELECT count(*) FROM investment_ledger.accounts WHERE workspace_id = $1',
          [workspace.id]))
      expect(result.code, `${result.message}`).toBeNull()
    } finally {
      await rollback(importer)
    }
  })
})
