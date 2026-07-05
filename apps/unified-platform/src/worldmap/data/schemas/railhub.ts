import { z } from 'zod'
import { CoordSchema, ISO3Schema, StrategicImportanceSchema, AttributionSchema } from './_shared'

export const RailHubTypeSchema = z.enum([
  'passenger','freight','mixed','high_speed',
  'border_crossing','port_interface','military',
])

export const RailHubSchema = z.object({
  id:        z.string().min(1).regex(/^RAIL-[A-Z0-9-]+$/, 'ID must start with RAIL-'),
  name:      z.string().min(2),
  countryId: ISO3Schema,
  city:      z.string().min(1),

  coordinates: CoordSchema,
  type:        RailHubTypeSchema,

  dailyPassengers:     z.number().int().positive().nullish(),
  annualFreightTonnes: z.number().positive().nullish(),

  connectedCountries: z.array(ISO3Schema).nullish(),
  gaugeType:          z.enum(['standard','broad','narrow','mixed']).nullish(),
  lineCount:          z.number().int().nonnegative().nullish(),

  strategicImportance: StrategicImportanceSchema,
  isPartOfBRI:         z.boolean().nullish(),

  geopoliticalNotes: z.string().nullish(),
  notes:             z.string().nullish(),

  attribution: AttributionSchema,
})

export type RailHub     = z.infer<typeof RailHubSchema>
export type RailHubType = z.infer<typeof RailHubTypeSchema>
