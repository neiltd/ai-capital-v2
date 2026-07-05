const CONGRESS_BASE = 'https://api.congress.gov/v3'

const RELEVANT_KEYWORDS = [
  'appropriations', 'defense authorization', 'infrastructure',
  'artificial intelligence', 'chips', 'energy', 'semiconductor',
  'cybersecurity', 'national security',
]

export function isRelevantBill(title: string): boolean {
  const lower = title.toLowerCase()
  return RELEVANT_KEYWORDS.some(kw => lower.includes(kw))
}

export interface RawBill {
  number:   string
  title:    string
  url:      string
  status:   string
  date:     string
  congress: number
}

export async function fetchRecentBills(): Promise<RawBill[]> {
  const apiKey = process.env.CONGRESS_API_KEY
  if (!apiKey) {
    console.log('[govflow] CONGRESS_API_KEY not set — skipping budget signals')
    return []
  }

  const results: RawBill[] = []

  async function fetchBillType(billType: 'hr' | 's'): Promise<void> {
    try {
      const url = `${CONGRESS_BASE}/bill?congress=119&billType=${billType}&sort=updateDate+desc&limit=50&api_key=${apiKey}`
      const res = await fetch(url)
      if (!res.ok) return
      const data = await res.json() as any
      const bills = (data.bills ?? []) as Array<{
        number: string; title: string; url: string
        updateDateIncludingText: string; latestAction?: { text: string }
      }>
      for (const b of bills) {
        if (!isRelevantBill(b.title)) continue
        results.push({
          number: b.number,
          title: b.title,
          url: b.url,
          status: b.latestAction?.text ?? 'unknown',
          date: (b.updateDateIncludingText ?? '').slice(0, 10),
          congress: 119,
        })
      }
    } catch { /* skip */ }
  }

  await Promise.all([fetchBillType('hr'), fetchBillType('s')])

  return results
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10)
}
