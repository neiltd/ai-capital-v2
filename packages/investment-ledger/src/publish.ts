import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { accountKey, businessFingerprint, sha256, switchGroupKey } from './inspect.js'
import { decimalOrNull } from './decimal.js'
import { serializeCanonicalRow } from './csv.js'
import { assertSeriesKey } from './series.js'
import type { ArchiveInspection, ArchiveRow, PublishResult } from './types.js'

const IMPORTER_VERSION = 'investment-ledger-phase1-v2'
type LedgerClient = Pick<PoolClient, 'query'>

/** Postgres raises this for the (workspace_id, series_key, source_kind, source_sha256) index. */
const UNIQUE_VIOLATION = '23505'
const SERIES_SOURCE_UNIQUE = 'import_batches_series_source_unique'
const SAVEPOINT = 'investment_ledger_publish'

/**
 * The workspace this publication belongs to and the principal recorded as its
 * author.
 *
 * BOTH ARE REQUIRED AND NEITHER IS INFERRED — not from the environment, not
 * from the connection, not from a default. A caller that does not know which
 * workspace it is writing into has no business writing. These values come from
 * `withAuthorizedServiceWorkspaceTransaction`, which DERIVES the principal from
 * the database rather than accepting one, so this interface cannot be used to
 * assert an identity.
 */
export interface WorkspaceContext {
  workspaceId: string
  actorPrincipalId: string
}

export interface PublishOptions {
  /**
   * 'owns' (default): publishArchive issues its own BEGIN/COMMIT, which is what
   * the CLI wants. 'nested': the caller already holds a transaction and
   * publishArchive brackets its work with a SAVEPOINT instead, so an
   * integration test can exercise the real publication path and then roll the
   * whole thing back. Neither mode weakens a constraint or a trigger.
   */
  transaction?: 'owns' | 'nested'
}

function brokerDirectory(broker: string): string {
  const names: Record<string, string> = {
    Dime: 'dime', Finnomena: 'finnomena', InnovestX: 'innovestx',
    Bualuang: 'bualuang', 'Binance TH': 'binance_th',
  }
  const directory = names[broker]
  if (!directory) throw new Error(`unsupported broker directory: ${broker}`)
  return directory
}

/**
 * F8: identity carries the market evidence that is actually available, so equal
 * symbols from unrelated markets are never conflated automatically.
 *
 * THE TWO FAILURE MODES. Keying on the broker would SPLIT one security held at
 * two brokers into two instruments — a real pattern, and the reason the broker
 * is not part of the key. Keying on the bare symbol would MERGE two unrelated
 * securities that happen to share a ticker across markets. Currency plus
 * exchange separates the markets without splitting the legitimate pairs: a
 * symbol quoted in one currency on one exchange cannot collide with the same
 * string quoted elsewhere.
 *
 * Where no exchange is published the identity rests on currency and symbol
 * alone; that weaker basis is visible in the key itself, and the per-broker
 * alias is preserved separately in instrument_aliases.
 */
export function instrumentKey(row: ArchiveRow): string {
  if (row.side === 'FEE') return `FEE:${row.broker.toUpperCase().replace(/\s+/g, '_')}`
  const exchange = row.exchange.trim().toUpperCase() || 'NO_EXCHANGE'
  return `${row.currency.trim().toUpperCase()}:${exchange}:${row.asset.trim().toUpperCase()}`
}

export function instrumentType(row: ArchiveRow): string {
  if (row.side === 'FEE') return 'fee'
  if (['SUB','SWITCH_IN','SWITCH_OUT','RED'].includes(row.side)) return 'fund'
  return 'equity'
}

function unresolvedReason(row: ArchiveRow): string | null {
  if (row.account) return null
  if (row.broker === 'Binance TH') return 'Fee invoice identifies the taxpayer, not an investment account'
  if (row.broker === 'Dime') return 'Mutual-fund confirmation omitted the account identifier'
  return 'Source row omitted account identifier'
}

