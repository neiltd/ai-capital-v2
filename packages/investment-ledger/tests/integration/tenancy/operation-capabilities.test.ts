import { it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import {
  connectAs, ensurePrincipals, seedWorkspace, beginAuthorized,
  rollback, probe, INSUFFICIENT_PRIVILEGE, RAISE_EXCEPTION,
  type Principals, type Workspace,
} from './fixture.js'
import { seedGraphAndRestrict, hex64, type ParentGraph } from './graph.js'
import { describeInPhase } from './phase.js'

// OPERATION-SPECIFIC CAPABILITIES, AND THE VIEW GRANTS THE TRIGGERS NEED.
//
// INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// Needs a disposable cluster carrying the roles from
// ops/roles/000_cluster_roles.sql, a database migrated 001-017, and one
// login URL per role. The database-free suite never executes it, so nothing
// here is verified until that gate runs.
//
// THE DEFECT THIS FILE EXISTS FOR. Migration 017 used ONE capability set per
// table for SELECT, INSERT and the locking UPDATE alike. Three BEFORE INSERT
// trigger functions take `SELECT ... FOR UPDATE` on a DIFFERENT table from the
// one being written, under the capability of the write they validate:
//
//   validate_account_resolution()           locks accounts               (reconciliation)
//   validate_document_verification_event()  locks document_file_variants (document-verification)
//   validate_reconciliation_event()         locks reconciliation_cases   (archive-import|reconciliation)
//
// A row lock is charged to the UPDATE privilege AND evaluates the UPDATE
// policy's USING clause as well as the SELECT policy's — two policies, not one.
// With a single shared set, `reconciliation` could not lock an account and
// `document-verification` could not lock a variant, so both real workflows
// failed at the trigger.
//
// The fix is NOT to widen the shared set: that would hand `reconciliation` the
// right to CREATE accounts and `document-verification` the right to CREATE file
// variants. Reading and creating are different authorities. This file proves
// both halves — the read/lock is permitted, the insert is not.

describeInPhase('post-lockdown', 'operation-specific capabilities', () => {
  let admin: Client
  let importer: Client
  let operator: Client
  let principals: Principals

  /** A workspace holding ONLY `reconciliation`, with a seeded parent graph. */
  let recWs: Workspace
  let recGraph: ParentGraph
  /** A workspace holding ONLY `document-verification`, likewise. */
  let dvWs: Workspace
  let dvGraph: ParentGraph
  /** A workspace holding ONLY `archive-import`. */
  let aiWs: Workspace
  let aiGraph: ParentGraph

  beforeAll(async () => {
    admin = await connectAs('admin')
    importer = await connectAs('importer')
    operator = await connectAs('operator')
    principals = await ensurePrincipals(admin)

    // seedGraphAndRestrict opens a setup window, seeds real parent rows, then
    // revokes everything except `keep`. So each workspace below genuinely holds
    // ONE capability and genuinely contains rows — which is what stops the
    // denials below passing against an empty relation.
    recWs = await seedWorkspace(admin, 'opcap-reconciliation')
    recGraph = await seedGraphAndRestrict(admin, importer, operator, recWs,
      principals.importer, principals.grantor, ['reconciliation'])

    dvWs = await seedWorkspace(admin, 'opcap-docverify')
    dvGraph = await seedGraphAndRestrict(admin, importer, operator, dvWs,
      principals.importer, principals.grantor, ['document-verification'])

    aiWs = await seedWorkspace(admin, 'opcap-archive-import')
    aiGraph = await seedGraphAndRestrict(admin, importer, operator, aiWs,
      principals.importer, principals.grantor, ['archive-import'])
  }, 180_000)

  afterAll(async () => {
    await operator?.end()
    await importer?.end()
    await admin?.end()
  })

  it('the three probe workspaces hold exactly one capability each', async () => {
    for (const [ws, cap] of [[recWs, 'reconciliation'], [dvWs, 'document-verification'],
                             [aiWs, 'archive-import']] as const) {
      const { rows } = await admin.query<{ capability: string }>(
        `SELECT capability::text AS capability FROM identity.workspace_service_grants
          WHERE workspace_id = $1 AND principal_id = $2 AND effective_range @> now()
          ORDER BY 1`,
        [ws.id, principals.importer.id])
      expect(rows.map(r => r.capability), `${cap} workspace`).toEqual([cap])
    }
  })

  it('the seeded rows really exist — no denial below can be vacuous', async () => {
    for (const [ws, g] of [[recWs, recGraph], [dvWs, dvGraph]] as const) {
      const { rows } = await admin.query<{ accounts: number; variants: number }>(
        `SELECT (SELECT count(*)::int FROM investment_ledger.accounts
                  WHERE workspace_id = $1) AS accounts,
                (SELECT count(*)::int FROM investment_ledger.document_file_variants
                  WHERE workspace_id = $1) AS variants`,
        [ws.id])
      expect(rows[0].accounts).toBeGreaterThan(0)
      expect(rows[0].variants).toBeGreaterThan(0)
      expect(g.placeholderAccountId).toBeTruthy()
      expect(g.variantId).toBeTruthy()
    }
  })

  // ── accounts: reconciliation reads and locks, but never creates. ─────────

  it('reconciliation can SELECT a seeded account', async () => {
    await beginAuthorized(importer, recWs.id, ['reconciliation'])
    try {
      const result = await probe(importer, async () => {
        const { rows } = await importer.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM investment_ledger.accounts WHERE workspace_id = $1',
          [recWs.id])
        if (rows[0].n === 0) throw new Error('read succeeded but returned no rows')
      })
      expect(result.code, `${result.message}`).toBeNull()
    } finally { await rollback(importer) }
  })

  it('reconciliation can LOCK a seeded account — the trigger takes FOR UPDATE', async () => {
    await beginAuthorized(importer, recWs.id, ['reconciliation'])
    try {
      const result = await probe(importer, () =>
        importer.query('SELECT id FROM investment_ledger.accounts WHERE id = $1 FOR UPDATE',
          [recGraph.placeholderAccountId]))
      expect(result.code, `${result.message}`).toBeNull()
    } finally { await rollback(importer) }
  })

  it('reconciliation CANNOT insert an account', async () => {
    // The half a widened shared set would have destroyed.
    await beginAuthorized(importer, recWs.id, ['reconciliation'])
    try {
      const result = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.accounts
             (workspace_id, actor_principal_id, account_key, platform, display_name,
              resolution_status, unresolved_reason)
           VALUES ($1,$2,$3,'tenancy',$3,'unresolved','must be refused')`,
          [recWs.id, principals.importer.id, `opcap-${Date.now()}`]))
      expect(result.code, `${result.message}`).toBe(INSUFFICIENT_PRIVILEGE)
      expect(result.message ?? '', 'must be a CAPABILITY refusal, not a privilege one')
        .toMatch(/holds none of/)
    } finally { await rollback(importer) }
  })

  it('the real account_resolutions workflow succeeds with reconciliation ALONE', async () => {
    // End to end: the INSERT fires validate_account_resolution(), which locks
    // `accounts` and reads `active_account_resolutions`. Both are reachable on
    // `reconciliation` only because 017 widened the SELECT/lock sets and
    // granted that view. No ledger-read anywhere.
    await beginAuthorized(importer, recWs.id, ['reconciliation'])
    try {
      const result = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.account_resolutions
             (workspace_id, actor_principal_id, placeholder_account_id,
              resolved_account_id, resolution_kind, reason)
           VALUES ($1,$2,$3,$4,'resolve','operation-capability probe')`,
          [recWs.id, principals.importer.id,
           recGraph.placeholderAccountId, recGraph.resolvedAccountId]))
      expect(result.code, `${result.message}`).toBeNull()
    } finally { await rollback(importer) }
  })

  // ── document_file_variants: document-verification reads and locks. ───────

  it('document-verification can SELECT and LOCK a seeded file variant', async () => {
    await beginAuthorized(importer, dvWs.id, ['document-verification'])
    try {
      const read = await probe(importer, () =>
        importer.query('SELECT id FROM investment_ledger.document_file_variants WHERE id = $1',
          [dvGraph.variantId]))
      const lock = await probe(importer, () =>
        importer.query(
          'SELECT id FROM investment_ledger.document_file_variants WHERE id = $1 FOR UPDATE',
          [dvGraph.variantId]))
      expect(read.code, `SELECT: ${read.message}`).toBeNull()
      expect(lock.code, `FOR UPDATE: ${lock.message}`).toBeNull()
    } finally { await rollback(importer) }
  })

  it('document-verification CANNOT insert a file variant', async () => {
    await beginAuthorized(importer, dvWs.id, ['document-verification'])
    try {
      const result = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.document_file_variants
             (workspace_id, actor_principal_id, logical_document_id, variant_kind, observed_path)
           VALUES ($1,$2,$3,'unlocked',$4)`,
          [dvWs.id, principals.importer.id, dvGraph.logicalDocumentId,
           `tenancy/opcap-${Date.now()}.pdf`]))
      expect(result.code, `${result.message}`).toBe(INSUFFICIENT_PRIVILEGE)
      expect(result.message ?? '').toMatch(/holds none of/)
    } finally { await rollback(importer) }
  })

  it('the real document_verification_events workflow succeeds with document-verification ALONE', async () => {
    // Fires validate_document_verification_event(), which locks
    // document_file_variants and reads active_document_verification_events.
    await beginAuthorized(importer, dvWs.id, ['document-verification'])
    try {
      const result = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.document_verification_events
             (workspace_id, actor_principal_id, variant_id, event_kind, content_sha256, reason)
           VALUES ($1,$2,$3,'verified',$4,'operation-capability probe')`,
          [dvWs.id, principals.importer.id, dvGraph.variantId, hex64()]))
      expect(result.code, `${result.message}`).toBeNull()
    } finally { await rollback(importer) }
  })

  // ── The four view grants are each required by a real workflow. ───────────

  it.each([
    ['reconciliation_case_current_state', 'reconciliation'],
    ['active_account_resolutions',        'reconciliation'],
    ['active_document_verification_events', 'document-verification'],
    ['current_import_batches',            'archive-import'],
  ] as const)('the importer can read %s under %s', async (view, capability) => {
    const ws = capability === 'reconciliation' ? recWs
             : capability === 'document-verification' ? dvWs : aiWs
    await beginAuthorized(importer, ws.id, [capability])
    try {
      const result = await probe(importer, () =>
        importer.query(`SELECT count(*) FROM investment_ledger.${view}`))
      expect(result.code, `${view}: ${result.message}`).toBeNull()
    } finally { await rollback(importer) }
  })

  it.each([
    'current_transactions', 'economic_amount_components', 'effective_accounts',
    'transaction_effective_accounts', 'current_document_verification',
  ] as const)('the withheld view %s is refused even to the importer', async view => {
    await beginAuthorized(importer, aiWs.id, ['archive-import'])
    try {
      const result = await probe(importer, () =>
        importer.query(`SELECT count(*) FROM investment_ledger.${view}`))
      expect(result.code, `${view}: ${result.message}`).toBe(INSUFFICIENT_PRIVILEGE)
      // MISSING SQL PRIVILEGE — no grant on the view — not a capability refusal.
      expect(result.message ?? '').toMatch(/permission denied/)
      expect(result.message ?? '').not.toMatch(/holds none of/)
    } finally { await rollback(importer) }
  })

  // ── The four failure classes are distinguishable. ────────────────────────

  it('missing PRIVILEGE, missing CAPABILITY, hidden ROW and STATE rejection differ', async () => {
    await beginAuthorized(importer, recWs.id, ['reconciliation'])
    try {
      // 1. missing SQL privilege: a withheld view.
      const noPrivilege = await probe(importer, () =>
        importer.query('SELECT 1 FROM investment_ledger.current_transactions LIMIT 1'))
      expect(noPrivilege.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(noPrivilege.message ?? '').toMatch(/permission denied/)

      // 2. missing capability: a table this workspace's capability cannot write.
      const noCapability = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.accounts
             (workspace_id, actor_principal_id, account_key, platform, display_name,
              resolution_status, unresolved_reason)
           VALUES ($1,$2,$3,'tenancy',$3,'unresolved','x')`,
          [recWs.id, principals.importer.id, `cls-${Date.now()}`]))
      expect(noCapability.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(noCapability.message ?? '').toMatch(/holds none of/)

      // 3. hidden row: another workspace's rows are filtered, not refused.
      const hidden = await importer.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM investment_ledger.accounts WHERE workspace_id = $1',
        [dvWs.id])
      expect(hidden.rows[0].n, 'cross-workspace rows must be hidden, not raised').toBe(0)

      // 4. application/state-machine rejection: P0001 from a plain RAISE.
      const created = await importer.query<{ id: string }>(
        `INSERT INTO investment_ledger.reconciliation_cases
           (workspace_id, actor_principal_id, case_key, case_type)
         VALUES ($1,$2,$3,'low_confidence') RETURNING id`,
        [recWs.id, principals.importer.id, `cls-case-${Date.now()}`])
      const stateReject = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.reconciliation_case_events
             (workspace_id, actor_principal_id, case_id, event_type)
           VALUES ($1,$2,$3,'MATCH')`,
          [recWs.id, principals.importer.id, created.rows[0].id]))
      expect(stateReject.code, 'a state-machine refusal is P0001, not 42501')
        .toBe(RAISE_EXCEPTION)
      expect(stateReject.message ?? '').toMatch(/first reconciliation event must be OPEN/)

      // All four are distinct.
      expect(new Set([noPrivilege.code, noCapability.code, stateReject.code]).size)
        .toBeGreaterThanOrEqual(2)
    } finally { await rollback(importer) }
  })

  // ── Deferred constraint triggers fire with workspace context still live. ──

  it('DEFERRED correction triggers fire at SET CONSTRAINTS ALL IMMEDIATE, in context', async () => {
    // A DETERMINISTIC INVALID CORRECTION GROUP, and an assertion that demands
    // the trigger actually ran.
    //
    // `enforce_correction_integrity` is an AFTER INSERT CONSTRAINT TRIGGER,
    // DEFERRABLE INITIALLY DEFERRED, so it runs at SET CONSTRAINTS or COMMIT —
    // after the statement that caused it, and only if the deferral works. It
    // reads `transactions` and `transaction_groups`, so the transaction-local
    // workspace context must still be published when it fires.
    //
    // The group below contains exactly ONE transaction, and that transaction is
    // a `reversal` whose target lives OUTSIDE the group — so the group has zero
    // originals and `validate_correction_group` raises the missing-original
    // error. Nothing about it is timing- or ordering-dependent.
    //
    // An earlier version of this test accepted EITHER success or a business
    // failure, which is no assertion at all: it passed whether or not the
    // trigger existed. This one fails if the trigger is removed (SET CONSTRAINTS
    // succeeds), if it is made non-deferrable (the INSERT raises instead, and
    // the insert-succeeded assertion catches it), or if the expectation is
    // weakened to accept success.
    await beginAuthorized(importer, aiWs.id, ['archive-import'])
    try {
      const group = await importer.query<{ id: string }>(
        `INSERT INTO investment_ledger.transaction_groups
           (workspace_id, actor_principal_id, group_type, group_key, description)
         VALUES ($1,$2,'correction',$3,'deferred trigger probe') RETURNING id`,
        [aiWs.id, principals.importer.id, `deferred-${Date.now()}`])
      const groupId = group.rows[0].id

      // THE INSERT RUNS DIRECTLY, NOT THROUGH probe(), AND THAT IS THE WHOLE
      // POINT OF THIS TEST.
      //
      // `probe()` wraps its callback in a SAVEPOINT and issues ROLLBACK TO
      // SAVEPOINT unconditionally — on success as well as on failure — because
      // every other probe in this suite wants the database left untouched. A
      // DEFERRED constraint trigger's pending event belongs to the subtransaction
      // that queued it, so rolling back to the savepoint DISCARDS it. The
      // subsequent SET CONSTRAINTS then had nothing to fire and returned
      // success, and the 2026-09-06 gate reported `expected null to be P0001` —
      // a test defeated by its own cleanup rather than by the schema.
      //
      // So the row is inserted straight onto the transaction. It must be
      // ACCEPTED here: if the trigger were not deferred it would raise at this
      // statement, and the rejection below makes that failure legible instead of
      // surfacing as an opaque driver error. probe() is still used — but only
      // around SET CONSTRAINTS, where a rollback after the verdict is harmless.
      try {
        await importer.query(
          `INSERT INTO investment_ledger.transactions
             (workspace_id, actor_principal_id, account_id, instrument_id,
              transaction_group_id, correction_of_id, correction_role,
              occurred_on, transaction_type, units, business_fingerprint, record_source)
           VALUES ($1,$2,$3,$4,$5,$6,'reversal','2026-03-04','SELL',1,$7,'archive_csv')`,
          [aiWs.id, principals.importer.id, aiGraph.placeholderAccountId,
           aiGraph.instrumentId, groupId, aiGraph.transactionId, hex64()])
      } catch (error) {
        const e = error as { code?: string; message?: string }
        throw new Error(
          'the INSERT must be accepted and the correction check DEFERRED, but it ' +
          `raised ${e.code ?? 'unknown'}: ${e.message ?? ''} — a constraint trigger ` +
          'that fires at statement time is not DEFERRABLE INITIALLY DEFERRED')
      }

      // The context must STILL be live, or the deferred trigger's reads would
      // be filtered to nothing and it would misfire for a tenancy reason.
      const ctx = await importer.query<{ ws: string | null; who: string | null }>(
        `SELECT nullif(current_setting('app.workspace_id', true),'') AS ws,
                nullif(current_setting('app.principal_id', true),'') AS who`)
      expect(ctx.rows[0].ws, 'workspace GUC must still be active when the trigger fires')
        .toBe(aiWs.id)
      expect(ctx.rows[0].who).toBe(principals.importer.id)

      // FOCUSED PRECONDITION, so a regression names itself. The deferred trigger
      // calls `validate_correction_group(gid)` as an ORDINARY function call,
      // which checks EXECUTE against this role. When that grant was missing the
      // 2026-09-07 gate saw only "expected 42501 to be P0001" here, and the
      // cause took a manual reproduction to find. One assertion turns that into
      // a named failure. The complete ACL matrix lives in ownership-and-acl.
      const exec = await importer.query<{ can: boolean }>(
        `SELECT has_function_privilege(
                  'ai_capital_importer',
                  'investment_ledger.validate_correction_group(uuid)'::regprocedure,
                  'EXECUTE') AS can`)
      expect(exec.rows[0].can,
        'the importer cannot EXECUTE validate_correction_group: the deferred trigger ' +
        'will raise 42501 before the correction-integrity rule runs').toBe(true)

      // AND NOW THE TRIGGER MUST FIRE, with this exact verdict.
      const fired = await probe(importer, () =>
        importer.query('SET CONSTRAINTS ALL IMMEDIATE'))
      expect(fired.code,
        'SET CONSTRAINTS ALL IMMEDIATE must raise — the deferred trigger did not run')
        .toBe(RAISE_EXCEPTION)
      expect(fired.message ?? '', 'not the missing-original correction-integrity error')
        .toMatch(/must contain exactly one original transaction, found 0/)
      expect(fired.message ?? '').toContain(groupId)
      // NOT a tenancy failure: the trigger reached its own rule.
      expect(fired.code).not.toBe(INSUFFICIENT_PRIVILEGE)
    } finally {
      await rollback(importer)
    }
  })
})
