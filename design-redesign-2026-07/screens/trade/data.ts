// Loader contract for /markets/waves/trade — the paper agent that acts ONLY
// on wave signals (wave-analyzer trades.db via `npm run trade`).
//
// Transparency principle (same as Discovery sizing): every position answers
// two questions inline —
//   WHY THIS STOCK: the exact wave signal that triggered it (wave, direction,
//     confidence, signal date, invalidation level, narrative).
//   WHY THIS SIZE:  fixed-fractional risk sizing —
//     riskBudget = TRADE_BUDGET × RISK_PER_TRADE  (2% of $5,000 = $100)
//     shares     = floor(riskBudget / |entry − stop|)
//     so a stop-out always costs ≈ 1R regardless of the name's price.
//
// HONESTY NOTE / GAP #21b: cli-trade.ts takes --shares manually today; the
// risk rule above is the PROPOSED sizing policy this screen renders (and
// back-computes for existing rows: risked $ = shares × |entry − stop|). The
// CLI should adopt it so the displayed rationale and the write path agree.

export interface TradeTrigger {
  wave: string
  direction: 'up' | 'down'
  confidence: number
  signal: 'buy' | 'sell'
  signalDate: string
  narrative: string
}

export interface TradeSizing {
  tradeBudgetUsd: number
  riskPerTradePct: number
  riskBudgetUsd: number
  perShareRiskUsd: number // |entry − stop|
  shares: number
  notionalUsd: number
  /** shares × perShareRisk — should equal ≈ riskBudget if the rule was followed. */
  actualRiskUsd: number
}

export interface TradePositionVM {
  id: string
  ticker: string
  label: string
  direction: 'long' | 'short'
  entryPrice: number
  stopLoss: number
  target: number
  shares: number
  openedAt: string
  currentPrice: number
  status: 'open' | 'closed' | 'stopped'
  closedAt?: string
  closePrice?: number
  pnl?: number
  outcome?: 'hit' | 'stopped' | 'closed-manual'
  trigger: TradeTrigger
  sizing: TradeSizing
}

export interface TradeViewModel {
  exportedAt: string
  config: { tradeBudgetUsd: number; riskPerTradePct: number; maxConcurrent: number }
  open: TradePositionVM[]
  closed: TradePositionVM[]
  /** Realized P&L by month for the "does this layer pay?" audit panel. */
  monthly: Array<{ month: string; pnlUsd: number; trades: number; hits: number }>
}

const CONFIG = { tradeBudgetUsd: 5000, riskPerTradePct: 0.02, maxConcurrent: 5 }

function sizing(entry: number, stop: number, shares: number): TradeSizing {
  const perShareRiskUsd = Math.abs(entry - stop)
  const riskBudgetUsd = CONFIG.tradeBudgetUsd * CONFIG.riskPerTradePct
  return {
    tradeBudgetUsd: CONFIG.tradeBudgetUsd,
    riskPerTradePct: CONFIG.riskPerTradePct,
    riskBudgetUsd,
    perShareRiskUsd,
    shares,
    notionalUsd: entry * shares,
    actualRiskUsd: perShareRiskUsd * shares,
  }
}

