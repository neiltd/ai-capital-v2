/**
 * Import contract schemas — what this project expects from the shared data hub.
 *
 * The hub PRODUCES these files. This project CONSUMES them.
 * These Zod schemas are the binding contract between the two.
 *
 * If the hub changes a field name or type, update this file first.
 * All downstream code (adapter, store, layers) will fail at the Zod parse step
 * rather than silently rendering wrong data.
 *
 * ─── Files expected at src/data/imports/ ─────────────────────────────────────
 *   events.json            — geopolitical events for map display
 *   energy-indicators.json — commodity prices (Brent, WTI, Henry Hub, etc.)
 *   macro-indicators.json  — World Bank economic indicators by country
 *   manifest.json          — metadata about the import batch
 *
 * ─── Hub contract version ────────────────────────────────────────────────────
 * SCHEMA_VERSION = '1.0.0'
 * The hub must include this version in each file's `schemaVersion` field.
 * This project rejects imports with a mismatched major version.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod'

export const SCHEMA_VERSION = '1.0.0'

// ── Shared primitives ─────────────────────────────────────────────────────────

const ISO3 = z.string().length(3).regex(/^[A-Z]{3}$/)
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

// ── EventAnalysis — optional deep analysis attached to an event by the admin panel ──

const ActorGoalSchema = z.object({
  name:        z.string(),
  stated_goal: z.string(),
  real_goal:   z.string(),
  red_lines:   z.string(),
})

const BlocPerspectiveSchema = z.object({
  bloc:             z.string(),
  how_they_see_it:  z.string(),
  their_interest:   z.string(),
  internal_tension: z.string(),
})

export const EventAnalysisSchema = z.object({
  what_happened:      z.string(),
  historical_context: z.string(),
  political_analysis: z.string(),
  social_analysis:    z.string(),
  actor_goals:        z.array(ActorGoalSchema),
  bloc_perspectives:  z.array(BlocPerspectiveSchema),
  what_to_watch:      z.array(z.string()),
  confidence: z.object({
    score:     z.number().min(0).max(1),
    reasoning: z.string(),
  }),
})

// ── events.json ───────────────────────────────────────────────────────────────

export const ImportedEventSchema = z.object({
  id:             z.string().min(1),
  source:         z.enum(['acled', 'gdelt', 'newsapi', 'manual', 'rss_intelligence']),
  eventDate:      DateStr,
  iso3:           z.array(ISO3).min(1),
  coordinates:    z.tuple([z.number(), z.number()]).optional(), // [lng, lat]

  // Coordinate provenance — set by the hub, never inferred by the frontend.
  // Values are the hub contract canonical names (PM-confirmed 2026-05-14):
  //   'source_exact'    — confirmed GPS/address point (e.g. ACLED field report)
  //   'source_approx'   — neighborhood/district level (e.g. Nominatim geocode)
  //   'country_centroid'— country centroid only, no sub-national location known
  //   'missing'         — no coordinates available; frontend must omit from map
  coordinateQuality: z.enum(['source_exact', 'source_approx', 'country_centroid', 'missing']).optional(),
  // coordinateSource: what produced the coordinates (e.g. 'acled-field', 'nominatim', 'gadm-centroid')
  coordinateSource:  z.string().optional(),

  // Classification
  eventType: z.enum([
    'conflict.armed', 'conflict.protest', 'conflict.riot', 'conflict.cyberattack',
    'diplomatic.cooperation', 'diplomatic.dispute',
    'economic.sanctions', 'economic.trade',
    'energy.disruption',
    'political.election', 'political.coup', 'political.policy',
    'humanitarian.disaster', 'humanitarian.crisis',
    'other',
  ]),

  // Content
  headline:       z.string().max(300),
  summary:        z.string().optional(),
  sourceUrl:      z.string().url().optional(),

  // Signals
  fatalities:     z.number().int().min(0).optional(),
  mentionCount:   z.number().int().min(0).optional(),

  // Quality
  confidenceScore: z.number().min(0).max(1),
  confidenceLabel: z.enum(['high', 'medium', 'low']),

  // Impact tiers (1 = global, 2 = regional, 3 = local)
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),

  // Optional intelligence enrichment (when hub has run analysis)
  tags:                z.array(z.string()).optional(),
  economicImpactScore: z.number().min(0).max(10).optional(),
  geopoliticalScore:   z.number().min(0).max(10).optional(),
  opportunityScore:    z.number().min(0).max(10).optional(),

  // Optional deep analysis — populated by admin panel when user has reviewed the event
  analysis: EventAnalysisSchema.optional(),
})

export const EventsImportSchema = z.object({
  schemaVersion: z.string(),
  generatedAt:   z.string(),
  source:        z.string(),           // hub identifier e.g. 'world-intelligence-hub'
  eventCount:    z.number().int(),
  dateRange:     z.object({
    from: DateStr,
    to:   DateStr,
  }),
  events: z.array(ImportedEventSchema),
})

// ── energy-indicators.json ────────────────────────────────────────────────────

export const EnergyIndicatorSchema = z.object({
  indicatorKey:  z.string(),           // 'brent_crude_usd_bbl', 'wti_crude_usd_bbl', etc.
  indicatorName: z.string(),
  unit:          z.string(),           // 'USD/barrel', 'USD/MMBtu', etc.
  source:        z.string(),           // 'eia'
  // Time series — most recent first
  series: z.array(z.object({
    period: DateStr,
    value:  z.number(),
  })).min(1),
})

export const EnergyImportSchema = z.object({
  schemaVersion: z.string(),
  generatedAt:   z.string(),
  asOf:          DateStr,
  indicators:    z.array(EnergyIndicatorSchema),
})

// ── macro-indicators.json ─────────────────────────────────────────────────────

export const MacroImportSchema = z.object({
  schemaVersion: z.string(),
  generatedAt:   z.string(),
  asOf:          z.string(),           // 'YYYY' or 'YYYY-MM'
  source:        z.string(),           // 'worldbank'
  // ISO3 → { indicatorKey: value }
  // Values are already normalised to 0–10 for indicator heatmap compatibility
  // alongside the raw absolute value stored separately
  byCountry: z.record(
    ISO3,
    z.record(z.string(), z.number())
  ),
})

// ── manifest.json ─────────────────────────────────────────────────────────────

export const ManifestSchema = z.object({
  schemaVersion: z.string(),
  generatedAt:   z.string(),
  hub:           z.string(),
  contents: z.object({
    events: z.object({
      count: z.number().int(),
      from:  DateStr,
      to:    DateStr,
    }),
    energyIndicators: z.object({
      count: z.number().int(),
      asOf:  z.string(),
    }),
    macroIndicators: z.object({
      countryCount:    z.number().int(),
      indicatorCount:  z.number().int(),
      asOf:            z.string(),
    }),
  }),
})

// ── intelligence-briefs.json ──────────────────────────────────────────────────

const AlignmentMapSchema = z.object({
  primary_alignment:  z.string(),
  secondary_ties:     z.string(),
  internal_factions:  z.string(),
  fault_lines:        z.string(),
})

export const CountryBriefSchema = z.object({
  iso3:               z.string().length(3),
  situation_overview: z.string(),
  key_dynamics:       z.string(),
  historical_roots:   z.string(),
  actor_map:          z.string(),
  alignment_map:      AlignmentMapSchema,
  watchlist:          z.array(z.string()),
  last_reviewed:      z.string(),
  last_synthesized:   z.string(),
})

export const IntelligenceBriefImportSchema = z.object({
  schemaVersion: z.string(),
  generatedAt:   z.string(),
  briefs:        z.array(CountryBriefSchema),
})

// ── Exported types ────────────────────────────────────────────────────────────

export type ImportedEvent    = z.infer<typeof ImportedEventSchema>
export type EventsImport     = z.infer<typeof EventsImportSchema>
export type EnergyIndicator  = z.infer<typeof EnergyIndicatorSchema>
export type EnergyImport     = z.infer<typeof EnergyImportSchema>
export type MacroImport      = z.infer<typeof MacroImportSchema>
export type ImportManifest   = z.infer<typeof ManifestSchema>
export type EventAnalysis           = z.infer<typeof EventAnalysisSchema>
export type CountryBrief            = z.infer<typeof CountryBriefSchema>
export type IntelligenceBriefImport = z.infer<typeof IntelligenceBriefImportSchema>
