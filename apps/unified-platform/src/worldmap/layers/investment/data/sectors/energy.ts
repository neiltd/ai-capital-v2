import type { SectorExposureProfile } from '../../types'

export const energySector: SectorExposureProfile = {
  id: 'sector-energy',
  name: 'Energy',
  gicsSector: 'Energy',
  gicsIndustries: ['Oil, Gas & Consumable Fuels', 'Energy Equipment & Services'],
  geopoliticalSensitivity: 'extreme',

  countryExposures: [
    {
      countryId: 'SAU',
      exposureType: 'supply-chain',
      direction: 'negative',
      magnitude: 'critical',
      mechanism: 'Saudi Arabia produces ~10% of global oil supply. OPEC+ production decisions directly set global oil prices. Saudi Aramco\'s Abqaiq facility processes ~7% of global oil supply — a single target attack (2019) caused a 15% overnight price spike.',
    },
    {
      countryId: 'RUS',
      exposureType: 'supply-chain',
      direction: 'negative',
      magnitude: 'high',
      mechanism: 'Russia supplies ~12% of global oil and ~17% of global LNG. Western sanctions post-2022 redirected Russian energy flows but created lasting price dislocations and European energy crisis.',
      historicalPrecedent: 'Russia-Ukraine war (2022) drove European natural gas prices up 800% and caused recession risk across EU.',
    },
    {
      countryId: 'IRN',
      exposureType: 'supply-chain',
      direction: 'negative',
      magnitude: 'high',
      mechanism: 'Iran controls ~5-6% of global oil reserves. US sanctions reduce Iranian exports. Conflict involving Iran risks closure of Strait of Hormuz, through which 21% of global oil flows.',
    },
    {
      countryId: 'ARE',
      exposureType: 'supply-chain',
      direction: 'mixed',
      magnitude: 'high',
      mechanism: 'UAE is both a major producer (ADNOC) and hosts strategic Fujairah oil terminal outside the Strait of Hormuz — a bypass route. Gulf stability directly affects UAE\'s energy role.',
    },
  ],

  chokepointExposures: [
    {
      chokepointId: 'STRAIT-HORMUZ',
      name: 'Strait of Hormuz',
      exposureType: 'energy',
      direction: 'negative',
      magnitude: 'critical',
      annualTradeValueUsdBn: 1200,
      note: '21% of global petroleum liquids and 25% of global LNG pass through Hormuz. Iran controls the northern shore. Closure would trigger an immediate oil price crisis.',
    },
    {
      chokepointId: 'STRAIT-BAB-EL-MANDEB',
      name: 'Bab-el-Mandeb',
      exposureType: 'energy',
      direction: 'negative',
      magnitude: 'high',
      annualTradeValueUsdBn: 700,
      note: '10% of global oil trade transits here. Houthi attacks (2024) caused major rerouting through Cape of Good Hope, adding 10-14 days and significant cost.',
    },
  ],

  tradeRouteExposures: [
    { routeId: 'ROUTE-SUEZ', name: 'Suez Canal Route', magnitude: 'high', note: 'Key route for oil from Middle East to Europe.' },
    { routeId: 'ROUTE-ARCTIC', name: 'Arctic Route', magnitude: 'medium', note: 'Emerging alternative as Arctic ice recedes — Russia controls access.' },
  ],

  commodityExposures: [
    { commodity: 'Crude Oil', role: 'output', direction: 'positive', magnitude: 'critical', note: 'Primary revenue driver for integrated oil companies.' },
    { commodity: 'Natural Gas', role: 'output', direction: 'positive', magnitude: 'high', note: 'LNG exports increasingly important. Henry Hub vs TTF price divergence creates arbitrage opportunities.' },
  ],

  vulnerabilities: [
    {
      id: 'VULN-ENE-1',
      title: 'Strait of Hormuz Closure Risk',
      description: 'Iranian retaliation to US/Israeli military action could involve closing or mining the Strait of Hormuz, triggering an immediate global oil shock.',
      triggerEvents: ['Iran nuclear deal collapse', 'US-Iran military strike', 'Israel-Iran escalation'],
      magnitude: 'critical',
      timeline: 'immediate',
    },
    {
      id: 'VULN-ENE-2',
      title: 'Russian Supply Disruption Escalation',
      description: 'Further escalation of Russia-Ukraine war could reduce already-diverted Russian oil flows and increase European energy costs.',
      triggerEvents: ['Expanded Ukraine conflict', 'New energy sanctions on Russia'],
      magnitude: 'high',
      timeline: 'weeks',
    },
  ],

  opportunities: [
    {
      id: 'OPP-ENE-1',
      title: 'Middle East Conflict Premium',
      description: 'Geopolitical risk in the Middle East creates persistent oil price premium benefiting upstream producers outside the region.',
      triggerEvents: ['Iran-Israel escalation', 'Houthi attack escalation', 'OPEC+ production cut'],
      magnitude: 'high',
      timeline: 'months',
    },
    {
      id: 'OPP-ENE-2',
      title: 'LNG Infrastructure Build-out',
      description: 'Europe\'s energy independence drive creates decade-long LNG infrastructure investment cycle. US LNG exporters are primary beneficiaries.',
      triggerEvents: ['EU energy policy announcements', 'New LNG terminal approvals'],
      magnitude: 'high',
      timeline: 'years',
    },
  ],

  flags: {
    energyIntensity: 'high',
    tradeRouteDependent: true,
    singleCountryConcentrationRisk: false,
    exportControlSensitive: false,
    sanctionsSensitive: true,
    cyberInfrastructureVulnerable: true,
    dualUse: false,
  },

  attribution: {
    sources: [
      { name: 'EIA World Energy Outlook 2024', url: 'https://www.eia.gov/outlooks/ieo/', type: 'official', accessedAt: '2024-06-01' },
      { name: 'IEA Oil Market Report', url: 'https://www.iea.org/reports/oil-market-report', type: 'official', accessedAt: '2024-06-01' },
    ],
    confidence: 'high',
    lastVerified: '2024-06-01',
    generatedBy: 'human',
  },
}
