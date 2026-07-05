import type { WatchlistAward, AgencyFlow } from '../types.js'

const USA_SPENDING = 'https://api.usaspending.gov/api/v2'

const FALLBACK_COMPANIES = [
  { ticker: 'MSFT', searchName: 'MICROSOFT' },
  { ticker: 'NVDA', searchName: 'NVIDIA' },
  { ticker: 'GOOGL', searchName: 'GOOGLE' },
  { ticker: 'AMZN', searchName: 'AMAZON' },
  { ticker: 'META', searchName: 'META PLATFORMS' },
  { ticker: 'AAPL', searchName: 'APPLE' },
  { ticker: 'PLTR', searchName: 'PALANTIR' },
  { ticker: 'JPM', searchName: 'JPMORGAN' },
  { ticker: 'BAC', searchName: 'BANK OF AMERICA' },
  { ticker: 'GS', searchName: 'GOLDMAN SACHS' },
]

function dateRange(daysAgo: number): { start: string; end: string } {
  const end = new Date()
  const start = new Date(end.getTime() - daysAgo * 86_400_000)
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  }
}

export type AwardRow = { ticker: string; company: string; description: string; amount: number; agency: string }

export function normalizeAwards(rows: AwardRow[]): WatchlistAward[] {
  const map = new Map<string, WatchlistAward>()
  for (const row of rows) {
    const existing = map.get(row.ticker)
    const contract = row.description.slice(0, 120)
    if (existing) {
      existing.total30d += row.amount
      existing.awardCount += 1
      if (!existing.contracts.includes(contract) && existing.contracts.length < 3) {
        existing.contracts.push(contract)
      }
    } else {
      map.set(row.ticker, {
        ticker: row.ticker,
        company: row.company,
        total30d: row.amount,
        awardCount: 1,
        topAgency: row.agency,
        contracts: [contract],
      })
    }
  }
  return Array.from(map.values())
}

export function computeAwardTrend(current: number, prior: number): 'rising' | 'stable' | 'falling' {
  if (prior === 0) return 'stable'
  if (current >= prior * 1.1) return 'rising'
  if (current <= prior * 0.9) return 'falling'
  return 'stable'
}

async function searchAwardDetail(
  searchName: string,
  startDate: string,
  endDate: string,
  ticker: string,
  company: string
): Promise<AwardRow[]> {
  const body = {
    filters: {
      time_period: [{ start_date: startDate, end_date: endDate }],
      recipient_search_text: [searchName],
      award_type_codes: ['A', 'B', 'C', 'D'],
    },
    fields: ['Award Amount', 'Description', 'Awarding Agency'],
    limit: 5,
    page: 1,
    sort: 'Award Amount',
    order: 'desc',
    subawards: false,
  }
  try {
    const res = await fetch(`${USA_SPENDING}/search/spending_by_award/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return []
    const data = (await res.json()) as any
    return (data.results ?? []).map((r: any) => ({
      ticker,
      company,
      description: (r['Description'] ?? '').slice(0, 120),
      amount: r['Award Amount'] ?? 0,
      agency: r['Awarding Agency'] ?? 'Unknown',
    }))
  } catch {
    return []
  }
}

export async function fetchWatchlistAwards(): Promise<WatchlistAward[]> {
  const { start, end } = dateRange(30)
  const rows: AwardRow[] = []
  for (const { ticker, searchName } of FALLBACK_COMPANIES) {
    try {
      const details = await searchAwardDetail(searchName, start, end, ticker, searchName)
      rows.push(...details)
    } catch {
      /* skip */
    }
  }
  return normalizeAwards(rows)
}

export async function fetchAgencyFlows(): Promise<AgencyFlow[]> {
  const current = dateRange(30)
  const prior30End = new Date(new Date().getTime() - 30 * 86_400_000)
  const prior30Start = new Date(prior30End.getTime() - 30 * 86_400_000)
  const prior = {
    start: prior30Start.toISOString().slice(0, 10),
    end: prior30End.toISOString().slice(0, 10),
  }

  async function getTopAgencies(startDate: string, endDate: string) {
    try {
      const body = {
        category: 'awarding_agency',
        filters: {
          time_period: [{ start_date: startDate, end_date: endDate }],
          award_type_codes: ['A', 'B', 'C', 'D'],
        },
        limit: 10,
        page: 1,
      }
      const res = await fetch(`${USA_SPENDING}/search/spending_by_category/awarding_agency/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) return []
      const data = (await res.json()) as any
      return (data.results ?? []) as Array<{ name: string; id: string; amount: number }>
    } catch {
      return []
    }
  }

  const [currentResults, priorResults] = await Promise.all([
    getTopAgencies(current.start, current.end),
    getTopAgencies(prior.start, prior.end),
  ])

  const priorMap = new Map(priorResults.map(r => [r.id, r.amount]))

  return currentResults.slice(0, 8).map(r => ({
    agency: r.name,
    agencyId: String(r.id),
    total30d: r.amount,
    trend: computeAwardTrend(r.amount, priorMap.get(r.id) ?? 0),
  }))
}
