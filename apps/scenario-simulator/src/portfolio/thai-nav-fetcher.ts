// Maps portfolio ticker → SEC FundDailyInfo proj_id and class filter.
// proj_id format: {Type}{ID}_{BuddhistYear}  (e.g. M0118_2561 = fund #118 registered in BE 2561)
// classFilter: exact class_abbr_name to pick from the NAV response; null picks first available class.

interface ThaiNavMapping {
  projId:      string
  classFilter: string | null
}

// Discovered via GET https://api.sec.or.th/FundFactsheet/fund/amc/{unique_id}
// then verified against https://api.sec.or.th/FundDailyInfo/{proj_id}/dailynav/{date}
const THAI_FUND_MAPPINGS: Record<string, ThaiNavMapping> = {
  'K-VIETNAM':       { projId: 'M0118_2561', classFilter: null },
  'K-ESGSI-THAIESG': { projId: 'M0095_2567', classFilter: 'K-ESGSI-ThaiESG' },
  'K-TNZ-THAIESG':   { projId: 'M0799_2566', classFilter: 'K-TNZ-ThaiESG' },
  'SCBCEH':          { projId: 'M0155_2556', classFilter: 'SCBCEH' },
  // Krungsri India Equity Fund — 3 classes (A/D/I) at different NAVs, so the
  // classFilter must pin the accumulating -A class. proj_id found 2026-08-11 via
  // GET /v2/fund/general-info/profiles?project_info=KFINDIA.
  'KFINDIA-A':       { projId: 'M0418_2560', classFilter: 'KFINDIA-A' },
}

// Migrated 2026-08-11 to the new SEC Open Data API. The old
// api.sec.or.th/FundDailyInfo/{projId}/dailynav/{date} path was RETIRED (it now
// returns HTTP 503 "migrate to secopendata.sec.or.th"). The new v2 endpoint
// takes proj_id + a date RANGE and returns the series in one call, so we fetch
// each fund with a single request instead of looping day-by-day (up to 10x).
// Spec: https://github.com/Sitthinut/sec-open-data-api-spec (fund product group).
// Base host + Ocp-Apim-Subscription-Key header are unchanged; only path + shape.
const SEC_API_BASE = process.env.SEC_NAV_BASE ?? 'https://api.sec.or.th'
const NAV_ENDPOINT = '/v2/fund/daily-info/nav'
const LOOKBACK_DAYS = 14

interface NavItem {
  nav_date:        string
  fund_class_name: string
  last_val:        number
}
interface NavResponse { message?: string; items?: NavItem[] }

function apiKey(): string {
  return process.env.SEC_FUND_API_KEY ?? ''
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// Returns the latest NAV plus a hardFail flag (auth/5xx/rate/network) that the
// caller's circuit-breaker uses to stop hammering a dead endpoint.
async function fetchLatestNav(
  projId: string,
  classFilter: string | null,
): Promise<{ result: { nav: number; date: string } | null; hardFail: boolean }> {
  const today = new Date()
  const end   = today.toISOString().slice(0, 10)
  const start = new Date(today.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10)
  const url = `${SEC_API_BASE}${NAV_ENDPOINT}?proj_id=${encodeURIComponent(projId)}`
            + `&start_nav_date=${start}&end_nav_date=${end}&page_size=100`

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'Ocp-Apim-Subscription-Key': apiKey() },
        signal:  AbortSignal.timeout(8_000),
      })
      // 421 = gateway rate-limit — honour Retry-After once (per SEC guidance).
      if (res.status === 421 && attempt === 0) {
        const wait = Number(res.headers.get('Retry-After') ?? '1') * 1000
        await delay(Math.min(Number.isFinite(wait) ? wait : 1000, 5_000))
        continue
      }
      if (!res.ok) {
        console.warn(`[ThaiNAV] ${projId}: HTTP ${res.status}`)
        return { result: null, hardFail: res.status >= 500 || res.status === 429 || res.status === 401 }
      }
      const body  = await res.json() as NavResponse
      const items = (body.items ?? []).filter(i => i.last_val > 0)
      if (items.length === 0) return { result: null, hardFail: false }
      // Prefer the requested share class; fall back to all classes. Then take
      // the most recent nav_date in the window.
      const matched = classFilter
        ? items.filter(i => i.fund_class_name?.toLowerCase() === classFilter.toLowerCase())
        : []
      const pool   = matched.length ? matched : items
      const latest = pool.reduce((a, b) => (b.nav_date > a.nav_date ? b : a))
      return { result: { nav: latest.last_val, date: latest.nav_date }, hardFail: false }
    } catch (err) {
      console.warn(`[ThaiNAV] Fetch error for ${projId}: ${(err as Error).message}`)
      return { result: null, hardFail: true }
    }
  }
  return { result: null, hardFail: false }
}

/**
 * Fetches the most recent NAV (in THB) for each Thai mutual fund ticker.
 * Pass a list of tickers to limit fetches; omit to fetch all known funds.
 * Returns a Record<ticker, navPrice> for tickers that successfully resolved.
 */
export async function fetchThaiNavs(
  tickers?: string[],
): Promise<Record<string, number>> {
  const toFetch = tickers
    ? tickers.filter(t => t in THAI_FUND_MAPPINGS)
    : Object.keys(THAI_FUND_MAPPINGS)

  const results: Record<string, number> = {}
  if (!apiKey()) {
    console.warn('[ThaiNAV] SEC_FUND_API_KEY not set — skipping Thai fund NAVs')
    return results
  }

  let consecutiveHardFails = 0
  for (const ticker of toFetch) {
    // Circuit-breaker: if the API is clearly down (auth/5xx/rate/network),
    // stop hammering it so the refresh degrades gracefully instead of blowing
    // the caller's timeout on a dead endpoint (the 2026-08 "Command failed" bug).
    if (consecutiveHardFails >= 3) {
      console.warn('[ThaiNAV] SEC API unavailable — skipping remaining fund NAVs this run')
      break
    }
    const mapping = THAI_FUND_MAPPINGS[ticker]
    const { result, hardFail } = await fetchLatestNav(mapping.projId, mapping.classFilter)
    if (result) {
      results[ticker] = result.nav
      consecutiveHardFails = 0
      console.log(`[ThaiNAV] ${ticker}: ฿${result.nav.toFixed(4)} (${result.date})`)
    } else {
      if (hardFail) consecutiveHardFails++
      console.warn(`[ThaiNAV] Could not fetch NAV for ${ticker} (proj_id=${mapping.projId})`)
    }
    await delay(60)  // throttle between requests (SEC guidance: ≥16ms)
  }
  return results
}

/** Returns the set of tickers for which a SEC NAV mapping is known. */
export function knownThaiNavTickers(): string[] {
  return Object.keys(THAI_FUND_MAPPINGS)
}