export async function loadTrade(): Promise<TradeViewModel> {
  return {
    exportedAt: '2026-07-06T17:05:43.402Z',
    config: CONFIG,
    open: [
      {
        id: 't-vz-1', ticker: 'VZ', label: 'Verizon', direction: 'long',
        entryPrice: 43.1, stopLoss: 41.2, target: 47.8, shares: 52,
        openedAt: '2026-06-30', currentPrice: 43.31, status: 'open',
        trigger: {
          wave: '5', direction: 'up', confidence: 80, signal: 'buy', signalDate: '2026-06-30',
          narrative: 'Wave 5 advance from the $41.20 wave-4 low, impulsive with volume confirmation; close below $41.20 invalidates.',
        },
        sizing: sizing(43.1, 41.2, 52), // $100 ÷ $1.90 = 52.6 → 52 shares
      },
      {
        id: 't-amzn-1', ticker: 'AMZN', label: 'Amazon', direction: 'short',
        entryPrice: 246.1, stopLoss: 256.9, target: 224.4, shares: 9,
        openedAt: '2026-07-01', currentPrice: 242.67, status: 'open',
        trigger: {
          wave: '5', direction: 'down', confidence: 80, signal: 'sell', signalDate: '2026-07-01',
          narrative: 'Five-wave decline maturing; measured move targets $224.40, invalidation above the $256.90 wave-4 high.',
        },
        sizing: sizing(246.1, 256.9, 9), // $100 ÷ $10.80 = 9.26 → 9 shares
      },
      {
        id: 't-t-1', ticker: 'T', label: 'AT&T', direction: 'short',
        entryPrice: 29.1, stopLoss: 30.25, target: 26.6, shares: 86,
        openedAt: '2026-07-02', currentPrice: 29.06, status: 'open',
        trigger: {
          wave: '5', direction: 'down', confidence: 70, signal: 'sell', signalDate: '2026-07-02',
          narrative: 'Mature five-wave decline; entered on corrective strength toward the zone top, invalidated above $30.25.',
        },
        sizing: sizing(29.1, 30.25, 86), // $100 ÷ $1.15 = 86.9 → 86 shares
      },
    ],
    closed: [
      {
        id: 't-meta-1', ticker: 'META', label: 'Meta Platforms', direction: 'short',
        entryPrice: 748.0, stopLoss: 772.0, target: 700.0, shares: 4,
        openedAt: '2026-06-18', currentPrice: 719.4, status: 'closed',
        closedAt: '2026-06-27', closePrice: 701.2, pnl: 187.2, outcome: 'hit',
        trigger: {
          wave: '5', direction: 'down', confidence: 60, signal: 'sell', signalDate: '2026-06-18',
          narrative: 'Wave 5 down from the $801 wave-3 extreme.',
        },
        sizing: sizing(748.0, 772.0, 4), // $100 ÷ $24 = 4.2 → 4 shares
      },
      {
        id: 't-sofi-1', ticker: 'SOFI', label: 'SoFi Technologies', direction: 'short',
        entryPrice: 26.4, stopLoss: 28.1, target: 23.2, shares: 58,
        openedAt: '2026-06-12', currentPrice: 24.1, status: 'closed',
        closedAt: '2026-06-24', closePrice: 23.35, pnl: 176.9, outcome: 'hit',
        trigger: {
          wave: '3', direction: 'down', confidence: 65, signal: 'sell', signalDate: '2026-06-12',
          narrative: 'Wave 3 breakdown with expanding range.',
        },
        sizing: sizing(26.4, 28.1, 58), // $100 ÷ $1.70 = 58.8 → 58 shares
      },
      {
        id: 't-intc-1', ticker: 'INTC', label: 'Intel', direction: 'long',
        entryPrice: 44.8, stopLoss: 43.6, target: 48.9, shares: 83,
        openedAt: '2026-06-10', currentPrice: 37.2, status: 'stopped',
        closedAt: '2026-06-16', closePrice: 43.6, pnl: -99.6, outcome: 'stopped',
        trigger: {
          wave: '3', direction: 'up', confidence: 55, signal: 'buy', signalDate: '2026-06-10',
          narrative: 'Provisional wave-3 advance — invalidated at the wave-2 low six sessions later.',
        },
        sizing: sizing(44.8, 43.6, 83), // stop-out cost −$99.60 ≈ exactly 1R by construction
      },
      {
        id: 't-gcf-1', ticker: 'GC=F', label: 'Gold', direction: 'short',
        entryPrice: 4510.0, stopLoss: 4592.0, target: 4290.0, shares: 0.9,
        openedAt: '2026-06-20', currentPrice: 4293.0, status: 'closed',
        closedAt: '2026-07-03', closePrice: 4529.0, pnl: -17.1, outcome: 'closed-manual',
        trigger: {
          wave: '5', direction: 'down', confidence: 50, signal: 'sell', signalDate: '2026-06-20',
          narrative: 'Wave 5 decline in gold — closed manually when the briefing added the disruption-hedge conflict (holding GOLD_OZ long while short GC=F was a net-zero trade paying two spreads).',
        },
        sizing: sizing(4510.0, 4592.0, 0.9),
      },
    ],
    monthly: [
      { month: '2026-05', pnlUsd: -38, trades: 2, hits: 1 },
      { month: '2026-06', pnlUsd: 264.5, trades: 3, hits: 2 },
      { month: '2026-07', pnlUsd: -17.1, trades: 1, hits: 0 },
    ],
  }
}
