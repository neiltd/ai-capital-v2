import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { PATHS } from '../../lib/paths.ts';
import type { EventAnalysis, CountryBrief } from '../../admin/types.ts';

// ── Analysis store (event_id → EventAnalysis) ─────────────────────────────────

export function loadAnalysisStore(): EventAnalysis[] {
  if (!existsSync(PATHS.intelligence.human.analysisStore)) return [];
  try {
    return JSON.parse(readFileSync(PATHS.intelligence.human.analysisStore, 'utf-8')) as EventAnalysis[];
  } catch {
    return [];
  }
}

function saveAnalysisStore(analyses: EventAnalysis[]): void {
  mkdirSync(PATHS.intelligence.human.root, { recursive: true });
  writeFileSync(PATHS.intelligence.human.analysisStore, JSON.stringify(analyses, null, 2));
}

export function getAnalysisById(eventId: string): EventAnalysis | undefined {
  return loadAnalysisStore().find(a => a.event_id === eventId);
}

export function upsertAnalysis(analysis: EventAnalysis): void {
  const store = loadAnalysisStore();
  const idx = store.findIndex(a => a.event_id === analysis.event_id);
  if (idx >= 0) {
    store[idx] = analysis;
  } else {
    store.push(analysis);
  }
  saveAnalysisStore(store);
}

// ── Briefs store (iso3 → CountryBrief) ───────────────────────────────────────

export function loadBriefs(): CountryBrief[] {
  if (!existsSync(PATHS.intelligence.human.briefs)) return [];
  try {
    return JSON.parse(readFileSync(PATHS.intelligence.human.briefs, 'utf-8')) as CountryBrief[];
  } catch {
    return [];
  }
}

function saveBriefs(briefs: CountryBrief[]): void {
  mkdirSync(PATHS.intelligence.human.root, { recursive: true });
  writeFileSync(PATHS.intelligence.human.briefs, JSON.stringify(briefs, null, 2));
}

export function getBriefByIso3(iso3: string): CountryBrief | undefined {
  return loadBriefs().find(b => b.iso3 === iso3);
}

export function upsertBrief(brief: CountryBrief): void {
  const briefs = loadBriefs();
  const idx = briefs.findIndex(b => b.iso3 === brief.iso3);
  if (idx >= 0) {
    briefs[idx] = brief;
  } else {
    briefs.push(brief);
  }
  saveBriefs(briefs);
}
