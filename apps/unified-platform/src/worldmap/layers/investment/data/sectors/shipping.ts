import type { SectorExposureProfile } from '../../types'

export const shippingLogisticsSector: SectorExposureProfile = {
  id: 'sector-shipping-logistics',
  name: 'Shipping & Logistics',
  gicsSector: 'Industrials',
  gicsIndustries: ['Marine Transportation', 'Air Freight & Logistics', 'Road & Rail'],
  geopoliticalSensitivity: 'extreme',

  countryExposures: [
    {
      countryId: 'CHN',
      exposureType: 'revenue',
      direction: 'positive',
      magnitude: 'critical',
      mechanism: 'China is the world\'s largest exporter (~14% of global exports). Chinese manufacturing output directly drives container shipping volumes. China slowdown = shipping volume decline.',
    },
    {
      countryId: 'SGP',
      exposureType: 'supply-chain',
      direction: 'negative',
      magnitude: 'high',
      mechanism: 'Singapore handles ~140M TEU annually and is the primary transshipment hub for Asia-Europe and intra-Asia trade. Political instability in Singapore would disrupt all regional shipping networks.',
    },
    {
      countryId: 'YEM',
      exposureType: 'supply-chain',
      direction: 'negative',
      magnitude: 'critical',
      mechanism: 'Houthi attacks from Yemen on Red Sea shipping (2024) forced major carriers to reroute via Cape of Good Hope, adding 10-14 days transit, $2,000+ per container, and significant fuel costs.',
      historicalPrecedent: 'Houthi campaign (2024): Maersk, CMA CGM, MSC suspended Red Sea operations. Freight rates tripled. Suez Canal traffic fell 42%.',
    },
    {
      countryId: 'EGY',
      exposureType: 'revenue',
      direction: 'mixed',
      magnitude: 'high',
      mechanism: 'Egypt earns ~$9-10B/year from Suez Canal tolls. Shipping rerouting around Cape = significant Egyptian revenue loss. Canal expansion and stability matter for global logistics.',
    },
  ],

  chokepointExposures: [
    {
      chokepointId: 'STRAIT-MALACCA',
      name: 'Strait of Malacca',
      exposureType: 'logistics',
      direction: 'negative',
      magnitude: 'critical',
      annualTradeValueUsdBn: 5400,
      note: '~90,000 vessels per year pass through Malacca. Piracy risk and political tension between Malaysia, Indonesia, Singapore could disrupt flows. No practical alternative exists.',
    },
    {
      chokepointId: 'CANAL-SUEZ',
      name: 'Suez Canal',
      exposureType: 'logistics',
      direction: 'negative',
      magnitude: 'critical',
      annualTradeValueUsdBn: 1000,
      note: '12-15% of global trade transits Suez. Blockage (Ever Given 2021: $10B/day) or Red Sea conflict forces Cape rerouting, adding $2,000-4,000 per container and 10-14 days.',
    },
    {
      chokepointId: 'CANAL-PANAMA',
      name: 'Panama Canal',
      exposureType: 'logistics',
      direction: 'negative',
      magnitude: 'high',
      annualTradeValueUsdBn: 270,
      note: 'Climate-driven drought reduced canal capacity 30-36% in 2023-2024, causing shipping backlogs and rate increases for Pacific-Atlantic trade.',
    },
    {
      chokepointId: 'STRAIT-BAB-EL-MANDEB',
      name: 'Bab-el-Mandeb',
      exposureType: 'logistics',
      direction: 'negative',
      magnitude: 'critical',
      annualTradeValueUsdBn: 700,
      note: 'Gateway to Suez Canal. Houthi threats in 2024 effectively closed this chokepoint for many carriers.',
    },
  ],

  tradeRouteExposures: [
    { routeId: 'ROUTE-ASIA-EUROPE', name: 'Asia-Europe (via Suez)', magnitude: 'critical', note: 'Most affected by Red Sea crisis. Cape rerouting adds 10-14 days.' },
    { routeId: 'ROUTE-TRANSPAC', name: 'Trans-Pacific', magnitude: 'high', note: 'US-China trade tension affects volumes. Panama Canal drought affects rates.' },
  ],

  commodityExposures: [
    { commodity: 'Bunker Fuel', role: 'input', direction: 'negative', magnitude: 'high', note: 'Fuel is 50-60% of shipping OPEX. Oil price spikes directly hit margins.' },
  ],

  vulnerabilities: [
    {
      id: 'VULN-SHP-1',
      title: 'Red Sea / Houthi Persistent Disruption',
      description: 'If Yemen conflict continues, Red Sea disruption becomes the new normal for shipping, permanently increasing Asia-Europe shipping costs and reshaping supply chains.',
      triggerEvents: ['Escalation of Houthi attacks', 'Western military response in Yemen', 'Iran-backed expansion of attacks'],
      magnitude: 'critical',
      timeline: 'months',
    },
    {
      id: 'VULN-SHP-2',
      title: 'Malacca Strait Piracy or Political Closure',
      description: 'Any serious disruption to Malacca Strait would affect 90,000 vessels annually and have no viable alternative route at scale.',
      triggerEvents: ['South China Sea military conflict', 'Malaysia-Singapore political crisis', 'Piracy escalation'],
      magnitude: 'critical',
      timeline: 'immediate',
    },
  ],

  opportunities: [
    {
      id: 'OPP-SHP-1',
      title: 'Cape of Good Hope Routing Beneficiaries',
      description: 'Ports along the alternative Cape route (West Africa, South Africa) benefit from increased traffic when Suez is disrupted.',
      triggerEvents: ['Red Sea conflict continuation', 'Suez Canal disruption'],
      magnitude: 'medium',
      timeline: 'months',
    },
    {
      id: 'OPP-SHP-2',
      title: 'Air Freight Surge',
      description: 'Sea shipping disruptions drive time-sensitive cargo to air freight, benefiting FedEx, UPS, DHL, and air cargo operators.',
      triggerEvents: ['Prolonged Red Sea closure', 'Just-in-time supply chain disruptions'],
      magnitude: 'high',
      timeline: 'weeks',
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
      { name: 'UNCTAD Maritime Transport Report 2024', url: 'https://unctad.org/webflyer/review-maritime-transport-2024', type: 'official', accessedAt: '2024-06-01' },
      { name: 'Freightos Baltic Index', url: 'https://fbx.freightos.com/', type: 'data', accessedAt: '2024-06-01' },
    ],
    confidence: 'high',
    lastVerified: '2024-06-01',
    generatedBy: 'human',
  },
}
