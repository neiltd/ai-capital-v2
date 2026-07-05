import type { SectorExposureProfile } from '../../types'

export const semiconductorsSector: SectorExposureProfile = {
  id: 'sector-semiconductors',
  name: 'Semiconductors',
  gicsSector: 'Information Technology',
  gicsIndustries: ['Semiconductors', 'Semiconductor Equipment'],
  geopoliticalSensitivity: 'extreme',

  countryExposures: [
    {
      countryId: 'TWN',
      exposureType: 'manufacturing',
      direction: 'negative',
      magnitude: 'critical',
      mechanism: 'TSMC produces ~92% of world\'s most advanced chips (≤5nm). Any military conflict or blockade of Taiwan would halt global chip supply for years. No alternative at scale exists.',
      historicalPrecedent: 'COVID-19 disruption to TSMC fabs caused global automotive chip shortage (2021-2022) costing automakers $210B.',
    },
    {
      countryId: 'CHN',
      exposureType: 'revenue',
      direction: 'negative',
      magnitude: 'high',
      mechanism: 'China accounts for 25-35% of global semiconductor revenue. US export controls (October 2022, October 2023) cut access to advanced chips and equipment for Chinese customers.',
      historicalPrecedent: 'US Entity List addition of Huawei (2019) cost TSMC, Qualcomm, Intel billions in lost revenue.',
    },
    {
      countryId: 'KOR',
      exposureType: 'manufacturing',
      direction: 'negative',
      magnitude: 'high',
      mechanism: 'Samsung and SK Hynix produce ~70% of global DRAM and ~50% of NAND flash. North Korea military escalation creates operational risk for Korean fabs.',
    },
    {
      countryId: 'NLD',
      exposureType: 'supply-chain',
      direction: 'negative',
      magnitude: 'critical',
      mechanism: 'ASML (Netherlands) is the sole producer of EUV lithography machines, which are required to manufacture chips below 7nm. Loss of ASML access = loss of advanced chip manufacturing capability.',
    },
    {
      countryId: 'USA',
      exposureType: 'regulation',
      direction: 'mixed',
      magnitude: 'high',
      mechanism: 'US CHIPS Act ($52.7B) is positive for US domestic production (Intel, TSMC Arizona, Samsung Texas). Export controls on advanced chips and equipment to China are negative for revenue.',
    },
    {
      countryId: 'JPN',
      exposureType: 'supply-chain',
      direction: 'negative',
      magnitude: 'high',
      mechanism: 'Japan supplies ~50-60% of global semiconductor materials (photoresists, chemicals, specialty gases). Japan export controls on chip-making materials to China (2023) add supply chain complexity.',
    },
  ],

  chokepointExposures: [
    {
      chokepointId: 'STRAIT-TAIWAN',
      name: 'Taiwan Strait',
      exposureType: 'supply-chain',
      direction: 'negative',
      magnitude: 'critical',
      annualTradeValueUsdBn: 2100,
      note: 'Taiwan Strait handles ~50% of global container traffic and 100% of the world\'s most advanced chip supply. Military closure would be the most catastrophic infrastructure event in modern history.',
    },
    {
      chokepointId: 'STRAIT-MALACCA',
      name: 'Strait of Malacca',
      exposureType: 'logistics',
      direction: 'negative',
      magnitude: 'high',
      annualTradeValueUsdBn: 5400,
      note: 'Critical transit point for chips shipped from East Asia to Europe and the Middle East.',
    },
  ],

  tradeRouteExposures: [
    {
      routeId: 'ROUTE-TRANSPAC-NORTH',
      name: 'Trans-Pacific (North)',
      magnitude: 'high',
      note: 'Primary shipping lane for chips from Taiwan/Korea to US West Coast.',
    },
  ],

  commodityExposures: [
    {
      commodity: 'Rare Earth Elements',
      role: 'input',
      direction: 'negative',
      magnitude: 'high',
      note: 'China controls ~60% of rare earth mining and ~85% of processing. Used in chip packaging, magnets, and display materials.',
    },
    {
      commodity: 'Ultra-pure Water',
      role: 'input',
      direction: 'negative',
      magnitude: 'medium',
      note: 'Chip fabrication requires massive quantities of ultra-pure water. Water stress in Taiwan is a growing operational risk for TSMC fabs.',
    },
    {
      commodity: 'Neon Gas',
      role: 'input',
      direction: 'negative',
      magnitude: 'high',
      note: 'Ukraine produces ~45-54% of global semiconductor-grade neon. Russia-Ukraine war (2022) caused neon price spike of 500%. Used in EUV lithography lasers.',
    },
  ],

  vulnerabilities: [
    {
      id: 'VULN-SEM-1',
      title: 'TSMC Single Point of Failure',
      description: 'The entire global technology ecosystem — from smartphones to AI to defense systems — depends on one company in one island that China claims sovereignty over.',
      triggerEvents: ['Taiwan military conflict', 'Taiwan blockade', 'TSMC natural disaster'],
      magnitude: 'critical',
      timeline: 'immediate',
    },
    {
      id: 'VULN-SEM-2',
      title: 'US-China Export Control Escalation',
      description: 'Ongoing US export controls reduce chip company revenues from China. Further escalation could trigger Chinese retaliation affecting rare earths, assembly, or consumer markets.',
      triggerEvents: ['New US export control package', 'China retaliation measures', 'Taiwan tensions'],
      magnitude: 'high',
      timeline: 'weeks',
    },
    {
      id: 'VULN-SEM-3',
      title: 'ASML Access Restriction',
      description: 'If ASML EUV machine exports are further restricted or disrupted, advanced chip production outside of existing installed base becomes impossible.',
      triggerEvents: ['Dutch government export ban expansion', 'Geopolitical pressure on Netherlands'],
      magnitude: 'critical',
      timeline: 'months',
    },
  ],

  opportunities: [
    {
      id: 'OPP-SEM-1',
      title: 'US CHIPS Act Beneficiaries',
      description: 'US domestic chip production investment creates multi-year capex cycle for equipment makers and materials suppliers.',
      triggerEvents: ['CHIPS Act funding disbursements', 'New fab announcements'],
      magnitude: 'high',
      timeline: 'years',
    },
    {
      id: 'OPP-SEM-2',
      title: 'AI Infrastructure Supercycle',
      description: 'Geopolitical competition in AI drives massive capital expenditure in AI chips, HBM memory, and networking silicon.',
      triggerEvents: ['AI model releases', 'Government AI investment announcements'],
      magnitude: 'critical',
      timeline: 'years',
    },
  ],

  flags: {
    energyIntensity: 'high',
    tradeRouteDependent: true,
    singleCountryConcentrationRisk: true,
    exportControlSensitive: true,
    sanctionsSensitive: true,
    cyberInfrastructureVulnerable: true,
    dualUse: true,
  },

  attribution: {
    sources: [
      { name: 'SIA Semiconductor Industry Factbook 2024', url: 'https://www.semiconductors.org/semiconductor-industry-factbook/', type: 'research', accessedAt: '2024-06-01' },
      { name: 'US Commerce Dept Export Control Rules Oct 2023', url: 'https://www.bis.doc.gov/index.php/documents/regulations-docs/federal-register-notices/federal-register-2023/3188-2023-21063', type: 'official', accessedAt: '2024-06-01' },
    ],
    confidence: 'high',
    lastVerified: '2024-06-01',
    generatedBy: 'human',
  },
}
