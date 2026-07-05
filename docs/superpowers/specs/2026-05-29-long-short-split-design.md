# Long-term Invest / Short-term Trade Split Design

## Goal

Add a short-term trading layer on top of the existing Elliott Wave analysis. The wave-analyzer gains an action-generator that computes trade plans (entry, stop, target) from wave pivot math and uses Claude Haiku to write a narrative explanation. Plans surface in two places: inline on the unified-platform wave detail page and in a new `/trade` page in the capital-intel-dashboard. The long-term invest system (thesis-memory → scenario-simulator → portfolio) is untouched.

## Two Modes

| | Invest | Trade |
|---|---|---|
| Time horizon | Months to years | Days to weeks |
| Signal source | Fundamentals + thesis | Elliott Wave + Fibonacci |
| Entry trigger | AI-proposed portfolio action | Wave 3/5 in progress, confidence ≥ 50 |
| Portfolio | Existing `/portfolio` in dashboard | New `/trade` in dashboard |
| AI model | Claude Sonnet 4.6 (thesis, scenarios) | Claude Haiku (narrative only) |

## Architecture

Three existing projects gain new files. No new projects.

```
wave-analyzer/
  src/
    actions/
      action-generator.ts    NEW — computes trade plans from waves.json
    portfolio/
      trade-portfolio.ts     NEW — SQLite for open/closed trades
    cli/
      cli-trade.ts           NEW — npm run trade -- open/close/list
    exporter.ts              MODIFY — also call action-generator, write wave-actions.json + wave-portfolio.json
  data/
    wave-actions.json        NEW (gitignored)
    wave-portfolio.json      NEW (gitignored)
    trades.db                NEW (gitignored)

unified-platform/
  src/
    lib/data.ts              MODIFY — add readWaveActions()
    components/capital/
      TradePlanCard.tsx      NEW — entry/stop/target/narrative card
    app/capital/waves/[ticker]/page.tsx  MODIFY — show TradePlanCard below fib table

capital-intel-dashboard/
  src/
    lib/data.ts              MODIFY — add readWaveActions(), readWavePortfolio()
    app/trade/
      page.tsx               NEW — signals table + open positions + closed P&L
    components/
      TradeSignalRow.tsx     NEW — one row in the signals table
      TradePositionRow.tsx   NEW — one row in the positions table
    components/Sidebar.tsx   MODIFY — add "Trade" nav item
```

## Types — `wave-analyzer/src/types.ts` additions

```typescript
export type TradeSignal = 'buy' | 'sell' | 'watch' | 'no-signal'

export interface TradeAction {
  ticker:        string
  label:         string
  currentWave:   string | null
  waveDirection: 'up' | 'down' | null
  confidence:    number
  signal:        TradeSignal
  entryZone:     { low: number; high: number } | null
  stopLoss:      number | null
  target:        number | null
  riskReward:    number | null               // (target - entry_mid) / (entry_mid - stop)
  narrative:     string                      // Claude Haiku output
  narrativeKey:  string                      // cache key: ticker+currentWave+confidence
  generatedAt:   string
}

export interface WaveActionsJSON {
  exportedAt: string
  asOf:       string
  actions:    TradeAction[]
}

export interface TradePosition {
  id:          string
  ticker:      string
  signal:      'buy' | 'sell'
  entryPrice:  number
  stopLoss:    number
  target:      number
  shares:      number
  openedAt:    string
  closedAt:    string | null
  closePrice:  number | null
  pnl:         number | null
  status:      'open' | 'closed' | 'stopped'
}

export interface WavePortfolioJSON {
  exportedAt:      string
  openPositions:   TradePosition[]
  closedPositions: TradePosition[]
  totalPnl:        number
}
```

## action-generator.ts

### Signal rules (deterministic, no AI)

Only assets with `confidence >= 50` and a known `currentWave` get a signal.

**Bullish impulse (waveDirection === 'up'):**

| Current Wave | Signal | Entry Zone | Stop Loss | Target |
|---|---|---|---|---|
| `3` | `buy` | close ± 2% | Wave 2 pivot low | Wave 2 low + (Wave 1 height × 1.618) |
| `5` | `buy` | close ± 2% | Wave 4 pivot low | Wave 4 low + (Wave 0→1 height × 1.618) |
| `2` or `4` | `watch` | null | null | null |
| `A`, `B`, `C` | `watch` | null | null | null |

**Bearish impulse (waveDirection === 'down'):**

