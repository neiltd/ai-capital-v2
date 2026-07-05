// LINE Messaging API — push message to the configured user.
// Requires LINE_CHANNEL_ACCESS_TOKEN and LINE_USER_ID in environment.

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push'

function token(): string | undefined  { return process.env.LINE_CHANNEL_ACCESS_TOKEN }
function userId(): string | undefined { return process.env.LINE_USER_ID }

export async function sendLine(text: string): Promise<void> {
  const tok = token()
  const uid = userId()
  if (!tok || !uid) {
    console.warn('[LINE] Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_USER_ID — skipping notification')
    return
  }

  try {
    const res = await fetch(LINE_PUSH_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${tok}`,
      },
      body: JSON.stringify({
        to:       uid,
        messages: [{ type: 'text', text }],
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      console.warn(`[LINE] Push failed: ${res.status} ${body}`)
    }
  } catch (err) {
    console.warn(`[LINE] Push error: ${(err as Error).message}`)
  }
}

const ACTION_EMOJI: Record<string, string> = {
  buy:  '🟢',
  hold: '🔵',
  trim: '🟡',
  exit: '🔴',
}

export function formatTradeSignals(opts: {
  date:    string
  actions: Array<{
    ticker:              string
    action:              string
    conviction:          string
    allocationChangePct: number
    rationale:           string
  }>
}): string {
  const { date, actions } = opts
  const actionable = actions.filter(a => a.action !== 'hold')
  if (actionable.length === 0) return ''

  const lines = [
    `📊 Trade Signals — ${date}`,
    ``,
    ...actionable.map(a => {
      const emoji  = ACTION_EMOJI[a.action] ?? '⚪'
      const change = a.allocationChangePct > 0 ? `+${a.allocationChangePct}%` : `${a.allocationChangePct}%`
      const short  = a.rationale.length > 120 ? a.rationale.slice(0, 117) + '...' : a.rationale
      return [
        `${emoji} ${a.action.toUpperCase()} ${a.ticker} (${a.conviction.toUpperCase()}) ${change}`,
        `   ${short}`,
      ].join('\n')
    }),
  ]
  return lines.join('\n')
}

export function formatDiscoveryBuy(opts: {
  ticker:     string
  company:    string
  score:      number
  conviction: string
  price:      number
  shares:     number
  rationale:  string
}): string {
  const { ticker, company, score, conviction, price, shares, rationale } = opts
  const value = (price * shares).toFixed(2)
  const short  = rationale.length > 200 ? rationale.slice(0, 197) + '...' : rationale
  return [
    `🟢 Discovery BUY — ${ticker}`,
    `${company}`,
    ``,
    `Score: ${score}/100  |  Conviction: ${conviction.toUpperCase()}`,
    `Price: $${price.toFixed(2)}  |  Shares: ${shares}  |  Value: $${value}`,
    ``,
    short,
  ].join('\n')
}
