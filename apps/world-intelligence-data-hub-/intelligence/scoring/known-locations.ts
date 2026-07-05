// Known-location bonus for the article scorer.
//
// Loads the worldmap facility datasets (hospitals, refineries, mines, water)
// + the 10 strategic chokepoints, and exposes a single function that returns
// matches in an article text. Used by article-scorer.ts to bump priority of
// articles that touch geography we already track.
//
// The same matching logic lives in apps/unified-platform/src/app/api/
// trade-graph/events/route.ts. Keep them aligned — when one changes, sync
// the other. V2 candidate: extract into a tiny @common package.

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

interface RawFacility { id: string; name: string; country: string; lat: number; lng: number }

// 10 strategic maritime chokepoints — same as the events API.
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
];

function normalizeNeedle(s: string): string | null {
  let t = s.toLowerCase().trim();
  t = t.replace(/\([^)]*\)/g, '').trim();
  t = t.replace(/\b(the|a|an)\s+/g, '');
  t = t.replace(/\s+(hospital|clinic|refinery|mine|plant|terminal|dam|reservoir|datacenter|data center)\s*$/i, '');
  t = t.trim();
  // <6 chars produces too many false positives. e.g. "BP" or "Mayo".
  if (t.length < 6) return null;
  return t;
}

interface FacilityEntry { type: string; id: string; needle: string }

function workspaceRoot(): string {
  // known-locations.ts → walk up to find pnpm-workspace.yaml.
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== '/') {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = join(dir, '..');
  }
  return process.cwd();
}

let _facilities: FacilityEntry[] | null = null;

function loadFacilities(): FacilityEntry[] {
  if (_facilities) return _facilities;
  const base = join(workspaceRoot(),
    'apps', 'unified-platform', 'src', 'worldmap', 'data', 'validated');

  const out: FacilityEntry[] = [];
  function load(type: string, file: string): void {
    const path = join(base, file);
    if (!existsSync(path)) return;
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as RawFacility[];
      for (const r of data) {
        if (!r.name || !r.id) continue;
        const needle = normalizeNeedle(r.name);
        if (!needle) continue;
        out.push({ type, id: r.id, needle });
      }
    } catch { /* skip */ }
  }
  load('hospital', 'hospitals.json');
  load('refinery', 'refineries.json');
  load('mine',     'critical-mineral-mines.json');
  load('water',    'water-infrastructure.json');

  _facilities = out;
  return out;
}

export interface LocationMatch {
  type:      'chokepoint' | 'facility'
  category:  string         // facility type ('refinery', 'hospital', …) or 'chokepoint'
  id:        string
  matchedOn: string
}

/**
 * Returns every known-location match in the article text. Deduplicates by
 * (type, id). Used to bump article relevance score.
 */
export function findKnownLocations(text: string): LocationMatch[] {
  const blob = text.toLowerCase();
  const out: LocationMatch[] = [];
  const seen = new Set<string>();

  // Chokepoints
  for (const { id, needles } of CHOKEPOINT_PATTERNS) {
    for (const n of needles) {
      if (blob.includes(n)) {
        const k = `chokepoint:${id}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ type: 'chokepoint', category: 'chokepoint', id, matchedOn: n });
        }
        break;
      }
    }
  }

  // Facilities
  for (const f of loadFacilities()) {
    if (blob.includes(f.needle)) {
      const k = `${f.type}:${f.id}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ type: 'facility', category: f.type, id: f.id, matchedOn: f.needle });
      }
    }
  }
  return out;
}