async function accountId(client: LedgerClient, row: ArchiveRow, ws: WorkspaceContext): Promise<string> {
  const key = accountKey(row)
  await client.query(
    `INSERT INTO investment_ledger.accounts
       (workspace_id, actor_principal_id,
        account_key, platform, external_account_id, display_name, resolution_status, unresolved_reason)
     VALUES ($7,$8,$1,$2,$3,$4,$5,$6)
     ON CONFLICT (workspace_id, account_key) DO NOTHING`,
    [key, row.broker, row.account || null, key, row.account ? 'resolved' : 'unresolved', unresolvedReason(row),
     ws.workspaceId, ws.actorPrincipalId],
  )
  const result = await client.query<{ id: string }>(
    'SELECT id FROM investment_ledger.accounts WHERE workspace_id = $1 AND account_key = $2',
    [ws.workspaceId, key])
  return result.rows[0].id
}

async function instrumentId(client: LedgerClient, row: ArchiveRow, ws: WorkspaceContext): Promise<string> {
  // `instruments` is GLOBAL and no runtime role holds INSERT on it, so the
  // direct upsert this used to perform is now `permission denied`. The
  // constrained function is the only path: it proves the caller's capability
  // from session_user and reproduces the canonical key EXACTLY as
  // `instrumentKey` does below, including the fee form `FEE:BINANCE_TH` that a
  // currency/exchange/symbol resolver could not produce.
  //
  // `instrumentKey` and `instrumentType` are retained as the SPECIFICATION the
  // parity test compares the SQL against. They no longer write anything.
  const instrument = await client.query<{ id: string }>(
    'SELECT investment_ledger.resolve_or_create_instrument($1,$2,$3,$4,$5,$6) AS id',
    [row.side, row.broker, row.currency, row.exchange, row.asset, ws.workspaceId],
  )
  await client.query(
    `INSERT INTO investment_ledger.instrument_aliases
       (workspace_id, actor_principal_id, instrument_id, platform, alias, exchange_key)
     VALUES ($1,$6,$2,$3,$4,$5)
     ON CONFLICT (workspace_id, platform, alias, exchange_key) DO NOTHING`,
    [ws.workspaceId, instrument.rows[0].id, row.broker, row.asset, row.exchange || '', ws.actorPrincipalId],
  )
  return instrument.rows[0].id
}

async function documentId(
  client: LedgerClient, row: ArchiveRow, archiveRoot: string, ws: WorkspaceContext,
): Promise<string> {
  await client.query(
    `INSERT INTO investment_ledger.logical_documents
       (workspace_id, actor_principal_id, platform, logical_key, document_type, source_filename)
     VALUES ($5,$6,$1,$2,$3,$4)
     ON CONFLICT (workspace_id, platform, logical_key) DO NOTHING`,
    [row.broker, row.source_file, row.doc_type, row.source_file,
     ws.workspaceId, ws.actorPrincipalId],
  )
  const logical = await client.query<{ id: string }>(
    `SELECT id FROM investment_ledger.logical_documents
      WHERE workspace_id = $1 AND platform = $2 AND logical_key = $3`,
    [ws.workspaceId, row.broker, row.source_file],
  )
  const directory = brokerDirectory(row.broker)
  const variants = [
    ['raw_encrypted', join(archiveRoot, directory, row.source_file)],
    ['unlocked', join(archiveRoot, `${directory}_unlocked`, row.source_file)],
  ] as const
  for (const [kind, path] of variants) {
    if (!existsSync(path)) continue
    // F7: existsSync observes a PATH, never content. No PDF is opened, parsed,
    // copied or hashed here, so identity stays explicitly UNVERIFIED until a
    // checksum is recorded under separate authorization.
    await client.query(
      `INSERT INTO investment_ledger.document_file_variants
         (workspace_id, actor_principal_id,
          logical_document_id, variant_kind, observed_path, verification_status)
       VALUES ($4,$5,$1,$2,$3,'unverified')
       ON CONFLICT (workspace_id, logical_document_id, variant_kind, observed_path) DO NOTHING`,
      [logical.rows[0].id, kind, path, ws.workspaceId, ws.actorPrincipalId],
    )
  }
  return logical.rows[0].id
}

