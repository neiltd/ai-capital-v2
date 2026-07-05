import { z } from 'zod'
import { ISO3Schema, YearSchema, PctSchema, AttributionSchema } from './_shared'

export const AiAdoptionSchema = z.object({
  countryId: ISO3Schema,
  year:      YearSchema,

  aiReadinessScore:    z.number().min(0).max(100).nullish(),
  aiAdoptionScore:     z.number().min(0).max(100).nullish(),
  aiTalentScore:       z.number().min(0).max(100).nullish(),

  aiInvestmentUsdM:   z.number().nonnegative().nullish(),
  aiStartupCount:     z.number().int().nonnegative().nullish(),
  aiUnicornCount:     z.number().int().nonnegative().nullish(),

  hasNationalAiStrategy:   z.boolean().nullish(),
  aiStrategyYear:          YearSchema.nullish(),
  aiPolicyScore:           z.number().min(0).max(100).nullish(),  // Oxford Insights uses 0-100

  cloudReadinessPct:       PctSchema.nullish(),
  broadbandPenetrationPct: PctSchema.nullish(),

  topAiSectors: z.array(z.string()).nullish(),

  attribution: AttributionSchema,
})

export type AiAdoption = z.infer<typeof AiAdoptionSchema>