| Current Wave | Signal | Entry Zone | Stop Loss | Target |
|---|---|---|---|---|
| `3` | `sell` | close ± 2% | Wave 2 pivot high | Wave 2 high − (Wave 1 height × 1.618) |
| `5` | `sell` | close ± 2% | Wave 4 pivot high | Wave 4 high − (Wave 0→1 height × 1.618) |
| `2` or `4` | `watch` | null | null | null |

**No signal:** confidence < 50, or currentWave is null, or pivot data insufficient to compute stop/target.

`riskReward` = `(target − entryMid) / (entryMid − stopLoss)` where `entryMid = (low + high) / 2`.
Only set when stop and target are both non-null and the ratio > 0.

Pivot lookup: use `asset.wavePivots` array. Wave 2 low = the pivot labeled `'2'`, Wave 4 low = pivot labeled `'4'`, etc.

### Narrative generation (Claude Haiku)

```typescript
async function generateNarrative(asset: WaveAsset, action: Omit<TradeAction, 'narrative'>): Promise<string>
```

Prompt:
```
You are a technical analyst. Write a 3-sentence trade rationale for this Elliott Wave setup.
Focus on: (1) what wave structure is forming, (2) why the entry zone makes sense,
(3) what invalidates the trade. Be specific with price levels. No fluff.

Ticker: {ticker}
Current wave: {currentWave} ({waveDirection})
Entry zone: ${entryZone.low} – ${entryZone.high}
Stop loss: ${stopLoss} ({why: e.g. "Wave 2 low"})
Target: ${target} ({why: e.g. "1.618× Wave 1"})
R:R: {riskReward}x
Confidence: {confidence}%
Wave pivots: {wavePivots mapped to "Label: $price (date)"}
```

Model: `claude-haiku-4-5-20251001`, max_tokens: 300.

**Caching:** narratives are cached in `data/narrative-cache.json` keyed by `narrativeKey = "${ticker}:${currentWave}:${Math.round(confidence/5)*5}"` (confidence rounded to nearest 5). Only regenerates when the key changes (i.e., wave label flips or confidence crosses a 5-point boundary). This prevents daily re-spend on stable structures.

```typescript
export async function generateActions(assets: WaveAsset[]): Promise<TradeAction[]>
// 1. Filter: confidence >= 50 and currentWave != null
// 2. Compute signal + prices deterministically
// 3. For each action with signal != 'no-signal': check cache, generate narrative if miss
// 4. Return all actions (including 'watch' and 'no-signal' — UI filters as needed)
```

## trade-portfolio.ts

SQLite at `data/trades.db`. Single table:

```sql
CREATE TABLE trades (
  id          TEXT PRIMARY KEY,
  ticker      TEXT NOT NULL,
  signal      TEXT NOT NULL,     -- 'buy' | 'sell'
  entry_price REAL NOT NULL,
  stop_loss   REAL NOT NULL,
  target      REAL NOT NULL,
  shares      REAL NOT NULL,
  opened_at   TEXT NOT NULL,
  closed_at   TEXT,
  close_price REAL,
  pnl         REAL,
  status      TEXT NOT NULL DEFAULT 'open'
)
```

```typescript
export function openTrade(t: Omit<TradePosition, 'id' | 'closedAt' | 'closePrice' | 'pnl' | 'status'>): TradePosition
export function closeTrade(id: string, closePrice: number): TradePosition
export function getOpenPositions(): TradePosition[]
export function getClosedPositions(limit?: number): TradePosition[]  // default 20
```

## cli-trade.ts

```
npm run trade -- open --ticker=NVDA --entry=1100 --stop=980 --target=1380 --shares=10
npm run trade -- close --id=<id> --price=1350
npm run trade -- list
```

`open` creates a new position. `close` marks it closed, computes P&L = `(closePrice − entryPrice) × shares` for buy, reversed for sell. `list` prints open positions with current unrealized P&L (requires current price from waves.json).

## exporter.ts modifications

```typescript
// After buildWaveAssets(), also:
import { generateActions } from './actions/action-generator.js'
import { getOpenPositions, getClosedPositions } from './portfolio/trade-portfolio.js'

const actions   = await generateActions(assets)
const waveActionsJson: WaveActionsJSON = { exportedAt, asOf, actions }
writeFileSync(actionsOutputPath, JSON.stringify(waveActionsJson, null, 2))

const openPositions   = getOpenPositions()
const closedPositions = getClosedPositions(50)
const totalPnl = closedPositions.reduce((s, p) => s + (p.pnl ?? 0), 0)
const wavePortfolioJson: WavePortfolioJSON = { exportedAt, openPositions, closedPositions, totalPnl }
writeFileSync(portfolioOutputPath, JSON.stringify(wavePortfolioJson, null, 2))
```