async function addAmount(
  client: LedgerClient, transactionId: string, type: string, amount: string,
  currency: string, representation: 'native' | 'broker_converted', ws: WorkspaceContext,
): Promise<void> {
  await client.query(
    `INSERT INTO investment_ledger.transaction_amount_components
       (workspace_id, actor_principal_id, transaction_id, component_type, amount,
        currency, representation_kind, counting_role)
     VALUES ($7,$8,$1,$2,$3,$4,$5,$6)`,
    [transactionId, type, amount, currency, representation,
     representation === 'native' ? 'economic' : 'informational',
     ws.workspaceId, ws.actorPrincipalId],
  )
}

async function publishRow(
  client: LedgerClient, row: ArchiveRow, rowNumber: number, batchId: string,
  archiveRoot: string, ws: WorkspaceContext,
): Promise<string> {
  const rawPayload = JSON.stringify(row)
  const raw = await client.query<{ id: string }>(
    `INSERT INTO investment_ledger.raw_import_rows
       (workspace_id, actor_principal_id, batch_id, row_number, raw_sha256, raw_payload)
     VALUES ($5,$6,$1,$2,$3,$4::jsonb) RETURNING id`,
    [batchId, rowNumber, sha256(serializeCanonicalRow(row)), rawPayload, ws.workspaceId, ws.actorPrincipalId],
  )
  const account = await accountId(client, row, ws)
  const instrument = await instrumentId(client, row, ws)
  const document = await documentId(client, row, archiveRoot, ws)
  let groupId: string | null = null
  if (row.is_switch.trim().toLowerCase() === 'true') {
    // Identity is the confirmation note, not the per-leg broker reference:
    // one note carries two different references for its two legs. Both
    // references remain on their own transaction rows via broker_reference.
    const key = switchGroupKey(row)
    await client.query(
      `INSERT INTO investment_ledger.transaction_groups
         (workspace_id, actor_principal_id, group_type, group_key, description)
       VALUES ($3,$4,'switch',$1,$2)
       ON CONFLICT (workspace_id, group_key) DO NOTHING`,
      [key, 'Fund switch legs from one broker confirmation note', ws.workspaceId, ws.actorPrincipalId],
    )
    const group = await client.query<{ id: string }>(
      'SELECT id FROM investment_ledger.transaction_groups WHERE workspace_id = $1 AND group_key = $2',
      [ws.workspaceId, key])
    groupId = group.rows[0].id
  }
  const transaction = await client.query<{ id: string }>(
    `INSERT INTO investment_ledger.transactions
       (workspace_id, actor_principal_id,
        import_row_id, account_id, instrument_id, transaction_group_id, occurred_on,
        transaction_type, units, unit_price, unit_price_currency, broker_reference,
        business_fingerprint, record_source)
     VALUES ($12,$13,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'archive_csv') RETURNING id`,
    [raw.rows[0].id, account, instrument, groupId, row.trade_date, row.side,
     decimalOrNull(row.units), decimalOrNull(row.unit_price), row.unit_price ? row.currency : null,
     row.reference || null, businessFingerprint(row, accountKey(row)),
     ws.workspaceId, ws.actorPrincipalId],
  )
  const transactionId = transaction.rows[0].id
  await client.query(
    `INSERT INTO investment_ledger.transaction_document_links
       (workspace_id, actor_principal_id, transaction_id, logical_document_id, link_role)
     VALUES ($3,$4,$1,$2,'evidence')`,
    [transactionId, document, ws.workspaceId, ws.actorPrincipalId],
  )
  const native = [
    ['gross', row.gross_amount], ['fee', row.fee], ['vat', row.vat],
    ['withholding_tax', row.withholding_tax], ['net', row.net_amount], ['cash_flow', row.cash_flow],
  ] as const
  for (const [type, value] of native) if (value !== '') await addAmount(client, transactionId, type, value, row.currency, 'native', ws)
  const converted = [
    ['gross', row.gross_thb], ['fee', row.fee_thb],
    ['withholding_tax', row.wht_thb], ['net', row.net_thb],
  ] as const
  for (const [type, value] of converted) if (value !== '') await addAmount(client, transactionId, type, value, 'THB', 'broker_converted', ws)
  return transactionId
}

