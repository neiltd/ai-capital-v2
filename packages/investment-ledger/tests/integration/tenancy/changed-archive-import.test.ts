import { it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import {
  connectAs, ensurePrincipals, seedWorkspace, grantCapability, beginAuthorized,
  commit, rollback, probe, INSUFFICIENT_PRIVILEGE, UNIQUE_VIOLATION, RAISE_EXCEPTION,
  type Principals, type Workspace,
} from './fixture.js'
import { describeInPhase } from './phase.js'
import { publishArchive } from '../../../src/publish.js'
import { fixtureInspection, fixtureRoot, uniqueSeries } from '../support.js'

// CHANGED-ARCHIVE IMPORT UNDER ARCHIVE-IMPORT-ONLY AUTHORITY.
//
// THE CONTRADICTION THIS RESOLVES. Re-importing a series with different bytes
// supersedes the previous batch, and that MUST raise a reconciliation case so a
// human reviews the difference — a case with no opening event has no state and
// is invisible to every view. But the importer holds `archive-import`, and
// reconciliation history belongs to `reconciliation`.
//
// Both easy answers were wrong: granting the importer `reconciliation` lets it
// RESOLVE the case it just opened, and having the CLI request both capabilities
// is the same thing spelled differently. So the database admits exactly one
// event from an archive-import-only caller: `OPEN`, on a `changed_archive`
// case, in its own workspace, where that case has no events yet.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO KINDS OF REFUSAL, TESTED SEPARATELY — WHICH THE FIRST DRAFT CONFLATED.
//
// There are two independent gates on `reconciliation_case_events`, and they
// fire in this order (BEFORE ROW triggers run in alphabetical order):
//
//   actor_is_authorized        → CAPABILITY. 42501.
//   reconciliation_event_scope → the archive-import carve-out. 42501.
//   validate_reconciliation_event → THE STATE MACHINE. A bare RAISE EXCEPTION,
//                                 so P0001, and nothing to do with authority.
//
// The first draft walked MATCH, FLAG_MISMATCH, RESOLVE, REOPEN and DISMISS
// consecutively against ONE case, committing as it went. That is a state
// machine walk wearing a capability test's clothes: after RESOLVE the case is
// closed, so the next probe fails on the STATE rule while the test claims it
// proved something about capabilities. Worse, the reverse — a capability
// failure being read as a legal-transition failure — is silent.
//
// So: every capability probe starts from the SAME committed state (a case with
// one OPEN event) and is rolled back, and the state-machine paths are a
// separate block that prepares an independent case per path.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// EVERY MUTATION HERE RUNS AS ai_capital_importer.
//
// An earlier version performed ten reconciliation INSERTs through
// `connectAs('agent')`. That contradicts the login architecture:
// ops/roles/000_cluster_roles.sql defines ai_capital_agent as a LOGIN with no
// memberships, and 017 gives it no INSERT privilege and no write policy — so
// those statements could never have succeeded. The first database gate never
// reached them because a different defect refused every write first, which is
// exactly how a role violation survives review.
//
// The importer is the domain-service login for all four capabilities. A
// reconciliation workflow therefore connects as the importer and holds
// `reconciliation`; it is NOT given `ledger-read` to make a trigger's view read
// succeed — the trigger reads are reachable on the capability the write already
// requires, and 017's select_caps are what make that true.
//
// ─────────────────────────────────────────────────────────────────────────────
// SEPARATION IS BY WORKSPACE, NOT BY CONNECTION — AND THE FIRST DRAFT HAD THIS
// EXACTLY BACKWARDS.
//
// It opened two clients with `connectAs('importer')` and called one of them the
// archive publisher and the other the reconciler, as though the pair had
// different authority. They do not, and cannot: capability is resolved from
// `session_user` through `identity.current_service_principal()`, both clients
// authenticate as `ai_capital_importer`, and the fixture binds exactly ONE
// service principal per login. Two connections are one principal. The setup
// then granted that single principal BOTH `archive-import` and `reconciliation`
// in ONE workspace and asserted it lacked `reconciliation` — an assertion no
// database could ever satisfy, and the 2026-09-06 gate duly failed it.
//
// The capability boundary that IS real is per (principal, workspace): a grant
// is a row in `identity.workspace_service_grants` keyed by both. So the file
// uses TWO capability-isolated workspaces over the same principal:
//
//   archiveWs  archive-import ONLY  — changed-archive publication and every
//                                     archive-import carve-out refusal
//   reconWs    reconciliation ONLY  — every positive transition and the whole
//                                     state machine
//
// Each workspace asserts BOTH halves positively (the capability it has, and the
// one it does not), so neither block can pass vacuously. `importer` and
// `reconciler` remain two connections purely so each can hold its own open
// transaction; the authority difference comes from which workspace it selects.
// No second principal is created and no second login is used.
// ─────────────────────────────────────────────────────────────────────────────

const TRANSITIONS = ['MATCH', 'FLAG_MISMATCH', 'REQUEST_REVIEW', 'RESOLVE', 'DISMISS', 'REOPEN'] as const

describeInPhase('post-lockdown', 'a changed archive publishes under archive-import alone', () => {
  let admin: Client
  /** The connection used for archive-import work, always in `archiveWs`. */
  let importer: Client
  /** A SECOND connection, used for reconciliation work, always in `reconWs`.
   *  SAME login and SAME service principal as `importer` — the two differ only
   *  in which workspace they select, which is where capability actually lives.
   *  Two clients exist so each can hold its own open transaction. */
  let reconciler: Client
  let principals: Principals
  /** archive-import ONLY. */
  let archiveWs: Workspace
  /** reconciliation ONLY. */
  let reconWs: Workspace
  /** The changed_archive case raised in `archiveWs` by publication. Every
   *  archive-import carve-out probe starts here and rolls back. */
  let openedCaseId: string
  /** An independent open case in `reconWs`, committed. The positive transition
   *  probes start here and roll back. It is deliberately NOT the changed-archive
   *  case above: that one lives in a workspace where nobody holds
   *  `reconciliation`, so reusing it would test two things at once. */
  let reconCaseId: string

  beforeAll(async () => {
    admin = await connectAs('admin')
    importer = await connectAs('importer')
    reconciler = await connectAs('importer')
    principals = await ensurePrincipals(admin)

    // ONE principal, TWO workspaces, ONE capability each. Granting both
    // capabilities in one workspace is what made the previous version
    // self-contradicting; keeping them apart is what makes each block's
    // negative assertion true rather than aspirational.
    archiveWs = await seedWorkspace(admin, 'changed-archive')
    reconWs = await seedWorkspace(admin, 'changed-archive-recon')
    await grantCapability(admin, archiveWs, principals.importer, 'archive-import', principals.grantor)
    await grantCapability(admin, reconWs, principals.importer, 'reconciliation', principals.grantor)
    // Deliberately NOT granted: `reconciliation` in archiveWs, `archive-import`
    // in reconWs, and `ledger-read` anywhere. If a trigger's view read only
    // works with ledger-read, that is a defect in 017's select_caps, not a
    // fixture need.

    // The positive-transition fixture: a committed case in `reconWs` sitting in
    // `open`, independent of the changed-archive case in `archiveWs`.
    await beginAuthorized(reconciler, reconWs.id, ['reconciliation'])
    const seeded = await reconciler.query<{ id: string }>(
      `INSERT INTO investment_ledger.reconciliation_cases
         (workspace_id, actor_principal_id, case_key, case_type)
       VALUES ($1,$2,$3,'field_mismatch') RETURNING id`,
      [reconWs.id, principals.importer.id, `recon-open-${Date.now()}`])
    await reconciler.query(
      `INSERT INTO investment_ledger.reconciliation_case_events
         (workspace_id, actor_principal_id, case_id, event_type)
       VALUES ($1,$2,$3,'OPEN')`,
      [reconWs.id, principals.importer.id, seeded.rows[0].id])
    await commit(reconciler)
    reconCaseId = seeded.rows[0].id
  }, 60_000)

  afterAll(async () => {
    await reconciler?.end()
    await importer?.end()
    await admin?.end()
  })

  // ── THE FIXTURE'S OWN PREMISE. Both blocks below are meaningless if the two
  //    workspaces are not actually capability-isolated, so each is asserted in
  //    BOTH directions: the capability that must be present, and the one that
  //    must be absent. A single-sided check would let a stray grant turn every
  //    refusal in this file into a vacuous pass.
  //
  //    CLEANUP IN `finally`. In the 2026-09-06 gate the `rec` expectation here
  //    failed, the trailing rollback never ran, and the next SEVEN tests failed
  //    with `begin(): a transaction is already open on this client` instead of
  //    their own verdicts. `rollback` tolerates an aborted transaction, so it
  //    is safe unconditionally. ────────────────────────────────────────────
  it('in archiveWs the principal holds archive-import and NOT reconciliation', async () => {
    await beginAuthorized(importer, archiveWs.id, ['archive-import'])
    try {
      const { rows } = await importer.query<{ imp: boolean; rec: boolean }>(
        `SELECT identity.service_has_workspace_capability($1,'archive-import'::identity.service_capability) AS imp,
                identity.service_has_workspace_capability($1,'reconciliation'::identity.service_capability) AS rec`,
        [archiveWs.id])
      expect(rows[0].imp, 'archiveWs must grant archive-import').toBe(true)
      expect(rows[0].rec, 'archiveWs must NOT grant reconciliation').toBe(false)
    } finally {
      await rollback(importer)
    }
  })

  it('in reconWs the SAME principal holds reconciliation and NOT archive-import', async () => {
    // Same login, same principal, opposite capability — which is the point:
    // authority is a property of (principal, workspace), not of the connection.
    await beginAuthorized(reconciler, reconWs.id, ['reconciliation'])
    try {
      const { rows } = await reconciler.query<{ imp: boolean; rec: boolean }>(
        `SELECT identity.service_has_workspace_capability($1,'archive-import'::identity.service_capability) AS imp,
                identity.service_has_workspace_capability($1,'reconciliation'::identity.service_capability) AS rec`,
        [reconWs.id])
      expect(rows[0].rec, 'reconWs must grant reconciliation').toBe(true)
      expect(rows[0].imp, 'reconWs must NOT grant archive-import').toBe(false)
    } finally {
      await rollback(reconciler)
    }
  })

  it('both connections authenticate as the same login and resolve to one principal', async () => {
    // The invariant the previous version violated in spirit by treating two
    // clients as two authorities. Proving it here means the workspace split is
    // doing the work, not an accidental second identity.
    for (const [label, client] of [['importer', importer], ['reconciler', reconciler]] as const) {
      const { rows } = await client.query<{ who: string; principal: string }>(
        `SELECT session_user AS who,
                identity.current_service_principal()::text AS principal`)
      expect(rows[0].who, `${label} must authenticate as ai_capital_importer`)
        .toBe('ai_capital_importer')
      expect(rows[0].principal, `${label} must resolve to the shared importer principal`)
        .toBe(principals.importer.id)
    }
  })

  it('publishing a CHANGED archive succeeds and opens exactly one case', async () => {
    const series = uniqueSeries('changed-archive')
    const ws = { workspaceId: archiveWs.id, actorPrincipalId: principals.importer.id }

    await beginAuthorized(importer, archiveWs.id, ['archive-import'])
    const first = await publishArchive(
      importer, fixtureInspection(3), fixtureRoot(), 'first.csv', series, ws,
      { transaction: 'nested' })
    await commit(importer)
    expect(first.priorBatchId).toBeNull()

    // DIFFERENT bytes, same series. This is the case.
    await beginAuthorized(importer, archiveWs.id, ['archive-import'])
    const second = await publishArchive(
      importer, fixtureInspection(4), fixtureRoot(), 'second.csv', series, ws,
      { transaction: 'nested' })
    await commit(importer)
    expect(second.exactRerun).toBe(false)
    expect(second.priorBatchId).toBe(first.batchId)

    await beginAuthorized(importer, archiveWs.id, ['archive-import'])
    try {
      const cases = await importer.query<{ id: string; case_type: string }>(
        `SELECT id, case_type FROM investment_ledger.reconciliation_cases
          WHERE workspace_id = $1 AND case_key LIKE $2`,
        [archiveWs.id, `changed-archive:${series}:%`])
      expect(cases.rows).toHaveLength(1)
      expect(cases.rows[0].case_type).toBe('changed_archive')

      const events = await importer.query<{ event_type: string; actor_principal_id: string }>(
        `SELECT event_type, actor_principal_id FROM investment_ledger.reconciliation_case_events
          WHERE workspace_id = $1 AND case_id = $2`,
        [archiveWs.id, cases.rows[0].id])
      expect(events.rows).toHaveLength(1)
      expect(events.rows[0].event_type).toBe('OPEN')
      expect(events.rows[0].actor_principal_id).toBe(principals.importer.id)

      // Published for the rest of the file BEFORE the assertions above can throw
      // past it would be wrong — but after them is correct: a case that failed
      // its shape check must not be handed to the transition tests.
      openedCaseId = cases.rows[0].id
    } finally {
      await rollback(importer)
    }
  }, 60_000)

  it('the case reads as open in the state view', async () => {
    // Why the event is mandatory: without it the case has no state and nothing
    // downstream can surface it for review.
    await beginAuthorized(importer, archiveWs.id, ['archive-import'])
    try {
      const { rows } = await importer.query<{ state: string }>(
        `SELECT state FROM investment_ledger.reconciliation_case_current_state
          WHERE workspace_id = $1 AND case_id = $2`,
        [archiveWs.id, openedCaseId])
      expect(rows).toHaveLength(1)
      expect(rows[0].state).toBe('open')
    } finally {
      await rollback(importer)
    }
  })

  // ── CAPABILITY. Same starting state every time; every probe rolled back. ──

  it.each(TRANSITIONS)('archive-import cannot author a %s event', async eventType => {
    await beginAuthorized(importer, archiveWs.id, ['archive-import'])
    try {
      const result = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.reconciliation_case_events
             (workspace_id, actor_principal_id, case_id, event_type)
           VALUES ($1,$2,$3,$4)`,
          [archiveWs.id, principals.importer.id, openedCaseId, eventType]))
      expect(result.code, `${eventType}: ${result.message}`).toBe(INSUFFICIENT_PRIVILEGE)
      // The scope trigger's own words. Asserting the message proves the refusal
      // came from the carve-out and NOT from the state machine, which would
      // also reject some of these — with P0001, and for a different reason.
      expect(result.message ?? '').toMatch(
        /archive-import may author only the opening event|holds none of/)
      expect(result.code).not.toBe(RAISE_EXCEPTION)
    } finally {
      await rollback(importer)
    }
  })

  it('archive-import cannot open a case of any OTHER type', async () => {
    await beginAuthorized(importer, archiveWs.id, ['archive-import'])
    try {
      const created = await importer.query<{ id: string }>(
        `INSERT INTO investment_ledger.reconciliation_cases
           (workspace_id, actor_principal_id, case_key, case_type)
         VALUES ($1,$2,$3,'missing_document') RETURNING id`,
        [archiveWs.id, principals.importer.id, `probe-type-${Date.now()}`])
      const result = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.reconciliation_case_events
             (workspace_id, actor_principal_id, case_id, event_type)
           VALUES ($1,$2,$3,'OPEN')`,
          [archiveWs.id, principals.importer.id, created.rows[0].id]))
      expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(result.message ?? '').toMatch(/may open only changed_archive cases/)
    } finally {
      await rollback(importer)
    }
  })

  it('archive-import cannot author a SECOND opening event', async () => {
    // Two independent refusals: the trigger's readable rule, and the partial
    // unique index that wins the race the trigger cannot. Either is acceptable;
    // succeeding is not.
    await beginAuthorized(importer, archiveWs.id, ['archive-import'])
    try {
      const result = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.reconciliation_case_events
             (workspace_id, actor_principal_id, case_id, event_type)
           VALUES ($1,$2,$3,'OPEN')`,
          [archiveWs.id, principals.importer.id, openedCaseId]))
      expect([INSUFFICIENT_PRIVILEGE, UNIQUE_VIOLATION, RAISE_EXCEPTION],
        `unexpected: ${result.code} ${result.message}`).toContain(result.code)
    } finally {
      await rollback(importer)
    }
  })

  it('archive-import cannot open a case belonging to another workspace', async () => {
    // The foreign workspace is `reconWs`. It needs no ad-hoc grant: the same
    // principal already holds `reconciliation` there and nothing else, which is
    // precisely the cross-workspace shape under test — the case is real, it
    // belongs to a workspace this principal genuinely participates in, and the
    // archive-import caller in `archiveWs` still must not reach it.
    await beginAuthorized(reconciler, reconWs.id, ['reconciliation'])
    const foreign = await reconciler.query<{ id: string }>(
      `INSERT INTO investment_ledger.reconciliation_cases
         (workspace_id, actor_principal_id, case_key, case_type)
       VALUES ($1,$2,$3,'changed_archive') RETURNING id`,
      [reconWs.id, principals.importer.id, `foreign-${Date.now()}`])
    await commit(reconciler)

    await beginAuthorized(importer, archiveWs.id, ['archive-import'])
    try {
      const result = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.reconciliation_case_events
             (workspace_id, actor_principal_id, case_id, event_type)
           VALUES ($1,$2,$3,'OPEN')`,
          [archiveWs.id, principals.importer.id, foreign.rows[0].id]))
      // Not merely forbidden — NOT VISIBLE. The scope trigger is SECURITY
      // INVOKER, so its lookup runs under the caller's own RLS and the case
      // simply is not there.
      expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(result.message ?? '').toMatch(/not visible in this workspace/)
    } finally {
      await rollback(importer)
    }
  })

  // ── AUTHORITY, for a reconciliation-capable service. Same shape: one
  //    starting state, every probe rolled back.
  //
  //    EVERYTHING BELOW RUNS IN `reconWs`, on `reconCaseId` — a case opened
  //    there specifically for these probes. It is deliberately NOT the
  //    changed-archive case from `archiveWs`: no principal holds
  //    `reconciliation` in that workspace, so a probe against it would be
  //    refused for tenancy reasons while claiming to prove something about
  //    reconciliation authority. Same login and same principal as the
  //    archive-import block above; only the workspace differs. ─────────────

  it.each(['MATCH', 'FLAG_MISMATCH', 'REQUEST_REVIEW', 'RESOLVE', 'DISMISS'] as const)(
    'reconciliation (as the IMPORTER login) may author %s from the open state', async eventType => {
      // Every one of these is a LEGAL transition out of `open`, so each probe
      // tests authority alone. REOPEN is excluded here because it is illegal
      // from `open` — it belongs to the state-machine block below, and mixing
      // the two is exactly the conflation this file was rewritten to avoid.
      await beginAuthorized(reconciler, reconWs.id, ['reconciliation'])
      try {
        const result = await probe(reconciler, () =>
          reconciler.query(
            `INSERT INTO investment_ledger.reconciliation_case_events
               (workspace_id, actor_principal_id, case_id, event_type)
             VALUES ($1,$2,$3,$4)`,
            [reconWs.id, principals.importer.id, reconCaseId, eventType]))
        expect(result.code, `${eventType}: ${result.message}`).toBeNull()
      } finally {
        await rollback(reconciler)
      }
    })

  // ── THE STATE MACHINE, on independently prepared cases. ───────────────────

  /** Open a fresh case and walk it to `path`'s last state, returning its id.
   *  Each call gets its OWN case, so no path can be affected by another. */
  async function caseAfter(path: readonly string[]): Promise<string> {
    await beginAuthorized(reconciler, reconWs.id, ['reconciliation'])
    const created = await reconciler.query<{ id: string }>(
      `INSERT INTO investment_ledger.reconciliation_cases
         (workspace_id, actor_principal_id, case_key, case_type)
       VALUES ($1,$2,$3,'field_mismatch') RETURNING id`,
      [reconWs.id, principals.importer.id, `path-${path.join('-')}-${Date.now()}-${Math.random()}`])
    for (const eventType of ['OPEN', ...path]) {
      await reconciler.query(
        `INSERT INTO investment_ledger.reconciliation_case_events
           (workspace_id, actor_principal_id, case_id, event_type)
         VALUES ($1,$2,$3,$4)`,
        [reconWs.id, principals.importer.id, created.rows[0].id, eventType])
    }
    await commit(reconciler)
    return created.rows[0].id
  }

  it('a closed case requires REOPEN, and REOPEN is legal there', async () => {
    const closed = await caseAfter(['RESOLVE'])
    await beginAuthorized(reconciler, reconWs.id, ['reconciliation'])
    try {
      const illegal = await probe(reconciler, () =>
        reconciler.query(
          `INSERT INTO investment_ledger.reconciliation_case_events
             (workspace_id, actor_principal_id, case_id, event_type)
           VALUES ($1,$2,$3,'MATCH')`,
          [reconWs.id, principals.importer.id, closed]))
      // P0001, not 42501: the state machine, not the capability system. That
      // distinction is the whole reason this block exists.
      expect(illegal.code).toBe(RAISE_EXCEPTION)
      expect(illegal.message ?? '').toMatch(/closed reconciliation case requires REOPEN/)

      const legal = await probe(reconciler, () =>
        reconciler.query(
          `INSERT INTO investment_ledger.reconciliation_case_events
             (workspace_id, actor_principal_id, case_id, event_type)
           VALUES ($1,$2,$3,'REOPEN')`,
          [reconWs.id, principals.importer.id, closed]))
      expect(legal.code, `${legal.message}`).toBeNull()
    } finally {
      await rollback(reconciler)
    }
  })

  it('a matched case accepts REOPEN and RESOLVE and nothing else', async () => {
    const matched = await caseAfter(['MATCH'])
    await beginAuthorized(reconciler, reconWs.id, ['reconciliation'])
    try {
      for (const eventType of ['REOPEN', 'RESOLVE']) {
        const result = await probe(reconciler, () =>
          reconciler.query(
            `INSERT INTO investment_ledger.reconciliation_case_events
               (workspace_id, actor_principal_id, case_id, event_type)
             VALUES ($1,$2,$3,$4)`,
            [reconWs.id, principals.importer.id, matched, eventType]))
        expect(result.code, `${eventType} should be legal from matched: ${result.message}`).toBeNull()
      }
      for (const eventType of ['MATCH', 'FLAG_MISMATCH', 'REQUEST_REVIEW', 'DISMISS']) {
        const result = await probe(reconciler, () =>
          reconciler.query(
            `INSERT INTO investment_ledger.reconciliation_case_events
               (workspace_id, actor_principal_id, case_id, event_type)
             VALUES ($1,$2,$3,$4)`,
            [reconWs.id, principals.importer.id, matched, eventType]))
        expect(result.code, `${eventType} should be illegal from matched`).toBe(RAISE_EXCEPTION)
      }
    } finally {
      await rollback(reconciler)
    }
  })

  it('the first event of any case must be OPEN', async () => {
    await beginAuthorized(reconciler, reconWs.id, ['reconciliation'])
    try {
      const created = await reconciler.query<{ id: string }>(
        `INSERT INTO investment_ledger.reconciliation_cases
           (workspace_id, actor_principal_id, case_key, case_type)
         VALUES ($1,$2,$3,'low_confidence') RETURNING id`,
        [reconWs.id, principals.importer.id, `first-event-${Date.now()}`])
      const result = await probe(reconciler, () =>
        reconciler.query(
          `INSERT INTO investment_ledger.reconciliation_case_events
             (workspace_id, actor_principal_id, case_id, event_type)
           VALUES ($1,$2,$3,'MATCH')`,
          [reconWs.id, principals.importer.id, created.rows[0].id]))
      expect(result.code).toBe(RAISE_EXCEPTION)
      expect(result.message ?? '').toMatch(/first reconciliation event must be OPEN/)
    } finally {
      await rollback(reconciler)
    }
  })

  it('an UNCHANGED re-publication opens no case at all', async () => {
    // The exact-rerun path. A case raised for identical bytes would train the
    // operator to dismiss changed-archive cases without reading them, which is
    // worse than not raising one.
    const series = uniqueSeries('unchanged')
    const ws = { workspaceId: archiveWs.id, actorPrincipalId: principals.importer.id }
    const inspection = fixtureInspection(3)

    await beginAuthorized(importer, archiveWs.id, ['archive-import'])
    await publishArchive(importer, inspection, fixtureRoot(), 'same.csv', series, ws,
      { transaction: 'nested' })
    await commit(importer)

    await beginAuthorized(importer, archiveWs.id, ['archive-import'])
    try {
      const again = await publishArchive(importer, inspection, fixtureRoot(), 'same.csv', series, ws,
        { transaction: 'nested' })
      expect(again.exactRerun).toBe(true)
      const { rows } = await importer.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM investment_ledger.reconciliation_cases
          WHERE workspace_id = $1 AND case_key LIKE $2`,
        [archiveWs.id, `changed-archive:${series}:%`])
      expect(rows[0].n).toBe(0)
    } finally {
      await rollback(importer)
    }
  }, 60_000)
})
