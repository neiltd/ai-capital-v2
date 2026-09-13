import { it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import {
  connectAs, ensurePrincipals, seedWorkspace, grantCapability, beginAuthorized,
  rollback, probe, probeDetached,
  INSUFFICIENT_PRIVILEGE, FK_VIOLATION, NO_ACTIVE_TRANSACTION,
  type Principals, type Workspace,
} from './fixture.js'
import { describeInPhase } from './phase.js'

// REQUIRED ACTOR ATTRIBUTION, AND WRONG-ACTOR REJECTION.
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
// The static matrix (tests/unit/tenant-attribution-matrix.test.ts) proves every
// tenant table HAS the column, the foreign key and the trigger, and that every
// production INSERT supplies a value. It cannot prove the value is the RIGHT
// one — that a caller cannot attribute its writes to somebody else — because
// that is a runtime property of the trigger. This file is the other half.
//
// THE THREAT MODEL, plainly: the column is an audit trail. If a service can
// write another principal's id into it, the trail records a fiction, and it
// records that fiction most convincingly precisely when someone is looking.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DISABLED-ACTOR TEST, AND WHY THE FIRST VERSION PROVED NOTHING.
//
// It wrapped the probe in `sqlstateOf(...).catch(() => INSUFFICIENT_PRIVILEGE)`
// on a client with no open transaction. Every step of that was wrong:
//
//   * with no transaction open, the helper's own SAVEPOINT raises 25P01, so the
//     returned "SQLSTATE" was about the helper, not the INSERT;
//   * the broad `.catch` then converted ANY failure — a dropped connection, a
//     typo in the SQL, a missing fixture row — into the very value the test
//     asserted, so it could not fail for any reason at all;
//   * and it never checked that the INSERT was reached, so a setup error and a
//     correct refusal were indistinguishable.
//
// It is now `probeDetached`, the exact SQLSTATE is asserted, the message is
// asserted, there is no catch, and the same INSERT is run again with the
// principal ENABLED to prove the statement was well-formed and that disabling
// is what refused it.
// ─────────────────────────────────────────────────────────────────────────────

const TENANT_TABLES = [
  'accounts', 'instrument_aliases', 'import_batches', 'raw_import_rows',
  'logical_documents', 'document_file_variants', 'document_extractions',
  'document_blobs', 'document_verification_events', 'transaction_groups',
  'transactions', 'transaction_amount_components', 'transaction_document_links',
  'validation_findings', 'reconciliation_cases', 'reconciliation_case_events',
  'account_resolutions',
] as const

describeInPhase('post-lockdown', 'actor attribution', () => {
  let admin: Client
  let importer: Client
  let principals: Principals
  let workspace: Workspace

  const probeAccount = (actorId: string, label: string) => ({
    sql: `INSERT INTO investment_ledger.accounts
            (workspace_id, actor_principal_id, account_key, platform, display_name,
             resolution_status, unresolved_reason)
          VALUES ($1,$2,$3,'tenancy',$3,'unresolved','attribution probe')`,
    values: [workspace.id, actorId, `${label}-${Date.now()}-${Math.random()}`],
  })

  beforeAll(async () => {
    admin = await connectAs('admin')
    importer = await connectAs('importer')
    principals = await ensurePrincipals(admin)
    workspace = await seedWorkspace(admin, 'attribution')
    await grantCapability(admin, workspace, principals.importer, 'archive-import', principals.grantor)
    // The AGENT principal, granted the SAME capability in the SAME workspace.
    // That combination is the point: the refusal below must be "you are not
    // this principal", not "this principal cannot do that here".
    await grantCapability(admin, workspace, principals.agent, 'archive-import', principals.grantor)
  })

  afterAll(async () => {
    await importer?.end()
    await admin?.end()
  })

  it('the two principals are distinct and BOTH entitled here', async () => {
    expect(principals.importer.id).not.toBe(principals.agent.id)
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity.workspace_service_grants
        WHERE workspace_id = $1 AND principal_id = ANY($2)
          AND capability = 'archive-import'::identity.service_capability
          AND effective_range @> now()`,
      [workspace.id, [principals.importer.id, principals.agent.id]])
    expect(rows[0].n).toBe(2)
  })

  it('every tenant table declares actor_principal_id NOT NULL', async () => {
    const { rows } = await admin.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r' AND c.relname <> 'instruments'
          AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = c.oid AND a.attname = 'actor_principal_id'
                             AND a.attnotnull)`)
    expect(rows.map(r => r.relname)).toEqual([])
    expect(TENANT_TABLES).toHaveLength(17)
  })

  it('an INSERT omitting the actor is refused by the attribution TRIGGER, with 42501', async () => {
    // TWO GUARDS, AND ONLY ONE OF THEM CAN BE OBSERVED HERE. The column is
    // `NOT NULL` and a BEFORE INSERT trigger checks the actor. BEFORE ROW
    // triggers run before constraints are evaluated, so `assert_actor_authorized`
    // sees the NULL actor and raises 42501 first; the NOT NULL violation is
    // never reached and 23502 is never observable from this path.
    //
    // An earlier version demanded 23502 and the 2026-09-06 gate failed it. The
    // fix is to assert what actually happens — and to keep proving the NOT NULL
    // declaration separately, in the catalogue, which the test
    // "every tenant table declares actor_principal_id NOT NULL" above does for
    // all 17 tenant tables. Dropping the runtime expectation therefore loses no
    // coverage of the constraint; it stops mis-attributing the refusal.
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const result = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.accounts
             (workspace_id, account_key, platform, display_name, resolution_status, unresolved_reason)
           VALUES ($1,$2,'tenancy',$2,'unresolved','no actor')`,
          [workspace.id, `no-actor-${Date.now()}`]))
      expect(result.code, `${result.message}`).toBe(INSUFFICIENT_PRIVILEGE)
      // Named, so a refusal for some unrelated privilege reason cannot pass as
      // this one.
      expect(result.message ?? '', 'not the actor-attribution guard')
        .toMatch(/actor|principal/i)
    } finally {
      await rollback(importer)
    }
  })

  it('...and the NOT NULL constraint is still declared, which is what the trigger backs up', async () => {
    // The constraint the runtime path can no longer demonstrate. Asserted on
    // the same table the test above writes to, so the pair reads as one fact:
    // the trigger refuses first, the constraint would refuse if it did not.
    const { rows } = await admin.query<{ attnotnull: boolean }>(
      `SELECT a.attnotnull FROM pg_attribute a
        WHERE a.attrelid = 'investment_ledger.accounts'::regclass
          AND a.attname = 'actor_principal_id' AND NOT a.attisdropped`)
    expect(rows, 'accounts.actor_principal_id is missing').toHaveLength(1)
    expect(rows[0].attnotnull, 'accounts.actor_principal_id must be NOT NULL').toBe(true)
  })

  it('a write attributed to ANOTHER principal is rejected', async () => {
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const p = probeAccount(principals.agent.id, 'impersonate')
      const result = await probe(importer, () => importer.query(p.sql, p.values))
      expect(result.code, `${result.message}`).toBe(INSUFFICIENT_PRIVILEGE)
      expect(result.message ?? '').toMatch(/is not the calling service principal/)
    } finally {
      await rollback(importer)
    }
  })

  it('a write attributed to a principal that does not exist is rejected', async () => {
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const p = probeAccount('00000000-0000-0000-0000-000000000000', 'ghost')
      const result = await probe(importer, () => importer.query(p.sql, p.values))
      // The trigger looks the principal up FIRST, so this is 42501 with its own
      // message rather than the foreign key's 23503 — the FK is an AFTER
      // trigger and never runs.
      expect([INSUFFICIENT_PRIVILEGE, FK_VIOLATION]).toContain(result.code)
      expect(result.message ?? '').toMatch(/is not an enabled principal|violates foreign key/)
    } finally {
      await rollback(importer)
    }
  })

  it('the SAME insert succeeds when correctly attributed', async () => {
    // The control for the two tests above AND for the disabled-actor test
    // below. Without it, a probe row that was simply malformed would satisfy
    // every negative assertion in this file.
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const p = probeAccount(principals.importer.id, 'correct')
      const result = await probe(importer, () => importer.query(p.sql, p.values))
      expect(result.code, `the probe row itself is invalid: ${result.message}`).toBeNull()
    } finally {
      await rollback(importer)
    }
  })

  it('a write attributed to a DISABLED principal is rejected — exact SQLSTATE, no catch', async () => {
    // probeDetached: this client has no transaction open, and `probe` would
    // refuse rather than hand back 25P01 dressed as a database answer.
    const p = probeAccount(principals.importer.id, 'disabled')
    await admin.query('UPDATE identity.principals SET disabled_at = now() WHERE id = $1',
      [principals.importer.id])
    try {
      const result = await probeDetached(importer, async () => {
        // Context is published WITHOUT calling the authorizer, because a
        // disabled principal cannot authorize at all — and if the failure came
        // from the authorizer this test would prove nothing about the trigger.
        await importer.query("SELECT set_config('app.workspace_id', $1, true)", [workspace.id])
        await importer.query(p.sql, p.values)
      })
      expect(result.code, `${result.message}`).toBe(INSUFFICIENT_PRIVILEGE)
      expect(result.code, 'a helper-level failure must never be mistaken for a refusal')
        .not.toBe(NO_ACTIVE_TRANSACTION)
      // The trigger's own words, which prove the INSERT was REACHED: nothing
      // else in the schema produces this message.
      expect(result.message ?? '').toMatch(/is not an enabled principal/)
    } finally {
      await admin.query('UPDATE identity.principals SET disabled_at = NULL WHERE id = $1',
        [principals.importer.id])
    }
  })

  it('...and the identical INSERT succeeds once the principal is re-enabled', async () => {
    // Independent proof that the statement above was well-formed and reached
    // the table: same SQL, same values shape, principal enabled, accepted.
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const p = probeAccount(principals.importer.id, 'reenabled')
      const result = await probe(importer, () => importer.query(p.sql, p.values))
      expect(result.code, `${result.message}`).toBeNull()
    } finally {
      await rollback(importer)
    }
  })

  it.each(TENANT_TABLES)('%s carries an ENABLED actor_is_authorized trigger', async table => {
    // A disabled trigger is the failure mode a `CREATE TRIGGER` grep misses:
    // the object exists, `tgenabled` is 'D', and nothing fires.
    const { rows } = await admin.query<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger
        WHERE tgrelid = ('investment_ledger.' || $1)::regclass
          AND tgname = 'actor_is_authorized' AND NOT tgisinternal`,
      [table])
    expect(rows, `${table} has no actor_is_authorized trigger`).toHaveLength(1)
    expect(rows[0].tgenabled, `${table}'s trigger is disabled`).toBe('O')
  })

  it('the actor recorded by a real write is the CALLING principal', async () => {
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const key = `attributed-${Date.now()}`
      await importer.query(
        `INSERT INTO investment_ledger.accounts
           (workspace_id, actor_principal_id, account_key, platform, display_name,
            resolution_status, unresolved_reason)
         VALUES ($1,$2,$3,'tenancy',$3,'unresolved','positive case')`,
        [workspace.id, principals.importer.id, key])
      const { rows } = await importer.query<{ actor: string }>(
        `SELECT actor_principal_id AS actor FROM investment_ledger.accounts
          WHERE workspace_id = $1 AND account_key = $2`,
        [workspace.id, key])
      expect(rows[0].actor).toBe(principals.importer.id)
    } finally {
      await rollback(importer)
    }
  })
})
