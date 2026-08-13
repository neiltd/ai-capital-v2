import type { ThaiContractorFlow } from '../types.js'
import { THAI_GOV_WATCHLIST } from './watchlist.js'

// ACT Ai's open procurement API (the backend behind procurement.actai.co).
// No auth. Querying `company/search?keyword=<regId>` by registration number
// returns an exact match with all-time totals; querying by name is fuzzy.
const ACT_AI_BASE = process.env.ACT_AI_BASE ?? 'https://admin-procurement.actai.co'

interface CompanySearchHit {
  companyId:         string
  companyName:       string
  totalProject:      number
  totalContractMoney: number
  hasCorruptionRisk: boolean
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function fetchContractor(entry: { ticker: string; regId: string }): Promise<ThaiContractorFlow | null> {
  const url = `${ACT_AI_BASE}/company/search?keyword=${encodeURIComponent(entry.regId)}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      console.warn(`[thai-govflow] ${entry.ticker}: HTTP ${res.status}`)
      return null
    }
    const body = await res.json() as { searchResult?: CompanySearchHit[] }
    const hits = body.searchResult ?? []
    // Registration-number search should return the exact entity; guard anyway.
    const hit = hits.find(h => h.companyId === entry.regId) ?? hits[0]
    if (!hit) {
      console.warn(`[thai-govflow] ${entry.ticker}: no match for regId ${entry.regId}`)
      return null
    }
    return {
      ticker:            entry.ticker,
      companyId:         hit.companyId,
      companyName:       hit.companyName,
      totalProjects:     hit.totalProject,
      totalContractTHB:  hit.totalContractMoney,
      hasCorruptionRisk: hit.hasCorruptionRisk,
    }
  } catch (err) {
    console.warn(`[thai-govflow] ${entry.ticker}: fetch error — ${(err as Error).message}`)
    return null
  }
}

/**
 * Fetches all-time Thai government procurement totals for the SET-listed
 * construction/infra watchlist, sorted by contract value (biggest state-money
 * recipient first). Individual failures are skipped; the run only surfaces
 * the contractors that resolved.
 */
export async function fetchThaiGovFlow(): Promise<ThaiContractorFlow[]> {
  const out: ThaiContractorFlow[] = []
  for (const entry of THAI_GOV_WATCHLIST) {
    const r = await fetchContractor(entry)
    if (r) {
      out.push(r)
      console.log(`[thai-govflow] ${r.ticker.padEnd(6)}: ฿${(r.totalContractTHB / 1e9).toFixed(2)}bn, ${r.totalProjects} proj, risk=${r.hasCorruptionRisk}`)
    }
    await delay(300)  // be polite to a public civic API
  }
  out.sort((a, b) => b.totalContractTHB - a.totalContractTHB)
  return out
}
