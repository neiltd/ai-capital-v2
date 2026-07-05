import type { SectorExposureProfile } from '../../types'

export const defenseSector: SectorExposureProfile = {
  id: 'sector-defense',
  name: 'Defense & Aerospace',
  gicsSector: 'Industrials',
  gicsIndustries: ['Aerospace & Defense'],
  geopoliticalSensitivity: 'extreme',

  countryExposures: [
    {
      countryId: 'USA',
      exposureType: 'revenue',
      direction: 'positive',
      magnitude: 'critical',
      mechanism: 'US DoD budget is the world\'s largest at ~$900B/year. US defense contractors derive 60-80% of revenue from US government contracts. Budget cycles, CR (continuing resolutions), and supplemental appropriations directly drive revenue.',
    },
    {
      countryId: 'UKR',
      exposureType: 'revenue',
      direction: 'positive',
      magnitude: 'high',
      mechanism: 'Russia-Ukraine war triggered the largest surge in Western defense spending since the Cold War. Ukraine military aid ($175B+ from US alone) flows directly to defense contractors.',
      historicalPrecedent: 'Lockheed Martin Javelin backorders reached 2-year lead time. Raytheon Stinger production ramped from 1,200 to 5,000+ per year.',
    },
    {
      countryId: 'ISR',
      exposureType: 'revenue',
      direction: 'positive',
      magnitude: 'high',
      mechanism: 'Israel-Hamas conflict (2023+) drove massive replenishment orders for Iron Dome interceptors (Raytheon), artillery shells, and precision munitions. $14.1B US military aid package.',
    },
    {
      countryId: 'TWN',
      exposureType: 'revenue',
      direction: 'positive',
      magnitude: 'high',
      mechanism: 'Taiwan increasing defense budget. US arms sales to Taiwan (F-16s, Abrams tanks, Harpoon missiles) create multi-year revenue streams as geopolitical tension increases.',
    },
    {
      countryId: 'DEU',
      exposureType: 'revenue',
      direction: 'positive',
      magnitude: 'high',
      mechanism: 'Germany broke with Bundeswehr tradition to hit NATO\'s 2% GDP defense target post-Ukraine. €100B special fund creates massive European defense opportunity.',
    },
  ],

  chokepointExposures: [
    {
      chokepointId: 'STRAIT-TAIWAN',
      name: 'Taiwan Strait',
      exposureType: 'supply-chain',
      direction: 'positive',
      magnitude: 'high',
      annualTradeValueUsdBn: 2100,
      note: 'Increased Taiwan Strait tension directly drives US defense budget increases and Taiwan arms sales.',
    },
    {
      chokepointId: 'STRAIT-HORMUZ',
      name: 'Strait of Hormuz',
      exposureType: 'supply-chain',
      direction: 'positive',
      magnitude: 'high',
      annualTradeValueUsdBn: 1200,
      note: 'US Navy presence in the Persian Gulf and Red Sea requires continuous munition expenditure and replenishment — ongoing revenue for defense contractors.',
    },
  ],

  tradeRouteExposures: [],

  commodityExposures: [
    {
      commodity: 'Titanium',
      role: 'input',
      direction: 'negative',
      magnitude: 'high',
      note: 'Russia was a major titanium supplier for aerospace (Boeing, Airbus). Sanctions post-2022 forced supply chain diversification to Japan, Kazakhstan, and new sources.',
    },
    {
      commodity: 'Rare Earth Elements',
      role: 'input',
      direction: 'negative',
      magnitude: 'high',
      note: 'Defense systems (F-35 requires 900+ lbs of rare earths) depend on China-controlled supply. Export restrictions could impair production schedules.',
    },
  ],

  vulnerabilities: [
    {
      id: 'VULN-DEF-1',
      title: 'Production Rate Constraints',
      description: 'US defense industrial base cannot rapidly scale munition production to meet wartime demand. Stinger, Javelin, 155mm artillery shell shortages exposed in Ukraine war.',
      triggerEvents: ['Major conflict breakout', 'Surge demand from multiple theaters'],
      magnitude: 'high',
      timeline: 'months',
    },
    {
      id: 'VULN-DEF-2',
      title: 'Rare Earth Dependency for Defense Systems',
      description: 'F-35, submarines, missile guidance systems all require rare earths dominated by China. Any embargo could halt advanced weapons production.',
      triggerEvents: ['US-China military conflict', 'China rare earth export ban'],
      magnitude: 'critical',
      timeline: 'months',
    },
  ],

  opportunities: [
    {
      id: 'OPP-DEF-1',
      title: 'NATO 2% GDP Spending Wave',
      description: 'NATO members collectively moving toward 2% GDP defense spending creates $300B+ additional annual defense demand over the next decade.',
      triggerEvents: ['NATO summit commitments', 'European defense budget approvals', 'New European conflicts'],
      magnitude: 'critical',
      timeline: 'years',
    },
    {
      id: 'OPP-DEF-2',
      title: 'Munition Replenishment Supercycle',
      description: 'Western countries depleted strategic reserves supporting Ukraine. Multi-year replenishment cycle benefits artillery, missile, and ammunition manufacturers.',
      triggerEvents: ['Ukraine aid packages', 'NATO stockpile targets', 'Indo-Pacific deterrence spending'],
      magnitude: 'high',
      timeline: 'years',
    },
  ],

  flags: {
    energyIntensity: 'medium',
    tradeRouteDependent: false,
    singleCountryConcentrationRisk: true,
    exportControlSensitive: true,
    sanctionsSensitive: false,
    cyberInfrastructureVulnerable: true,
    dualUse: true,
  },

  attribution: {
    sources: [
      { name: 'SIPRI Military Expenditure Database 2024', url: 'https://www.sipri.org/databases/milex', type: 'data', accessedAt: '2024-06-01' },
      { name: 'US DoD Budget FY2025', url: 'https://comptroller.defense.gov/Budget-Materials/', type: 'official', accessedAt: '2024-06-01' },
    ],
    confidence: 'high',
    lastVerified: '2024-06-01',
    generatedBy: 'human',
  },
}
