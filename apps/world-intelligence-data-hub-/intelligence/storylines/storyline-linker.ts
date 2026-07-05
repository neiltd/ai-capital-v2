// Cross-day event → storyline linker.
//
// For a given date's event file (post-dedup), matches each event to an
// existing storyline or creates a new one. Writes storyline_id back to the
// event's lifecycle field and persists the updated storyline store.
//
// Matching algorithm (deterministic, no AI):
//   Score = country_overlap(+3) + actor_overlap(+2) + type_match(+3/+1)
//            + title_similarity(+2) + temporal_proximity(+1)
//   Threshold: 5 — requires at least two strong signals to link.
//
// Only storylines with latest_seen_at within 72h are candidates (adjacent days).

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join }         from 'path';
import type { IntelligenceEvent }   from '../schema/intelligence-event.ts';
import type { Storyline, StorylineStore } from '../schema/storyline.ts';
import {
  StorylineSchema,
  generateStorylineId,
  computeStorylineState,
  scoreEventAgainstStoryline,
  MATCH_THRESHOLD,
  EVENT_TYPE_FAMILIES,
  meaningfulWords,
  normalizeText,
} from '../schema/storyline.ts';
import type { SignalBreakdown } from '../schema/storyline.ts';
import { PATHS }   from '../../lib/paths.ts';
import { logger }  from '../../lib/logger.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LinkDecision {
  event_id:        string;
  event_title:     string;
  event_type:      string;
  storyline_id:    string;
  storyline_title: string;
  score:           number;
  signals?:        SignalBreakdown;   // full breakdown of what drove the match
  action:          'linked' | 'created' | 'updated';
  uncertain:       boolean;
  gravity:         boolean;
}

export interface FragmentCluster {
  country:          string;
  family:           string;
  storyline_ids:    string[];
  storyline_titles: string[];
}

export interface StorylineChange {
  storyline_id:     string;
  title:            string;
  events_added:     number;
  state_before:     string;
  state_after:      string;
  cohesion_before:  string | undefined;
  cohesion_after:   string | undefined;
  days_active:      number;
  newly_fading:     boolean;
}

export interface LinkResult {
  date:                string;
  events_processed:    number;
  storylines_new:      number;
  storylines_updated:  number;
  persistence_rate:    number;  // fraction of events that linked to existing storylines
  decisions:           LinkDecision[];
  uncertain:           LinkDecision[];
  gravity_links:       LinkDecision[];
  fragments:           FragmentCluster[];
  changes:             StorylineChange[];  // cross-day comparison vs yesterday's snapshot
  snapshot_date:       string | null;      // date of the snapshot we compared against
}

// ── Persistence ───────────────────────────────────────────────────────────────

const STORYLINE_PATH = join(PATHS.intelligence.outputs, 'storylines', 'storylines.json');

const SNAPSHOT_DIR = join(PATHS.intelligence.outputs, 'storylines', 'snapshots');

function snapshotPath(date: string): string {
  return join(SNAPSHOT_DIR, `${date}.json`);
}

function saveSnapshot(date: string, store: StorylineStore): void {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(snapshotPath(date), JSON.stringify(store, null, 2));
}

function loadSnapshot(date: string): StorylineStore | null {
  const p = snapshotPath(date);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')) as StorylineStore; }
  catch { return null; }
}

