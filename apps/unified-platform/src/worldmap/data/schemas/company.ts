import { z } from 'zod'
import { ISO3Schema, PctSchema, YearSchema } from './_shared'

const MagnitudeSchema = z.enum(['low', 'medium', 'high', 'critical'])

const SourceRefSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  type: z.enum(['filing', 'news', 'research', 'data', 'official', 'other']),
  accessedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  verbatimQuote: z.string().optional(),
})

const AttributionSchema = z.object({
  sources: z.array(SourceRefSchema).min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedBy: z.enum(['human', 'ai-assisted']),
})

const GeographicRevenueSchema = z.object({
  region: z.string(),
  countryIds: z.array(ISO3Schema).optional(),
  percentOfRevenue: PctSchema,
  revenueUsdBn: z.number().optional(),
  year: YearSchema,
  note: z.string().optional(),
})

const SupplyChainNodeSchema = z.object({
  role: z.enum(['supplier', 'customer', 'manufacturer', 'distributor', 'logistics', 'partner']),
  name: z.string(),
  countryId: ISO3Schema,
  city: z.string().optional(),
  percentOfSupply: z.number().optional().nullable(),
  percentOfRevenue: z.number().optional().nullable(),
  isConcentrationRisk: z.boolean(),
  strategicNote: z.string(),
})

const CommodityDependencySchema = z.object({
  commodity: z.string(),
  role: z.enum(['input', 'output', 'byproduct']),
  percentOfCOGS: z.number().optional().nullable(),
  percentOfRevenue: z.number().optional().nullable(),
  primarySupplyCountries: z.array(ISO3Schema),
  isHedged: z.boolean(),
  hedgingNote: z.string().optional(),
  geopoliticalRisk: MagnitudeSchema,
  note: z.string(),
})

const RegionalExposureSchema = z.object({
  region: z.string(),
  countryIds: z.array(ISO3Schema),
  exposureType: z.enum(['revenue', 'supply-chain', 'manufacturing', 'regulatory', 'debt', 'production', 'currency']),
  magnitude: MagnitudeSchema,
  note: z.string(),
  filingRefs: z.array(z.string()).optional(),
})

const InfrastructureDependencySchema = z.object({
  type: z.enum(['port', 'airport', 'cable', 'trade-route', 'chokepoint', 'pipeline', 'rail', 'digital', 'it-infrastructure']),
  entityId: z.string(),
  name: z.string(),
  importance: MagnitudeSchema,
  note: z.string(),
})

export const CompanyProfileSchema = z.object({
  id: z.string().startsWith('COMPANY-'),
  ticker: z.string(),
  name: z.string(),
  exchange: z.string(), // NYSE, NASDAQ, etc.
  gicsSector: z.string(),
  gicsIndustryGroup: z.string(),
  gicsIndustry: z.string(),
  countryOfIncorporation: ISO3Schema,
  countryOfHQ: ISO3Schema,
  marketCapUsdBn: z.number().optional().nullable(),
  revenueUsdBn: z.number().optional().nullable(),
  fiscalYear: YearSchema,

  description: z.string(),
  businessModel: z.string(),
  geopoliticalSummary: z.string(),

  revenueByGeography: z.array(GeographicRevenueSchema),
  keySuppliers: z.array(SupplyChainNodeSchema),
  keyCustomers: z.array(SupplyChainNodeSchema),
  manufacturingLocations: z.array(z.object({
    countryId: ISO3Schema,
    city: z.string().optional().nullable(),
    percentOfCapacity: z.number().optional().nullable(),
    note: z.string(),
  })),

  commodityDependencies: z.array(CommodityDependencySchema),
  regionalExposures: z.array(RegionalExposureSchema),
  infrastructureDependencies: z.array(InfrastructureDependencySchema),

  flags: z.object({
    chinaRevenuePct: z.number().optional().nullable(),
    chinaManufacturingDependent: z.boolean(),
    russiaExposed: z.boolean(),
    middleEastEnergyDependent: z.boolean(),
    taiwanSemiconductorDependent: z.boolean(),
    redSeaTradeRouteDependent: z.boolean(),
    straitOfHormuzDependent: z.boolean(),
    sanctionsSensitive: z.boolean(),
    exportControlSensitive: z.boolean(),
  }),

  latestFilingId: z.string().optional(),
  secCik: z.string().optional(),
  secEdgarUrl: z.string().url().optional().or(z.string().length(0)),

  attribution: AttributionSchema,
})

export type CompanyProfile = z.infer<typeof CompanyProfileSchema>
