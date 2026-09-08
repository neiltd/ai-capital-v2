import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { addDecimals } from '../../src/decimal.js'
import { parseArchiveCsv } from '../../src/csv.js'
import { inspectArchive, switchGroupKey } from '../../src/inspect.js'
import type { ArchiveRow } from '../../src/types.js'

// SWITCH IDENTITY AND DERIVED POSITIONS — proved on FABRICATED data.
//
// These cases used to assert a literal list of the operator's real holdings,
// two real broker reference numbers and a real confirmation filename. None of
// that was necessary: every claim here is about the ALGORITHM, and an algorithm
// is proved by constructing the structure it must handle. The fixture below
// contains exactly those structures — a confirmation whose two legs carry
// different references and settle on different dates, a confirmation whose legs
// share one reference and one date, a holding sold without a recorded purchase,
// and two funds acquired ONLY through a SWITCH_IN and later partly sold.
//
// Each case pairs its assertion with a control that recomputes the result under
// the PREVIOUS, incorrect rule and shows it differs. Without those controls a
// passing test would not distinguish a correct implementation from a lucky one.

const FIXTURE = resolve(__dirname, '..', 'fixtures', 'synthetic-archive.csv')
const inspection = inspectArchive(FIXTURE)
const rows = parseArchiveCsv(readFileSync(FIXTURE, 'utf8'))
const switchRows = rows.filter(row => row.is_switch.trim().toLowerCase() === 'true')

/** The rule that was replaced: identity from the per-leg broker reference. */
const referenceKey = (row: ArchiveRow) => [row.broker, row.source_file, row.reference].join('|')
/** The rule that was rejected: identity that also pins the settlement date. */
const datedKey = (row: ArchiveRow) => `${switchGroupKey(row)}|${row.trade_date}`

const legsOf = (key: string) => switchRows.filter(row => switchGroupKey(row) === key)

describe('switch identity comes from the source document', () => {
  it('groups the six switch legs into three complete OUT+IN confirmations', () => {
    expect(switchRows).toHaveLength(6)
    expect(switchRows.filter(row => row.side === 'SWITCH_OUT')).toHaveLength(3)
    expect(switchRows.filter(row => row.side === 'SWITCH_IN')).toHaveLength(3)

    expect(inspection.switchGroupKeys).toHaveLength(3)
    expect(inspection.incompleteSwitchGroups).toEqual([])
    for (const key of inspection.switchGroupKeys) {
      const legs = legsOf(key)
      expect(legs, key).toHaveLength(2)
      expect(legs.filter(leg => leg.side === 'SWITCH_OUT'), key).toHaveLength(1)
      expect(legs.filter(leg => leg.side === 'SWITCH_IN'), key).toHaveLength(1)
    }
  })

  it('CONTROL: the reference key really does split one of these confirmations', () => {
    // Four reference groups against three document groups, so the old rule
    // manufactures a fourth "confirmation" that has only one leg.
    expect(new Set(switchRows.map(referenceKey)).size).toBe(4)
    expect(new Set(switchRows.map(switchGroupKey)).size).toBe(3)

    const split = inspection.switchGroupKeys.filter(
      key => new Set(legsOf(key).map(leg => leg.reference)).size === 2)
    expect(split, 'exactly one fabricated confirmation has per-leg references').toHaveLength(1)

    const orphaned = [...new Set(switchRows.map(referenceKey))]
      .filter(key => switchRows.filter(row => referenceKey(row) === key).length === 1)
    expect(orphaned, 'the old rule leaves two half-groups behind').toHaveLength(2)
  })

  it('preserves BOTH per-leg references, on their own rows', () => {
    const [key] = inspection.switchGroupKeys.filter(
      k => new Set(legsOf(k).map(leg => leg.reference)).size === 2)
    const legs = legsOf(key)
    const out = legs.find(leg => leg.side === 'SWITCH_OUT')!
    const incoming = legs.find(leg => leg.side === 'SWITCH_IN')!
    expect(out.reference).not.toBe('')
    expect(incoming.reference).not.toBe('')
    expect(out.reference).not.toBe(incoming.reference)
    // Neither leg was rewritten to carry the other's reference.
    expect(rows.filter(row => row.reference === out.reference)).toHaveLength(1)
    expect(rows.filter(row => row.reference === incoming.reference)).toHaveLength(1)
  })

  it('trade_date is not part of the key: legs may settle on different dates', () => {
    const staggered = inspection.switchGroupKeys.filter(
      key => new Set(legsOf(key).map(leg => leg.trade_date)).size === 2)
    expect(staggered, 'the fixture contains a confirmation that settles over two days').toHaveLength(1)
    // CONTROL: adding the date to the key splits exactly that pair, so a
    // date-bearing key reports four groups where there are three.
    expect(new Set(switchRows.map(datedKey)).size).toBe(4)
  })
})

