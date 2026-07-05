/**
 * Pure indicator data layer — no React dependencies.
 *
 * Merges three static validated sources into a single ISO3-keyed index,
 * normalising all values to a 0–10 scale for uniform color rendering.
 *
 * Sources:
 *   indicators-index.json  — geopolitical scores (7 indicators, ~214 countries)
 *   utilities.json         — energy mix + water stress (34 countries)
 *   food-security.json     — GFSI food security score (22 countries)
 *
 * ─── Future agent integration point ───────────────────────────────────────────
 * When AI agents begin producing intelligence data, they should write to
 * data/validated/ in the same shape as the sources above. The pipeline:
 *
 *   Agent output → data/raw/<type>/   (gitignored, Gemini/agent workspace)
 *                → npm run validate:data   (Zod schema check)
 *                → data/validated/<type>.json
 *                → indicators-index.json is rebuilt from validated data
 *
 * This module reads from data/validated/ only — agents never write here directly.
 * The allIndicators object is immutable after construction; agents trigger a
 * build-time rebuild, not a runtime mutation.
 *
 * For future real-time updates (e.g. live news scoring), the buildIndicatorsIndex()
 * function can be called again with a merged dataset and the result re-exported.
 * The component layer reads allIndicators without knowing if it was built once or
 * rebuilt — keeping the interface stable across static and dynamic modes.
 * ──────────────────────────────────────────────────────────────────────────────
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import indicatorsIndex  from '../../data/indicators-index.json'
import utilitiesData    from '../../data/validated/utilities.json'
import foodSecurityData from '../../data/validated/food-security.json'

/** ISO3 → { indicatorKey: normalised 0–10 score } */
export type IndicatorsMap = Record<string, Record<string, number>>

/**
 * Indicators where a HIGH score means BAD (color scale is inverted).
 * Defined here rather than in the store because this is pure domain knowledge,
 * not UI state. Both map rendering and the heatmap legend read from this set.
 *
 * Future: this set may grow as new indicators are added (e.g. corruption index,
 * inequality score). Add the key here and ensure the pipeline normalises the
 * raw value to 0–10 where 10 = worst.
 */
export const INVERTED_INDICATORS = new Set<string>([
  'fossilFuelShare',   // 0–10 where 10 = 100% fossil = bad
  'waterStressScore',  // 0–10 where 10 = extreme stress = bad
])

/**
 * Build the unified indicator index from all validated sources.
 * Called once at module load. Produces an immutable snapshot.
 *
 * Performance note: at ~214 countries × ~12 indicators this runs in <1ms.
 * If country count grows to thousands (e.g. admin1 sub-national data), consider
 * moving this to a build-time script that writes a pre-merged JSON instead.
 */
function buildIndicatorsIndex(): IndicatorsMap {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const index: IndicatorsMap = { ...(indicatorsIndex as any) }

  // Energy mix: electricity generation by source, 0–100% → 0–10
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const u of utilitiesData as any[]) {
    const mix = u.electricityMix as Record<string, number | null> | null
    if (!mix || !u.countryId) continue
    const renewable = (mix.solar ?? 0) + (mix.wind ?? 0) + (mix.hydro ?? 0) + (mix.otherRenewables ?? 0)
    const fossil    = (mix.coal  ?? 0) + (mix.gas   ?? 0) + (mix.oil   ?? 0)
    const nuclear   = mix.nuclear ?? 0
    index[u.countryId] = {
      ...(index[u.countryId] ?? {}),
      renewableShare:   renewable / 10,              // 0–100% → 0–10
      fossilFuelShare:  fossil    / 10,              // 0–100% → 0–10 (inverted)
      nuclearShare:     nuclear   / 10,              // 0–100% → 0–10
      // Aqueduct 0–5 scale: multiply by 2 to normalise to 0–10 (inverted)
      waterStressScore: (u.waterStressScore ?? 0) * 2,
    }
  }

  // Food security: GFSI 0–100 → 0–10
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const f of foodSecurityData as any[]) {
    if (!f.countryId || f.overallScore == null) continue
    index[f.countryId] = {
      ...(index[f.countryId] ?? {}),
      foodSecurityScore: f.overallScore / 10,
    }
  }

  return index
}

