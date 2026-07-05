// Canonical portfolio type shapes used across the AI Capital monorepo.
// Owner: scenario-simulator (positions originate there, drive briefing).

export type AssetClass = 'us_equity' | 'th_equity' | 'th_fund' | 'gold' | 'cash'
export type Currency   = 'USD' | 'THB'
export type Strategy   = 'tactical' | 'dca' | 'tax_locked'

export interface Position {
  ticker:        string
  company:       string
  shares:        number
  avgCost:       number
  currentPrice:  number
  currentValue:  number
  unrealizedPnl: number
  updatedAt:     string
  assetClass:    AssetClass
  currency:      Currency
  priceSymbol:   string   // Yahoo Finance symbol; '' if no live price (cash, manual NAV)
  strategy:      Strategy
}
