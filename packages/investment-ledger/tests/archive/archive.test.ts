import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseArchiveCsv } from '../../src/csv.js'
import { accountKey, inspectArchive } from '../../src/inspect.js'
import { archivePath } from '../archive-env.js'

// THE OPERATOR'S REAL ARCHIVE. This suite is deliberately NOT part of the
// default test command: it reads one operator's private financial record, named
// only through INVESTMENT_ARCHIVE_CSV. It is not skipped when that variable is
// absent — archivePath() throws, so an unconfigured run is a visible failure
// rather than a silent pass that looks like coverage.
//
// WHAT THIS SUITE MAY ASSERT. Structure, vocabulary and self-consistency —
// never content. It previously called assertApprovedArchive(), which compared
// the file against a digest and a set of exact financial totals baked into
// committed source; that concept is gone, along with the CLI cases that existed
// only to guard those bytes. Archive identity is now the OPERATOR's assertion,
// made with --expect-sha256 at the moment of apply, and it is exercised in the
// portable CLI suite against a fabricated fixture.
//
// So nothing here embeds a digest, a holding, an identifier, a filename or a
// financial total. Every expectation is either a vocabulary check or a
// recomputation from the same file.

const ARCHIVE = archivePath()

/** The transaction vocabulary the schema and the publisher both implement. */
const SIDES = ['BUY', 'SELL', 'SUB', 'RED', 'SWITCH_IN', 'SWITCH_OUT', 'FEE']
/** The platforms the executable broker mapping supports. Approved vocabulary. */
const PLATFORMS = ['Dime', 'Finnomena', 'InnovestX', 'Bualuang', 'Binance TH']

describe('the supplied archive is structurally sound', () => {
  it('inspects without throwing and yields a non-empty, well-formed result', () => {
    const inspection = inspectArchive(ARCHIVE)
    expect(inspection.rows.length).toBeGreaterThan(0)
    expect(inspection.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(inspection.exactDuplicateRows, 'a duplicated row would be a real defect').toBe(0)
    expect(inspection.incompleteSwitchGroups).toEqual([])
    // No finding may be an error: an error-severity finding means the file is
    // not fit to publish, which the CLI would then have to refuse.
    expect(inspection.findings.filter(f => f.severity === 'error')).toEqual([])
  })

  it('uses only the supported platform and transaction vocabulary', () => {
    const rows = parseArchiveCsv(readFileSync(ARCHIVE, 'utf8'))
    for (const row of rows) {
      expect(PLATFORMS, 'unsupported platform').toContain(row.broker)
      expect(SIDES, 'unsupported transaction type').toContain(row.side)
      expect(['THB', 'USD'], 'unsupported currency').toContain(row.currency)
      expect(row.trade_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    // Non-vacuous: the archive must actually exercise more than one platform
    // and more than one transaction type, or these checks prove nothing.
    expect(new Set(rows.map(r => r.broker)).size).toBeGreaterThan(1)
    expect(new Set(rows.map(r => r.side)).size).toBeGreaterThan(1)
  })

  it('counts missing values rather than guessing them, and counts them correctly', () => {
    const inspection = inspectArchive(ARCHIVE)
    const rows = inspection.rows
    // The inspector's tallies must equal an independent recount of the same
    // file. This is what "preserves missing values instead of guessing" means
    // operationally, and it needs no per-broker figure to say so.
    expect(inspection.missingAccounts).toBe(rows.filter(r => !r.account).length)
    expect(inspection.missingNetAmounts).toBe(rows.filter(r => !r.net_amount).length)
    expect(inspection.missingAccounts, 'the archive must exercise the placeholder path')
      .toBeGreaterThan(0)
    expect(inspection.missingNetAmounts, 'the archive must exercise the absent-component path')
      .toBeGreaterThan(0)
    // Every account-less row gets an explicit placeholder key, never a blank.
    for (const row of rows.filter(r => !r.account)) {
      expect(accountKey(row)).toMatch(/^.+:UNRESOLVED_/)
    }
    // And one warning is raised per missing value, so nothing is silently absorbed.
    expect(inspection.findings.filter(f => f.code === 'UNRESOLVED_ACCOUNT'))
      .toHaveLength(inspection.missingAccounts)
    expect(inspection.findings.filter(f => f.code === 'MISSING_NET_AMOUNT'))
      .toHaveLength(inspection.missingNetAmounts)
  })

  it('keeps a broker-converted amount distinct from the amount it converts', () => {
    const rows = inspectArchive(ARCHIVE).rows
    const dual = rows.filter(row => row.currency !== 'THB' && row.gross_thb)
    expect(dual.length, 'the archive must contain a dual-representation row').toBeGreaterThan(0)
    for (const row of dual) {
      // The converted figure is separate evidence, never the same number under
      // another name — that is what lets publication mark it informational.
      expect(row.gross_amount).not.toBe(row.gross_thb)
    }
  })

  it('reports per-currency totals without any of them being asserted here', () => {
    const inspection = inspectArchive(ARCHIVE)
    // The totals are computed and returned — the operator reads them from the
    // inspect output. This asserts only that they EXIST and are well formed for
    // every currency present, never what they are.
    for (const currency of Object.keys(inspection.currencyRows)) {
      expect(inspection.currencyRows[currency]).toBeGreaterThan(0)
      expect(inspection.cashFlowByCurrency[currency]).toMatch(/^-?\d+(\.\d+)?$/)
    }
    expect(Object.values(inspection.currencyRows).reduce((a, b) => a + b, 0))
      .toBe(inspection.rows.length)
  })
})
