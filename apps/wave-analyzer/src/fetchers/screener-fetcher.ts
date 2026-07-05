export async function fetchMostActiveScreener(count: number): Promise<string[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=most_actives&count=${count}&start=0`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) {
      console.warn(`[screener] HTTP ${res.status}`)
      return []
    }
    const data = await res.json() as {
      finance: { result: Array<{ quotes: Array<{ symbol: string }> }> | null }
    }
    return (data.finance.result?.[0]?.quotes ?? []).map(q => q.symbol)
  } catch (err) {
    console.warn('[screener] fetch error', err)
    return []
  }
}
