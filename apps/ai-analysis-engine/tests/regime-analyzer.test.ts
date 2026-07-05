import { describe, it, expect, vi } from 'vitest'
import { analyzeRegime, formatLiquidity, formatGovFlow } from '../src/analysis/regime-analyzer.js'
import type { CompanyHealth } from '../src/types.js'
import type { LiquidityContext, GovFlowContext } from '../src/analysis/regime-analyzer.js'

const mockHealth: CompanyHealth[] = [{
  ticker: 'NVDA', company: 'NVIDIA',
  thesisSummary: 'NVIDIA dominates GPU market',
  assumptions: [{ text: 'GPU demand stays strong', status: 'stable' }],
  recentChunks: [],
  healthScore: 'positive',
}]

describe('analyzeRegime', () => {
  it('returns MacroRegime with correct shape from Claude tool response', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: 'tool_use',
            name: 'classify_macro_regime',
            input: {
              regime: 'AI Acceleration',
              confidence: 'high',
              rationale: 'GPU demand is strong across the board.',
              keyIndicators: ['NVDA revenue up 60%', 'CRWV expanding capacity'],
              affectedTickers: ['NVDA', 'TSM'],
            },
          }],
        }),
      },
    }

    const result = await analyzeRegime(mockHealth, { client: mockClient as any })

    expect(result.regime).toBe('AI Acceleration')
    expect(result.confidence).toBe('high')
    expect(result.rationale).toBe('GPU demand is strong across the board.')
    expect(result.keyIndicators).toHaveLength(2)
    expect(result.affectedTickers).toContain('NVDA')
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('throws when Claude does not return tool_use block', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'unexpected text response' }],
        }),
      },
    }

    await expect(analyzeRegime(mockHealth, { client: mockClient as any }))
      .rejects.toThrow('Expected tool_use response')
  })
})

const mockLiquidity: LiquidityContext = {
  asOf: '2026-05-29',
  indicators: [
    { seriesId: 'WALCL',     label: 'Fed Balance Sheet',        value: 7200,  unit: 'Billions USD', change4w: -85,  changeYoY: -2.1, signal: 'draining'  },
    { seriesId: 'WTREGEN',   label: 'Treasury General Account', value: 850,   unit: 'Billions USD', change4w: 120,  changeYoY: null, signal: 'draining'  },
    { seriesId: 'RRPONTSYD', label: 'Overnight Reverse Repo',   value: 400,   unit: 'Billions USD', change4w: -180, changeYoY: null, signal: 'injecting' },
    { seriesId: 'M2SL',      label: 'M2 Money Supply',          value: 21000, unit: 'Billions USD', change4w: null, changeYoY: 1.2,  signal: 'injecting' },
  ],
}

describe('formatLiquidity', () => {
  it('includes header with asOf date', () => {
    const result = formatLiquidity(mockLiquidity)
    expect(result).toContain('2026-05-29')
    expect(result).toContain('Global Liquidity Conditions')
  })

  it('shows DRAINING for draining signals', () => {
    expect(formatLiquidity(mockLiquidity)).toContain('DRAINING')
  })

  it('shows INJECTING for injecting signals', () => {
    expect(formatLiquidity(mockLiquidity)).toContain('INJECTING')
  })

  it('shows 4w change with sign for non-null change4w', () => {
    expect(formatLiquidity(mockLiquidity)).toContain('4w: -85.0B')
  })

  it('shows YoY for M2SL', () => {
    expect(formatLiquidity(mockLiquidity)).toContain('YoY: +1.20%')
  })

  it('shows Net: MIXED/NEUTRAL when 2 draining and 2 injecting', () => {
    expect(formatLiquidity(mockLiquidity)).toContain('Net: MIXED/NEUTRAL')
  })

  it('shows Net: TIGHTENING when majority draining', () => {
    const drainingCtx: LiquidityContext = {
      asOf: '2026-05-29',
      indicators: [
        { seriesId: 'WALCL',     label: 'Fed BS',  value: 7200,  unit: 'Billions USD', change4w: -85,  changeYoY: null, signal: 'draining' },
        { seriesId: 'WTREGEN',   label: 'TGA',     value: 850,   unit: 'Billions USD', change4w: 120,  changeYoY: null, signal: 'draining' },
        { seriesId: 'RRPONTSYD', label: 'RRP',     value: 400,   unit: 'Billions USD', change4w: 180,  changeYoY: null, signal: 'draining' },
        { seriesId: 'M2SL',      label: 'M2',      value: 21000, unit: 'Billions USD', change4w: null, changeYoY: 0.2,  signal: 'neutral'  },
      ],
    }
    expect(formatLiquidity(drainingCtx)).toContain('Net: TIGHTENING')
  })
})

const mockGovFlow: GovFlowContext = {
  asOf: '2026-05-29',
  watchlistAwards: [{
    ticker: 'NVDA', company: 'NVIDIA',
    total30d: 5_000_000,
    topAgency: 'Department of Defense',
    contracts: ['AI compute infrastructure for JAIC'],
  }],
  agencyFlows: [{
    agency: 'Department of Defense', total30d: 80_000_000_000, trend: 'rising',
  }],
  budgetSignals: [{
    billNumber: 'HR2670', title: 'National Defense Authorization Act',
    summary: 'The NDAA 2025 authorizes $850B for defense including AI programs.',
    relevantTickers: ['NVDA', 'PLTR'], totalFunding: 850_000_000_000,
    keyProvisions: ['AI Task Force', 'Cyber Command expansion'],
  }],
}

describe('formatGovFlow', () => {
  it('includes header with asOf date', () => {
    const result = formatGovFlow(mockGovFlow)
    expect(result).toContain('2026-05-29')
    expect(result).toContain('Government Capital Flows')
  })

  it('shows award dollar amount', () => {
    const result = formatGovFlow(mockGovFlow)
    expect(result).toContain('NVDA')
    expect(result).toContain('$5M')
  })

  it('shows rising trend arrow for agency', () => {
    const result = formatGovFlow(mockGovFlow)
    expect(result).toContain('↑')
  })

  it('includes bill number and tickers', () => {
    const result = formatGovFlow(mockGovFlow)
    expect(result).toContain('HR2670')
    expect(result).toContain('NVDA')
  })
})

describe('analyzeRegime with govFlowContext', () => {
  it('passes govFlowContext without error', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: 'tool_use',
            name: 'classify_macro_regime',
            input: {
              regime: 'Defense Spending Surge', confidence: 'medium',
              rationale: 'DoD AI budget expanding.',
              keyIndicators: ['NDAA passed'], affectedTickers: ['NVDA'],
            },
          }],
        }),
      },
    }
    const result = await analyzeRegime(mockHealth, { client: mockClient as any, govFlowContext: mockGovFlow })
    expect(result.regime).toBe('Defense Spending Surge')
  })
})
