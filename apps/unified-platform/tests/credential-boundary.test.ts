// THE UNIFIED PLATFORM'S CREDENTIAL BOUNDARY — slice S4A.
//
// This app is network-facing, so what matters is not only which database it
// reaches but which credential it is CAPABLE of holding. These assertions are
// made against the SOURCE TEXT, deliberately and literally: a raw scan cannot be
// satisfied by a comment that merely explains the rule, and it catches a
// reintroduced literal in a string, a template, a comment or a default.
//
// WHAT IS PERMITTED. Exactly one PostgreSQL credential in the SERVER runtime:
// DASHBOARD_DATABASE_URL, which migration 019 restricts to SELECT on five
// `trade` tables. That is a server-only variable — it carries no NEXT_PUBLIC_
// prefix, so Next never inlines it into a client bundle.
//
// WHAT IS FORBIDDEN. Any pipeline, migrator, owner, superuser or claim-writer
// credential; the generic DATABASE_URL (which in this process is Prisma's SQLite
// file: URL); any NEXT_PUBLIC_* database credential; any credential literal; and
// any dashboard credential reaching client code.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The market-hours check is the only thing POST() branches on, so it is the only
// thing mocked. Everything else in the route is exercised for real.
const isMarketOpen = vi.fn<() => boolean>()
vi.mock('@/lib/market-hours', () => ({ isMarketOpen: () => isMarketOpen() }))

const HERE    = dirname(fileURLToPath(import.meta.url))
const APP     = resolve(HERE, '..')
const SRC     = join(APP, 'src')
const REFRESH = join(SRC, 'app', 'api', 'portfolio', 'refresh', 'route.ts')
const GRAPH   = join(SRC, 'app', 'api', 'trade-graph', 'route.ts')

/** Every source file under src/, excluding generated Prisma output. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) acc.push(full)
  }
  return acc
}

const FILES = sourceFiles(SRC)
const rel = (f: string) => f.slice(APP.length + 1)

describe('the scan covers real files', () => {
  it('found the app source, and both routes are in it', () => {
    // NON-VACUITY. Every assertion below quantifies over FILES; an empty list
    // would satisfy all of them while proving nothing.
    expect(FILES.length).toBeGreaterThan(20)
    expect(FILES).toContain(REFRESH)
    expect(FILES).toContain(GRAPH)
  })
})

describe('no database credential literal anywhere under src/', () => {
  it('no postgres:// or postgresql:// literal', () => {
    const offenders = FILES.filter(f => /postgres(ql)?:\/\//.test(readFileSync(f, 'utf-8')))
    expect(offenders.map(rel), 'a PostgreSQL URL literal is present').toEqual([])
  })

  it('no embedded credential-shaped connection string', () => {
    // user:password@host — the shape, not a specific host.
    const offenders = FILES.filter(f =>
      /[a-z0-9_-]+:[^\s@/]+@[a-z0-9.-]+:\d{2,5}\//i.test(readFileSync(f, 'utf-8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('no NEXT_PUBLIC_* database credential — those are inlined into client bundles', () => {
    const offenders: string[] = []
    for (const f of FILES) {
      const m = readFileSync(f, 'utf-8').match(/NEXT_PUBLIC_[A-Z0-9_]*(DATABASE|DB|POSTGRES|PG)[A-Z0-9_]*/g)
      if (m) offenders.push(`${rel(f)}: ${m.join(', ')}`)
    }
    expect(offenders, 'a database credential would be exposed to the browser').toEqual([])
  })

  it('DASHBOARD_DATABASE_URL is never read by app source — only by @common/db', () => {
    // The seam is getDashboardPool(); the app never touches the variable itself,
    // so there is exactly one place that validates it.
    const offenders = FILES.filter(f => /DASHBOARD_DATABASE_URL/.test(readFileSync(f, 'utf-8')))
    expect(offenders.map(rel)).toEqual([])
  })
})

