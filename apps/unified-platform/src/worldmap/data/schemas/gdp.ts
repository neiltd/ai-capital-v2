import { z } from 'zod'
import { ISO3Schema, PctSchema, YearSchema, AttributionSchema, assertSumsTo100 } from './_shared'

export const GdpSectorSchema = z.object({
  sector:       z.string().min(1),
  percentOfGDP: PctSchema,
  notes:        z.string().nullish(),
})

export const GdpCompositionSchema = z.object({
  countryId:    ISO3Schema,
  year:         YearSchema,
  gdpUsdBn:     z.number().positive().nullish(),
  gdpPerCapita: z.number().positive().nullish(),

  sectors: z.array(GdpSectorSchema).min(1),

  attribution: AttributionSchema,
})
.refine(d => assertSumsTo100(d.sectors.map(s => s.percentOfGDP), 5), {
  message: 'GDP sector percentages must sum to approximately 100%',
  path: ['sectors'],
})

export type GdpComposition = z.infer<typeof GdpCompositionSchema>
export type GdpSector      = z.infer<typeof GdpSectorSchema>
