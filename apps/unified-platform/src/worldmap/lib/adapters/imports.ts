/**
 * Import adapter — fetches and validates hub-exported JSON files at runtime.
 *
 * Files live in public/data/imports/ and are served as static assets.
 * This mirrors the existing pattern used for countries-110m.json.
 *
 * Loading strategy:
 *   1. Try the real file (e.g. events.json) — dropped by the hub on deploy
 *   2. If 404, try the example file (events.example.json) — committed for dev
 *   3. If both fail, return an empty fallback and log a warning
 *
 * This means the app runs correctly in three modes:
 *   - Production:   hub drops real files → real data shown
 *   - Development:  example files committed → sample data shown
 *   - Offline:      nothing found → app runs with no intelligence data
 *
 * Every loader also reports an `origin` ('live' | 'example' | 'empty') so
 * callers (and ultimately the UI) can tell real hub data from placeholder
 * sample data instead of treating both as indistinguishable "live" data.
 *
 * ─── Data flow ────────────────────────────────────────────────────────────────
 *   public/data/imports/{file}.json    (hub-produced, gitignored)
 *   public/data/imports/{file}.example.json  (sample, committed)
 *       │  fetched at runtime via fetch()
 *       ▼
 *   loadImports()  ← validates each file with Zod
 *       │
 *       ▼
 *   useIntelligenceStore  ← typed runtime state
 *       │
 *       ▼
 *   Map layers / CountryPanel  ← read from store, render only
 *
 * ─── Future agent integration point ──────────────────────────────────────────
 * Agents write enriched versions of the same files (same schema, optional
 * fields populated). No changes to this adapter required — the optional
 * fields flow through as-is.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  EventsImportSchema,
  ManifestSchema,
  SCHEMA_VERSION,
  type ImportedEvent,
  type ImportManifest,
} from '../../data/schemas/imports'

// Where a loaded resource's data actually came from.
export type ImportOrigin = 'live' | 'example' | 'empty'

interface FetchResult<T> {
  data:   T
  origin: ImportOrigin
}

// ── Runtime fetch — tries real file then example file ────────────────────────
async function tryFetch<T>(filename: string, fallback: T): Promise<FetchResult<T>> {
  const base = `${process.env.NEXT_PUBLIC_BASE_URL ?? '/'}data/imports/`
  const candidates = [filename, filename.replace('.json', '.example.json')]

  for (const candidate of candidates) {
    try {
      const res = await fetch(`${base}${candidate}`)
      if (res.ok) {
        const data = await res.json() as T
        const origin: ImportOrigin = candidate === filename ? 'live' : 'example'
        if (origin === 'example') {
          console.info(`[imports] Using example file: ${candidate}`)
        }
        return { data, origin }
      }
      if (res.status !== 404) {
        console.warn(`[imports] ${candidate} returned HTTP ${res.status}`)
      }
    } catch (e) {
      console.warn(`[imports] Failed to fetch ${candidate}:`, (e as Error).message)
    }
  }

  console.warn(`[imports] ${filename} not found — intelligence data unavailable for this source.`)
  return { data: fallback, origin: 'empty' }
}

// ── Schema version guard ──────────────────────────────────────────────────────
function checkVersion(schemaVersion: string, filename: string): boolean {
  const [importedMajor] = schemaVersion.split('.')
  const [expectedMajor] = SCHEMA_VERSION.split('.')
  if (importedMajor !== expectedMajor) {
    console.error(
      `[imports] ${filename} schema version mismatch — ` +
      `expected major ${expectedMajor}, got ${schemaVersion}. ` +
      `Update src/data/schemas/imports.ts to match the hub contract.`
    )
    return false
  }
  return true
}

// ── Per-file loaders ──────────────────────────────────────────────────────────

export async function loadEvents(): Promise<FetchResult<ImportedEvent[]>> {
  const { data: raw, origin } = await tryFetch<unknown>('events.json', null)
  if (!raw) return { data: [], origin: 'empty' }

  const result = EventsImportSchema.safeParse(raw)
  if (!result.success) {
    console.error('[imports] events.json schema error:', result.error.issues.slice(0, 5))
    return { data: [], origin: 'empty' }
  }
  if (!checkVersion(result.data.schemaVersion, 'events.json')) return { data: [], origin: 'empty' }

  console.info(`[imports] events.json — ${result.data.events.length} events loaded`)
  return { data: result.data.events, origin }
}

export async function loadManifest(): Promise<FetchResult<ImportManifest | null>> {
  const { data: raw, origin } = await tryFetch<unknown>('manifest.json', null)
  if (!raw) return { data: null, origin: 'empty' }

  const result = ManifestSchema.safeParse(raw)
  if (!result.success) {
    console.error('[imports] manifest.json schema error:', result.error.issues.slice(0, 3))
    return { data: null, origin: 'empty' }
  }
  return { data: result.data, origin }
}

// ── Load all imports in one parallel call ─────────────────────────────────────
export interface LoadedImports {
  events:   ImportedEvent[]
  manifest: ImportManifest | null
  // True if any loaded resource's data actually came from a *.example.json
  // fallback rather than real hub-produced data.
  isSample: boolean
}

export async function loadAllImports(): Promise<LoadedImports> {
  const [events, manifest] = await Promise.all([
    loadEvents(),
    loadManifest(),
  ])
  return {
    events:   events.data,
    manifest: manifest.data,
    isSample: events.origin === 'example' || manifest.origin === 'example',
  }
}