describe('switch legs participate in derived holdings', () => {
  const positions = (source: ArchiveRow[]) => {
    const totals = new Map<string, string[]>()
    for (const row of source) {
      const units = row.units.trim()
      if (!units) continue
      const signed = ['SELL', 'RED', 'SWITCH_OUT'].includes(row.side)
        ? `-${units.replace(/^-/, '')}` : units
      const key = `${row.broker}|${row.account}|${row.asset}|${row.currency}`
      totals.set(key, [...(totals.get(key) ?? []), signed])
    }
    return new Set([...totals.entries()]
      .filter(([, values]) => addDecimals(values).startsWith('-'))
      .map(([key]) => key))
  }

  it('reports exactly the four fabricated short positions', () => {
    expect(inspection.negativePositionKeys).toHaveLength(4)
    expect(inspection.negativePositionKeys).toEqual([
      'Synthetic Broker A|SYN-0001|SYNB|THB',
      'Synthetic Broker B|SYN-0002|SYNFUND-C|THB',
      'Synthetic Broker B|SYN-0002|SYNFUND-E|THB',
      'Synthetic Broker B|SYN-0002|SYNFUND-OUT|THB',
    ])
    // The production result must equal an independent recomputation, so the
    // literal list above cannot drift away from the rule it stands for.
    expect(new Set(inspection.negativePositionKeys)).toEqual(positions(rows))
  })

  it('CONTROL: excluding switch legs invents two short positions that do not exist', () => {
    const withoutSwitchLegs = positions(rows.filter(r => r.is_switch.trim().toLowerCase() !== 'true'))
    const spurious = [...withoutSwitchLegs].filter(key => !inspection.negativePositionKeys.includes(key))
    expect(spurious.sort()).toEqual([
      'Synthetic Broker B|SYN-0002|SYNFUND-D|THB',
      'Synthetic Broker B|SYN-0002|SYNFUND-F|THB',
    ])
    // Each spurious short is a fund whose ONLY acquisition was a SWITCH_IN —
    // which is exactly why dropping the legs makes it look permanently short.
    for (const key of spurious) {
      const asset = key.split('|')[2]
      expect(rows.some(r => r.side === 'SWITCH_IN' && r.asset === asset), asset).toBe(true)
      expect(rows.some(r => r.side === 'BUY' && r.asset === asset), asset).toBe(false)
    }
  })

  it('a short position stays a WARNING: missing history is still possible', () => {
    const negatives = inspection.findings.filter(f => f.code === 'NEGATIVE_DERIVED_POSITION')
    expect(negatives).toHaveLength(4)
    expect(negatives.every(f => f.severity === 'warning')).toBe(true)
  })
})

describe('the fixture reads no private data', () => {
  it('is the committed synthetic archive, needing no environment at all', () => {
    expect(FIXTURE).toBe(join(resolve(__dirname, '..'), 'fixtures', 'synthetic-archive.csv'))
    expect(inspection.rows).toHaveLength(12)
    expect(inspection.currencyRows).toEqual({ THB: 12 })
    expect(inspection.missingAccounts).toBe(0)
    expect(inspection.exactDuplicateRows).toBe(0)
    expect(inspection.multiRowReferenceGroups).toBe(2)
    expect(inspection.logicalSourceFiles).toBe(9)
  })
})
