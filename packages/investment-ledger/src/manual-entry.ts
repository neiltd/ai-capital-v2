// Manual ledger entry — DOMAIN LAYER ONLY.
//
// WHAT THIS IS NOT. It is not an HTTP surface, it establishes no context of its
// own, it never calls `set_config`, it never reads a GUC, and it never touches
// `identity`. Every function here takes a transaction that is ALREADY
// authorized, and does nothing to obtain one.
//
// WHY THAT MATTERS RIGHT NOW. Human runtime authority is deferred to the OIDC
// gate: `ai_capital_app` holds no tenant privilege at all in this foundation,
// because with no session mechanism there is no trustworthy way to derive a
// workspace for a person, and a policy keyed on a bare GUC would be no
// protection. So in this phase these functions are reachable only through a
// service transaction holding `manual-entry` — which is exactly how the
// database will judge them, and exactly what the tests exercise.

import type { WorkspaceClient } from '@common/db'

export interface ManualTransactionInput {
  accountId: string
  instrumentId: string
  occurredOn: string
  transactionType: 'BUY' | 'SELL' | 'SUB' | 'RED' | 'SWITCH_IN' | 'SWITCH_OUT' | 'FEE'
  units: string | null
  unitPrice: string | null
  unitPriceCurrency: string | null
  brokerReference: string | null
  businessFingerprint: string
  transactionGroupId?: string | null
}

/**
 * Record a transaction the operator entered by hand.
 *
 * `record_source` is 'manual', which is what distinguishes it from an imported
 * row for every downstream reconciliation query. `workspace_id` and
 * `actor_principal_id` come from the transaction, never from the caller's
 * argument, so a manual entry cannot be attributed to anyone else.
 */
export async function createManualTransaction(
  tx: WorkspaceClient, input: ManualTransactionInput,
): Promise<string> {
  const row = await tx.queryOne<{ id: string }>(
    `INSERT INTO investment_ledger.transactions
       (workspace_id, actor_principal_id, account_id, instrument_id,
        transaction_group_id, occurred_on, transaction_type, units, unit_price,
        unit_price_currency, broker_reference, business_fingerprint, record_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual') RETURNING id`,
    [tx.workspaceId, tx.principalId, input.accountId, input.instrumentId,
     input.transactionGroupId ?? null, input.occurredOn, input.transactionType,
     input.units, input.unitPrice, input.unitPriceCurrency,
     input.brokerReference, input.businessFingerprint],
  )
  if (!row) throw new Error('manual transaction insert returned no row')
  return row.id
}

/**
 * Record a correction against an existing transaction.
 *
 * Corrections are new rows, never edits: the ledger's append-only triggers
 * reject UPDATE outright, and `current_transactions` drops a reversed row from
 * the current projection rather than deleting anything. A correction must live
 * in a `correction` group, which 015 enforces in the database.
 */
export async function createCorrection(
  tx: WorkspaceClient,
  input: ManualTransactionInput & {
    correctionOfId: string
    correctionRole: 'reversal' | 'replacement'
    transactionGroupId: string
  },
): Promise<string> {
  const row = await tx.queryOne<{ id: string }>(
    `INSERT INTO investment_ledger.transactions
       (workspace_id, actor_principal_id, account_id, instrument_id,
        transaction_group_id, correction_of_id, correction_role, occurred_on,
        transaction_type, units, unit_price, unit_price_currency,
        broker_reference, business_fingerprint, record_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'manual') RETURNING id`,
    [tx.workspaceId, tx.principalId, input.accountId, input.instrumentId,
     input.transactionGroupId, input.correctionOfId, input.correctionRole,
     input.occurredOn, input.transactionType, input.units, input.unitPrice,
     input.unitPriceCurrency, input.brokerReference, input.businessFingerprint],
  )
  if (!row) throw new Error('correction insert returned no row')
  return row.id
}

/**
 * Open a reconciliation case and its mandatory first OPEN event.
 *
 * Both rows are written in the caller's transaction, so a case can never exist
 * without the event that gives it a state — 013's validator rejects any first
 * event that is not OPEN.
 *
 * NOTE the capability split, stated precisely because it is narrow: opening a
 * CASE is permitted to `archive-import` or `reconciliation`. The EVENT requires
 * `reconciliation`, with exactly one carve-out enforced by 017's
 * `reconciliation_event_scope` trigger — a caller holding only `archive-import`
 * may write the FIRST event of a `changed_archive` case, and nothing else. So
 * calling this helper for any other case type, or for a second event, needs
 * `reconciliation`; an importer can raise a flag and can never clear one.
 */
export async function openReconciliationCase(
  tx: WorkspaceClient,
  input: { caseKey: string; caseType: string; subjectTransactionId?: string | null; notes?: string },
): Promise<{ caseId: string }> {
  const created = await tx.queryOne<{ id: string }>(
    `INSERT INTO investment_ledger.reconciliation_cases
       (workspace_id, actor_principal_id, case_key, case_type, subject_transaction_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tx.workspaceId, tx.principalId, input.caseKey, input.caseType,
     input.subjectTransactionId ?? null],
  )
  if (!created) throw new Error('reconciliation case insert returned no row')
  await tx.query(
    `INSERT INTO investment_ledger.reconciliation_case_events
       (workspace_id, actor_principal_id, case_id, event_type, notes)
     VALUES ($1,$2,$3,'OPEN',$4)`,
    [tx.workspaceId, tx.principalId, created.id, input.notes ?? null],
  )
  return { caseId: created.id }
}
