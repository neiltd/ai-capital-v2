import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { inspectArchive, switchGroupKey } from '../../src/inspect.js'
import { parseArchiveCsv } from '../../src/csv.js'
import { COLUMNS } from '../../src/types.js'
import { archivePath } from '../archive-env.js'
import type { ArchiveRow } from '../../src/types.js'

// PROPERTIES OF THE SUPPLIED ARCHIVE — no literal drawn from it.
//
// The exact-identity cases (which grouping rule wins, which shorts are real)
// belong to the portable suite, where they run against a fabricated fixture and
// can assert exact values safely. What remains here is the question that fixture
// cannot answer: does the rule still hold on the operator's real data?
//
// Every expectation below is RECOMPUTED from the file at run time, or derived by
// re-running the production inspector over a filtered copy of it. Nothing is
// pinned to a filename, a reference, an account, a holding or an amount, so this
// file discloses nothing even though it reads a private record.
//
// It also does not reimplement `switchGroupKey` or the position arithmetic: a
// second copy of the rule would drift, and comparing a rule to its own clone
// proves nothing. The control below removes rows and re-inspects instead.

const ARCHIVE = archivePath()
const inspection = inspectArchive(ARCHIVE)
const rows = parseArchiveCsv(readFileSync(ARCHIVE, 'utf8'))
const switchRows = rows.filter(row => row.is_switch.trim().toLowerCase() === 'true')

const csvField = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/**
 * Re-inspect a filtered copy of the archive with the PRODUCTION inspector.
 *
 * The alternative — recomputing positions here — would be a second copy of the
 * rule under test, so a drift in either would go unnoticed. The temporary file
 * lives in the OS temp directory and is removed in `finally`.
 */
function inspectWithout(predicate: (row: ArchiveRow) => boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-archive-'))
  try {
    const kept = rows.filter(row => !predicate(row))
    const body = [
      COLUMNS.join(','),
      ...kept.map(row => COLUMNS.map(column => csvField(row[column])).join(',')),
    ].join('\n') + '\n'
    const path = join(dir, 'filtered.csv')
    writeFileSync(path, body)
    return inspectArchive(path)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('switch identity holds on the supplied archive', () => {
  it('every switch group is exactly one SWITCH_OUT and one SWITCH_IN', () => {
    expect(switchRows.length, 'the archive must contain switch legs at all').toBeGreaterThan(0)
    expect(switchRows.filter(r => r.side === 'SWITCH_OUT').length)
      .toBe(switchRows.filter(r => r.side === 'SWITCH_IN').length)
    expect(inspection.incompleteSwitchGroups).toEqual([])
    expect(inspection.switchGroupKeys).toHaveLength(switchRows.length / 2)
  })

  it('CONTROL: keying on the broker reference would break that, here too', () => {
    const byReference = new Set(switchRows.map(r => [r.broker, r.source_file, r.reference].join('|')))
    expect(byReference.size,
      'if this ever equals the group count, the archive no longer exercises the defect')
      .toBeGreaterThan(inspection.switchGroupKeys.length)
  })

  it('both legs of a split confirmation keep their own reference', () => {
    const groups = new Map<string, ArchiveRow[]>()
    for (const row of switchRows) {
      const key = switchGroupKey(row)
      groups.set(key, [...(groups.get(key) ?? []), row])
    }
    const split = [...groups.values()].filter(legs => new Set(legs.map(l => l.reference)).size > 1)
    expect(split.length, 'the archive must contain at least one per-leg-reference confirmation')
      .toBeGreaterThan(0)
    for (const legs of split) {
      expect(legs).toHaveLength(2)
      for (const leg of legs) expect(leg.reference.trim()).not.toBe('')
      // Distinct, and neither overwritten by the other.
      expect(new Set(legs.map(l => l.reference)).size).toBe(2)
    }
  })

  it('some confirmations settle over two dates, so the key must not carry one', () => {
    const dated = new Set(switchRows.map(r => [switchGroupKey(r), r.trade_date].join('|')))
    expect(dated.size,
      'a date-bearing key would report more groups than there are confirmations')
      .toBeGreaterThan(inspection.switchGroupKeys.length)
  })
})

describe('derived positions on the supplied archive', () => {
  it('every reported short position is a well-formed account/instrument key', () => {
    expect(inspection.negativePositionKeys.length).toBeGreaterThan(0)
    for (const key of inspection.negativePositionKeys) {
      const parts = key.split('|')
      expect(parts, 'key shape').toHaveLength(4)
      for (const part of parts) expect(part.trim(), 'key segment').not.toBe('')
    }
    // Sorted and unique, so the set is stable across runs.
    expect(inspection.negativePositionKeys).toEqual([...inspection.negativePositionKeys].sort())
    expect(new Set(inspection.negativePositionKeys).size).toBe(inspection.negativePositionKeys.length)
    // One warning per short position, never an error.
    const findings = inspection.findings.filter(f => f.code === 'NEGATIVE_DERIVED_POSITION')
    expect(findings).toHaveLength(inspection.negativePositionKeys.length)
    expect(findings.every(f => f.severity === 'warning')).toBe(true)
  })

  it('CONTROL: excluding switch legs invents shorts that the real rule does not report', () => {
    const withoutSwitchLegs = inspectWithout(row => row.is_switch.trim().toLowerCase() === 'true')
    const spurious = withoutSwitchLegs.negativePositionKeys
      .filter(key => !inspection.negativePositionKeys.includes(key))
    expect(spurious.length, 'the archive must contain switch-acquired holdings').toBeGreaterThan(0)
    // Each one is a holding whose acquisition is a SWITCH_IN — which is exactly
    // why dropping the legs makes it look permanently short.
    for (const key of spurious) {
      const asset = key.split('|')[2]
      expect(switchRows.some(r => r.side === 'SWITCH_IN' && r.asset === asset)).toBe(true)
    }
  })
})
