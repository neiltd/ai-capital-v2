import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import {
  ALL_CAPABILITIES, connectAs, ensurePrincipals, seedWorkspace, beginAuthorized,
  probe, probeDetached, rollback, INSUFFICIENT_PRIVILEGE,
  type Capability, type Principals, type Workspace,
} from './fixture.js'
import { seedGraphAndRestrict, tableInserts, TENANT_TABLES, type ParentGraph } from './graph.js'
import { describeInPhase } from './phase.js'

// THE CAPABILITY MATRIX — every tenant table × every capability, as REAL
// INSERTs.
//
// INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE FIRST VERSION OF THIS FILE ACTUALLY TESTED, AND WHY IT WAS WORTHLESS.
//
// It created one principal per capability, bound them all to
// `ai_capital_importer` — which is UNIQUE, so all but the first collided — and
// then, for each table, called `identity.authorize_service_workspace(...)` and
// asserted the result. That is a test of the authorization FUNCTION. It touches
// no table, so it cannot detect a missing policy, a policy naming the wrong
// capability set, a missing attribution trigger, or a trigger whose capability
// arguments disagree with its policy. Every one of those is the actual failure
// mode. A table with NO policy at all would have passed it.
//
// THE CORRECTED SHAPE.
//
//   * ONE principal, bound to `ai_capital_importer`. That is what production
//     has, and it is what `service_principal_roles.db_role` permits.
//   * FIVE WORKSPACES, one per capability, each holding exactly that one.
//     Capability differences belong to workspaces; inventing principals to
//     express them was the original mistake.
//   * A real, valid INSERT into all seventeen tenant tables in every workspace
//     — 85 cells. The parent-row graph is seeded per workspace during a setup
//     window that is then closed by revocation (see graph.ts).
//   * Every probe rolls back, successes included, so a cell cannot satisfy a
//     later cell's unique constraint or change its starting state.
//
// WHY THE NEGATIVE CELLS ASSERT A MESSAGE AS WELL AS A SQLSTATE. A row missing
// a parent, violating a CHECK or omitting a NOT NULL column also fails — and a
// test that accepted any failure would pass while the INSERT never reached the
// authorization layer at all. Both refusal paths here (the `actor_is_authorized`
// trigger and the RLS policy's authorizer) say "holds none of", and nothing
// else in the schema does. That phrase is the proof that the INSERT was
// well-formed and was turned away for the reason claimed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SELECT / lock capabilities, written out rather than derived from the
 * migration — a test that read its expectation from the thing under test would
 * agree with any mistake it contained.
 *
 * These differ from INSERT on exactly two tables, and the difference is the
 * point. Three BEFORE INSERT trigger functions take `SELECT ... FOR UPDATE` on
 * a table OTHER than the one being written, under the capability of the write
 * they validate:
 *
 *   validate_account_resolution()           locks accounts      under reconciliation
 *   validate_document_verification_event()  locks variants      under document-verification
 *   validate_reconciliation_event()         locks cases         under archive-import|reconciliation
 *
 * PostgreSQL charges a row lock to the UPDATE privilege AND applies the UPDATE
 * policy's USING clause as well as the SELECT policy's, so a lock is gated by
 * two policies. Reading and locking therefore share a set; CREATING is
 * narrower, so that `reconciliation` never gains authority to insert an account
 * and `document-verification` never gains authority to insert a file variant.
 */
const READ_LOCK_CAPABILITIES: Record<string, Capability[]> = {
  accounts:                      ['archive-import', 'manual-entry', 'reconciliation'],
  instrument_aliases:            ['archive-import', 'manual-entry'],
  import_batches:                ['archive-import'],
  raw_import_rows:               ['archive-import'],
  logical_documents:             ['archive-import'],
  document_file_variants:        ['archive-import', 'document-verification'],
  document_extractions:          ['archive-import'],
  document_blobs:                ['archive-import'],
  document_verification_events:  ['document-verification'],
  transaction_groups:            ['archive-import', 'manual-entry'],
  transactions:                  ['archive-import', 'manual-entry'],
  transaction_amount_components: ['archive-import', 'manual-entry'],
  transaction_document_links:    ['archive-import', 'manual-entry'],
  validation_findings:           ['archive-import'],
  reconciliation_cases:          ['archive-import', 'reconciliation'],
  reconciliation_case_events:    ['archive-import', 'reconciliation'],
  account_resolutions:           ['reconciliation'],
}

