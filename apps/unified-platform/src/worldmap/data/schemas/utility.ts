import { z } from 'zod'
import { ISO3Schema, PctSchema, YearSchema, AttributionSchema, assertSumsTo100 } from './_shared'

export const EnergyMixSchema = z.object({
  coal:            PctSchema.nullish(),
  gas:             PctSchema.nullish(),
  oil:             PctSchema.nullish(),
  nuclear:         PctSchema.nullish(),
  hydro:           PctSchema.nullish(),
  solar:           PctSchema.nullish(),
  wind:            PctSchema.nullish(),
  otherRenewables: PctSchema.nullish(),
  other:           PctSchema.nullish(),
}).refine(mix => {
  const vals = Object.values(mix).filter((v): v is number => v != null)
  if (vals.length === 0) return false
  return assertSumsTo100(vals, 5)  // 5% tolerance for rounding
}, { message: 'Energy mix percentages must sum to approximately 100%' })

export const CountryUtilitySchema = z.object({
  countryId: ISO3Schema,
  year:      YearSchema,

  electricityConsumptionTWh: z.number().positive().nullish(),
  electricityProductionTWh:  z.number().positive().nullish(),
  electricityMix:            EnergyMixSchema,
  renewableSharePct:         PctSchema.nullish(),

  waterStressScore:    z.number().min(0).max(5).nullish(),
  waterWithdrawalPct:  z.number().min(0).nullish(),  // >100 valid (fossil groundwater/desalination use)

  foodSecurityScore:   z.number().min(0).max(100).nullish(),

  aiAdoptionScore:     z.number().min(0).max(100).nullish(),
  internetPenetration: PctSchema.nullish(),
  mobilePenetration:   z.number().min(0).max(300).nullish(),  // can exceed 100%

  attribution: AttributionSchema,
})

export type CountryUtility = z.infer<typeof CountryUtilitySchema>
export type EnergyMix      = z.infer<typeof EnergyMixSchema>
