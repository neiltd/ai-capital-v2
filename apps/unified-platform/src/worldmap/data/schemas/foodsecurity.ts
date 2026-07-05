import { z } from 'zod'
import { ISO3Schema, YearSchema, AttributionSchema } from './_shared'

export const FoodSecuritySchema = z.object({
  countryId: ISO3Schema,
  year:      YearSchema,

  overallScore: z.number().min(0).max(100),

  availability: z.number().min(0).max(100).nullish(),
  access:       z.number().min(0).max(100).nullish(),
  utilization:  z.number().min(0).max(100).nullish(),
  stability:    z.number().min(0).max(100).nullish(),

  undernourishedPct:       z.number().min(0).max(100).nullish(),
  foodImportDependencyPct: z.number().min(0).max(200).nullish(),  // >100 valid for re-exporters
  cerealYieldKgHa:         z.number().positive().nullish(),

  climateVulnerability: z.enum(['none','low','medium','high','extreme']).nullish(),
  conflictExposure:     z.enum(['none','low','medium','high','extreme']).nullish(),

  attribution: AttributionSchema,
})

export type FoodSecurity = z.infer<typeof FoodSecuritySchema>
