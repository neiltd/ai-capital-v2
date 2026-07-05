export const dynamic = 'force-dynamic'

import { NextResponse, type NextRequest } from 'next/server'
// Import from the pool subpath, not '@common/db' root — root pulls in the
// LanceDB vector-store which webpack can't bundle (native .node binary).
import { getPool } from '@common/db/pool'

// Public response shape — duplicated client-side in the trade layer rather
// than imported, to avoid cross-app type coupling. Keep in sync.
interface CountryDto {
  iso3:         string
  name:         string
  centroidLat:  number | null
  centroidLon:  number | null
}
interface FlowDto {
  originIso3:   string
  destIso3:     string
  commodity:    string
  valueUsd:     string   // bigint serialized as decimal string
  periodYear:   number
  periodQuarter: number | null
}
interface ChokepointDto {
  id:           string
  name:         string
  lat:          number
  lon:          number
  description:  string | null
}
interface TickerDepDto {
  ticker:       string
  countryIso3:  string
  commodity:    string
  chokepointId: string | null
  criticality:  number
  rationale:    string | null
}

export interface TradeGraphResponse {
  countries:    CountryDto[]
  flows:        FlowDto[]          // latest per (origin,dest,commodity)
  chokepoints:  ChokepointDto[]
  chokepointRoutes: Array<{ chokepointId: string; originIso3: string; destIso3: string }>
  tickerDeps:   TickerDepDto[]
  /** Map (origin,dest) → tickers exposed to that bilateral lane. Computed
   *  server-side so the client doesn't have to join across thousands of rows. */
  laneExposure: Record<string, string[]>
}

/**
 * GET /api/trade-graph?portfolioOnly=true&ticker=NVDA
 *
 * Query params:
 *   portfolioOnly  — when true (default), filter flows to lanes that touch at
 *                    least one ticker's dependencies (keeps the map readable).
 *   ticker         — narrow to a single ticker's exposure.
 */
export async function GET(req: NextRequest) {
  try {
    const pool = getPool()
    const params = req.nextUrl.searchParams
    const portfolioOnly = params.get('portfolioOnly') !== 'false'
    const ticker = params.get('ticker')

    // Fetch in parallel — each is a cheap indexed read.
    const [countriesQ, chokepointsQ, routesQ, tickerDepsQ] = await Promise.all([
      pool.query(`select iso3, name, centroid_lat, centroid_lon from trade.countries order by iso3`),
      pool.query(`select id, name, lat, lon, description from trade.chokepoints order by name`),
      pool.query(`select chokepoint_id, origin_iso3, dest_iso3 from trade.chokepoint_routes`),
      ticker
        ? pool.query(
            `select ticker, country_iso3, commodity, chokepoint_id, criticality, rationale
               from trade.ticker_dependencies where ticker = $1 order by criticality`,
            [ticker],
          )
        : pool.query(
            `select ticker, country_iso3, commodity, chokepoint_id, criticality, rationale
               from trade.ticker_dependencies order by ticker, criticality`,
          ),
    ])

    // Latest flow per (origin, dest, commodity) — distinct-on with descending period.
    // When portfolioOnly, restrict to lanes that match at least one ticker dep
    // (origin OR dest matches a dep's country_iso3).
    const flowSql = portfolioOnly
      ? `select distinct on (origin_iso3, dest_iso3, commodity)
                origin_iso3, dest_iso3, commodity, value_usd, period_year, period_quarter
           from trade.flows f
          where exists (
                  select 1 from trade.ticker_dependencies td
                   where td.country_iso3 = f.origin_iso3 or td.country_iso3 = f.dest_iso3
                )
          order by origin_iso3, dest_iso3, commodity,
                   period_year desc, period_quarter desc nulls last`
      : `select distinct on (origin_iso3, dest_iso3, commodity)
                origin_iso3, dest_iso3, commodity, value_usd, period_year, period_quarter
           from trade.flows
          order by origin_iso3, dest_iso3, commodity,
                   period_year desc, period_quarter desc nulls last`
    const flowsQ = await pool.query(flowSql)

    // Build lane → tickers index from the deps we already fetched.
    const laneExposure: Record<string, string[]> = {}
    const tickerDeps: TickerDepDto[] = tickerDepsQ.rows.map(r => {
      const dep: TickerDepDto = {
        ticker:       r.ticker,
        countryIso3:  r.country_iso3,
        commodity:    r.commodity,
        chokepointId: r.chokepoint_id,
        criticality:  r.criticality,
        rationale:    r.rationale,
      }
      // Index every lane that touches this dep's country. The client will
      // resolve hover/click highlights by (origin,dest) lookup.
      return dep
    })

    // For each flow, list tickers whose dep matches either endpoint.
    const depsByCountry = new Map<string, Set<string>>()
    for (const d of tickerDeps) {
      const set = depsByCountry.get(d.countryIso3) ?? new Set<string>()
      set.add(d.ticker)
      depsByCountry.set(d.countryIso3, set)
    }
    const flows: FlowDto[] = flowsQ.rows.map(r => {
      const key = `${r.origin_iso3}>${r.dest_iso3}`
      const originTickers = depsByCountry.get(r.origin_iso3)
      const destTickers   = depsByCountry.get(r.dest_iso3)
      const tickerArr: string[] = []
      if (originTickers) originTickers.forEach(t => tickerArr.push(t))
      if (destTickers)   destTickers.forEach(t   => tickerArr.push(t))
      if (tickerArr.length > 0) laneExposure[key] = Array.from(new Set(tickerArr)).sort()
      return {
        originIso3:    r.origin_iso3,
        destIso3:      r.dest_iso3,
        commodity:     r.commodity,
        valueUsd:      String(r.value_usd),
        periodYear:    r.period_year,
        periodQuarter: r.period_quarter,
      }
    })

    const response: TradeGraphResponse = {
      countries:   countriesQ.rows.map(r => ({
        iso3:        r.iso3,
        name:        r.name,
        centroidLat: r.centroid_lat,
        centroidLon: r.centroid_lon,
      })),
      flows,
      chokepoints: chokepointsQ.rows.map(r => ({
        id: r.id, name: r.name, lat: r.lat, lon: r.lon, description: r.description,
      })),
      chokepointRoutes: routesQ.rows.map(r => ({
        chokepointId: r.chokepoint_id,
        originIso3:   r.origin_iso3,
        destIso3:     r.dest_iso3,
      })),
      tickerDeps,
      laneExposure,
    }

    return NextResponse.json(response)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[api/trade-graph] error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