export async function publishArchive(
  client: LedgerClient, inspection: ArchiveInspection, archiveRoot: string,
  sourceName: string, seriesKey: string, ws: WorkspaceContext,
  options: PublishOptions = {},
): Promise<PublishResult> {
  // The workspace is a REQUIRED POSITIONAL argument, placed before the optional
  // bag: a caller cannot forget it and still compile.
  if (!ws?.workspaceId || !ws?.actorPrincipalId) {
    throw new Error('publishArchive requires an explicit workspace and actor principal')
  }
  // Fail closed before anything is read or written: an import with no series is
  // an import that could supersede the wrong dataset.
  const series = assertSeriesKey(seriesKey)

  for (const [index, row] of inspection.rows.entries()) {
    if (!['THB', 'USD'].includes(row.currency)) throw new Error(`row ${index + 2}: unsupported currency ${row.currency}`)
    if (!['BUY','SELL','SUB','RED','SWITCH_IN','SWITCH_OUT','FEE'].includes(row.side)) {
      throw new Error(`row ${index + 2}: unsupported transaction type ${row.side}`)
    }
    if (decimalOrNull(row.cash_flow) === null) throw new Error(`row ${index + 2}: cash_flow is required`)
  }

  const nested = options.transaction === 'nested'
  const begin = () => client.query(nested ? `SAVEPOINT ${SAVEPOINT}` : 'BEGIN')
  const commit = () => client.query(nested ? `RELEASE SAVEPOINT ${SAVEPOINT}` : 'COMMIT')
  const undo = () => client.query(nested ? `ROLLBACK TO SAVEPOINT ${SAVEPOINT}` : 'ROLLBACK')

  await begin()
  try {
    // Serialize publication PER WORKSPACE AND SERIES, so the head this call
    // supersedes cannot move underneath it. Different series never contend, and
    // — the point of the two-key form — neither do two DIFFERENT WORKSPACES that
    // happen to use the same series name. Advisory locks are cluster-wide, so a
    // single-key `hashtext('investment-ledger-series:' + series)` made every
    // tenant importing a series called `archive` queue behind every other one:
    // not a correctness bug, but a cross-tenant availability coupling and an
    // observable side channel. `pg_advisory_xact_lock(int4, int4)` takes the
    // workspace as the first key and the series as the second.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [`investment-ledger-workspace:${ws.workspaceId}`, `investment-ledger-series:${series}`])

    // Exact-rerun identity is (series, kind, bytes). The same bytes in another
    // series is a different fact, not a re-run of this one.
    const exact = await client.query<{ id: string }>(
      `SELECT id FROM investment_ledger.import_batches
        WHERE workspace_id = $3 AND series_key = $1 AND source_kind = 'archive_csv' AND source_sha256 = $2`,
      [series, inspection.sha256, ws.workspaceId],
    )
    if (exact.rowCount) {
      await undo()
      return { batchId: exact.rows[0].id, seriesKey: series, insertedTransactions: 0, exactRerun: true, priorBatchId: null }
    }

    // The head of THIS series only. An unrelated series' import is invisible
    // here, so it can never supersede this one.
    const prior = await client.query<{ id: string }>(
      `SELECT id FROM investment_ledger.current_import_batches
        WHERE workspace_id = $2 AND series_key = $1 AND source_kind = 'archive_csv'
        ORDER BY published_at DESC, id DESC LIMIT 1`,
      [series, ws.workspaceId],
    )

    let batchId: string
    try {
      const batch = await client.query<{ id: string }>(
        `INSERT INTO investment_ledger.import_batches
           (workspace_id, actor_principal_id,
            series_key, source_kind, source_name, source_sha256, importer_version, row_count, status, changed_from_batch)
         VALUES ($7,$8,$1,'archive_csv',$2,$3,$4,$5,'published',$6) RETURNING id`,
        [series, sourceName, inspection.sha256, IMPORTER_VERSION, inspection.rows.length, prior.rows[0]?.id ?? null, ws.workspaceId, ws.actorPrincipalId],
      )
      batchId = batch.rows[0].id
    } catch (error) {
      // Two concurrent publications of the SAME bytes into the SAME series must
      // not leave an unexplained error. The advisory lock closes this in
      // practice; the unique index closes it absolutely, and losing that race is
      // a successful idempotent re-run. Any OTHER unique violation — notably a
      // second successor for one predecessor — is a real conflict and is raised.
      const violation = error as { code?: string; constraint?: string }
      if (violation.code !== UNIQUE_VIOLATION || violation.constraint !== SERIES_SOURCE_UNIQUE) throw error
      await undo()
      const winner = await client.query<{ id: string }>(
        `SELECT id FROM investment_ledger.import_batches
          WHERE workspace_id = $3 AND series_key = $1 AND source_kind = 'archive_csv' AND source_sha256 = $2`,
        [series, inspection.sha256, ws.workspaceId],
      )
      if (!winner.rowCount) throw error
      return { batchId: winner.rows[0].id, seriesKey: series, insertedTransactions: 0, exactRerun: true, priorBatchId: null }
    }

    for (let index = 0; index < inspection.rows.length; index++) {
        const transactionId = await publishRow(client, inspection.rows[index], index + 2, batchId, archiveRoot, ws)
      for (const finding of inspection.findings.filter(item => item.rowNumber === index + 2)) {
        const raw = await client.query<{ id: string }>(
            `SELECT id FROM investment_ledger.raw_import_rows
              WHERE workspace_id = $3 AND batch_id = $1 AND row_number = $2`,
          [batchId, index + 2, ws.workspaceId],
        )
        await client.query(
          `INSERT INTO investment_ledger.validation_findings
             (workspace_id, actor_principal_id,
                batch_id, import_row_id, transaction_id, finding_code, severity, details)
           VALUES ($7,$8,$1,$2,$3,$4,$5,$6::jsonb)`,
          [batchId, raw.rows[0].id, transactionId, finding.code, finding.severity, JSON.stringify(finding.details), ws.workspaceId, ws.actorPrincipalId],
        )
      }
    }
    for (const finding of inspection.findings.filter(item => item.rowNumber === undefined)) {
      await client.query(
        `INSERT INTO investment_ledger.validation_findings
           (workspace_id, actor_principal_id, batch_id, finding_code, severity, details)
           VALUES ($5,$6,$1,$2,$3,$4::jsonb)`,
        [batchId, finding.code, finding.severity, JSON.stringify(finding.details),
           ws.workspaceId, ws.actorPrincipalId],
      )
    }
    if (prior.rows[0]) {
      const caseKey = `changed-archive:${series}:${prior.rows[0].id}:${batchId}`
      const reconciliation = await client.query<{ id: string }>(
        `INSERT INTO investment_ledger.reconciliation_cases
             (workspace_id, actor_principal_id, case_key, case_type)
         VALUES ($2,$3,$1,'changed_archive') RETURNING id`,
          [caseKey, ws.workspaceId, ws.actorPrincipalId],
      )
      // THE ONE RECONCILIATION EVENT AN IMPORT MAY AUTHOR.
      //
      // `actor` was free text ('archive-importer'); it is now a principal id,
      // and 017's `actor_is_authorized` trigger refuses any principal that is
      // not the calling service. The capability rule is deliberately narrow and
      // enforced in the DATABASE, not here: `reconciliation_event_scope` (017)
      // lets a caller holding only `archive-import` insert exactly one event —
      // event_type 'OPEN', on a `changed_archive` case, in the same workspace,
      // where the case has no events yet. Every MATCH / FLAG_MISMATCH /
      // REQUEST_REVIEW / RESOLVE / DISMISS / REOPEN transition still requires
      // `reconciliation`, so an importer can raise the flag and can never clear
      // it. A partial unique index makes the "first event" test race-safe.
      //
      // This is why the CLI authorizes `archive-import` alone: granting an
      // importer `reconciliation` so that this single INSERT would pass would
      // have handed it authority over the entire review history.
      await client.query(
          `INSERT INTO investment_ledger.reconciliation_case_events
             (workspace_id, actor_principal_id, case_id, event_type, notes, evidence)
         VALUES ($3,$4,$1,'OPEN','Archive hash changed within this series; independent review required',$2::jsonb)`,
          [reconciliation.rows[0].id,
           JSON.stringify({ seriesKey: series, priorBatchId: prior.rows[0].id, newBatchId: batchId }),
           ws.workspaceId, ws.actorPrincipalId],
      )
    }
    await commit()
    return {
      batchId, seriesKey: series, insertedTransactions: inspection.rows.length,
      exactRerun: false, priorBatchId: prior.rows[0]?.id ?? null,
    }
  } catch (error) {
    await undo()
    throw error
  }
}
