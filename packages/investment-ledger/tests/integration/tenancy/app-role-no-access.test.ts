import { it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectAs, seedWorkspace, sqlstateOfDetached, INSUFFICIENT_PRIVILEGE } from './fixture.js'
import { describeInPhase } from './phase.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const MIGRATIONS = join(ROOT, 'packages', 'db', 'migrations')

/**
 * Every SQL file the TENANCY FOUNDATION authored: migrations 011-017 and all of
 * ops/.
 *
 * A CLOSED RANGE, not ">= 11". The property below belongs to the tenancy work
 * specifically — it did not touch the portfolio access model — and migration 018
 * is not part of that work. 018 is the separately approved legacy-runtime grant
 * migration; it names `portfolio` on purpose, granting `ai_capital_pipeline`
 * SELECT and UPDATE on `portfolio.positions` and `portfolio.trade_log`. Sweeping
 * it into this list would make a true statement about the tenancy foundation
 * fail because of a different, deliberate decision.
 */
const TENANCY_SQL: string[] = [
  ...readdirSync(MIGRATIONS)
    .filter(f => {
      const n = Number(f.slice(0, 3))
      return f.endsWith('.sql') && n >= 11 && n <= 17
    })
    .sort()
    .map(f => join(MIGRATIONS, f)),
  join(ROOT, 'ops', 'roles', '000_cluster_roles.sql'),
  join(ROOT, 'ops', 'bootstrap', '010_database_bootstrap.sql'),
  join(ROOT, 'ops', 'bootstrap', '090_post_migration_lockdown.sql'),
]

// ai_capital_app HOLDS NO LEDGER ACCESS IN THIS FOUNDATION.
//
// INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// THIS IS A DELIBERATE ABSENCE, not an oversight, and it is tested BECAUSE it
// is the kind of absence a well-meaning future change closes.
//
// `ai_capital_app` is the human-facing runtime role. Giving it tenant access
// now would require deriving a workspace for a PERSON, and this foundation has
// no session mechanism to derive one from. The only thing available would be a
// caller-set GUC — and a policy keyed on a bare GUC is not protection, it is a
// parameter. Human authority is therefore deferred to the OIDC gate, where
// `external_identities` and `workspace_memberships` (both already modelled in
// 011) get a trustworthy session to hang from.
//
// If a future change grants this role anything before that gate lands, these
// assertions are what should stop it and ask for the design.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE USED TO CLAIM, WRONGLY.
//
// An earlier version ended with a POSITIVE assertion that `ai_capital_app`
// still holds SELECT on `portfolio.positions` — "the role is not idle, it
// serves the dashboard". On a database built from this repository that is
// simply false: no SQL here grants it, migrations 001-010 predate the role
// entirely, and `ops/bootstrap/010_database_bootstrap.sql` gives it CONNECT and
// nothing else. The assertion described a production cluster's hand-made ACLs,
// not anything the repository can reproduce, so on a fresh disposable database
// it could only fail.
//
// It is replaced by what can actually be checked and is what was actually
// meant: THE TENANCY WORK DID NOT TOUCH THE PORTFOLIO ACCESS MODEL. Nothing in
// 011-017 or in `ops/` issues a single statement naming `portfolio`, no tenancy
// role acquired any privilege there, and the schema carries no policy, no RLS
// and no trigger from this work. That is a regression check the repository can
// honour.
//
// MIGRATION 018 IS OUT OF SCOPE HERE, DELIBERATELY. It does name `portfolio` —
// SELECT and UPDATE for `ai_capital_pipeline`, the scheduled pipeline's own
// least-privilege identity — which is a separately approved decision and not a
// tenancy-foundation regression. The runtime assertions below still prove that
// `ai_capital_app` reaches nothing, and 018 grants `ai_capital_app` nothing.
//
// SEPARATE DECISION, DELIBERATELY NOT MADE HERE: whether `ai_capital_app`
// SHOULD hold read access to `portfolio` at all. It may well need it when the
// dashboard is pointed at a database built this way — but inventing a
// legacy-portfolio ACL inside a tenancy remediation would be adding an
// unreviewed grant to the one schema this work promised not to touch. It is
// reported as a design and authorization question instead.

