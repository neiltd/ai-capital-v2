import { z } from 'zod'
import { CoordSchema, ISO3Schema, AttributionSchema, YearSchema, StrategicImportanceSchema } from './_shared'

export const PlantTypeSchema   = z.enum(['coal','gas','oil','nuclear','hydro','solar','wind','geothermal','biomass','other'])
export const PlantStatusSchema = z.enum(['operating','construction','planned','decommissioned','mothballed'])

export const PowerPlantSchema = z.object({
  id:        z.string().min(1).regex(/^PLANT-[A-Z0-9-]+$/, 'ID must start with PLANT-'),
  name:      z.string().min(2),
  countryId: ISO3Schema,
  city:      z.string().nullish(),

  coordinates: CoordSchema,
  type:        PlantTypeSchema,
  status:      PlantStatusSchema,

  // ── Capacity — nullish: Gemini returns null for unknown values ──
  capacityMW:       z.number().positive().nullish(),
  annualOutputGWh:  z.number().nonnegative().nullish(),

  // ── Timeline ──
  yearCommissioned: YearSchema.nullish(),
  yearRetirement:   YearSchema.nullish(),

  // ── Ownership ──
  operator: z.string().nullish(),
  owner:    z.string().nullish(),

  // ── Importance — for tier-based rendering and thematic filtering ──
  // Tier 1 (critical): baseload plants ≥5 GW, nuclear, sole grid suppliers
  // Tier 2 (high): major regional plants ≥1 GW, strategic fuel type
  // Tier 3 (medium): mid-size plants 200 MW–1 GW
  // Tier 4 (low): small/local plants <200 MW
  // Gemini assigns based on capacity, type, and grid strategic role.
  strategicImportance: StrategicImportanceSchema.nullish(),

  // ── Context ──
  strategicNote: z.string().nullish(),
  notes:         z.string().nullish(),

  attribution: AttributionSchema,
})
.refine(d => {
  if (d.yearRetirement != null && d.yearCommissioned != null) {
    return d.yearRetirement > d.yearCommissioned
  }
  return true
}, { message: 'yearRetirement must be after yearCommissioned' })

export type PowerPlant = z.infer<typeof PowerPlantSchema>
export type PlantType   = z.infer<typeof PlantTypeSchema>
export type PlantStatus = z.infer<typeof PlantStatusSchema>
