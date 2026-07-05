import type { SectorExposureProfile } from '../../types'

export const aiInfrastructureSector: SectorExposureProfile = {
  id: 'sector-ai-infrastructure',
  name: 'AI Infrastructure & Datacenters',
  gicsSector: 'Information Technology',
  gicsIndustries: ['Technology Hardware, Storage & Peripherals', 'IT Services', 'Software'],
  geopoliticalSensitivity: 'extreme',

  countryExposures: [
    {
      countryId: 'TWN',
      exposureType: 'supply-chain',
      direction: 'negative',
      magnitude: 'critical',
      mechanism: 'NVIDIA\'s H100/H200 GPUs are fabricated exclusively by TSMC in Taiwan using CoWoS advanced packaging. Any Taiwan disruption halts AI chip production. Lead times already 52+ weeks.',
    },
    {
      countryId: 'CHN',
      exposureType: 'regulation',
      direction: 'negative',
      magnitude: 'high',
      mechanism: 'US export controls (Oct 2022, Oct 2023, Oct 2024) prohibit advanced AI chips (H100, A100 equivalents) and chip-making equipment exports to China. China represents ~20-25% of global AI chip demand.',
    },
    {
      countryId: 'NLD',
      exposureType: 'supply-chain',
      direction: 'negative',
      magnitude: 'critical',
      mechanism: 'ASML\'s EUV machines are sole-source for advanced AI chip manufacturing. Dutch government export controls extended to China in 2023 under US pressure.',
    },
    {
      countryId: 'USA',
      exposureType: 'regulation',
      direction: 'mixed',
      magnitude: 'critical',
      mechanism: 'US government is both the primary driver of AI demand (DoD, NSA, intelligence agencies) and the primary regulator of chip exports. CHIPS Act creates domestic manufacturing opportunity.',
    },
    {
      countryId: 'SGP',
      exposureType: 'supply-chain',
      direction: 'positive',
      magnitude: 'high',
      mechanism: 'Singapore is the preferred location for hyperscale AI datacenter expansion in Asia due to political stability, submarine cable infrastructure, and English common law.',
    },
  ],

  chokepointExposures: [
    {
      chokepointId: 'CABLE-TRANSPACIFIC',
      name: 'Trans-Pacific Submarine Cables',
      exposureType: 'supply-chain',
      direction: 'negative',
      magnitude: 'critical',
      annualTradeValueUsdBn: 10000,
      note: 'AI training and inference requires massive data transfers across submarine cables. US-China cable restrictions (FCC rejections of Pacific Light Cable Network) fragment global AI infrastructure.',
    },
  ],

  tradeRouteExposures: [
    { routeId: 'ROUTE-TRANSPAC-NORTH', name: 'Trans-Pacific (North)', magnitude: 'high', note: 'Critical for AI hardware shipped from Taiwan/Korea to US datacenters.' },
  ],

  commodityExposures: [
    {
      commodity: 'Electricity',
      role: 'input',
      direction: 'negative',
      magnitude: 'critical',
      note: 'AI datacenters consume 10-50x more power per rack than traditional datacenters. A single H100 cluster of 10,000 GPUs requires ~40-50 MW. Energy availability is now a binding constraint on AI expansion.',
    },
    {
      commodity: 'Rare Earth Elements',
      role: 'input',
      direction: 'negative',
      magnitude: 'high',
      note: 'Rare earths used in GPU packaging, power supply magnets, and cooling systems. China controls 60% of mining and 85% of processing.',
    },
    {
      commodity: 'Cooling Water',
      role: 'input',
      direction: 'negative',
      magnitude: 'medium',
      note: 'AI datacenters use liquid cooling requiring large water volumes. Water scarcity in US Southwest (Arizona, Nevada where many hyperscale datacenters are located) creates growing constraint.',
    },
  ],

  vulnerabilities: [
    {
      id: 'VULN-AI-1',
      title: 'GPU Supply Chain Taiwan Concentration',
      description: 'The entire global AI buildout depends on TSMC CoWoS packaging capacity in Taiwan. Taiwan risk = AI infrastructure risk. There is no backup for advanced GPU manufacturing.',
      triggerEvents: ['Taiwan military conflict', 'TSMC operational disruption', 'Taiwan earthquake'],
      magnitude: 'critical',
      timeline: 'immediate',
    },
    {
      id: 'VULN-AI-2',
      title: 'US-China AI Decoupling',
      description: 'Progressive tightening of US export controls on AI chips to China risks Chinese retaliation on rare earths, electronics assembly, or other tech supply chain components.',
      triggerEvents: ['New chip export control tier', 'China rare earth export ban', 'Taiwan conflict escalation'],
      magnitude: 'high',
      timeline: 'months',
    },
    {
      id: 'VULN-AI-3',
      title: 'Power Grid Constraint',
      description: 'US and European power grids are not built for AI datacenter density. Hyperscalers competing for power creates regulatory risk and delays AI infrastructure buildout.',
      triggerEvents: ['Power grid regulatory changes', 'Extreme weather events', 'Nuclear plant closures'],
      magnitude: 'high',
      timeline: 'years',
    },
  ],

  opportunities: [
    {
      id: 'OPP-AI-1',
      title: 'Nuclear Power Renaissance for AI',
      description: 'Hyperscalers (Microsoft, Google, Amazon) signing long-term nuclear power purchase agreements creates multi-decade opportunity for nuclear operators and developers.',
      triggerEvents: ['AI power demand announcements', 'Nuclear SMR approvals', 'Hyperscaler PPA signings'],
      magnitude: 'high',
      timeline: 'years',
    },
    {
      id: 'OPP-AI-2',
      title: 'US Domestic Chip Manufacturing',
      description: 'CHIPS Act investments in Intel, TSMC Arizona, Samsung Texas create domestic AI chip production — reducing Taiwan concentration risk long-term.',
      triggerEvents: ['CHIPS Act milestones', 'TSMC Arizona production ramp', 'New fab announcements'],
      magnitude: 'high',
      timeline: 'years',
    },
  ],

  flags: {
    energyIntensity: 'high',
    tradeRouteDependent: true,
    singleCountryConcentrationRisk: true,
    exportControlSensitive: true,
    sanctionsSensitive: false,
    cyberInfrastructureVulnerable: true,
    dualUse: true,
  },

  attribution: {
    sources: [
      { name: 'IEA Electricity 2024 Report on AI Data Centers', url: 'https://www.iea.org/reports/electricity-2024', type: 'official', accessedAt: '2024-06-01' },
      { name: 'NVIDIA 10-K FY2024', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=NVDA&type=10-K', type: 'filing', accessedAt: '2024-06-01' },
    ],
    confidence: 'high',
    lastVerified: '2024-06-01',
    generatedBy: 'human',
  },
}
