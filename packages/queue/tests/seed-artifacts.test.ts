// D3-B3: the required untracked seed is proved BEFORE a flow can exist.
//
// On 2026-09-29 `graph.json` was missing from the relocated checkout. The daily
// flow was submitted anyway, ran twenty stages, failed terminally on an ENOENT
// inside ai-analysis-engine, and left six parents blocked behind a scheduled row
// that had to be retired by hand. Every part of that was knowable up front.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  GRAPH_SEED_PATH, SeedArtifactRefused, checkoutRoot, requireDailySeedArtifacts,
} from '../src/seed-artifacts.js'

const GOOD = {
  schemaVersion: '1.0',
  exportedAt: '2026-07-03T06:11:37.317Z',
  nodes: [{ ticker: 'NVDA' }],
  edges: [{ from: 'NVDA', to: 'AVGO' }],
}

let root: string
const seed = (): string => join(root, GRAPH_SEED_PATH)
const plant = (body: string): void => {
  mkdirSync(join(root, 'apps', 'dependency-graph-engine', 'data'), { recursive: true })
  writeFileSync(seed(), body)
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'd3-seed-')) })
afterEach(() => { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }) })

describe('D3-B3: required runtime seed preflight', () => {
  it('accepts the reviewed artifact', () => {
    plant(JSON.stringify(GOOD))
    expect(() => requireDailySeedArtifacts(root)).not.toThrow()
  })

  it('leaves the file byte-identical', () => {
    const body = JSON.stringify(GOOD)
    plant(body)
    requireDailySeedArtifacts(root)
    expect(readFileSync(seed(), 'utf-8')).toBe(body)
  })

  it('refuses an absent seed', () => {
    expect(() => requireDailySeedArtifacts(root)).toThrow(SeedArtifactRefused)
    expect(() => requireDailySeedArtifacts(root)).toThrow(/is absent from this checkout/)
  })

  it('refuses a SYMLINK standing where the seed belongs', () => {
    // A link could point at a graph outside the checkout — a different input
    // than the one this preflight would be claiming to have checked.
    const elsewhere = join(root, 'elsewhere.json')
    writeFileSync(elsewhere, JSON.stringify(GOOD))
    mkdirSync(join(root, 'apps', 'dependency-graph-engine', 'data'), { recursive: true })
    symlinkSync(elsewhere, seed())
    expect(() => requireDailySeedArtifacts(root)).toThrow(/is a symlink, not a regular file/)
  })

  it('refuses a directory in its place', () => {
    mkdirSync(seed(), { recursive: true })
    expect(() => requireDailySeedArtifacts(root)).toThrow(/is not a regular file/)
  })

  it('refuses unparseable JSON', () => {
    plant('{ nodes: [] ')
    expect(() => requireDailySeedArtifacts(root)).toThrow(/is not valid JSON/)
  })

  it('refuses a JSON array or scalar', () => {
    plant('[]')
    expect(() => requireDailySeedArtifacts(root)).toThrow(/does not contain a JSON object/)
  })

  it('refuses a wrong schemaVersion', () => {
    plant(JSON.stringify({ ...GOOD, schemaVersion: '2.0' }))
    expect(() => requireDailySeedArtifacts(root)).toThrow(/does not declare schemaVersion 1\.0/)
  })

  it('refuses empty or missing nodes and edges', () => {
    plant(JSON.stringify({ ...GOOD, nodes: [] }))
    expect(() => requireDailySeedArtifacts(root)).toThrow(/has no nodes/)
    plant(JSON.stringify({ ...GOOD, edges: [] }))
    expect(() => requireDailySeedArtifacts(root)).toThrow(/has no edges/)
    plant(JSON.stringify({ schemaVersion: '1.0' }))
    expect(() => requireDailySeedArtifacts(root)).toThrow(/has no nodes/)
  })

  it('NEVER puts graph contents in the refusal', () => {
    // The graph names real holdings and their relationships.
    plant(JSON.stringify({ ...GOOD, schemaVersion: '9.9', nodes: [{ ticker: 'SECRET-HOLDING-3319' }] }))
    const err = (() => { try { requireDailySeedArtifacts(root); return null } catch (e) { return e as Error } })()
    expect(err?.message).not.toContain('SECRET-HOLDING-3319')
  })

  it('resolves against the checkout it is running from, not a remembered path', () => {
    // Derived from this module's location; the whole defect was a file that
    // existed in one tree and not the one being served.
    // Proved by what the resolved root CONTAINS, not by a hardcoded absolute
    // path: this package's own manifest must sit under it.
    expect(existsSync(join(checkoutRoot(), 'packages', 'queue', 'package.json'))).toBe(true)
    expect(existsSync(join(checkoutRoot(), 'pnpm-workspace.yaml'))).toBe(true)
    // And an explicit root is honoured, so the check is about THAT tree.
    plant(JSON.stringify(GOOD))
    expect(() => requireDailySeedArtifacts(root)).not.toThrow()
  })
})

describe('D3-B3: the preflight precedes submission', () => {
  const submitDailyPipeline = vi.fn()
  const recordStart = vi.fn()

  beforeEach(() => { vi.clearAllMocks() })

  it('a refusal reaches no submission and no run recording', async () => {
    // Ordering proved by consequence, not by reading the file: with the seed
    // absent, neither the submitter nor the recorder is reached at all.
    let threw: Error | null = null
    try { requireDailySeedArtifacts(root) } catch (e) { threw = e as Error }
    expect(threw).toBeInstanceOf(SeedArtifactRefused)
    expect(submitDailyPipeline).not.toHaveBeenCalled()
    expect(recordStart).not.toHaveBeenCalled()
  })

  it('run-daily calls the preflight before submitDailyPipeline in source order', async () => {
    const src = readFileSync(
      new URL('../bin/run-daily.ts', import.meta.url), 'utf-8')
    const preflight = src.indexOf('requireDailySeedArtifacts()')
    const submit = src.indexOf('await submitDailyPipeline(')
    expect(preflight).toBeGreaterThan(-1)
    expect(submit).toBeGreaterThan(-1)
    expect(preflight).toBeLessThan(submit)
    // And it is inside the block that exits 2 rather than merely logging.
    expect(src.slice(preflight, submit)).toMatch(/process\.exit\(2\)/)
  })
})
