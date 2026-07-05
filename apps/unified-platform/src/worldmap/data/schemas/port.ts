import { z } from 'zod'
import { CoordSchema, ISO3Schema, StrategicImportanceSchema, AttributionSchema } from './_shared'

export const PortTypeSchema = z.enum(['container', 'oil', 'lng', 'bulk', 'multipurpose', 'naval', 'mixed'])
export type PortType = z.infer<typeof PortTypeSchema>

// 'critical' added — consistent with conflict intensity scale (e.g. Ukraine Black Sea ports)
export const PortRiskLevelSchema = z.enum(['low', 'medium', 'high', 'extreme', 'critical'])
export type PortRiskLevel = z.infer<typeof PortRiskLevelSchema>

export const PortSchema = z.object({
  id:        z.string().min(1).regex(/^PORT-[A-Z0-9-]+$/, 'ID must start with PORT-'),
  name:      z.string().min(3),
  countryId: ISO3Schema,
  city:      z.string().min(1),

  coordinates: CoordSchema,
  type:        PortTypeSchema,

  // ── Throughput — nullish: Gemini returns null for unknown values ──
  annualThroughputTEU:    z.number().nonnegative().nullish(),
  annualThroughputTonnes: z.number().nonnegative().nullish(),

  // ── Physical ──
  berthCount:   z.number().int().nonnegative().nullish(),
  maxDraftM:    z.number().positive().nullish(),
  areaHectares: z.number().positive().nullish(),

  // ── Classification ──
  strategicImportance: StrategicImportanceSchema,
  riskLevel:           PortRiskLevelSchema.nullish(),

  // ── Annotation ──
  geopoliticalNotes: z.string().nullish(),
  notes:             z.string().nullish(),

  attribution: AttributionSchema,
})

export type Port = z.infer<typeof PortSchema>