/** INSERT capabilities — the CREATION authority, deliberately narrower. */
const WRITE_CAPABILITIES: Record<string, Capability[]> = {
  accounts:                      ['archive-import', 'manual-entry'],
  instrument_aliases:            ['archive-import', 'manual-entry'],
  import_batches:                ['archive-import'],
  raw_import_rows:               ['archive-import'],
  logical_documents:             ['archive-import'],
  document_file_variants:        ['archive-import'],
  document_extractions:          ['archive-import'],
  document_blobs:                ['archive-import'],
  document_verification_events:  ['document-verification'],
  transaction_groups:            ['archive-import', 'manual-entry'],
  transactions:                  ['archive-import', 'manual-entry'],
  transaction_amount_components: ['archive-import', 'manual-entry'],
  transaction_document_links:    ['archive-import', 'manual-entry'],
  validation_findings:           ['archive-import'],
  reconciliation_cases:          ['archive-import', 'reconciliation'],
  // The one table whose row is not a plain capability set. `reconciliation`
  // authorizes every transition; `archive-import` authorizes exactly one event
  // — an OPEN on an eventless `changed_archive` case, which is precisely what
  // the graph provides. The narrow rule itself lives in
  // changed-archive-import.test.ts; here it is only the INSERT that must reach
  // the table under both.
  reconciliation_case_events:    ['archive-import', 'reconciliation'],
  account_resolutions:           ['reconciliation'],
}