describeInPhase('post-lockdown', 'the app role', () => {
  let app: Client
  let admin: Client

  beforeAll(async () => {
    app = await connectAs('app')
    admin = await connectAs('admin')
  })

  afterAll(async () => {
    await app?.end()
    await admin?.end()
  })

  it('cannot even see the ledger schema', async () => {
    const { rows } = await app.query<{ ok: boolean }>(
      "SELECT has_schema_privilege(session_user, 'investment_ledger', 'USAGE') AS ok")
    expect(rows[0].ok).toBe(false)
  })

  it('holds no privilege on any ledger table', async () => {
    const { rows } = await admin.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'ai_capital_app' AND table_schema IN ('investment_ledger','identity')
        ORDER BY 1, 2`)
    expect(rows).toEqual([])
  })

  it('is named by no policy anywhere', async () => {
    const { rows } = await admin.query<{ relname: string; polname: string }>(
      `SELECT c.relname, p.polname FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('investment_ledger','identity')
          AND 'ai_capital_app'::regrole = ANY(p.polroles)`)
    expect(rows).toEqual([])
  })

  it('cannot execute any identity function', async () => {
    const { rows } = await admin.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('identity','investment_ledger')
          AND has_function_privilege('ai_capital_app', p.oid, 'EXECUTE')
        ORDER BY 1`)
    expect(rows.map(r => r.proname)).toEqual([])
  })

  it('a direct SELECT is refused', async () => {
    const code = await sqlstateOfDetached(app, () =>
      app.query('SELECT count(*) FROM investment_ledger.transactions'))
    expect(code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('cannot authorize itself into a workspace even if one exists', async () => {
    const workspace = await seedWorkspace(admin, 'app-probe')
    const code = await sqlstateOfDetached(app, () =>
      app.query('SELECT identity.authorize_service_workspace($1, $2::identity.service_capability)',
        [workspace.id, 'ledger-read']))
    expect(code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('the tenancy foundation issues no statement naming portfolio — 011-017 and ops only', () => {
    // The regression check, made against the SOURCE, because that is where the
    // property lives: a grant, revoke or ALTER on the legacy schema would have
    // to be written down somewhere, and there is nowhere else it could be.
    // Comment lines are stripped so prose about portfolio does not read as a
    // statement about it.
    const offenders: string[] = []
    for (const file of TENANCY_SQL) {
      const code = readFileSync(file, 'utf-8')
        .split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
      if (/\bportfolio\b/.test(code)) offenders.push(file.slice(file.lastIndexOf('/') + 1))
    }
    expect(offenders, 'the tenancy work must not touch the portfolio schema').toEqual([])
    // Non-vacuity: the file list must actually have been read.
    expect(TENANCY_SQL.length).toBe(10)
  })

  it('no tenancy role acquired any privilege in the portfolio schema', async () => {
    // The runtime half of the same property, over EXACTLY the four roles the
    // two queries below name: ai_capital_importer, ai_capital_agent,
    // ai_capital_identity_authority and ai_capital_operator — the ledger
    // tenancy and operations roles this work introduces.
    //
    // `ai_capital_app` is DELIBERATELY NOT among them. An existing installation
    // may carry pre-existing, manually configured portfolio ACLs for that role,
    // granted outside this repository; asserting anything absolute about it
    // against a fresh disposable database would be asserting a fact about
    // somebody's cluster that this database cannot know either way.
    //
    // What IS established, and where: the source-level test above proves this
    // tenancy change contains no explicit statement naming `portfolio` — no
    // GRANT, no REVOKE, no ALTER — in migrations 011-017 or in any `ops/` file.
    // That is the reason to expect an existing cluster's ai_capital_app ACL to
    // survive a deployment; CONFIRMING that it survived would require comparing
    // the ACL before and after on that cluster, which no fresh-database
    // assertion can stand in for.
    //
    // Whether a FRESH installation should grant ai_capital_app read access to
    // `portfolio` at all is a separate design and authorization decision, and
    // is deliberately not made here.
    const { rows } = await admin.query<{ grantee: string; table_name: string; privilege_type: string }>(
      `SELECT grantee, table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'portfolio'
          AND grantee IN ('ai_capital_importer','ai_capital_agent',
                          'ai_capital_identity_authority','ai_capital_operator')
        ORDER BY 1,2,3`)
    expect(rows).toEqual([])

    const schema = await admin.query<{ role: string }>(
      `SELECT r.rolname AS role FROM pg_roles r
        WHERE r.rolname IN ('ai_capital_importer','ai_capital_agent',
                            'ai_capital_identity_authority','ai_capital_operator')
          AND has_schema_privilege(r.rolname, 'portfolio', 'USAGE')
        ORDER BY 1`)
    expect(schema.rows.map(r => r.role)).toEqual([])
  })

  it('the portfolio schema carries no policy, RLS or trigger from this work', async () => {
    // Coupling would not have to be a grant. A policy or an attribution trigger
    // on a legacy table would change its behaviour just as thoroughly.
    const rls = await admin.query<{ relname: string; en: boolean; force: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS en, c.relforcerowsecurity AS force
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'portfolio' AND c.relkind = 'r' ORDER BY 1`)
    expect(rls.rows.length, 'the portfolio schema should have tables').toBeGreaterThan(0)
    for (const row of rls.rows) {
      expect(row.en, `${row.relname} acquired RLS`).toBe(false)
      expect(row.force, `${row.relname} acquired FORCE RLS`).toBe(false)
    }

    const policies = await admin.query<{ relname: string; polname: string }>(
      `SELECT c.relname, p.polname FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'portfolio'`)
    expect(policies.rows).toEqual([])

    const triggers = await admin.query<{ relname: string; tgname: string }>(
      `SELECT c.relname, t.tgname FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'portfolio' AND NOT t.tgisinternal
          AND t.tgname IN ('actor_is_authorized','reject_mutation','reject_truncate',
                           'reconciliation_event_scope')`)
    expect(triggers.rows).toEqual([])
  })

  it('no tenancy column was added to a portfolio table', async () => {
    const { rows } = await admin.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'portfolio'
          AND column_name IN ('workspace_id','actor_principal_id')
        ORDER BY 1,2`)
    expect(rows).toEqual([])
  })
})
