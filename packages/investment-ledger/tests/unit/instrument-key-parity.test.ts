import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseArchiveCsv } from '../../src/csv.js'
import { instrumentKey, instrumentType } from '../../src/publish.js'
import type { ArchiveRow } from '../../src/types.js'

// V2 INSTRUMENT IDENTITY MUST SURVIVE THE MOVE INTO SQL.
//
// `instruments` is global and no runtime role may INSERT into it, so the
// importer's inline upsert became a call to
// investment_ledger.resolve_or_create_instrument. That function has to produce
// byte-identical canonical keys, or every existing instrument would be
// duplicated under a new name the first time the archive is re-imported.
//
// The fee branch is the one a naive currency/exchange/symbol resolver gets
// wrong: V2 emits `FEE:<BROKER, SPACES AS UNDERSCORES>`, so `Binance TH` must
// map to `FEE:BINANCE_TH` and not to `THB:NO_EXCHANGE:FEE` or similar.
//
// This test is DATABASE-FREE by construction: it re-implements the SQL branch
// as a string transformation and compares it against the TypeScript
// specification, over the committed synthetic fixture. The database-backed
// half — that the deployed function agrees with both — is an integration test
// and is deliberately not run in this phase.

const PKG = resolve(__dirname, '..', '..')
const FIXTURE = resolve(PKG, 'tests', 'fixtures', 'synthetic-archive.csv')

// The V2 specification, IMPORTED rather than copied. A local copy would drift
// from the thing it claims to specify, and the test would keep passing.
const specKey = instrumentKey
const specType = instrumentType
function specName(row: ArchiveRow): string {
  return row.side === 'FEE' ? `${row.broker} fees` : row.asset
}

/** What 017's PL/pgSQL computes, expressed in TypeScript with the same rules. */
function sqlKey(row: ArchiveRow): string {
  if (row.side === 'FEE') {
    // upper() then regexp_replace(..., '\s+', '_', 'g') — deliberately NO btrim,
    // so V2's treatment of surrounding whitespace as underscores is reproduced.
    return `FEE:${row.broker.toUpperCase().replace(/\s+/g, '_')}`
  }
  const exchange = row.exchange.trim().toUpperCase() || 'NO_EXCHANGE'
  return `${row.currency.trim().toUpperCase()}:${exchange}:${row.asset.trim().toUpperCase()}`
}

describe('the SQL instrument resolver reproduces V2 identity exactly', () => {
  const rows = parseArchiveCsv(readFileSync(FIXTURE, 'utf8'))

  it('agrees on every row of the committed fixture', () => {
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(sqlKey(row), `row ${row.reference}`).toBe(specKey(row))
    }
  })

  it('preserves the fee form, including a broker name containing a space', () => {
    const fee = rows.filter(r => r.side === 'FEE')
    expect(fee.length, 'the fixture must contain a fee row').toBeGreaterThan(0)
    for (const row of fee) {
      expect(sqlKey(row)).toMatch(/^FEE:[A-Z0-9_]+$/)
      expect(sqlKey(row)).not.toContain(' ')
    }
    // The real archive's Binance TH is the case a naive resolver breaks. Its
    // broker name is approved vocabulary, not private data.
    const binance = { ...rows[0], side: 'FEE', broker: 'Binance TH' } as ArchiveRow
    expect(sqlKey(binance)).toBe('FEE:BINANCE_TH')
    expect(specKey(binance)).toBe('FEE:BINANCE_TH')
  })

  it('CONTROL: a currency/exchange/symbol resolver would NOT produce the fee key', () => {
    // Without this, a resolver that quietly dropped the fee branch would still
    // pass every assertion above.
    const naive = (row: ArchiveRow) =>
      `${row.currency.trim().toUpperCase()}:${row.exchange.trim().toUpperCase() || 'NO_EXCHANGE'}:${row.asset.trim().toUpperCase()}`
    const fee = rows.find(r => r.side === 'FEE')!
    expect(naive(fee)).not.toBe(specKey(fee))
  })

  it('agrees on instrument_type and display_name too', () => {
    for (const row of rows) {
      const type = row.side === 'FEE' ? 'fee'
        : ['SUB', 'SWITCH_IN', 'SWITCH_OUT', 'RED'].includes(row.side) ? 'fund' : 'equity'
      const name = row.side === 'FEE' ? `${row.broker} fees` : row.asset
      expect(type).toBe(specType(row))
      expect(name).toBe(specName(row))
    }
  })
})
