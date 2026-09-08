// THE MINIMUM VALID PARENT-ROW GRAPH.
//
// INTEGRATION SUPPORT — USED ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// WHY THIS EXISTS. The capability matrix has to execute a REAL, VALID INSERT
// into every tenant table — an insert that would succeed if the capability were
// held. Most of those tables have composite (workspace_id, id) foreign keys, so
// "valid" means a parent row already exists IN THE SAME WORKSPACE. Without that
// graph a probe dies at 23503 whatever its capabilities, and the matrix reports
// a uniform failure that says nothing about authorization.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SETUP WINDOW, AND WHY IT IS NOT A BACK DOOR.
//
// A workspace granted only `reconciliation` cannot create an import batch — by
// design. So the graph cannot be seeded under the grant set the workspace is
// going to be tested with, and there are only bad ways around that:
//
//   * seed as the superuser — the `actor_is_authorized` trigger resolves the
//     caller from `session_user`, and the admin login is bound to no principal,
//     so every insert is refused. Binding a principal to a superuser login
//     would be inventing a capability the production system does not have.
//   * disable the triggers — the admin's DDL lives in an uncommitted
//     transaction the importer's connection cannot see, and committing it would
//     leave a shared test database with its guards off.
//   * grant the extra capabilities and leave them — destroys the negative half
//     of the matrix, which is the half that matters.
//
// What this module does instead uses only production mechanisms: grant the full
// capability set, seed the graph, COMMIT, then REVOKE every capability the
// workspace is not meant to keep, through `identity.terminate_service_grant`.
// Revocation truncates the grant's effective range, so afterwards the workspace
// genuinely holds one capability and the rows are genuinely already there.
//
// The parents stay referenceable after revocation because PostgreSQL evaluates
// referential integrity in system-owned AFTER triggers that are not subject to
// row-level security — a row the inserter can no longer SELECT still satisfies
// the foreign key. That is a property worth stating out loud, because it is
// exactly the difference between "cannot see" and "does not exist".
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import {
  ALL_CAPABILITIES, beginAuthorized, commit, grantCapability, terminateGrant,
  type Capability, type ServicePrincipal, type Workspace,
} from './fixture.js'

/** 64 lowercase hex characters, which several CHECK constraints require. */
export function hex64(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, '').slice(0, 64)
}

/** The one global instrument every workspace's aliases and transactions use.
 *  `instruments` carries no RLS and no attribution trigger — it is the single
 *  deliberately global table — so the admin may insert it directly. */
