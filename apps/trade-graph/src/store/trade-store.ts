// Pg-only store for trade-graph. No SQLite fallback — trade-graph is greenfield
// and ships pgvector-native; we don't need to maintain a dual backend.

import { getPool } from '@common/db'
import type {
  Country, TradeFlow, Chokepoint, ChokepointRoute, TickerDependency,
  CommodityCategory, FlowSource,
} from '../types.js'

function row<T>(r: unknown): T { return r as T }

export interface TradeStore {
  // ── Countries ────────────────────────────────────────────────────────────
  upsertCountry(c: Country): Promise<void>
  listCountries(): Promise<Country[]>

  // ── Trade flows ──────────────────────────────────────────────────────────
  /** Insert or replace (origin,dest,commodity,year,quarter) — last write wins. */
  upsertFlow(f: Omit<TradeFlow, 'id' | 'ingestedAt'>): Promise<void>
  /** Bulk-upsert; uses one INSERT … ON CONFLICT round-trip. */
  upsertFlows(flows: Array<Omit<TradeFlow, 'id' | 'ingestedAt'>>): Promise<number>
  flowsForCountry(iso3: string, opts?: { latestOnly?: boolean }): Promise<TradeFlow[]>

  // ── Chokepoints ──────────────────────────────────────────────────────────
  upsertChokepoint(c: Chokepoint): Promise<void>
  listChokepoints(): Promise<Chokepoint[]>
  setChokepointRoutes(chokepointId: string, routes: Array<{ originIso3: string; destIso3: string }>): Promise<void>
  routesForChokepoint(chokepointId: string): Promise<ChokepointRoute[]>

  // ── Ticker dependencies ──────────────────────────────────────────────────
  upsertTickerDependency(d: Omit<TickerDependency, 'id' | 'createdAt'>): Promise<void>
  depsForTicker(ticker: string): Promise<TickerDependency[]>
  /** Reverse lookup — "who depends on this country?" — drives the cascade view. */
  tickersDependentOnCountry(iso3: string): Promise<string[]>
  tickersDependentOnChokepoint(chokepointId: string): Promise<string[]>
}

