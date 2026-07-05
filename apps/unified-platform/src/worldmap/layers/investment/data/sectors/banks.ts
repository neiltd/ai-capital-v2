import type { SectorExposureProfile } from '../../types'

export const banksSector: SectorExposureProfile = {
  id: 'sector-banks',
  name: 'Banks & Financial System',
  gicsSector: 'Financials',
  gicsIndustries: ['Banks', 'Capital Markets', 'Diversified Financial Services'],
  geopoliticalSensitivity: 'high',

  countryExposures: [
    {
      countryId: 'CHN',
      exposureType: 'revenue',
      direction: 'negative',
      magnitude: 'high',
      mechanism: 'US banks face regulatory pressure on China business. Chinese property crisis (Evergrande et al.) creates credit risk for international banks with China exposure. SWIFT exclusion risks for Chinese banks.',
    },
    {
      countryId: 'RUS',
      exposureType: "regulation",
      direction: 'negative',
      magnitude: 'high',
      mechanism: 'Russian bank assets frozen, SWIFT exclusion. Western banks had to exit Russia (Societe Generale lost $3.2B). Any resumption of Russian business faces political risk.',
    },
    {
      countryId: 'USA',
      exposureType: "regulation",
      direction: 'mixed',
      magnitude: 'critical',
      mechanism: 'Federal Reserve policy (interest rates) is the single largest driver of bank profitability globally. US sanctions regime determines which counterparties global banks can serve.',
    },
    {
      countryId: 'IRN',
      exposureType: "regulation",
      direction: 'negative',
      magnitude: 'high',
      mechanism: 'OFAC secondary sanctions mean any bank doing business with sanctioned Iranian entities faces US market exclusion. Creates broad avoidance even for legal transactions.',
    },
    {
      countryId: 'SAU',
      exposureType: 'revenue',
      direction: 'positive',
      magnitude: 'high',
      mechanism: 'Saudi Vision 2030 infrastructure investment creates massive project finance and investment banking opportunity. Gulf banks and international banks with Middle East presence benefit.',
    },
  ],

  chokepointExposures: [
    {
      chokepointId: 'SWIFT-NETWORK',
      name: 'SWIFT Financial Messaging Network',
      exposureType: 'logistics',
      direction: 'negative',
      magnitude: 'critical',
      annualTradeValueUsdBn: 150000,
      note: 'SWIFT exclusion (as with Russia 2022) is a financial chokepoint equivalent. Banks excluded from SWIFT lose access to global transaction infrastructure. Alternative networks (CIPS) exist but are limited.',
    },
  ],

  tradeRouteExposures: [],

  commodityExposures: [
    {
      commodity: 'Oil',
      role: 'input',
      direction: 'mixed',
      magnitude: 'medium',
      note: 'Banks with large commodity lending books are indirectly exposed to oil price moves through credit quality of energy company borrowers.',
    },
  ],

  vulnerabilities: [
    {
      id: 'VULN-BNK-1',
      title: 'Secondary Sanctions Overreach',
      description: 'US OFAC secondary sanctions increasingly punish foreign banks for business with sanctioned entities. Non-US banks face existential risk if they misjudge compliance — BNPP paid $8.9B fine in 2014.',
      triggerEvents: ['New US sanctions package', 'Escalation of China/Iran/Russia sanctions'],
      magnitude: 'high',
      timeline: 'weeks',
    },
    {
      id: 'VULN-BNK-2',
      title: 'China Property Crisis Contagion',
      description: 'Chinese property developer defaults (Evergrande, Country Garden) create credit stress for Hong Kong-listed banks and international banks with China exposure.',
      triggerEvents: ['Major Chinese developer default', 'China banking crisis', 'RMB depreciation'],
      magnitude: 'high',
      timeline: 'months',
    },
    {
      id: 'VULN-BNK-3',
      title: 'De-dollarization Accelerates',
      description: 'BRICS+ alternative payment systems, CIPS expansion, and gold reserve accumulation reduce dollar dominance. Long-term threat to US bank franchise value from dollar clearing.',
      triggerEvents: ['BRICS+ currency announcement', 'Saudi Arabia oil yuan pricing', 'Fed policy error'],
      magnitude: 'medium',
      timeline: 'years',
    },
  ],

  opportunities: [
    {
      id: 'OPP-BNK-1',
      title: 'Middle East Project Finance Boom',
      description: 'Saudi Vision 2030, UAE diversification, and Gulf infrastructure investment create $2T+ project finance opportunity for banks with regional presence.',
      triggerEvents: ['Vision 2030 project awards', 'High oil price sustaining Gulf budgets'],
      magnitude: 'high',
      timeline: 'years',
    },
    {
      id: 'OPP-BNK-2',
      title: 'Sanctions Compliance Infrastructure',
      description: 'Increasing sanctions complexity drives demand for compliance technology and advisory — opportunity for specialized financial institutions.',
      triggerEvents: ['New sanctions regime', 'Enforcement actions against banks'],
      magnitude: 'medium',
      timeline: 'years',
    },
  ],

  flags: {
    energyIntensity: 'low',
    tradeRouteDependent: false,
    singleCountryConcentrationRisk: false,
    exportControlSensitive: false,
    sanctionsSensitive: true,
    cyberInfrastructureVulnerable: true,
    dualUse: false,
  },

  attribution: {
    sources: [
      { name: 'BIS Quarterly Review', url: 'https://www.bis.org/publ/qtrpdf/', type: 'official', accessedAt: '2024-06-01' },
      { name: 'US Treasury OFAC Sanctions Programs', url: 'https://ofac.treasury.gov/sanctions-programs-and-country-information', type: 'official', accessedAt: '2024-06-01' },
    ],
    confidence: 'high',
    lastVerified: '2024-06-01',
    generatedBy: 'human',
  },
}
