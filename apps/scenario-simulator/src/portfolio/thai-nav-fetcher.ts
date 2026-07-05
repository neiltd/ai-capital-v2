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
  // KFINDIA-A (Krungsri India Equity Fund-A) — proj_id not yet found in SEC API.
  // Add here once you find the proj_id (check your fund statement or Krungsri app).
  // Example: 'KFINDIA-A': { projId: 'M????_????', classFilter: 'KFINDIA-A' },
}

const SEC_NAV_BASE = 'https://api.sec.or.th/FundDailyInfo'

interface NavEntry {
  nav_date:        string
  class_abbr_name: string
  last_val:        number
}

function apiKey(): string {
  return process.env.SEC_FUND_API_KEY ?? 'cbb0bd1c5cef4e138336c8914bd08f56'
}

async function fetchNavForDate(projId: string, date: string): Promise<NavEntry[] | null> {
  const url = `${SEC_NAV_BASE}/${projId}/dailynav/${date}`
  try {
    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey() },
    })
    if (res.status === 204) return null
    if (!res.ok) {
      console.warn(`[ThaiNAV] ${projId} @ ${date}: HTTP ${res.status}`)
      return null
    }
    return await res.json() as NavEntry[]
  } catch (err) {
    console.warn(`[ThaiNAV] Fetch error for ${projId}: ${(err as Error).message}`)
    return null
  }
}

async function fetchLatestNav(projId: string, classFilter: string | null): Promise<{ nav: number; date: string } | null> {
  const today = new Date()
  for (let daysBack = 1; daysBack <= 10; daysBack++) {
    const d = new Date(today)
    d.setDate(today.getDate() - daysBack)
    const dateStr = d.toISOString().slice(0, 10)
    const entries = await fetchNavForDate(projId, dateStr)
    if (!entries || entries.length === 0) continue
    const entry = classFilter
      ? (entries.find(e => e.class_abbr_name === classFilter) ?? entries[0])
      : entries[0]
    if (entry?.last_val > 0) return { nav: entry.last_val, date: dateStr }
  }
  return null
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
  for (const ticker of toFetch) {
    const mapping = THAI_FUND_MAPPINGS[ticker]
    const result  = await fetchLatestNav(mapping.projId, mapping.classFilter)
    if (result) {
      results[ticker] = result.nav
      console.log(`[ThaiNAV] ${ticker}: ฿${result.nav.toFixed(4)} (${result.date})`)
    } else {
      console.warn(`[ThaiNAV] Could not fetch NAV for ${ticker} (proj_id=${mapping.projId})`)
    }
  }
  return results
}

/** Returns the set of tickers for which a SEC NAV mapping is known. */
export function knownThaiNavTickers(): string[] {
  return Object.keys(THAI_FUND_MAPPINGS)
}