export async function ensureProbeInstrument(admin: Client): Promise<string> {
  const key = 'THB:TENANCY:PROBE'
  const existing = await admin.query<{ id: string }>(
    'SELECT id FROM investment_ledger.instruments WHERE canonical_key = $1', [key])
  if (existing.rowCount) return existing.rows[0].id
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO investment_ledger.instruments (canonical_key, display_name, instrument_type)
     VALUES ($1,'Tenancy probe instrument','equity') RETURNING id`, [key])
  return rows[0].id
}

/** Every id a probe row might need to name. */
export interface ParentGraph {
  workspaceId: string
  actorId: string
  instrumentId: string
  /** An UNRESOLVED account — the placeholder an account_resolutions row names. */
  placeholderAccountId: string
  /** A RESOLVED account, so a `resolve` resolution has a legal target. */
  resolvedAccountId: string
  batchId: string
  rawImportRowId: string
  logicalDocumentId: string
  variantId: string
  transactionGroupId: string
  transactionId: string
  /** A `changed_archive` case with NO events yet, so both the archive-import
   *  carve-out and an ordinary reconciliation OPEN are legal against it. */
  emptyCaseId: string
}

/**
 * Every tenant table, in the order a visibility fixture must fill them.
 *
 * Exported so a test can assert it covers all seventeen rather than trusting a
 * hand-written list to have kept up with the schema.
 */
export const TENANT_TABLES = [
  'accounts', 'instrument_aliases', 'import_batches', 'raw_import_rows',
  'logical_documents', 'document_file_variants', 'document_extractions',
  'document_blobs', 'document_verification_events', 'transaction_groups',
  'transactions', 'transaction_amount_components', 'transaction_document_links',
  'validation_findings', 'reconciliation_cases', 'reconciliation_case_events',
  'account_resolutions',
] as const

/**
 * Seed the graph, then reduce the workspace to `keep`.
 *
 * Returns the ids and leaves the workspace holding exactly the capabilities in
 * `keep`. Everything is COMMITTED: probes roll themselves back, and a graph
 * that vanished with them would have to be rebuilt per probe.
 *
 * `options.fillEveryTenantTable` additionally puts at least one row in ALL
 * SEVENTEEN tenant tables — see `fillRemainingTenantTables` for why that is a
 * separate opt-in and not the default.
 */
export async function seedGraphAndRestrict(
  admin: Client, importer: Client, operator: Client,
  workspace: Workspace, principal: ServicePrincipal, grantor: ServicePrincipal,
  keep: Capability[], options: { fillEveryTenantTable?: boolean } = {},
): Promise<ParentGraph> {
  const instrumentId = await ensureProbeInstrument(admin)

  // THE SETUP WINDOW. Every write capability, briefly.
  const grantIds = new Map<Capability, string>()
  for (const capability of ALL_CAPABILITIES) {
    grantIds.set(capability, await grantCapability(admin, workspace, principal, capability, grantor))
  }

  const actorId = await beginAuthorized(importer, workspace.id, ['archive-import'])
  if (actorId !== principal.id) {
    throw new Error(
      `the importer login resolved to principal ${actorId}, not the seeded ${principal.id}. ` +
      'One db_role must map to exactly one principal.')
  }

  const one = async (sql: string, values: unknown[]): Promise<string> => {
    const { rows } = await importer.query<{ id: string }>(sql, values)
    return rows[0].id
  }
  const ws = workspace.id
  const suffix = randomUUID().slice(0, 8)

  const placeholderAccountId = await one(
    `INSERT INTO investment_ledger.accounts
       (workspace_id, actor_principal_id, account_key, platform, display_name,
        resolution_status, unresolved_reason)
     VALUES ($1,$2,$3,'tenancy',$3,'unresolved','probe placeholder') RETURNING id`,
    [ws, actorId, `probe-placeholder-${suffix}`])

  const resolvedAccountId = await one(
    `INSERT INTO investment_ledger.accounts
       (workspace_id, actor_principal_id, account_key, platform, external_account_id,
        display_name, resolution_status)
     VALUES ($1,$2,$3,'tenancy','EXT-0001',$3,'resolved') RETURNING id`,
    [ws, actorId, `probe-resolved-${suffix}`])

  const batchId = await one(
    `INSERT INTO investment_ledger.import_batches
       (workspace_id, actor_principal_id, series_key, source_kind, source_name,
        source_sha256, importer_version, row_count, status)
     VALUES ($1,$2,$3,'archive_csv','tenancy-probe',$4,'tenancy-suite',1,'published')
     RETURNING id`,
    [ws, actorId, `probe:graph-${suffix}`, hex64()])

  const rawImportRowId = await one(
    `INSERT INTO investment_ledger.raw_import_rows
       (workspace_id, actor_principal_id, batch_id, row_number, raw_sha256, raw_payload)
     VALUES ($1,$2,$3,2,$4,'{}'::jsonb) RETURNING id`,
    [ws, actorId, batchId, hex64()])

  const logicalDocumentId = await one(
    `INSERT INTO investment_ledger.logical_documents
       (workspace_id, actor_principal_id, platform, logical_key, document_type, source_filename)
     VALUES ($1,$2,'tenancy',$3,'confirmation','probe.pdf') RETURNING id`,
    [ws, actorId, `probe-doc-${suffix}`])

  const variantId = await one(
    `INSERT INTO investment_ledger.document_file_variants
       (workspace_id, actor_principal_id, logical_document_id, variant_kind, observed_path)
     VALUES ($1,$2,$3,'unlocked',$4) RETURNING id`,
    [ws, actorId, logicalDocumentId, `tenancy/probe-${suffix}.pdf`])

  const transactionGroupId = await one(
    `INSERT INTO investment_ledger.transaction_groups
       (workspace_id, actor_principal_id, group_type, group_key, description)
     VALUES ($1,$2,'switch',$3,'probe group') RETURNING id`,
    [ws, actorId, `probe-group-${suffix}`])

  const transactionId = await one(
    `INSERT INTO investment_ledger.transactions
       (workspace_id, actor_principal_id, import_row_id, account_id, instrument_id,
        occurred_on, transaction_type, units, business_fingerprint, record_source)
     VALUES ($1,$2,$3,$4,$5,'2026-01-02','BUY',1,$6,'archive_csv') RETURNING id`,
    [ws, actorId, rawImportRowId, placeholderAccountId, instrumentId, hex64()])

  // A case with NO events. The archive-import carve-out and an ordinary
  // reconciliation OPEN are both legal against it, which is what lets one row
  // serve every probe — probes roll back, so it stays empty.
  const emptyCaseId = await one(
    `INSERT INTO investment_ledger.reconciliation_cases
       (workspace_id, actor_principal_id, case_key, case_type)
     VALUES ($1,$2,$3,'changed_archive') RETURNING id`,
    [ws, actorId, `probe-case-${suffix}`])

  if (options.fillEveryTenantTable) {
    await fillRemainingTenantTables(importer, ws, actorId, {
      instrumentId, placeholderAccountId, resolvedAccountId, batchId,
      rawImportRowId, logicalDocumentId, variantId, transactionId,
      emptyCaseId, suffix,
    })
  }

  await commit(importer)

  // CLOSE THE WINDOW. Revocation, through the production function, as the
  // operator. After this the workspace holds exactly `keep`.
  for (const capability of ALL_CAPABILITIES) {
    if (keep.includes(capability)) continue
    await terminateGrant(operator, grantIds.get(capability)!, 'revoke',
      `tenancy suite: setup window closed, workspace keeps ${keep.join('+') || 'nothing'}`)
  }

  return {
    workspaceId: ws, actorId, instrumentId,
    placeholderAccountId, resolvedAccountId, batchId, rawImportRowId,
    logicalDocumentId, variantId, transactionGroupId, transactionId, emptyCaseId,
  }
}

/** A valid INSERT for one tenant table, parameterised by the graph. */
export interface TableInsert {
  table: string
  sql: string
  values: (g: ParentGraph) => unknown[]
}

/**
 * One valid INSERT per tenant table — seventeen of them, checked against that
 * count by the matrix so a table added later cannot be silently uncovered.
 *
 * Each row is unique per call (`randomUUID`) so a probe never collides with the
 * graph row it was modelled on, and every one is genuinely insertable: under
 * the right capability these succeed.
 */
export function tableInserts(): TableInsert[] {
  const u = () => randomUUID().slice(0, 8)
  return [
    {
      table: 'accounts',
      sql: `INSERT INTO investment_ledger.accounts
              (workspace_id, actor_principal_id, account_key, platform, display_name,
               resolution_status, unresolved_reason)
            VALUES ($1,$2,$3,'tenancy',$3,'unresolved','matrix probe')`,
      values: g => [g.workspaceId, g.actorId, `matrix-account-${u()}`],
    },
    {
      table: 'instrument_aliases',
      sql: `INSERT INTO investment_ledger.instrument_aliases
              (workspace_id, actor_principal_id, instrument_id, platform, alias, exchange_key)
            VALUES ($1,$2,$3,'tenancy',$4,'')`,
      values: g => [g.workspaceId, g.actorId, g.instrumentId, `matrix-alias-${u()}`],
    },
    {
      table: 'import_batches',
      sql: `INSERT INTO investment_ledger.import_batches
              (workspace_id, actor_principal_id, series_key, source_kind, source_name,
               source_sha256, importer_version, row_count, status)
            VALUES ($1,$2,$3,'archive_csv','matrix',$4,'tenancy-suite',0,'published')`,
      values: g => [g.workspaceId, g.actorId, `probe:matrix-${u()}`, hex64()],
    },
    {
      table: 'raw_import_rows',
      sql: `INSERT INTO investment_ledger.raw_import_rows
              (workspace_id, actor_principal_id, batch_id, row_number, raw_sha256, raw_payload)
            VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`,
      // row_number > 1 and unique per (workspace, batch): 3 upward, never the
      // graph's own row 2.
      values: g => [g.workspaceId, g.actorId, g.batchId,
                    3 + Math.floor(Math.random() * 1_000_000), hex64()],
    },
    {
      table: 'logical_documents',
      sql: `INSERT INTO investment_ledger.logical_documents
              (workspace_id, actor_principal_id, platform, logical_key, document_type, source_filename)
            VALUES ($1,$2,'tenancy',$3,'confirmation','matrix.pdf')`,
      values: g => [g.workspaceId, g.actorId, `matrix-doc-${u()}`],
    },
    {
      table: 'document_file_variants',
      sql: `INSERT INTO investment_ledger.document_file_variants
              (workspace_id, actor_principal_id, logical_document_id, variant_kind, observed_path)
            VALUES ($1,$2,$3,'raw_encrypted',$4)`,
      values: g => [g.workspaceId, g.actorId, g.logicalDocumentId, `tenancy/matrix-${u()}.pdf`],
    },
    {
      table: 'document_extractions',
      sql: `INSERT INTO investment_ledger.document_extractions
              (workspace_id, actor_principal_id, logical_document_id, extraction_version,
               extractor_name, extractor_version, extraction_sha256, payload)
            VALUES ($1,$2,$3,$4,'tenancy','1',$5,'{}'::jsonb)`,
      values: g => [g.workspaceId, g.actorId, g.logicalDocumentId,
                    1 + Math.floor(Math.random() * 1_000_000), hex64()],
    },
    {
      table: 'document_blobs',
      // object_key must begin with this workspace's own uuid — enforced by both
      // a CHECK regex and the `object_key_is_workspace_scoped` trigger.
      sql: `INSERT INTO investment_ledger.document_blobs
              (workspace_id, actor_principal_id, content_sha256, byte_size, object_key)
            VALUES ($1,$2,$3,1024,$4)`,
      values: g => [g.workspaceId, g.actorId, hex64(),
                    `${g.workspaceId}/tenancy/matrix-${u()}.pdf`],
    },
    {
      table: 'document_verification_events',
      sql: `INSERT INTO investment_ledger.document_verification_events
              (workspace_id, actor_principal_id, variant_id, event_kind, content_sha256, reason)
            VALUES ($1,$2,$3,'verified',$4,'matrix probe')`,
      values: g => [g.workspaceId, g.actorId, g.variantId, hex64()],
    },
    {
      table: 'transaction_groups',
      sql: `INSERT INTO investment_ledger.transaction_groups
              (workspace_id, actor_principal_id, group_type, group_key, description)
            VALUES ($1,$2,'multi_fill',$3,'matrix probe')`,
      values: g => [g.workspaceId, g.actorId, `matrix-group-${u()}`],
    },
    {
      table: 'transactions',
      // No import_row_id: UNIQUE (workspace_id, import_row_id) would collide
      // with the graph's transaction, and a manual entry legitimately has none.
      sql: `INSERT INTO investment_ledger.transactions
              (workspace_id, actor_principal_id, account_id, instrument_id,
               occurred_on, transaction_type, units, business_fingerprint, record_source)
            VALUES ($1,$2,$3,$4,'2026-02-03','SELL',2,$5,'manual')`,
      values: g => [g.workspaceId, g.actorId, g.placeholderAccountId, g.instrumentId, hex64()],
    },
    {
      table: 'transaction_amount_components',
      sql: `INSERT INTO investment_ledger.transaction_amount_components
              (workspace_id, actor_principal_id, transaction_id, component_type, amount,
               currency, representation_kind, counting_role)
            VALUES ($1,$2,$3,$4,100,'THB','native','economic')`,
      // component_type is part of a unique key with (transaction, currency,
      // representation); the graph creates none, so any type is free — but a
      // probe repeated in the same savepoint must still differ, hence the pick.
      values: g => [g.workspaceId, g.actorId, g.transactionId,
                    ['gross', 'fee', 'vat', 'withholding_tax', 'net', 'cash_flow'][
                      Math.floor(Math.random() * 6)]],
    },
    {
      table: 'transaction_document_links',
      sql: `INSERT INTO investment_ledger.transaction_document_links
              (workspace_id, actor_principal_id, transaction_id, logical_document_id, link_role)
            VALUES ($1,$2,$3,$4,'evidence')`,
      values: g => [g.workspaceId, g.actorId, g.transactionId, g.logicalDocumentId],
    },
    {
      table: 'validation_findings',
      sql: `INSERT INTO investment_ledger.validation_findings
              (workspace_id, actor_principal_id, batch_id, import_row_id, finding_code,
               severity, details)
            VALUES ($1,$2,$3,$4,'matrix_probe','info','{}'::jsonb)`,
      values: g => [g.workspaceId, g.actorId, g.batchId, g.rawImportRowId],
    },
    {
      table: 'reconciliation_cases',
      sql: `INSERT INTO investment_ledger.reconciliation_cases
              (workspace_id, actor_principal_id, case_key, case_type, subject_transaction_id)
            VALUES ($1,$2,$3,'field_mismatch',$4)`,
      values: g => [g.workspaceId, g.actorId, `matrix-case-${u()}`, g.transactionId],
    },
    {
      table: 'reconciliation_case_events',
      // The empty changed_archive case, opened. Legal for `reconciliation`
      // (any transition) AND for `archive-import` (the one carve-out), which is
      // why this table's matrix row is checked against BOTH and is the only one
      // whose expectation is not a plain capability set.
      sql: `INSERT INTO investment_ledger.reconciliation_case_events
              (workspace_id, actor_principal_id, case_id, event_type, notes)
            VALUES ($1,$2,$3,'OPEN','matrix probe')`,
      values: g => [g.workspaceId, g.actorId, g.emptyCaseId],
    },
    {
      table: 'account_resolutions',
      sql: `INSERT INTO investment_ledger.account_resolutions
              (workspace_id, actor_principal_id, placeholder_account_id, resolved_account_id,
               resolution_kind, reason)
            VALUES ($1,$2,$3,$4,'resolve','matrix probe')`,
      values: g => [g.workspaceId, g.actorId, g.placeholderAccountId, g.resolvedAccountId],
    },
  ]
}


/**
 * Put at least one row in the EIGHT tenant tables the parent graph does not
 * already fill, so a workspace can be used to test SELECT and locking against
 * every one of the seventeen.
 *
 * WHY THIS IS OPT-IN, AND NOT SIMPLY PART OF THE GRAPH.
 *
 * Three of these rows CHANGE WHAT A LATER INSERT MAY DO, so a workspace that
 * carries them cannot also be used to test INSERT authority:
 *
 *   account_resolutions          an active resolution makes the next resolution
 *                                for the same placeholder account illegal
 *                                ("already has an active resolution").
 *   reconciliation_case_events   an OPEN event on the graph's changed_archive
 *                                case destroys the archive-import carve-out
 *                                probe, which needs an EVENTLESS case.
 *   transaction_amount_components a seeded (type, currency, representation)
 *                                triple can collide with the INSERT probe's
 *                                randomly chosen component_type.
 *
 * So the capability matrix uses TWO workspaces per capability: one with the
 * plain graph for INSERT probes, and one filled like this for SELECT/LOCK
 * probes. Both are reduced to the same single capability once the setup window
 * closes, so neither weakens the authority under test.
 */
async function fillRemainingTenantTables(
  importer: Client, ws: string, actorId: string,
  g: {
    instrumentId: string; placeholderAccountId: string; resolvedAccountId: string
    batchId: string; rawImportRowId: string; logicalDocumentId: string
    variantId: string; transactionId: string; emptyCaseId: string; suffix: string
  },
): Promise<void> {
  const q = (sql: string, values: unknown[]) => importer.query(sql, values)

  await q(`INSERT INTO investment_ledger.instrument_aliases
             (workspace_id, actor_principal_id, instrument_id, platform, alias, exchange_key)
           VALUES ($1,$2,$3,'tenancy',$4,'')`,
    [ws, actorId, g.instrumentId, `vis-alias-${g.suffix}`])

  await q(`INSERT INTO investment_ledger.document_extractions
             (workspace_id, actor_principal_id, logical_document_id, extraction_version,
              extractor_name, extractor_version, extraction_sha256, payload)
           VALUES ($1,$2,$3,1,'tenancy','1',$4,'{}'::jsonb)`,
    [ws, actorId, g.logicalDocumentId, hex64()])

  await q(`INSERT INTO investment_ledger.document_blobs
             (workspace_id, actor_principal_id, content_sha256, byte_size, object_key)
           VALUES ($1,$2,$3,512,$4)`,
    [ws, actorId, hex64(), `${ws}/tenancy/vis-${g.suffix}.pdf`])

  await q(`INSERT INTO investment_ledger.document_verification_events
             (workspace_id, actor_principal_id, variant_id, event_kind, content_sha256, reason)
           VALUES ($1,$2,$3,'verified',$4,'visibility fixture')`,
    [ws, actorId, g.variantId, hex64()])

  await q(`INSERT INTO investment_ledger.transaction_amount_components
             (workspace_id, actor_principal_id, transaction_id, component_type, amount,
              currency, representation_kind, counting_role)
           VALUES ($1,$2,$3,'gross',100,'THB','native','economic')`,
    [ws, actorId, g.transactionId])

  await q(`INSERT INTO investment_ledger.transaction_document_links
             (workspace_id, actor_principal_id, transaction_id, logical_document_id, link_role)
           VALUES ($1,$2,$3,$4,'evidence')`,
    [ws, actorId, g.transactionId, g.logicalDocumentId])

  await q(`INSERT INTO investment_ledger.validation_findings
             (workspace_id, actor_principal_id, batch_id, import_row_id, finding_code,
              severity, details)
           VALUES ($1,$2,$3,$4,'visibility_fixture','info','{}'::jsonb)`,
    [ws, actorId, g.batchId, g.rawImportRowId])

  // The case exists but is eventless; opening it fills the events table.
  await q(`INSERT INTO investment_ledger.reconciliation_case_events
             (workspace_id, actor_principal_id, case_id, event_type, notes)
           VALUES ($1,$2,$3,'OPEN','visibility fixture')`,
    [ws, actorId, g.emptyCaseId])

  await q(`INSERT INTO investment_ledger.account_resolutions
             (workspace_id, actor_principal_id, placeholder_account_id,
              resolved_account_id, resolution_kind, reason)
           VALUES ($1,$2,$3,$4,'resolve','visibility fixture')`,
    [ws, actorId, g.placeholderAccountId, g.resolvedAccountId])
}
