export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// Reads world-intel events from disk (events/<date>.json) and tags each one
// with the trade-graph chokepoints + countries it likely affects.
//
// "Trade-disrupting" = event_type in the SHORTLIST + severity ≥ 3, OR the
// title/summary names a known chokepoint (catches missile strikes that aren't
// formally 'sanctions' but close a strait).
//
// Affected lanes are computed client-side in the layer using the existing
// chokepointRoutes + tickerDeps indexes.

interface RawEvent {
  event_id: string
  event: { title: string; summary: string; event_type: string; severity: number; status: string }
  geography: { countries: string[] }
  identity: { first_seen_at: string; extracted_at: string }
}

const TRADE_DISRUPTING_TYPES = new Set<string>([
  'sanctions',
  'trade_dispute',
  'supply_disruption',
  'energy_infrastructure',
  'opec_decision',
  'commodity_price_move',
])

// Free-text matchers for chokepoint mentions. Lower-case search in title+summary.
// Keep `id` matching the trade.chokepoints rows so the client can index by id.
const CHOKEPOINT_PATTERNS: Array<{ id: string; needles: string[] }> = [
  { id: 'hormuz',            needles: ['hormuz', 'persian gulf', 'strait of hormuz'] },
  { id: 'suez',              needles: ['suez', 'suez canal'] },
  { id: 'malacca',           needles: ['malacca', 'strait of malacca'] },
  { id: 'panama',            needles: ['panama canal'] },
  { id: 'bab_el_mandeb',     needles: ['bab-el-mandeb', 'bab el-mandeb', 'red sea', 'houthi'] },
  { id: 'bosphorus',         needles: ['bosphorus', 'bosphorus strait'] },
  { id: 'cape_of_good_hope', needles: ['cape of good hope', 'cape town shipping'] },
  { id: 'drake',             needles: ['drake passage', 'cape horn'] },
  { id: 'taiwan_strait',     needles: ['taiwan strait', 'taiwan blockade'] },
  { id: 'english_channel',   needles: ['english channel'] },
]

interface TaggedEvent {
  eventId:              string
  title:                string
  summary:              string
  eventType:            string
  severity:             number
  status:               string
  occurredAt:           string   // ISO datetime
  expiresAt:            string   // ISO datetime — 24h after occurredAt
  affectedCountries:    string[]
  affectedChokepoints:  string[]
  affectedFacilities:   AffectedFacility[]
}

interface AffectedFacility {
  type:        'hospital' | 'refinery' | 'mine' | 'water' | 'datacenter'
  id:          string
  name:        string
  country:     string
  lat:         number
  lng:         number
  matchedOn:   string   // the needle that hit (for debug/UI tooltip)
}

// ── Facility detection ──────────────────────────────────────────────────────
// Substring-match facility names from the worldmap data files against the
// event title+summary. To avoid false positives we use a normalized form
// (lowercase, strip "the", "a", trailing parentheticals) AND require
// length >= 6 chars (so we don't false-match short names like "BP").
//
// Country context is also a filter — if the event has affectedCountries
// and the facility's country isn't in that set, we skip the match.

interface RawFacility { id: string; name: string; country: string; lat: number; lng: number }

function normalizeNeedle(s: string): string | null {
  let t = s.toLowerCase().trim()
  // Drop parentheticals + qualifiers
  t = t.replace(/\([^)]*\)/g, '').trim()
  t = t.replace(/\b(the|a|an)\s+/g, '')
  t = t.replace(/\s+(hospital|clinic|refinery|mine|plant|terminal|dam|reservoir|datacenter|data center)\s*$/i, '')
  t = t.trim()
  // Need >= 6 chars to avoid false positives like "bp" or "mayo"
  if (t.length < 6) return null
  return t
}

interface FacilityIndex {
  type: AffectedFacility['type']
  entries: Array<{ raw: RawFacility; needle: string }>
}

let _facilityIndex: FacilityIndex[] | null = null
let _facilityIndexMtimeMs = 0

const FACILITY_FILES: Array<[AffectedFacility['type'], string]> = [
  ['hospital', 'hospitals.json'],
  ['refinery', 'refineries.json'],
  ['mine',     'critical-mineral-mines.json'],
  ['water',    'water-infrastructure.json'],
  // Note: datacenters.json uses different field names (coordinates: [lng, lat]
  // and countryId instead of country). Skip for V1 — V2 can normalize.
]

// Reload the index if any source file's mtime is newer than what we last loaded —
// picks up pipeline-regenerated facility data without needing a server restart.
function latestMtimeMs(base: string): number {
  let latest = 0
  for (const [, file] of FACILITY_FILES) {
    const path = join(base, file)
    if (!existsSync(path)) continue
    const mtime = statSync(path).mtimeMs
    if (mtime > latest) latest = mtime
  }
  return latest
}