/**
 * Unified indicator index — ISO3 → normalised scores (0–10).
 * Immutable after construction. All rendering reads from this object.
 */
export const allIndicators: IndicatorsMap = buildIndicatorsIndex()

/**
 * Maps a normalised score (1–10) to an RGB color string.
 * Scale: red (1) → amber (~5.5) → green (10)
 *
 * Performance note: produces a new string per call. At 214 countries × 1 render
 * per indicator change this is negligible. If rendering thousands of features,
 * switch to a pre-computed Uint8Array palette and index by Math.round(score).
 */
export function scoreToColor(score: number): string {
  const t = (score - 1) / 9
  if (t < 0.5) {
    const u = t * 2
    return `rgb(${Math.round(220 + (217 - 220) * u)},${Math.round(38 + (119 - 38) * u)},38)`
  }
  const u = (t - 0.5) * 2
  return `rgb(${Math.round(217 + (22 - 217) * u)},${Math.round(119 + (163 - 119) * u)},${Math.round(6 + (74 - 6) * u)})`
}

/**
 * Applies the color scale with inversion for indicators where high = bad.
 * Reads from INVERTED_INDICATORS — no side effects.
 */
export function toHeatmapColor(key: string, score: number): string {
  return INVERTED_INDICATORS.has(key)
    ? scoreToColor(Math.max(1, 10 - score + 1))
    : scoreToColor(Math.max(1, score))
}

// ── Indicator domain model ───────────────────────────────────────────────────
// Moved here from store/useMapStore.ts — these are domain constants, not UI state.
// The store imports IndicatorKey as a type for heatmapIndicator.
// HeatmapSelector imports all three for display rendering.
//
// Future: add new indicator keys here and update INDICATOR_LABELS + INDICATOR_GROUPS.
// The store and rendering pipeline pick up new indicators automatically because
// both read from these structures at runtime — no other files need to change.

/**
 * All valid heatmap indicator keys.
 * 'none' means no heatmap is active — countries show relationship/selection colors.
 */
export type IndicatorKey =
  | 'none'
  // ── Geopolitical (1–10 scale, higher = better) ──────────────────────────
  | 'politicalStability'
  | 'economicDirection'
  | 'investmentAttractiveness'
  | 'geopoliticalRisk'
  | 'educationQuality'
  | 'healthcareQuality'
  | 'technologyInvestment'
  // ── Energy (0–100%, normalised to 0–10) ─────────────────────────────────
  | 'renewableShare'       // higher = cleaner grid ↑
  | 'fossilFuelShare'      // higher = more fossil ↓ (inverted)
  | 'nuclearShare'         // higher = more nuclear
  // ── Food & Resources (normalised to 0–10) ────────────────────────────────
  | 'foodSecurityScore'    // GFSI 0–100, higher = more secure ↑
  | 'waterStressScore'     // Aqueduct 0–5, higher = more stress ↓ (inverted)

/** Display labels for the heatmap selector dropdown. */
export const INDICATOR_LABELS: Record<IndicatorKey, string> = {
  none:                     'No heatmap',
  politicalStability:       'Political Stability',
  economicDirection:        'Economic Direction',
  investmentAttractiveness: 'Investment Attractiveness',
  geopoliticalRisk:         'Geopolitical Risk',
  educationQuality:         'Education Quality',
  healthcareQuality:        'Healthcare Quality',
  technologyInvestment:     'Technology Investment',
  renewableShare:           'Renewable Energy %',
  fossilFuelShare:          'Fossil Fuel % ↓',
  nuclearShare:             'Nuclear Energy %',
  foodSecurityScore:        'Food Security (GFSI)',
  waterStressScore:         'Water Stress ↓',
}

/** Grouped indicator keys for the heatmap selector optgroup structure. */
export const INDICATOR_GROUPS: { label: string; keys: IndicatorKey[] }[] = [
  {
    label: 'Geopolitical',
    keys: ['politicalStability', 'economicDirection', 'investmentAttractiveness',
           'geopoliticalRisk', 'educationQuality', 'healthcareQuality', 'technologyInvestment'],
  },
  {
    label: 'Energy',
    keys: ['renewableShare', 'fossilFuelShare', 'nuclearShare'],
  },
  {
    label: 'Food & Water',
    keys: ['foodSecurityScore', 'waterStressScore'],
  },
]