// Find the most recent snapshot strictly older than `date`
function loadPreviousSnapshot(date: string): { snapshot: StorylineStore; date: string } | null {
  if (!existsSync(SNAPSHOT_DIR)) return null;
  try {
    const files = readdirSync(SNAPSHOT_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .filter(d => d < date)
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const prevDate = files[0]!;
    const snap = loadSnapshot(prevDate);
    return snap ? { snapshot: snap, date: prevDate } : null;
  } catch { return null; }
}

function loadStore(): StorylineStore {
  if (!existsSync(STORYLINE_PATH)) {
    return { schema_version: '1.0', generated_at: new Date().toISOString(), storylines: [] };
  }
  try {
    return JSON.parse(readFileSync(STORYLINE_PATH, 'utf-8')) as StorylineStore;
  } catch {
    return { schema_version: '1.0', generated_at: new Date().toISOString(), storylines: [] };
  }
}

function saveStore(store: StorylineStore): void {
  mkdirSync(join(PATHS.intelligence.outputs, 'storylines'), { recursive: true });
  store.generated_at = new Date().toISOString();
  writeFileSync(STORYLINE_PATH, JSON.stringify(store, null, 2));
}

interface EventOutputFile {
  date:    string;
  events:  IntelligenceEvent[];
  stats:   Record<string, unknown>;
  [k: string]: unknown;
}

function loadEventFile(date: string): { path: string; file: EventOutputFile } | null {
  const p = join(PATHS.intelligence.outputEvents, `${date}.json`);
  if (!existsSync(p)) return null;
  try {
    return { path: p, file: JSON.parse(readFileSync(p, 'utf-8')) as EventOutputFile };
  } catch {
    return null;
  }
}

function saveEventFile(path: string, file: EventOutputFile): void {
  writeFileSync(path, JSON.stringify(file, null, 2));
}

// ── Event feature extraction ──────────────────────────────────────────────────

function extractActorWords(e: IntelligenceEvent): Set<string> {
  const names = [
    ...(e.actors.individuals   ?? []).map(a => a.name),
    ...(e.actors.organizations ?? []).map(o => o.name),
  ];
  return new Set(names.flatMap(n => normalizeText(n).split(' ').filter(w => w.length > 3)));
}

// ── Storyline creation from an event ─────────────────────────────────────────

function extractSourceIds(event: IntelligenceEvent): string[] {
  return [...new Set(event.sources.extracted_from.map(r => r.source_id))];
}

type FamilySnap = { date: string; composition: Record<string, number>; total_events: number; dominant: string };

function appendFamilyHistory(
  history:     FamilySnap[],
  date:        string,
  composition: Record<string, number>,
  total:       number,
): FamilySnap[] {
  const dominant = Object.entries(composition).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
  const last = history[history.length - 1];
  // Only add a new snapshot when date changes or dominant family changes
  if (last && last.date === date && last.dominant === dominant) {
    // Update the current day's snapshot in-place
    return [...history.slice(0, -1), { date, composition, total_events: total, dominant }];
  }
  const snap: FamilySnap = { date, composition, total_events: total, dominant };
  return [...history.slice(-89), snap];  // cap at 90 entries
}

// Observe which signal drives most links INTO a storyline across all decisions.
export function computeCohesionSignal(
  storyId:   string,
  decisions: LinkDecision[],
): string {
  const linked = decisions.filter(d => d.storyline_id === storyId && d.action === 'updated' && d.signals);
  if (linked.length === 0) return 'none';

  const counts: Record<string, number> = {};
  for (const d of linked) {
    const p = d.signals!.primary;
    counts[p] = (counts[p] ?? 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (top.length === 0) return 'none';
  // If top two signals are tied, call it 'mixed'
  if (top.length >= 2 && top[0]![1] === top[1]![1]) return 'mixed';
  return top[0]![0];
}

function buildFamilyComposition(eventTypes: string[]): Record<string, number> {
  const comp: Record<string, number> = {};
  for (const t of eventTypes) {
    const f = EVENT_TYPE_FAMILIES[t] ?? 'other';
    comp[f] = (comp[f] ?? 0) + 1;
  }
  return comp;
}

function createStoryline(event: IntelligenceEvent, date: string, now: string): Storyline {
  const actorWords = [...extractActorWords(event)];
  const escalation = event.geopolitical_scores.escalation_potential;
  const eventType  = event.event.event_type;

  const s: Storyline = {
    storyline_id:       generateStorylineId(event.event_id),
    title:              event.event.title,
    event_types:        [eventType],
    countries:          [...event.geography.countries],
    actor_names:        actorWords,
    event_ids:          [event.event_id],
    total_events:       1,
    total_sources:      event.sources.source_count,
    runs_seen:          event.sources.runs_seen ?? 1,
    first_seen_at:      event.identity.first_seen_at,
    latest_seen_at:     event.identity.updated_at,
    last_event_date:    date,
    avg_confidence:     event.event.confidence_score,
    max_severity:       event.event.severity,
    escalation_history: [escalation],
    avg_escalation:     escalation,
    storyline_state:    'emerging',
    days_active:        0,
    unique_source_ids:  extractSourceIds(event),
    family_composition: buildFamilyComposition([eventType]),
    family_history:     [{ date, composition: buildFamilyComposition([eventType]), total_events: 1, dominant: EVENT_TYPE_FAMILIES[eventType] ?? 'other' }],
    cohesion_signal:    undefined,
  };

  // Recompute state (might not be 'emerging' if confidence/sources are high)
  s.storyline_state = computeStorylineState({
    total_events:       s.total_events,
    days_active:        s.days_active,
    days_since_last:    0,
    avg_escalation:     s.avg_escalation,
    escalation_history: s.escalation_history,
  });

  return s;
}

// ── Storyline update when a new event is linked ───────────────────────────────

function addEventToStoryline(
  s:     Storyline,
  event: IntelligenceEvent,
  date:  string,
  now:   string,
): Storyline {
  if (s.event_ids.includes(event.event_id)) return s;  // idempotent

  const escalation    = event.geopolitical_scores.escalation_potential;
  const newHistory    = [...s.escalation_history, escalation];
  const avgEsc        = newHistory.reduce((a, b) => a + b, 0) / newHistory.length;
  const newEventTypes = [...new Set([...s.event_types, event.event.event_type])];
  const newCountries  = [...new Set([...s.countries, ...event.geography.countries])];
  const newActors     = [...new Set([...s.actor_names, ...extractActorWords(event)])];
  const totalSources  = s.total_sources + event.sources.source_count;
  const totalEvents   = s.total_events + 1;
  const avgConf       = (s.avg_confidence * s.total_events + event.event.confidence_score) / totalEvents;
  const maxSev        = Math.max(s.max_severity, event.event.severity) as 1|2|3|4|5;

  const firstDate   = new Date(s.first_seen_at);
  const latestDate  = new Date(event.identity.updated_at);
  const daysActive  = Math.round((latestDate.getTime() - firstDate.getTime()) / 86_400_000);
  const daysSinceLast = 0;  // this event is fresh

  // Use highest-confidence event's title as canonical storyline title
  const useNewTitle = event.event.confidence_score > s.avg_confidence;

  const newSourceIds = [...new Set([...s.unique_source_ids, ...extractSourceIds(event)])];

  const updated: Storyline = {
    ...s,
    title:              useNewTitle ? event.event.title : s.title,
    event_types:        newEventTypes,
    countries:          newCountries,
    actor_names:        newActors,
    event_ids:          [...s.event_ids, event.event_id],
    total_events:       totalEvents,
    total_sources:      totalSources,
    runs_seen:          s.runs_seen + (event.sources.runs_seen ?? 1),
    latest_seen_at:     event.identity.updated_at,
    last_event_date:    date,
    avg_confidence:     Math.round(avgConf * 1000) / 1000,
    max_severity:       maxSev,
    escalation_history: newHistory,
    avg_escalation:     Math.round(avgEsc * 1000) / 1000,
    days_active:        daysActive,
    unique_source_ids:  newSourceIds,
    family_composition: buildFamilyComposition(newEventTypes),
    family_history:     appendFamilyHistory(
      s.family_history ?? [],
      date,
      buildFamilyComposition(newEventTypes),
      totalEvents,
    ),
  };

  updated.storyline_state = computeStorylineState({
    total_events:       updated.total_events,
    days_active:        updated.days_active,
    days_since_last:    daysSinceLast,
    avg_escalation:     updated.avg_escalation,
    escalation_history: updated.escalation_history,
  });

  return updated;
}

// ── Fragment detection ────────────────────────────────────────────────────────
// Identifies potential fragmentation: multiple active storylines sharing the same
// primary country AND dominant event family — suggesting they may be fragments
// of the same underlying narrative that didn't link at the time.

function dominantFamilyOf(s: Storyline): string {
  let max = 0;
  let dominant = 'other';
  for (const [fam, n] of Object.entries(s.family_composition)) {
    if (n > max) { max = n; dominant = fam; }
  }
  return dominant;
}

function detectFragments(storylines: Storyline[]): FragmentCluster[] {
  // Only consider non-fading storylines
  const active = storylines.filter(s => s.storyline_state !== 'fading');
  const clusters: FragmentCluster[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!, b = active[j]!;
      const key = [a.storyline_id, b.storyline_id].sort().join(':');
      if (seen.has(key)) continue;

      const sharedCountry = a.countries.find(c => b.countries.includes(c));
      const familyA = dominantFamilyOf(a);
      const familyB = dominantFamilyOf(b);

      if (sharedCountry && familyA === familyB && familyA !== 'other') {
        seen.add(key);
        // Find or extend an existing cluster
        const existing = clusters.find(c =>
          c.country === sharedCountry && c.family === familyA &&
          (c.storyline_ids.includes(a.storyline_id) || c.storyline_ids.includes(b.storyline_id)),
        );
        if (existing) {
          if (!existing.storyline_ids.includes(b.storyline_id)) {
            existing.storyline_ids.push(b.storyline_id);
            existing.storyline_titles.push(b.title);
          }
          if (!existing.storyline_ids.includes(a.storyline_id)) {
            existing.storyline_ids.push(a.storyline_id);
            existing.storyline_titles.push(a.title);
          }
        } else {
          clusters.push({
            country: sharedCountry,
            family:  familyA,
            storyline_ids:    [a.storyline_id, b.storyline_id],
            storyline_titles: [a.title, b.title],
          });
        }
      }
    }
  }

  // Only return clusters with ≥2 storylines (exclude single-storyline non-fragments)
  return clusters.filter(c => c.storyline_ids.length >= 2);
}

// ── Main linking function ─────────────────────────────────────────────────────

export function linkEventsToStorylines(date: string, dryRun = false): LinkResult {
  const loaded = loadEventFile(date);
  if (!loaded) {
    logger.warn('storylines', `No event file for ${date}`);
    return { date, events_processed: 0, storylines_new: 0, storylines_updated: 0, persistence_rate: 0, decisions: [], uncertain: [], gravity_links: [], fragments: [], changes: [], snapshot_date: null };
  }

  const { path: eventFilePath, file: eventFile } = loaded;
  const store   = loadStore();
  const events  = eventFile.events;
  const now     = new Date().toISOString();
  const nowMs   = Date.now();

  // Index existing storylines by id for fast lookup
  const storyMap = new Map<string, Storyline>(store.storylines.map(s => [s.storyline_id, s]));

  // Only consider storylines active within 72h as match candidates
  const PROXIMITY_MS    = 72 * 3_600_000;
  const recentStorylines = store.storylines.filter(s => {
    const latestMs = new Date(s.latest_seen_at).getTime();
    return (nowMs - latestMs) <= PROXIMITY_MS;
  });

  const decisions:  LinkDecision[] = [];
  let newCount      = 0;
  let updatedCount  = 0;

  for (const event of events) {
    // Extract features for matching
    const actorWords  = extractActorWords(event);
    const titleWords  = meaningfulWords(event.event.title);
    const countries   = event.geography.countries;
    const eventType   = event.event.event_type;

    // Score against all recent storylines
    let bestScore:     number             = 0;
    let bestBreakdown: SignalBreakdown | undefined;
    let bestStoryline: Storyline | null   = null;

    for (const s of recentStorylines) {
      if (s.event_ids.includes(event.event_id)) {
        bestScore     = 99;
        bestStoryline = s;
        break;
      }

      const latestMs = new Date(s.latest_seen_at).getTime();
      const temporal = (nowMs - latestMs) <= PROXIMITY_MS;

      const breakdown = scoreEventAgainstStoryline(
        countries, actorWords, eventType, titleWords, s, temporal,
      );

      if (breakdown.total > bestScore) {
        bestScore     = breakdown.total;
        bestBreakdown = breakdown;
        bestStoryline = s;
      }
    }

    let action: LinkDecision['action'];
    let linkedStorylineId: string;
    let linkedStorylineTitle: string;

    if (bestScore === 99 && bestStoryline) {
      // Already linked — idempotent
      action               = 'linked';
      linkedStorylineId    = bestStoryline.storyline_id;
      linkedStorylineTitle = bestStoryline.title;
    } else if (bestScore >= MATCH_THRESHOLD && bestStoryline) {
      // Link to existing storyline
      const updated = addEventToStoryline(bestStoryline, event, date, now);
      storyMap.set(updated.storyline_id, updated);
      // Also add to recentStorylines (in-place update for subsequent events)
      const idx = recentStorylines.findIndex(s => s.storyline_id === updated.storyline_id);
      if (idx >= 0) recentStorylines[idx] = updated;

      action               = 'updated';
      linkedStorylineId    = updated.storyline_id;
      linkedStorylineTitle = updated.title;
      updatedCount++;
    } else {
      // Create new storyline
      const newStory = createStoryline(event, date, now);
      storyMap.set(newStory.storyline_id, newStory);
      recentStorylines.push(newStory);

      action               = 'created';
      linkedStorylineId    = newStory.storyline_id;
      linkedStorylineTitle = newStory.title;
      newCount++;
    }

    // Write storyline_id back to event lifecycle
    event.lifecycle = {
      ...event.lifecycle,
      storyline_id: linkedStorylineId,
    };

    const effectiveScore = bestScore === 99 ? 0 : bestScore;
    const decision: LinkDecision = {
      event_id:        event.event_id,
      event_title:     event.event.title,
      event_type:      event.event.event_type,
      storyline_id:    linkedStorylineId,
      storyline_title: linkedStorylineTitle,
      score:           effectiveScore,
      signals:         bestBreakdown,
      action,
      uncertain: effectiveScore >= MATCH_THRESHOLD && effectiveScore <= MATCH_THRESHOLD + 1,
      gravity:   action === 'updated'
                 && effectiveScore <= MATCH_THRESHOLD + 1
                 && (bestStoryline?.total_events ?? 0) >= 8,
    };
    decisions.push(decision);
  }

  // Compute cohesion_signal for each storyline based on this run's decisions
  for (const [id, s] of storyMap) {
    const cohesion = computeCohesionSignal(id, decisions);
    if (cohesion !== 'none') {
      storyMap.set(id, { ...s, cohesion_signal: cohesion });
    }
  }

  // Mark fading storylines not touched by this run
  for (const [id, s] of storyMap) {
    if (!decisions.some(d => d.storyline_id === id)) {
      const daysSinceLast = (nowMs - new Date(s.latest_seen_at).getTime()) / 86_400_000;
      const newState = computeStorylineState({
        total_events:       s.total_events,
        days_active:        s.days_active,
        days_since_last:    daysSinceLast,
        avg_escalation:     s.avg_escalation,
        escalation_history: s.escalation_history,
      });
      if (newState !== s.storyline_state) {
        storyMap.set(id, { ...s, storyline_state: newState });
      }
    }
  }

  const updatedStore: StorylineStore = {
    schema_version: '1.0',
    generated_at:   now,
    storylines:     [...storyMap.values()],
  };

  if (!dryRun) {
    saveStore(updatedStore);
    saveEventFile(eventFilePath, eventFile);
    logger.info('storylines', `${date}: ${events.length} events → ${newCount} new storylines, ${updatedCount} updated`);
  }

  const uncertain     = decisions.filter(d => d.uncertain);
  const gravityLinks  = decisions.filter(d => d.gravity);
  const fragments     = detectFragments([...storyMap.values()]);

  const linked   = decisions.filter(d => d.action === 'updated').length;
  const total    = decisions.filter(d => d.action !== 'linked').length || 1;
  const persistenceRate = Math.round((linked / Math.max(total, 1)) * 1000) / 1000;

  // Cross-day comparison: load yesterday's snapshot and diff
  const prevSnap       = loadPreviousSnapshot(date);
  const snapshotDate   = prevSnap?.date ?? null;
  const prevMap        = new Map((prevSnap?.snapshot.storylines ?? []).map(s => [s.storyline_id, s]));
  const changes: StorylineChange[] = [];

  for (const s of storyMap.values()) {
    const prev = prevMap.get(s.storyline_id);
    if (!prev) continue;  // new storyline — not a "change"

    const eventsAdded   = s.total_events - prev.total_events;
    const stateChanged  = s.storyline_state !== prev.storyline_state;
    const cohesionChanged = s.cohesion_signal !== prev.cohesion_signal;
    const newlyFading   = s.storyline_state === 'fading' && prev.storyline_state !== 'fading';

    if (eventsAdded > 0 || stateChanged || cohesionChanged) {
      changes.push({
        storyline_id:    s.storyline_id,
        title:           s.title,
        events_added:    eventsAdded,
        state_before:    prev.storyline_state,
        state_after:     s.storyline_state,
        cohesion_before: prev.cohesion_signal,
        cohesion_after:  s.cohesion_signal,
        days_active:     s.days_active,
        newly_fading:    newlyFading,
      });
    }
  }

  // Save today's snapshot BEFORE writing the updated store
  // (so the snapshot represents the state going into this run, for tomorrow's diff)
  if (!dryRun) {
    saveSnapshot(date, store);  // snapshot of store BEFORE today's changes
  }

  return {
    date,
    events_processed:    events.length,
    storylines_new:      newCount,
    storylines_updated:  updatedCount,
    persistence_rate:    persistenceRate,
    decisions,
    uncertain,
    gravity_links:       gravityLinks,
    fragments,
    changes,
    snapshot_date:       snapshotDate,
  };
}

// ── Store reader ──────────────────────────────────────────────────────────────

export function getStorylines(): Storyline[] {
  return loadStore().storylines;
}

export { loadStore as loadStorylineStore, saveStore as saveStorylineStore };