function loadFacilityIndex(): FacilityIndex[] {
  const base = join(workspaceRoot(), 'apps', 'unified-platform', 'src', 'worldmap', 'data', 'validated')
  const currentMtimeMs = latestMtimeMs(base)
  if (_facilityIndex && currentMtimeMs <= _facilityIndexMtimeMs) return _facilityIndex

  function load(type: AffectedFacility['type'], file: string): FacilityIndex {
    const path = join(base, file)
    if (!existsSync(path)) return { type, entries: [] }
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as RawFacility[]
      const entries: FacilityIndex['entries'] = []
      for (const r of data) {
        if (!r.name || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue
        const needle = normalizeNeedle(r.name)
        if (!needle) continue
        entries.push({ raw: r, needle })
      }
      return { type, entries }
    } catch {
      return { type, entries: [] }
    }
  }

  _facilityIndex = FACILITY_FILES.map(([type, file]) => load(type, file))
  _facilityIndexMtimeMs = currentMtimeMs
  return _facilityIndex
}

function detectFacilities(title: string, summary: string, eventCountries: string[]): AffectedFacility[] {
  const blob = `${title} ${summary}`.toLowerCase()
  const countrySet = new Set(eventCountries)
  const out: AffectedFacility[] = []
  const seen = new Set<string>()
  for (const { type, entries } of loadFacilityIndex()) {
    for (const { raw, needle } of entries) {
      if (!blob.includes(needle)) continue
      // Country filter — when the event has named countries, the facility
      // must be in one of them. When it doesn't, accept any match.
      if (countrySet.size > 0 && !countrySet.has(raw.country)) continue
      const dedupKey = `${type}:${raw.id}`
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)
      out.push({
        type, id: raw.id, name: raw.name, country: raw.country,
        lat: raw.lat, lng: raw.lng, matchedOn: needle,
      })
    }
  }
  return out
}

function workspaceRoot(): string {
  // We're at apps/unified-platform/src/app/api/trade-graph/events/route.ts
  // Walk up to the dir holding pnpm-workspace.yaml.
  let dir = process.cwd()
  while (dir !== '/') {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    dir = join(dir, '..')
  }
  return process.cwd()
}

function listRecentEventFiles(eventsDir: string, sinceDays: number): string[] {
  if (!existsSync(eventsDir)) return []
  const all = readdirSync(eventsDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
  // Last N days. Cheap: take last sinceDays entries by alphabetical order
  // (date format is lexicographic).
  return all.slice(-sinceDays).map(f => join(eventsDir, f))
}

function tagEvent(raw: RawEvent): TaggedEvent | null {
  const title   = raw.event.title   ?? ''
  const summary = raw.event.summary ?? ''
  const blob    = `${title} ${summary}`.toLowerCase()

  // Detect chokepoint mentions regardless of event type — a missile strike that
  // closes Hormuz is more important than its taxonomy label.
  const affectedChokepoints: string[] = []
  for (const { id, needles } of CHOKEPOINT_PATTERNS) {
    if (needles.some(n => blob.includes(n))) affectedChokepoints.push(id)
  }

  const typeMatch  = TRADE_DISRUPTING_TYPES.has(raw.event.event_type)
  const sevHigh    = (raw.event.severity ?? 0) >= 3
  const chokeMatch = affectedChokepoints.length > 0

  // Trade-disrupting = (right type AND severity≥3) OR (chokepoint mention).
  if (!chokeMatch && !(typeMatch && sevHigh)) return null

  const occurredAt = raw.identity.first_seen_at ?? raw.identity.extracted_at
  const occMs      = new Date(occurredAt).getTime()
  const expiresAt  = new Date(occMs + 24 * 60 * 60 * 1000).toISOString()

  const affectedCountries = raw.geography?.countries?.filter(c => /^[A-Z]{3}$/.test(c)) ?? []
  const affectedFacilities = detectFacilities(title, summary, affectedCountries)
  return {
    eventId:             raw.event_id,
    title,
    summary,
    eventType:           raw.event.event_type,
    severity:            raw.event.severity,
    status:              raw.event.status,
    occurredAt,
    expiresAt,
    affectedCountries,
    affectedChokepoints,
    affectedFacilities,
  }
}

export async function GET() {
  try {
    const eventsDir = join(workspaceRoot(),
      'apps', 'world-intelligence-data-hub-', 'intelligence', 'outputs', 'events')
    const files = listRecentEventFiles(eventsDir, 3)  // last 3 days covers the 24h window even on Sunday

    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const tagged: TaggedEvent[] = []

    for (const file of files) {
      let parsed: unknown
      try { parsed = JSON.parse(readFileSync(file, 'utf-8')) }
      catch { continue }
      const events: RawEvent[] = Array.isArray(parsed)
        ? parsed as RawEvent[]
        : ((parsed as { events?: RawEvent[] }).events ?? [])
      for (const ev of events) {
        const t = tagEvent(ev)
        if (!t) continue
        if (new Date(t.expiresAt).getTime() < Date.now()) continue   // already expired
        if (new Date(t.occurredAt).getTime() < cutoff)   continue    // older than 24h
        tagged.push(t)
      }
    }

    // Most recent first.
    tagged.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())

    return NextResponse.json({
      events: tagged,
      windowHours: 24,
      countSourcesScanned: files.length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[api/trade-graph/events] error:', message)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