describe('the refresh route holds no credential and spawns nothing', () => {
  const text = readFileSync(REFRESH, 'utf-8')

  const FORBIDDEN = [
    'PIPELINE_DATABASE_URL',
    'DATABASE_URL',
    'getPool',
    'getDashboardPool',
    'child_process',
    'execFile',
    'promisify',
    'spawn',
    'scenario-simulator',
  ]

  for (const symbol of FORBIDDEN) {
    it(`does not reference ${symbol}`, () => {
      // Raw text, comments included. A comment naming the removed symbol would
      // weaken a check whose whole value is that it is literal.
      expect(text, `refresh/route.ts still references ${symbol}`).not.toContain(symbol)
    })
  }

  it('imports nothing from node:child_process, util or path', () => {
    expect(text).not.toMatch(/from ['"](node:)?(child_process|util|path)['"]/)
  })

  it('answers 409 for a closed market BEFORE anything else', () => {
    // ORDER IS PART OF THE CONTRACT. "Prices would not have moved" is a
    // different fact from "refresh is not configured", and a caller outside
    // market hours must keep getting the answer it always got.
    const i409 = text.indexOf('409')
    const i503 = text.indexOf('503')
    expect(i409, 'the 409 branch is gone').toBeGreaterThan(-1)
    expect(i503, 'the 503 branch is missing').toBeGreaterThan(-1)
    expect(i409, '503 precedes 409').toBeLessThan(i503)
    expect(text.indexOf('isMarketOpen')).toBeLessThan(i409)
  })

  it('the market-hours guard is LIVE, not short-circuited', () => {
    // MUTATION CONTROL. Rewriting the condition to `if (false && !isMarketOpen())`
    // leaves every positional assertion above true — 409 still appears before
    // 503, isMarketOpen is still named — while the guard no longer guards. So
    // the condition itself is pinned, exactly.
    expect(text).toMatch(/if\s*\(\s*!isMarketOpen\(\)\s*\)\s*\{/)
    expect(text, 'the market-hours guard is short-circuited')
      .not.toMatch(/if\s*\(\s*(false|true)\s*(&&|\|\|)/)
  })

  it('returns 503 with code REFRESH_UNAVAILABLE for an eligible request', () => {
    expect(text).toContain('REFRESH_UNAVAILABLE')
    expect(text).toMatch(/status:\s*503/)
    expect(text).toMatch(/ok:\s*false/)
  })

  it('does not enqueue anything yet — delegated refresh is a later slice', () => {
    expect(text).not.toMatch(/@common\/queue|FlowProducer|submitDaily|Queue\(/)
  })
})

describe('the trade-graph route uses the dashboard pool', () => {
  const text = readFileSync(GRAPH, 'utf-8')

  it('imports getDashboardPool from the @common/db/pool subpath', () => {
    expect(text).toMatch(/import \{[^}]*getDashboardPool[^}]*\} from '@common\/db\/pool'/)
  })

  it('never imports or calls getPool', () => {
    expect(text).not.toMatch(/\bgetPool\b/)
  })

  it('calls getDashboardPool()', () => {
    expect(text).toMatch(/getDashboardPool\(\)/)
  })

  it('queries exactly the five tables migration 019 grants, in both directions', () => {
    // The pinning that keeps the route and the grant from drifting apart: a
    // sixth table added here fails the unit gate instead of production.
    const GRANTED = [
      'trade.chokepoint_routes',
      'trade.chokepoints',
      'trade.countries',
      'trade.flows',
      'trade.ticker_dependencies',
    ]
    const referenced = [...new Set(text.match(/\btrade\.[a-z_]+/g) ?? [])].sort()
    expect(referenced).toEqual([...GRANTED].sort())
  })

  it('reaches no schema other than trade', () => {
    const OTHER = ['capital', 'portfolio', 'thesis', 'briefing', 'graph', 'desk',
                   'identity', 'investment_ledger', 'cash_ledger', 'db']
    for (const schema of OTHER) {
      expect(text, `trade-graph reaches schema ${schema}`)
        .not.toMatch(new RegExp(`\\b(from|join)\\s+${schema}\\.`, 'i'))
    }
  })

  it('issues no write', () => {
    expect(text).not.toMatch(/\b(insert\s+into|update\s+\w|delete\s+from|truncate)\b/i)
  })
})

describe('the refresh route BEHAVES correctly, not merely reads correctly', () => {
  // WHY THIS EXISTS. The static scans above prove the 409 text precedes the 503
  // text and that the guard is not short-circuited. Neither executes POST().
  // Deleting the `return` from the market-closed branch would leave every static
  // assertion true while the function fell through and answered 503 to a caller
  // outside market hours. The only way to catch that is to call the thing.

  beforeEach(() => { isMarketOpen.mockReset() })

  it('markets closed -> 409, and NOT the unavailable code', async () => {
    isMarketOpen.mockReturnValue(false)
    const { POST } = await import('@/app/api/portfolio/refresh/route')
    const res = await POST()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.ok).toBe(false)
    // The distinguishing assertion: a fallthrough would answer 503 with this code.
    expect(body.code).not.toBe('REFRESH_UNAVAILABLE')
    expect(body.error).toMatch(/markets are closed/i)
  })

  it('markets open -> 503 REFRESH_UNAVAILABLE', async () => {
    isMarketOpen.mockReturnValue(true)
    const { POST } = await import('@/app/api/portfolio/refresh/route')
    const res = await POST()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.code).toBe('REFRESH_UNAVAILABLE')
  })

  it('the mock genuinely drives the outcome — both branches in one test', async () => {
    // NON-VACUITY for the mock itself. If the module mock were not wired, POST()
    // would call the real isMarketOpen and both calls below would return the
    // SAME status, silently reducing the two tests above to one.
    const { POST } = await import('@/app/api/portfolio/refresh/route')

    isMarketOpen.mockReturnValue(false)
    const closed = await POST()
    isMarketOpen.mockReturnValue(true)
    const open = await POST()

    expect(isMarketOpen).toHaveBeenCalledTimes(2)
    expect(closed.status).toBe(409)
    expect(open.status).toBe(503)
    expect(closed.status, 'the mock did not change the outcome').not.toBe(open.status)
  })

  it('returns no credential, path or internal detail in either body', async () => {
    for (const open of [false, true]) {
      isMarketOpen.mockReturnValue(open)
      const { POST } = await import('@/app/api/portfolio/refresh/route')
      const body = JSON.stringify(await (await POST()).json())
      expect(body).not.toMatch(/postgres(ql)?:\/\//)
      expect(body).not.toMatch(/\/Users\//)
      expect(body).not.toMatch(/DATABASE_URL/)
    }
  })
})