Output paths:
- `wave-actions.json` → `data/wave-actions.json`
- `wave-portfolio.json` → `data/wave-portfolio.json`

## unified-platform changes

**`src/lib/data.ts` — add:**
```typescript
export function readWaveActions(): WaveActionsJSON | null {
  try {
    return JSON.parse(readFileSync(join(DATA_ROOT, 'wave-analyzer/data/wave-actions.json'), 'utf-8'))
  } catch { return null }
}
```

**`src/components/capital/TradePlanCard.tsx`** — new server component:
```tsx
import type { TradeAction } from '@/types'

export function TradePlanCard({ action }: { action: TradeAction }) {
  if (action.signal === 'no-signal') return null

  const signalColor = action.signal === 'buy' ? 'text-green-signal' : action.signal === 'sell' ? 'text-red-signal' : 'text-amber-signal'
  const USD = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

  return (
    <div className="mt-5">
      <h2 className="text-[11px] font-semibold text-[#8a8f98] uppercase tracking-wider mb-2">Trade Plan</h2>
      <div className="bg-[#111318] border border-[#23252a] rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[11px] font-semibold uppercase tracking-wide rounded px-2 py-0.5 ${signalColor}`}
            style={{ background: 'currentColor' + '22' }}>
            {action.signal}
          </span>
          {action.riskReward && (
            <span className="text-[11px] text-amber-signal bg-amber-signal/10 rounded px-2 py-0.5">
              R:R {action.riskReward.toFixed(1)}×
            </span>
          )}
        </div>

        {action.signal !== 'watch' && action.entryZone && (
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-green-signal/5 border border-green-signal/20 rounded p-2">
              <div className="text-[10px] text-text-inactive uppercase">Entry Zone</div>
              <div className="text-xs font-semibold text-green-signal mt-0.5">
                {USD(action.entryZone.low)} – {USD(action.entryZone.high)}
              </div>
            </div>
            <div className="bg-red-signal/5 border border-red-signal/20 rounded p-2">
              <div className="text-[10px] text-text-inactive uppercase">Stop Loss</div>
              <div className="text-xs font-semibold text-red-signal mt-0.5">{action.stopLoss ? USD(action.stopLoss) : '—'}</div>
            </div>
            <div className="bg-accent-primary/5 border border-accent-primary/20 rounded p-2">
              <div className="text-[10px] text-text-inactive uppercase">Target</div>
              <div className="text-xs font-semibold text-accent-primary mt-0.5">{action.target ? USD(action.target) : '—'}</div>
            </div>
          </div>
        )}

        <p className="text-xs text-text-secondary leading-relaxed">{action.narrative}</p>
      </div>
    </div>
  )
}
```

**`app/capital/waves/[ticker]/page.tsx`** — add after fib table:
```tsx
import { readWaveActions } from '@/lib/data'
import { TradePlanCard } from '@/components/capital/TradePlanCard'

// In component body, after readWaves():
const waveActions = readWaveActions()
const tradeAction = waveActions?.actions.find(a => a.ticker === ticker) ?? null

// In JSX, after fib checks section:
{tradeAction && <TradePlanCard action={tradeAction} />}
```

## capital-intel-dashboard changes

**`src/lib/data.ts`** — add `readWaveActions()` and `readWavePortfolio()` reading from `../wave-analyzer/data/`.

**`src/app/trade/page.tsx`** — new page:
```tsx
export const dynamic = 'force-dynamic'

// Reads waveActions + wavePortfolio
// Shows:
//   - 3 stat cards: active signals, open positions, closed P&L
//   - Signals table: sorted by confidence desc, then riskReward desc
//     Columns: Ticker, Signal, Wave, Confidence, R:R, Entry Zone, Stop, Target
//     Filter: signal !== 'no-signal'
//   - Open positions table: Ticker, Entry, Stop, Target, Shares, Unrealized P&L
//   - Closed trades table (last 20): Ticker, Entry, Close, P&L
```

**`src/components/Sidebar.tsx`** — add `{ href: '/trade', label: 'Trade' }` to nav items, between Portfolio and Discovery.

## Cost

| Item | Cost |
|------|------|
| Claude Haiku narratives (~15 signals/day, cached — only regenerates on wave change) | ~$0.15/month |
| No new API keys needed | — |
| **Total addition** | **~$0.15/month** |

## Narrative cache invalidation

Wave structures typically hold for 3–14 days. The cache key `ticker:wave:rounded_confidence` means:
- A narrative is reused as long as the same wave label is active
- Regenerates the day NVDA flips from Wave 3 to Wave 4 (structure changed)
- Confidence rounding to nearest 5 prevents spurious regeneration from 72% → 73%
