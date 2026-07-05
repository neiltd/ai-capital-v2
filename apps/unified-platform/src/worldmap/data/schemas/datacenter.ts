import { z } from 'zod'
import { CoordSchema, ISO3Schema, AttributionSchema, YearSchema, StrategicImportanceSchema } from './_shared'

export const DatacenterTierSchema   = z.enum(['1','2','3','4'])
export const DatacenterStatusSchema = z.enum(['operational','construction','planned','decommissioned'])
export const DatacenterTypeSchema   = z.enum(['hyperscale','colocation','enterprise','government','edge'])

export const DatacenterSchema = z.object({
  id:        z.string().min(1).regex(/^DC-[A-Z0-9-]+$/, 'ID must start with DC-'),
  name:      z.string().min(2),
  countryId: ISO3Schema,
  city:      z.string().min(1),

  coordinates: CoordSchema,
  type:        DatacenterTypeSchema,
  status:      DatacenterStatusSchema,

  tierLevel:    DatacenterTierSchema.nullish(),
  capacityMW:   z.number().positive().nullish(),
  floorSpaceM2: z.number().positive().nullish(),
  pue:          z.number().min(1).max(5).nullish(),

  operator: z.string().nullish(),
  owner:    z.string().nullish(),

  yearOpened:   YearSchema.nullish(),
  yearPlanned:  YearSchema.nullish(),

  // ── Importance — for tier-based rendering and digital sovereignty scope ──
  // Note: DatacenterTierSchema (Uptime Institute I-IV redundancy rating) is separate —
  // strategicImportance is about geopolitical/intelligence significance, not facility spec.
  // Tier 1 (critical): hyperscale DCs serving national cloud infrastructure, military
  // Tier 2 (high): major hyperscale / major colocation, cloud region anchors
  // Tier 3 (medium): significant colocation, enterprise-scale
  // Tier 4 (low): small enterprise / edge nodes
  strategicImportance: StrategicImportanceSchema.nullish(),

  cloudRegion:       z.string().nullish(),
  geopoliticalNotes: z.string().nullish(),
  notes:             z.string().nullish(),

  attribution: AttributionSchema,
})

export type Datacenter       = z.infer<typeof DatacenterSchema>
export type DatacenterTier   = z.infer<typeof DatacenterTierSchema>
export type DatacenterStatus = z.infer<typeof DatacenterStatusSchema>