export function createTradeStore(): TradeStore {
  const pool = getPool()

  return {
    async upsertCountry(c) {
      await pool.query(
        `insert into trade.countries (iso3, name, centroid_lat, centroid_lon)
         values ($1, $2, $3, $4)
         on conflict (iso3) do update
           set name = excluded.name,
               centroid_lat = excluded.centroid_lat,
               centroid_lon = excluded.centroid_lon`,
        [c.iso3, c.name, c.centroidLat, c.centroidLon],
      )
    },

    async listCountries() {
      const r = await pool.query(
        `select iso3, name, centroid_lat, centroid_lon from trade.countries order by iso3`,
      )
      return r.rows.map(x => ({
        iso3:        x.iso3,
        name:        x.name,
        centroidLat: x.centroid_lat,
        centroidLon: x.centroid_lon,
      }))
    },

    async upsertFlow(f) {
      await pool.query(
        `insert into trade.flows (origin_iso3, dest_iso3, commodity, value_usd, period_year, period_quarter, source)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (origin_iso3, dest_iso3, commodity, period_year, period_quarter)
         do update set
           value_usd   = excluded.value_usd,
           source      = excluded.source,
           ingested_at = now()`,
        [f.originIso3, f.destIso3, f.commodity, f.valueUsd.toString(), f.periodYear, f.periodQuarter, f.source],
      )
    },

    async upsertFlows(flows) {
      if (flows.length === 0) return 0
      // Build a parameterised multi-row insert. Postgres caps params at ~65k,
      // so chunk to be safe — each row is 7 cols, max 9000 rows per round-trip.
      const CHUNK = 8000
      let total = 0
      for (let off = 0; off < flows.length; off += CHUNK) {
        const chunk = flows.slice(off, off + CHUNK)
        const params: Array<string | number | null> = []
        const valuesSql = chunk.map((f, i) => {
          const base = i * 7
          params.push(f.originIso3, f.destIso3, f.commodity, f.valueUsd.toString(),
                      f.periodYear, f.periodQuarter, f.source)
          return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`
        }).join(',')
        const res = await pool.query(
          `insert into trade.flows (origin_iso3, dest_iso3, commodity, value_usd, period_year, period_quarter, source)
           values ${valuesSql}
           on conflict (origin_iso3, dest_iso3, commodity, period_year, period_quarter)
           do update set
             value_usd   = excluded.value_usd,
             source      = excluded.source,
             ingested_at = now()`,
          params,
        )
        total += res.rowCount ?? 0
      }
      return total
    },

    async flowsForCountry(iso3, opts = {}) {
      const sql = opts.latestOnly
        ? `select distinct on (origin_iso3, dest_iso3, commodity)
                  id, origin_iso3, dest_iso3, commodity, value_usd,
                  period_year, period_quarter, source, ingested_at
             from trade.flows
            where origin_iso3 = $1 or dest_iso3 = $1
            order by origin_iso3, dest_iso3, commodity, period_year desc, period_quarter desc nulls last`
        : `select id, origin_iso3, dest_iso3, commodity, value_usd,
                  period_year, period_quarter, source, ingested_at
             from trade.flows
            where origin_iso3 = $1 or dest_iso3 = $1
            order by period_year desc, period_quarter desc nulls last`
      const r = await pool.query(sql, [iso3])
      return r.rows.map(x => row<TradeFlow>({
        id:            x.id,
        originIso3:    x.origin_iso3,
        destIso3:      x.dest_iso3,
        commodity:     x.commodity as CommodityCategory,
        valueUsd:      BigInt(x.value_usd),
        periodYear:    x.period_year,
        periodQuarter: x.period_quarter,
        source:        x.source as FlowSource,
        ingestedAt:    x.ingested_at,
      }))
    },

    async upsertChokepoint(c) {
      await pool.query(
        `insert into trade.chokepoints (id, name, lat, lon, description)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do update
           set name = excluded.name,
               lat = excluded.lat,
               lon = excluded.lon,
               description = excluded.description`,
        [c.id, c.name, c.lat, c.lon, c.description],
      )
    },

    async listChokepoints() {
      const r = await pool.query(
        `select id, name, lat, lon, description from trade.chokepoints order by name`,
      )
      return r.rows.map(x => ({
        id: x.id, name: x.name, lat: x.lat, lon: x.lon, description: x.description,
      }))
    },

    async setChokepointRoutes(chokepointId, routes) {
      // Idempotent: wipe + re-insert in a transaction so the set semantics hold.
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query(
          `delete from trade.chokepoint_routes where chokepoint_id = $1`,
          [chokepointId],
        )
        for (const r of routes) {
          await client.query(
            `insert into trade.chokepoint_routes (chokepoint_id, origin_iso3, dest_iso3)
             values ($1, $2, $3) on conflict do nothing`,
            [chokepointId, r.originIso3, r.destIso3],
          )
        }
        await client.query('commit')
      } catch (err) {
        await client.query('rollback')
        throw err
      } finally {
        client.release()
      }
    },

    async routesForChokepoint(chokepointId) {
      const r = await pool.query(
        `select chokepoint_id, origin_iso3, dest_iso3
           from trade.chokepoint_routes
          where chokepoint_id = $1`,
        [chokepointId],
      )
      return r.rows.map(x => ({
        chokepointId: x.chokepoint_id,
        originIso3:   x.origin_iso3,
        destIso3:     x.dest_iso3,
      }))
    },

    async upsertTickerDependency(d) {
      await pool.query(
        `insert into trade.ticker_dependencies
           (ticker, country_iso3, commodity, chokepoint_id, criticality, rationale, source)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [d.ticker, d.countryIso3, d.commodity, d.chokepointId, d.criticality, d.rationale, d.source],
      )
    },

    async depsForTicker(ticker) {
      const r = await pool.query(
        `select id, ticker, country_iso3, commodity, chokepoint_id,
                criticality, rationale, source, created_at
           from trade.ticker_dependencies
          where ticker = $1
          order by criticality, country_iso3`,
        [ticker],
      )
      return r.rows.map(x => row<TickerDependency>({
        id:           x.id,
        ticker:       x.ticker,
        countryIso3:  x.country_iso3,
        commodity:    x.commodity as CommodityCategory,
        chokepointId: x.chokepoint_id,
        criticality:  x.criticality as 1 | 2 | 3 | 4 | 5,
        rationale:    x.rationale,
        source:       x.source as 'llm' | 'manual',
        createdAt:    x.created_at,
      }))
    },

    async tickersDependentOnCountry(iso3) {
      const r = await pool.query(
        `select distinct ticker from trade.ticker_dependencies where country_iso3 = $1 order by ticker`,
        [iso3],
      )
      return r.rows.map(x => x.ticker as string)
    },

    async tickersDependentOnChokepoint(chokepointId) {
      const r = await pool.query(
        `select distinct ticker from trade.ticker_dependencies where chokepoint_id = $1 order by ticker`,
        [chokepointId],
      )
      return r.rows.map(x => x.ticker as string)
    },
  }
}
