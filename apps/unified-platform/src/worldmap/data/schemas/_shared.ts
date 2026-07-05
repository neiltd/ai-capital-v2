import { z } from 'zod'

// ─── Coordinate ───────────────────────────────────────────────────────────────
// GeoJSON order: [longitude, latitude]
export const CoordSchema = z
  .tuple([
    z.number().min(-180).max(180, 'Longitude must be between -180 and 180'),
    z.number().min(-90).max(90,   'Latitude must be between -90 and 90'),
  ])
  .refine(([lng, lat]) => !(lng === 0 && lat === 0), {
    message: 'Coordinate [0, 0] is the null island — likely a placeholder. Use null if unknown.',
  })

export type Coord = z.infer<typeof CoordSchema>

// ─── Source attribution (required on every entity) ────────────────────────────
export const SourceRefSchema = z.object({
  name:       z.string().min(1, 'Source name required'),
  url:        z.string().url('Source URL must be a valid URL'),
  accessedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'accessedAt must be YYYY-MM-DD'),
})

export type SourceRef = z.infer<typeof SourceRefSchema>

// ─── Confidence metadata ──────────────────────────────────────────────────────
export const ConfidenceSchema = z.object({
  confidence:   z.enum(['high', 'medium', 'low']),
  sourceCount:  z.number().int().min(1),
  lastVerified: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'lastVerified must be YYYY-MM-DD'),
})

export type Confidence = z.infer<typeof ConfidenceSchema>

// ─── Combined attribution block ───────────────────────────────────────────────
export const AttributionSchema = z.object({
  sources:    z.array(SourceRefSchema).min(1, 'At least one source required'),
  confidence: ConfidenceSchema,
})

export type Attribution = z.infer<typeof AttributionSchema>

// ─── Strategic importance scale ───────────────────────────────────────────────
// This is the infrastructure tiering field used across all spatial entity types.
// Tier mapping (for future render registry and zoom-aware filtering):
//   critical → Tier 1: global arteries — always show
//   high     → Tier 2: regional strategic hubs — show at zoom ≥ 3
//   medium   → Tier 3: contextual infrastructure — show at zoom ≥ 5
//   low      → Tier 4: background / noise — show only at high zoom or in thematic view
//
// All 7 infrastructure entity types should carry this field.
// Entities without it cannot participate in tier-based filtering.
export const StrategicImportanceSchema = z.enum(['low', 'medium', 'high', 'critical'])
export type StrategicImportance = z.infer<typeof StrategicImportanceSchema>

// ─── Thematic scopes ──────────────────────────────────────────────────────────
// Used in LayerMeta (registry) and optionally on individual entities.
// A thematic scope groups layers and entities by geopolitical relevance domain.
// Future: UI lets analyst switch to a thematic view that activates relevant layers.
export const ThematicScopeSchema = z.enum([
  'energy-security',
  'logistics-fragility',
  'digital-sovereignty',
  'semiconductor-supply-chain',
  'maritime-chokepoints',
])
export type ThematicScope = z.infer<typeof ThematicScopeSchema>

// ─── Risk level ───────────────────────────────────────────────────────────────
export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'extreme'])
export type RiskLevel = z.infer<typeof RiskLevelSchema>

// ─── ISO 3166-1 alpha-3 (partial list — expand as needed) ────────────────────
// Validates the format only; full country list in scripts/_iso3.ts
export const ISO3Schema = z
  .string()
  .length(3, 'ISO country code must be exactly 3 characters')
  .regex(/^[A-Z]{3}$/, 'ISO3 code must be uppercase letters only')

// ─── Year ─────────────────────────────────────────────────────────────────────
export const YearSchema = z
  .number()
  .int()
  .min(1850)
  .max(new Date().getFullYear() + 30)  // allow future retirement/planned dates up to 30 yrs

// ─── Percentage (0–100) ───────────────────────────────────────────────────────
export const PctSchema = z.number().min(0).max(100)

// ─── Percentage sum check helper ──────────────────────────────────────────────
export function assertSumsTo100(
  values: (number | undefined | null)[],
  tolerance = 2
): boolean {
  const sum = values.reduce<number>((acc, v) => acc + (v ?? 0), 0)
  return Math.abs(sum - 100) <= tolerance
}
