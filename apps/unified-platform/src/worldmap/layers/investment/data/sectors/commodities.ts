import type { CommodityExposureMap } from '../../types'

export const oilBrentExposure: CommodityExposureMap = {
  commodity: 'Brent Crude Oil',
  unit: 'USD/barrel',
  majorProducers: [
    { countryId: 'SAU', shareOfGlobalProduction: 12, geopoliticalRisk: 'high', note: 'OPEC de facto leader. Abqaiq attack (2019) caused 15% overnight price spike.' },
    { countryId: 'RUS', shareOfGlobalProduction: 12, geopoliticalRisk: 'critical', note: 'Sanctioned since 2022. Oil rerouted to India/China at discount.' },
    { countryId: 'USA', shareOfGlobalProduction: 22, geopoliticalRisk: 'low', note: 'Largest producer. Strategic Petroleum Reserve can buffer short-term shocks.' },
    { countryId: 'IRQ', shareOfGlobalProduction: 5, geopoliticalRisk: 'high', note: 'Ongoing instability. Oil infrastructure targeted periodically.' },
    { countryId: 'IRN', shareOfGlobalProduction: 5, geopoliticalRisk: 'critical', note: 'Sanctioned. Controls northern shore of Strait of Hormuz.' },
    { countryId: 'ARE', shareOfGlobalProduction: 4, geopoliticalRisk: 'medium', note: 'Stable producer. Fujairah terminal provides Hormuz bypass.' },
  ],
  transitChokepoints: [
    { chokepointId: 'STRAIT-HORMUZ', name: 'Strait of Hormuz', percentOfGlobalFlowThrough: 21, riskLevel: 'critical' },
    { chokepointId: 'STRAIT-BAB-EL-MANDEB', name: 'Bab-el-Mandeb', percentOfGlobalFlowThrough: 10, riskLevel: 'high' },
    { chokepointId: 'CANAL-SUEZ', name: 'Suez Canal', percentOfGlobalFlowThrough: 12, riskLevel: 'high' },
  ],
  priceDrivers: [
    { type: 'geopolitical', description: 'Middle East conflict risk premium', direction: 'positive', magnitude: 'high' },
    { type: 'supply', description: 'OPEC+ production quotas', direction: 'positive', magnitude: 'critical' },
    { type: 'demand', description: 'China economic growth / slowdown', direction: 'mixed', magnitude: 'high' },
    { type: 'geopolitical', description: 'Russia sanctions compliance', direction: 'positive', magnitude: 'medium' },
    { type: 'supply', description: 'US shale production swing', direction: 'negative', magnitude: 'high' },
    { type: 'currency', description: 'USD strength (oil is USD-denominated)', direction: 'negative', magnitude: 'medium' },
  ],
  beneficiaries: [
    { type: 'country', description: 'Saudi Arabia, UAE, Iraq, Kuwait — revenue increases with price', direction: 'positive' },
    { type: 'sector', description: 'Oil & Gas producers — higher margin on existing production', direction: 'positive' },
    { type: 'company-type', description: 'US shale producers — profitable at $60+/barrel breakeven', direction: 'positive' },
    { type: 'sector', description: 'Oil field services (SLB, HAL, BKR) — higher activity at high prices', direction: 'positive' },
  ],
  losers: [
    { type: 'sector', description: 'Airlines — fuel is 20-30% of operating costs', direction: 'negative' },
    { type: 'sector', description: 'Shipping & logistics — bunker fuel costs rise', direction: 'negative' },
    { type: 'sector', description: 'Consumer discretionary — higher energy costs reduce spending', direction: 'negative' },
    { type: 'country', description: 'Oil-importing countries (India, Japan, South Korea, Thailand) — worsens trade balance', direction: 'negative' },
    { type: 'sector', description: 'Chemicals & plastics — feedstock cost increase', direction: 'negative' },
  ],
  attribution: {
    sources: [
      { name: 'EIA Short-Term Energy Outlook', url: 'https://www.eia.gov/steo/', type: 'official', accessedAt: '2024-06-01' },
      { name: 'IEA Oil Market Report', url: 'https://www.iea.org/reports/oil-market-report', type: 'official', accessedAt: '2024-06-01' },
    ],
    confidence: 'high',
    lastVerified: '2024-06-01',
    generatedBy: 'human',
  },
}

export const goldExposure: CommodityExposureMap = {
  commodity: 'Gold',
  unit: 'USD/troy oz',
  majorProducers: [
    { countryId: 'CHN', shareOfGlobalProduction: 11, geopoliticalRisk: 'medium', note: 'Largest producer. Domestic demand also very high.' },
    { countryId: 'AUS', shareOfGlobalProduction: 10, geopoliticalRisk: 'low', note: 'Stable jurisdiction.' },
    { countryId: 'RUS', shareOfGlobalProduction: 10, geopoliticalRisk: 'high', note: 'Sanctioned. Gold used to partially circumvent sanctions.' },
    { countryId: 'CAN', shareOfGlobalProduction: 5, geopoliticalRisk: 'low', note: 'Stable.' },
    { countryId: 'COD', shareOfGlobalProduction: 4, geopoliticalRisk: 'critical', note: 'Conflict gold mining is ongoing risk.' },
  ],
  transitChokepoints: [],
  priceDrivers: [
    { type: 'geopolitical', description: 'Global risk aversion / safe haven demand', direction: 'positive', magnitude: 'high' },
    { type: 'currency', description: 'USD weakness (inverse relationship)', direction: 'positive', magnitude: 'high' },
    { type: 'demand', description: 'Central bank purchases (de-dollarization trend)', direction: 'positive', magnitude: 'high' },
    { type: 'geopolitical', description: 'Sanctions driving reserve diversification from USD to gold', direction: 'positive', magnitude: 'medium' },
    { type: 'demand', description: 'Real interest rates (opportunity cost of holding gold)', direction: 'negative', magnitude: 'high' },
  ],
  beneficiaries: [
    { type: 'company-type', description: 'Gold mining companies — higher revenue on existing production', direction: 'positive' },
    { type: 'country', description: 'Gold-producing nations — higher export revenues', direction: 'positive' },
    { type: 'sector', description: 'Gold ETFs and financial products', direction: 'positive' },
  ],
  losers: [
    { type: 'sector', description: 'Risk assets in general — gold rising often means risk-off sentiment', direction: 'negative' },
  ],
  attribution: {
    sources: [
      { name: 'World Gold Council Demand Trends', url: 'https://www.gold.org/goldhub/research/gold-demand-trends', type: 'research', accessedAt: '2024-06-01' },
    ],
    confidence: 'high',
    lastVerified: '2024-06-01',
    generatedBy: 'human',
  },
}
