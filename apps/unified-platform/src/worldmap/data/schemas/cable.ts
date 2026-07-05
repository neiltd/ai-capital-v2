import { z } from 'zod'
import { CoordSchema, ISO3Schema, AttributionSchema, StrategicImportanceSchema } from './_shared'

export const CableStatusSchema = z.enum(['active','planned','construction','damaged','decommissioned','unknown'])
export type CableStatus = z.infer<typeof CableStatusSchema>

export const LandingPointSchema = z.object({
  name:        z.string().min(1),
  countryId:   ISO3Schema,
  coordinates: CoordSchema,
  city:        z.string().nullish(),
})

export const SubmarineCableSchema = z.object({
  id:   z.string().min(2),  // allow any non-empty string — Gemini uses varied cable naming
  name: z.string().min(3),

  route:         z.array(CoordSchema).min(2, 'Route must have at least 2 coordinate points'),
  landingPoints: z.array(LandingPointSchema).min(2, 'Must have at least 2 landing points'),

  status: CableStatusSchema,

  lengthKm:      z.number().positive().nullish(),
  capacityTbps:  z.number().positive().nullish(),
  yearLaid:      z.number().int().min(1850).max(2040).nullish(),
  yearRepaired:  z.number().int().min(1850).max(2040).nullish(),

  owners:    z.array(z.string()).nullish(),
  operators: z.array(z.string()).nullish(),

  // ── Importance — for digital sovereignty thematic scope ──
  // Tier 1 (critical): transoceanic cables carrying >20% of intercontinental traffic
  // Tier 2 (high): major regional cables, alternative transoceanic routes
  // Tier 3 (medium): regional connectivity cables
  // Tier 4 (low): short coastal cables, redundant backups
  strategicImportance: StrategicImportanceSchema.nullish(),

  vulnerabilities:   z.string().nullish(),
  geopoliticalNotes: z.string().nullish(),
  notes:             z.string().nullish(),

  attribution: AttributionSchema,
})

export type SubmarineCable = z.infer<typeof SubmarineCableSchema>
export type LandingPoint    = z.infer<typeof LandingPointSchema>