describeInPhase('post-lockdown', 'capability matrix', () => {
  let admin: Client
  let importer: Client
  let operator: Client
  let principals: Principals
  const workspaces = new Map<Capability, Workspace>()
  const graphs = new Map<Capability, ParentGraph>()
  /** A SECOND workspace per capability, filled in all seventeen tenant tables,
   *  used only for SELECT/LOCK. Kept separate because three of those rows would
   *  change what a later INSERT may legally do — see fillRemainingTenantTables
   *  in graph.ts. */
  const visWorkspaces = new Map<Capability, Workspace>()
  const INSERTS = tableInserts()

  beforeAll(async () => {
    admin = await connectAs('admin')
    importer = await connectAs('importer')
    operator = await connectAs('operator')
    principals = await ensurePrincipals(admin)

    for (const capability of ALL_CAPABILITIES) {
      const workspace = await seedWorkspace(admin, `matrix-${capability}`)
      workspaces.set(capability, workspace)
      graphs.set(capability, await seedGraphAndRestrict(
        admin, importer, operator, workspace, principals.importer, principals.grantor,
        [capability]))

      const vis = await seedWorkspace(admin, `matrixvis-${capability}`)
      visWorkspaces.set(capability, vis)
      await seedGraphAndRestrict(
        admin, importer, operator, vis, principals.importer, principals.grantor,
        [capability], { fillEveryTenantTable: true })
    }
  }, 240_000)

  afterAll(async () => {
    await operator?.end()
    await importer?.end()
    await admin?.end()
  })

  // ── Preconditions. If any of these are false the matrix below is noise. ────

  it('exactly one principal is bound to ai_capital_importer', async () => {
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity.service_principal_roles
        WHERE db_role = 'ai_capital_importer'`)
    expect(rows[0].n).toBe(1)
  })

  it('the importer login resolves to that principal', async () => {
    const workspace = workspaces.get('archive-import')!
    const actor = await beginAuthorized(importer, workspace.id, ['archive-import'])
    expect(actor).toBe(principals.importer.id)
    await rollback(importer)
  })

  it('each matrix workspace holds exactly one live capability', async () => {
    // The setup window is CLOSED. If a revocation silently failed, the negative
    // half of this file would report success for the wrong reason.
    for (const capability of ALL_CAPABILITIES) {
      const { rows } = await admin.query<{ capability: string }>(
        `SELECT capability::text AS capability
           FROM identity.workspace_service_grants
          WHERE workspace_id = $1 AND principal_id = $2
            AND effective_range @> now()
          ORDER BY 1`,
        [workspaces.get(capability)!.id, principals.importer.id])
      expect(rows.map(r => r.capability), `workspace for ${capability}`).toEqual([capability])
    }
  })

  it('covers all seventeen tenant tables and nothing else', async () => {
    expect(INSERTS.map(i => i.table).sort()).toEqual(Object.keys(WRITE_CAPABILITIES).sort())
    expect(INSERTS).toHaveLength(17)
    const { rows } = await admin.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r'
          AND c.relname <> 'instruments' ORDER BY 1`)
    expect(rows.map(r => r.relname)).toEqual(Object.keys(WRITE_CAPABILITIES).sort())
  })

  it('the parent graph exists in every workspace', async () => {
    for (const capability of ALL_CAPABILITIES) {
      const g = graphs.get(capability)!
      for (const [name, id] of Object.entries(g)) {
        expect(id, `${capability}: ${name}`).toBeTruthy()
      }
    }
  })

  // ── The matrix. 5 capabilities × 17 tables = 85 cells. ────────────────────

  for (const capability of ALL_CAPABILITIES) {
    describe(`workspace holding only ${capability}`, () => {
      for (const insert of tableInserts()) {
        const allowed = WRITE_CAPABILITIES[insert.table].includes(capability)

        it(`${allowed ? 'INSERTS INTO' : 'is refused by'} ${insert.table}`, async () => {
          const workspace = workspaces.get(capability)!
          const graph = graphs.get(capability)!
          await beginAuthorized(importer, workspace.id, [capability])
          try {
            const result = await probe(importer, () =>
              importer.query(insert.sql, insert.values(graph)))

            if (allowed) {
              // A valid row, accepted. Nothing else in this suite proves the
              // INSERT was well-formed; if this cell fails on 23502/23503/23514
              // the probe row is wrong and every negative cell above it is
              // meaningless.
              expect(result.code, `${insert.table}: ${result.message}`).toBeNull()
            } else {
              expect(result.code, `${insert.table}: ${result.message}`)
                .toBe(INSUFFICIENT_PRIVILEGE)
              // Proof the row reached the authorization layer rather than
              // dying on a constraint that happens to share no SQLSTATE.
              expect(result.message, `${insert.table} was refused for another reason`)
                .toMatch(/holds none of/)
            }
          } finally {
            await rollback(importer)
          }
        })
      }
    })
  }

  // ── Properties of the matrix as a whole. ──────────────────────────────────

  // ── OPERATION SPLIT: the two tables where reading and creating diverge. ──

  it('accounts: SELECT admits reconciliation, INSERT does not', () => {
    expect(READ_LOCK_CAPABILITIES.accounts).toContain('reconciliation')
    expect(WRITE_CAPABILITIES.accounts).not.toContain('reconciliation')
  })

  it('document_file_variants: SELECT admits document-verification, INSERT does not', () => {
    expect(READ_LOCK_CAPABILITIES.document_file_variants).toContain('document-verification')
    expect(WRITE_CAPABILITIES.document_file_variants).not.toContain('document-verification')
  })

  it('every INSERT set is a SUBSET of its SELECT set — reading is never narrower', () => {
    for (const [table, insertCaps] of Object.entries(WRITE_CAPABILITIES)) {
      for (const c of insertCaps) {
        expect(READ_LOCK_CAPABILITIES[table], `${table}: ${c} may insert but not select`)
          .toContain(c)
      }
    }
  })

  it('only accounts and document_file_variants diverge', () => {
    // A divergence should be written down, not inferred. If a third table ever
    // needs one, this fails and someone has to say why.
    const diverging = Object.keys(WRITE_CAPABILITIES).filter(t =>
      [...READ_LOCK_CAPABILITIES[t]].sort().join() !== [...WRITE_CAPABILITIES[t]].sort().join())
    expect(diverging.sort()).toEqual(['accounts', 'document_file_variants'])
  })

  it('every visibility workspace really holds a row in ALL SEVENTEEN tables', async () => {
    // THE NON-VACUITY PRECONDITION FOR THE WHOLE BLOCK BELOW, checked once and
    // as the ADMIN, which bypasses RLS — so it measures what is PHYSICALLY
    // there, not what the role under test can see.
    //
    // Without this, an allowed SELECT that merely "did not throw" and an
    // allowed FOR UPDATE that locked nothing would both pass against an empty
    // table, and a denied cell would never evaluate its RLS predicate at all.
    expect([...TENANT_TABLES]).toHaveLength(17)
    for (const capability of ALL_CAPABILITIES) {
      const vis = visWorkspaces.get(capability)!
      for (const table of TENANT_TABLES) {
        const { rows } = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM investment_ledger.${table} WHERE workspace_id = $1`,
          [vis.id])
        expect(rows[0].n, `${capability}: ${table} is empty, so its cell would be vacuous`)
          .toBeGreaterThan(0)
      }
    }
  }, 120_000)

  it('...and still holds exactly one live capability after the setup window closed', async () => {
    for (const capability of ALL_CAPABILITIES) {
      const { rows } = await admin.query<{ capability: string }>(
        `SELECT capability::text AS capability FROM identity.workspace_service_grants
          WHERE workspace_id = $1 AND principal_id = $2 AND effective_range @> now()
          ORDER BY 1`,
        [visWorkspaces.get(capability)!.id, principals.importer.id])
      expect(rows.map(r => r.capability)).toEqual([capability])
    }
  })

  for (const capability of ALL_CAPABILITIES) {
    describe(`workspace holding only ${capability} — SELECT and LOCK`, () => {
      for (const table of Object.keys(READ_LOCK_CAPABILITIES)) {
        const allowed = READ_LOCK_CAPABILITIES[table].includes(capability)

        it(`${allowed ? 'may SELECT and LOCK' : 'is refused SELECT/LOCK on'} ${table}`, async () => {
          const vis = visWorkspaces.get(capability)!

          // The row is there — asserted as the admin, per cell, so a fixture
          // regression cannot silently empty one table and pass.
          const physical = await admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM investment_ledger.${table} WHERE workspace_id = $1`,
            [vis.id])
          expect(physical.rows[0].n, `${table}: nothing to see, cell is vacuous`)
            .toBeGreaterThan(0)

          await beginAuthorized(importer, vis.id, [capability])
          try {
            const read = await probe(importer, async () => {
              const { rows } = await importer.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM investment_ledger.${table}`)
              // POSITIVE RESULT, not merely absence of an error. RLS hides rows
              // rather than raising, so "did not throw" proves nothing.
              if (rows[0].n < 1) throw new Error(`visible-row count was ${rows[0].n}`)
            })

            // `SELECT 1 ... FOR UPDATE` rather than `id`: transaction_document_links
            // has no id column. rowCount tells us a row was actually locked.
            const lock = await probe(importer, async () => {
              const res = await importer.query(
                `SELECT 1 FROM investment_ledger.${table} LIMIT 1 FOR UPDATE`)
              if ((res.rowCount ?? 0) < 1) throw new Error('locked no row')
            })

            if (allowed) {
              expect(read.code, `${table} SELECT: ${read.message}`).toBeNull()
              expect(lock.code, `${table} FOR UPDATE: ${lock.message}`).toBeNull()
            } else {
              expect(read.code, `${table} SELECT: ${read.message}`).toBe(INSUFFICIENT_PRIVILEGE)
              expect(read.message, `${table} was refused for another reason`)
                .toMatch(/holds none of/)
              expect(lock.code, `${table} FOR UPDATE: ${lock.message}`).toBe(INSUFFICIENT_PRIVILEGE)
            }
          } finally {
            await rollback(importer)
          }
        })
      }
    })
  }

  it('every table is writable by at least one capability', () => {
    for (const [table, caps] of Object.entries(WRITE_CAPABILITIES)) {
      expect(caps.length, `${table} is unreachable`).toBeGreaterThan(0)
    }
  })

  it('ledger-read authorizes no write anywhere', () => {
    // Asserted as a property of the expectation table too, so a future edit
    // that adds it to a row fails here rather than only in the 17 cells.
    for (const [table, caps] of Object.entries(WRITE_CAPABILITIES)) {
      expect(caps, table).not.toContain('ledger-read')
    }
  })

  it('a workspace with ledger-read cannot authorize a write transaction at all', async () => {
    const workspace = workspaces.get('ledger-read')!
    await beginAuthorized(importer, workspace.id, ['ledger-read'])
    const result = await probe(importer, () =>
      importer.query(
        `SELECT identity.authorize_service_workspace_any(
                  $1, ARRAY['archive-import','manual-entry','reconciliation',
                            'document-verification']::identity.service_capability[])`,
        [workspace.id]))
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
    expect(result.message).toMatch(/holds none of/)
    await rollback(importer)
  })

  it('the any-of form returns the principal when ONE capability is held', async () => {
    // Why a non-throwing predicate plus an any-of authorizer both exist: a
    // throwing single check cannot express OR, because it aborts on the first
    // miss before the second is considered.
    const workspace = workspaces.get('manual-entry')!
    await beginAuthorized(importer, workspace.id, ['manual-entry'])
    const { rows } = await importer.query<{ id: string }>(
      `SELECT identity.authorize_service_workspace_any(
                $1, ARRAY['archive-import','manual-entry']::identity.service_capability[]) AS id`,
      [workspace.id])
    expect(rows[0].id).toBe(principals.importer.id)
    await rollback(importer)
  })

  it('a capability outside the enum cannot be granted', async () => {
    // probeDetached, not probe: the admin has no transaction open here, and
    // probe() refuses rather than returning 25P01 dressed up as a result.
    const workspace = workspaces.get('ledger-read')!
    const result = await probeDetached(admin, () =>
      admin.query(
        `INSERT INTO identity.workspace_service_grants
           (workspace_id, principal_id, capability, valid_from, granted_by)
         VALUES ($1,$2,'superuser'::identity.service_capability, now(), $3)`,
        [workspace.id, principals.importer.id, principals.grantor.id]))
    // 22P02: invalid input value for enum. The vocabulary is closed, so a typo
    // is a hard error rather than a silently ineffective grant.
    expect(result.code).toBe('22P02')
  })
})
