// D3-B1: the backtest reads the store that is actually being written.
//
// In production `cli-brief` writes every prediction to `briefing.predictions`,
// so the JSONL archive stops growing the moment `DATABASE_URL` is set. The
// backtest kept reading the file: on a checkout where the ignored file was
// missing it exited 1 before scoring anything, and where it existed it scored a
// frozen snapshot and reported that as today's calibration.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const query = vi.fn()
const closePool = vi.fn(async () => undefined)
const usePostgres = vi.fn(() => true)

vi.mock('@common/db', () => ({
  usePostgres: () => usePostgres(),
  getPool: () => ({ query }),
  closePool: () => closePool(),
}))

// Watched so a Postgres-mode read that touches the legacy file is caught, not
// merely assumed absent.
const readFileSync = vi.fn()
const existsSync = vi.fn()
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return {
    ...real,
    readFileSync: (...a: Parameters<typeof real.readFileSync>) => {
      readFileSync(...a); return real.readFileSync(...a)
    },
    existsSync: (...a: Parameters<typeof real.existsSync>) => {
      existsSync(...a); return real.existsSync(...a)
    },
  }
})

const load = async () =>
  (await import('../src/backtest/backtest-runner.js')).loadPredictions

const ROW = (date: string) => ({
  date, regime: 'risk-on', confidence: 'high',
  actions: [{
    ticker: 'NVDA', scenarioType: 'base', action: 'buy',
    conviction: 'high', allocationChangePct: 2.5,
  }],
})

let dir: string
beforeEach(() => {
  vi.clearAllMocks()
  usePostgres.mockReturnValue(true)
  dir = mkdtempSync(join(tmpdir(), 'd3-backtest-'))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('D3-B1: prediction corpus source', () => {
  it('reads briefing.predictions in date order when Postgres is selected', async () => {
    query.mockResolvedValue({ rows: [ROW('2026-01-02'), ROW('2026-02-03')] })
    const rows = await (await load())(join(dir, 'archive', 'predictions.jsonl'))
    expect(rows.map(r => r.date)).toEqual(['2026-01-02', '2026-02-03'])
    // ORDERED BY THE DATABASE, not by whatever order rows came back in. A
    // mutant that drops ORDER BY passes any test that only counts rows.
    const sql = (query.mock.calls[0]?.[0] as string).replace(/\s+/g, ' ')
    expect(sql).toMatch(/ORDER BY date/i)
    expect(sql).toMatch(/date::text/)
    expect(sql).toMatch(/FROM briefing\.predictions/)
  })

  it('never touches the JSONL path in Postgres mode', async () => {
    query.mockResolvedValue({ rows: [ROW('2026-01-02')] })
    const archive = join(dir, 'archive', 'predictions.jsonl')
    await (await load())(archive)
    const touched = [...readFileSync.mock.calls, ...existsSync.mock.calls]
      .map(c => String(c[0])).filter(p => p.includes('predictions.jsonl'))
    expect(touched).toEqual([])
  })

  it('FAILS CLOSED on a Postgres error rather than falling back to the file', async () => {
    // The file is present and valid, so a fallback would silently succeed with
    // stale data — which is the outcome under test, not an absence of data.
    const archive = join(dir, 'predictions.jsonl')
    writeFileSync(archive, JSON.stringify(ROW('2019-01-01')) + '\n')
    query.mockRejectedValue(new Error('connection terminated'))
    await expect((await load())(archive)).rejects.toThrow(/connection terminated/)
    expect(closePool).toHaveBeenCalledTimes(1)
  })

  it('closes the owned pool on success as well as failure', async () => {
    query.mockResolvedValue({ rows: [ROW('2026-01-02')] })
    await (await load())(join(dir, 'x.jsonl'))
    expect(closePool).toHaveBeenCalledTimes(1)
  })

  it('still reads the JSONL when Postgres is NOT selected', async () => {
    usePostgres.mockReturnValue(false)
    const archive = join(dir, 'predictions.jsonl')
    writeFileSync(archive, [JSON.stringify(ROW('2026-03-04')), JSON.stringify(ROW('2026-03-05'))].join('\n') + '\n')
    const rows = await (await load())(archive)
    expect(rows.map(r => r.date)).toEqual(['2026-03-04', '2026-03-05'])
    expect(query).not.toHaveBeenCalled()
    expect(closePool).not.toHaveBeenCalled()
  })

  it('refuses a missing JSONL ONLY in fallback mode', async () => {
    usePostgres.mockReturnValue(false)
    await expect((await load())(join(dir, 'nope.jsonl'))).rejects.toThrow(/No predictions archive/)
    // And the same absence is irrelevant once Postgres is selected.
    usePostgres.mockReturnValue(true)
    query.mockResolvedValue({ rows: [ROW('2026-01-02')] })
    await expect((await load())(join(dir, 'nope.jsonl'))).resolves.toHaveLength(1)
  })

  it('reports malformed database records by field, without echoing the row', async () => {
    const secret = 'SECRET-POSITION-8143'
    query.mockResolvedValue({ rows: [{ ...ROW('2026-01-02'), actions: secret }] })
    const err = await (await load())(join(dir, 'x.jsonl')).catch((e: Error) => e)
    expect(String(err)).toMatch(/briefing\.predictions row 1: actions is not an array/)
    expect(String(err)).not.toContain(secret)
  })

  it('reports malformed action fields by index and name', async () => {
    query.mockResolvedValue({ rows: [{
      ...ROW('2026-01-02'),
      actions: [{ ticker: 'NVDA', scenarioType: 'base', action: 'buy', conviction: 'urgent', allocationChangePct: 1 }],
    }] })
    await expect((await load())(join(dir, 'x.jsonl'))).rejects
      .toThrow(/actions\[0\]\.conviction is not one of high, medium, low/)
  })

  it('reports a malformed JSONL line by file and line number', async () => {
    usePostgres.mockReturnValue(false)
    const archive = join(dir, 'predictions.jsonl')
    writeFileSync(archive, JSON.stringify(ROW('2026-01-02')) + '\n' + '{not json\n')
    await expect((await load())(archive)).rejects.toThrow(/line 2: the line is not JSON/)
  })
})
