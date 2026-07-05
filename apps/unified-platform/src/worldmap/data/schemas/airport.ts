import { z } from 'zod'
import { CoordSchema, ISO3Schema, StrategicImportanceSchema, AttributionSchema } from './_shared'

export const AirportSchema = z.object({
  // ── Identity ──
  // Allow IATA (3-char), ICAO (4-char), or any uppercase slug for military/strategic airports
  id:   z.string().min(2).regex(/^[A-Z0-9-]{2,10}$/, 'ID must be uppercase letters/numbers, 2-10 chars'),
  name: z.string().min(3),
  countryId: ISO3Schema,
  city: z.string().min(1),

  // ── Codes ──
  // .nullish() = accepts string | null | undefined — Gemini returns null for unknown fields
  iata: z.string().length(3).regex(/^[A-Z]{3}$/).nullish(),
  icao: z.string().length(4).regex(/^[A-Z]{4}$/).nullish(),

  // ── Location ──
  coordinates: CoordSchema,

  // ── Traffic (annual) ──
  passengerVolume: z.number().int().nonnegative().nullish(), // null = unknown, 0 = valid (new/military)
  cargoVolume:     z.number().nonnegative().nullish(),       // null = unknown

  // ── Physical ──
  runwayCount: z.number().int().min(1).max(20).nullish(),
  elevationM:  z.number().nullish(),

  // ── Classification ──
  strategicImportance: StrategicImportanceSchema,

  // ── Annotation ──
  geopoliticalNotes: z.string().nullish(),
  notes:             z.string().nullish(),

  // ── Attribution ──
  attribution: AttributionSchema,
})
.refine(d => d.iata != null || d.icao != null, {
  message: 'At least one of iata or icao must be provided (non-null)',
})

export type Airport = z.infer<typeof AirportSchema>
