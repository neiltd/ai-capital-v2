import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { addDecimals, decimalOrNull } from './decimal.js'
import { parseArchiveCsv, serializeCanonicalRow } from './csv.js'
import type { ArchiveInspection, ArchiveRow, ValidationFinding } from './types.js'

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function signedUnits(row: ArchiveRow): string | null {
  const units = decimalOrNull(row.units)
  if (units === null) return null
  return ['SELL', 'RED', 'SWITCH_OUT'].includes(row.side) ? `-${units.replace(/^-/, '')}` : units
}

export function businessFingerprint(row: ArchiveRow, accountKey: string): string {
  // Evidence for duplicate review, deliberately not a uniqueness constraint.
  // A broker reference is one ingredient, never the identity by itself.
  return sha256([
    row.broker, accountKey, row.trade_date, row.side, row.asset, row.exchange,
    row.currency, row.units, row.unit_price, row.gross_amount, row.net_amount,
    row.cash_flow, row.reference,
  ].join('\u001f'))
}

export function accountKey(row: ArchiveRow): string {
  if (row.account) return `${row.broker}:${row.account}`
  if (row.broker === 'Binance TH') return 'Binance TH:UNRESOLVED_FEE_ACCOUNT'
  if (row.broker === 'Dime') return 'Dime:UNRESOLVED_MUTUAL_FUND_ACCOUNT'
  return `${row.broker}:UNRESOLVED_ACCOUNT`
}

/**
 * Switch identity comes from the SOURCE DOCUMENT, not from broker-reference
 * equality.
 *
 * WHY. A single switch confirmation is one economic event with two legs, but a
 * broker may stamp each leg with its OWN reference — the outgoing fund and the
 * incoming fund are, from the broker's side, two bookings. Keying on the
 * reference therefore splits such a confirmation into two half-groups, each
 * missing its counterpart, and the incompleteness is then reported as a data
 * error that does not exist. One confirmation note is one switch; the reference
 * is a per-leg broker artefact, not the identity. Both references are preserved
 * on their own transaction rows.
 *
 * trade_date is deliberately NOT part of the key either: the two legs may
 * settle on different dates, and including the date splits every such pair.
 */
export function switchGroupKey(row: ArchiveRow): string {
  return `switch:${row.broker}:${row.source_file}`
}

export function inspectArchive(path: string): ArchiveInspection {
  const bytes = readFileSync(path)
  const rows = parseArchiveCsv(bytes.toString('utf8'))
  const findings: ValidationFinding[] = []
  const currencyRows: Record<string, number> = {}
  const flows: Record<string, string[]> = {}
  const rawRows = new Set<string>()
  const referenceGroups = new Map<string, number>()
  const positions = new Map<string, string[]>()
  const switchGroups = new Map<string, Array<{ rowNumber: number; side: string; reference: string }>>()
  let missingAccounts = 0
  let missingNetAmounts = 0
  let exactDuplicateRows = 0

  rows.forEach((row, index) => {
    const rowNumber = index + 2
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.trade_date)) throw new Error(`row ${rowNumber}: invalid trade_date`)
    if (!['THB', 'USD'].includes(row.currency)) throw new Error(`row ${rowNumber}: unsupported currency ${row.currency}`)
    if (!['BUY','SELL','SUB','RED','SWITCH_IN','SWITCH_OUT','FEE'].includes(row.side)) throw new Error(`row ${rowNumber}: unsupported side ${row.side}`)
    const flow = decimalOrNull(row.cash_flow)
    if (flow === null) throw new Error(`row ${rowNumber}: missing cash_flow`)
    for (const column of ['units','unit_price','gross_amount','fee','vat','withholding_tax','net_amount','cash_flow','gross_thb','fee_thb','wht_thb','net_thb'] as const) decimalOrNull(row[column])
    currencyRows[row.currency] = (currencyRows[row.currency] ?? 0) + 1
    ;(flows[row.currency] ??= []).push(flow)
    const canonical = serializeCanonicalRow(row)
    if (rawRows.has(canonical)) exactDuplicateRows++
    rawRows.add(canonical)
    const refGroup = [row.broker, row.source_file, row.reference].join('\u001f')
    referenceGroups.set(refGroup, (referenceGroups.get(refGroup) ?? 0) + 1)
    if (!row.account) {
      missingAccounts++
      findings.push({ rowNumber, code: 'UNRESOLVED_ACCOUNT', severity: 'warning', details: { broker: row.broker, placeholder: accountKey(row) } })
    }
    if (!row.net_amount) {
      missingNetAmounts++
      findings.push({ rowNumber, code: 'MISSING_NET_AMOUNT', severity: 'warning', details: { broker: row.broker } })
    }
    // F4: switch legs ARE economic unit movements and must participate in the
    // derived holdings. Excluding them makes any fund that was only ever
    // acquired through a SWITCH_IN look permanently short, because its
    // acquisition is invisible while its later disposals are not. SWITCH_OUT is
    // negative and SWITCH_IN positive, exactly like RED/SUB.
    const signed = signedUnits(row)
    if (signed !== null) {
      const key = `${row.broker}|${row.account || accountKey(row)}|${row.asset}|${row.currency}`
      const values = positions.get(key) ?? []
      values.push(signed)
      positions.set(key, values)
    }
    if (row.is_switch.trim().toLowerCase() === 'true') {
      const key = switchGroupKey(row)
      const legs = switchGroups.get(key) ?? []
      legs.push({ rowNumber, side: row.side, reference: row.reference })
      switchGroups.set(key, legs)
    }
  })

  // A switch group must be exactly one SWITCH_OUT and one SWITCH_IN. Anything
  // else is reported explicitly rather than guessed at.
  const switchGroupKeys = [...switchGroups.keys()].sort()
  const incompleteSwitchGroups: string[] = []
  for (const [key, legs] of [...switchGroups.entries()].sort()) {
    const outs = legs.filter(leg => leg.side === 'SWITCH_OUT').length
    const ins = legs.filter(leg => leg.side === 'SWITCH_IN').length
    if (outs === 1 && ins === 1) continue
    incompleteSwitchGroups.push(key)
    findings.push({
      code: 'INCOMPLETE_SWITCH_GROUP', severity: 'error',
      details: { groupKey: key, switchOut: outs, switchIn: ins, rowNumbers: legs.map(leg => leg.rowNumber).join(','),
                 references: legs.map(leg => leg.reference).join(',') },
    })
  }

  const negativePositionKeys = [...positions.entries()]
    .filter(([, values]) => addDecimals(values).startsWith('-'))
    .map(([key]) => key).sort()
  for (const key of negativePositionKeys) findings.push({ code: 'NEGATIVE_DERIVED_POSITION', severity: 'warning', details: { key } })

  return {
    sha256: sha256(bytes), rows,
    logicalSourceFiles: new Set(rows.map(row => `${row.broker}\u001f${row.source_file}`)).size,
    currencyRows,
    cashFlowByCurrency: Object.fromEntries(Object.entries(flows).map(([currency, values]) => [currency, addDecimals(values)])),
    missingAccounts,
    missingNetAmounts,
    exactDuplicateRows,
    multiRowReferenceGroups: [...referenceGroups.values()].filter(count => count > 1).length,
    negativePositionKeys,
    switchGroupKeys,
    incompleteSwitchGroups,
    findings,
  }
}
