// Cross-domain observer — deterministic, no AI, no causal claims.
// Joins intelligence events + storylines with commodity price data.
// Records co-occurrences and proximity patterns for human analysis.
//
// What this does NOT do:
//   - claim causation ("this event caused this price move")
//   - make predictions or signals
//   - feed back into the intelligence pipeline
//   - call external APIs
//
// Outputs a snapshot written to intelligence/metrics/cross-domain/{date}.json

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PATHS } from '../../lib/paths.ts';
import { logger } from '../../lib/logger.ts';
import { getRange } from '../../store/timeseries-store.ts';
import { OIL_PRICE_BENCHMARKS, GAS_PRICE_BENCHMARKS } from '../../ingestion/timeseries/benchmark-configs.ts';
import type { IntelligenceEvent } from '../schema/intelligence-event.ts';
import type { Storyline } from '../schema/storyline.ts';
import type { StoredDatapoint } from '../../ingestion/timeseries/types.ts';
import type {
  CrossDomainSnapshot,
  StorylineBenchmarkLink,
  DisruptionPriceWindow, BenchmarkPriceWindow,
  EscalationVolatilityEntry,
  ChokepointPriceObservation,
  CrossDomainSummary,
} from './types.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const OBSERVATION_WINDOW_DAYS = 14;
const ALL_BENCHMARKS = [...OIL_PRICE_BENCHMARKS, ...GAS_PRICE_BENCHMARKS];

// Oil-relevant country set (matches oil-exporter.ts)
const OIL_COUNTRIES = new Set([
  'IRN','SAU','ARE','QAT','KWT','OMN','IRQ','YEM','EGY',
  'RUS','AZE','KAZ',
  'LBY','NGA','AGO','DZA','SDN','SSD',
  'VEN','ECU','BRA','COL',
  'NOR','GBR',
]);

const ENERGY_EVENT_TYPES = new Set([
  'supply_disruption','energy_infrastructure','opec_decision','commodity_price_move',
]);

// Event types that commonly move oil prices when happening in oil countries
const SECONDARY_ENERGY_TYPES = new Set([
  'sanctions','armed_conflict','airstrike','missile_attack','military_operation',
  'diplomatic_incident',
]);

// Chokepoint detection — title/description keywords mapped to labels
const CHOKEPOINT_PATTERNS: Array<[RegExp, string]> = [
  [/hormuz/i,         'hormuz'],
  [/bab.?el.?mandeb/i,'bab_el_mandeb'],
  [/suez/i,           'suez'],
  [/malacca/i,        'malacca'],
  [/red sea/i,        'red_sea'],
  [/strait/i,         'strait'],
];

// ── Price index ───────────────────────────────────────────────────────────────
// Build a flat date→value map for efficient lookups across the observation window.

interface PriceIndex {
  [benchmarkId: string]: Map<string, number>;  // date → value
}

function buildPriceIndex(from: string, to: string): PriceIndex {
  const index: PriceIndex = {};
  for (const bid of ALL_BENCHMARKS) {
    const points = getRange(bid, from, to);
    const m = new Map<string, number>();
    for (const p of points) {
      if (p.value !== null) m.set(p.date, p.value);
    }
    index[bid] = m;
  }
  return index;
}

function getNearestBefore(map: Map<string, number>, targetDate: string, maxDaysBack = 5): [string, number] | null {
  for (let i = 0; i <= maxDaysBack; i++) {
    const d = offsetDate(targetDate, -i);
    const v = map.get(d);
    if (v !== undefined) return [d, v];
  }
  return null;
}

function getNearestAfter(map: Map<string, number>, targetDate: string, maxDaysForward = 5): [string, number] | null {
  for (let i = 1; i <= maxDaysForward; i++) {
    const d = offsetDate(targetDate, i);
    const v = map.get(d);
    if (v !== undefined) return [d, v];
  }
  return null;
}

function deltaPct(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return Math.round(((a - b) / b) * 10000) / 100;  // round to 2dp
}

function offsetDate(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000;
}

// ── Event history loader ──────────────────────────────────────────────────────

interface DayEvents {
  date: string;
  events: IntelligenceEvent[];
}

function loadEventHistory(upToDate: string, windowDays: number): DayEvents[] {
  const history: DayEvents[] = [];
  const eventsDir = PATHS.intelligence.outputEvents;

  for (let i = 0; i < windowDays; i++) {
    const date = offsetDate(upToDate, -i);
    const path = join(eventsDir, `${date}.json`);
    if (!existsSync(path)) continue;
    try {
      const file = JSON.parse(readFileSync(path, 'utf-8')) as { events: IntelligenceEvent[] };
      history.push({ date, events: file.events ?? [] });
    } catch {
      logger.warn('cross-domain', `Could not load event file for ${date}`);
    }
  }
  return history.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Storyline → benchmark linkage ─────────────────────────────────────────────

function scoreStorylineBenchmarkLink(s: Storyline): StorylineBenchmarkLink {
  let score = 0;
  const reasons: string[] = [];

  // Energy event types
  const energyTypes = s.event_types.filter(t => ENERGY_EVENT_TYPES.has(t));
  if (energyTypes.length > 0) {
    score += energyTypes.length * 2;
    reasons.push(`energy_event_type:${energyTypes.join(',')}`);
  }

  // Secondary types with oil countries
  const secondaryTypes = s.event_types.filter(t => SECONDARY_ENERGY_TYPES.has(t));
  const oilCountryCount = s.countries.filter(c => OIL_COUNTRIES.has(c)).length;
  if (secondaryTypes.length > 0 && oilCountryCount > 0) {
    score += secondaryTypes.length;
    reasons.push(`geopolitical_event_in_energy_region:${s.countries.filter(c => OIL_COUNTRIES.has(c)).join(',')}`);
  }

  // Pure oil country with any high-escalation event
  if (oilCountryCount > 0 && s.avg_escalation >= 0.6) {
    score += oilCountryCount;
    reasons.push(`high_escalation_energy_country`);
  }

  // Chokepoint keyword in title
  for (const [pattern, label] of CHOKEPOINT_PATTERNS) {
    if (pattern.test(s.title)) {
      score += 3;
      reasons.push(`chokepoint:${label}`);
      break;
    }
  }

  // Determine which benchmarks to link based on regions
  const linkedBenchmarks: string[] = [];
  if (score >= 2) {
    // All energy-linked storylines affect Brent and WTI
    linkedBenchmarks.push('brent_crude', 'wti_crude');
    // Gas storylines
    const gasKeywords = /pipeline|lng|gas|natural.?gas|henry.?hub|ttf|nbp/i;
    if (gasKeywords.test(s.title) || s.event_types.includes('energy_infrastructure')) {
      linkedBenchmarks.push('henry_hub');
    }
  }

  return {
    storylineId:      s.storyline_id,
    storylineTitle:   s.title,
    storylineState:   s.storyline_state,
    daysActive:       s.days_active,
    avgEscalation:    s.avg_escalation,
    maxSeverity:      s.max_severity,
    countries:        s.countries,
    eventTypes:       s.event_types,
    linkedBenchmarks: [...new Set(linkedBenchmarks)],
    linkStrength:     Math.min(1, score / 8),  // 8 = max realistic score
    linkReasons:      reasons,
  };
}

// ── Supply disruption price windows ───────────────────────────────────────────

function isEnergyEvent(e: IntelligenceEvent): boolean {
  if (ENERGY_EVENT_TYPES.has(e.event.event_type)) return true;
  if (
    SECONDARY_ENERGY_TYPES.has(e.event.event_type) &&
    e.geography.countries.some(c => OIL_COUNTRIES.has(c)) &&
    (e.market_impact?.relevance ?? 0) > 0.40
  ) return true;
  return false;
}

function isHormuzRelated(e: IntelligenceEvent): boolean {
  const hormuzCountries = new Set(['IRN','ARE','OMN','QAT','KWT','SAU','USA']);
  const text = `${e.event.title} ${e.event.summary}`.toLowerCase();
  return (
    (/hormuz|strait|naval.?blockade|tanker.?seiz/i.test(text)) ||
    (
      e.geography.countries.some(c => hormuzCountries.has(c)) &&
      ['supply_disruption','energy_infrastructure','military_operation','airstrike','armed_conflict']
        .includes(e.event.event_type)
    )
  );
}

function buildDisruptionPriceWindow(
  e: IntelligenceEvent,
  eventDate: string,
  priceIndex: PriceIndex,
): DisruptionPriceWindow {
  const benchmarkWindows: BenchmarkPriceWindow[] = ALL_BENCHMARKS.map(bid => {
    const m = priceIndex[bid]!;

    const onDate    = getNearestBefore(m, eventDate, 3);
    const before7d  = getNearestBefore(m, offsetDate(eventDate, -7), 3);
    const after3d   = getNearestAfter(m, eventDate, 5);

    return {
      benchmarkId:       bid,
      priceOnDate:       onDate?.[1] ?? null,
      priceOnDateDate:   onDate?.[0] ?? null,
      price7dBefore:     before7d?.[1] ?? null,
      price7dBeforeDate: before7d?.[0] ?? null,
      delta7dPct:        deltaPct(onDate?.[1] ?? null, before7d?.[1] ?? null),
      price3dAfter:      after3d?.[1] ?? null,
      price3dAfterDate:  after3d?.[0] ?? null,
      delta3dForwardPct: deltaPct(after3d?.[1] ?? null, onDate?.[1] ?? null),
    };
  });

  return {
    eventId:             e.event_id,
    eventDate,
    eventType:           e.event.event_type,
    eventTitle:          e.event.title,
    countries:           e.geography.countries,
    escalationPotential: e.geopolitical_scores.escalation_potential,
    isSupplyDisruption:  e.event.event_type === 'supply_disruption',
    isHormuzRelated:     isHormuzRelated(e),
    benchmarkWindows,
  };
}

// ── Escalation → volatility log ───────────────────────────────────────────────

function buildEscalationVolatilityEntry(
  day: DayEvents,
  priceIndex: PriceIndex,
): EscalationVolatilityEntry {
  const events = day.events;
  const escalations = events.map(e => e.geopolitical_scores.escalation_potential);

  const benchmarkDailyChange = ALL_BENCHMARKS.map(bid => {
    const m = priceIndex[bid]!;
    const today = getNearestBefore(m, day.date, 0);    // exact date only
    const prior = getNearestBefore(m, offsetDate(day.date, -1), 4);  // prior trading day
    return {
      benchmarkId: bid,
      price:       today?.[1] ?? null,
      priorPrice:  prior?.[1] ?? null,
      changePct:   deltaPct(today?.[1] ?? null, prior?.[1] ?? null),
    };
  });

  return {
    date:                  day.date,
    maxEscalation:         escalations.length ? Math.max(...escalations) : 0,
    avgEscalation:         avg(escalations),
    eventCount:            events.length,
    supplyDisruptionCount: events.filter(e => e.event.event_type === 'supply_disruption').length,
    energyEventCount:      events.filter(e => ENERGY_EVENT_TYPES.has(e.event.event_type)).length,
    hormuzEventCount:      events.filter(e => isHormuzRelated(e)).length,
    benchmarkDailyChange,
  };
}

// ── Chokepoint → price observations ───────────────────────────────────────────

function detectChokepointLabel(e: IntelligenceEvent): string | null {
  const text = `${e.event.title} ${e.event.summary}`;
  for (const [pattern, label] of CHOKEPOINT_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  // Hormuz-adjacent countries in conflict context
  if (isHormuzRelated(e)) return 'hormuz';
  return null;
}

function buildChokepointObservation(
  e: IntelligenceEvent,
  eventDate: string,
  label: string,
  priceIndex: PriceIndex,
): ChokepointPriceObservation {
  const benchmarkResponses = ALL_BENCHMARKS.map(bid => {
    const m = priceIndex[bid]!;
    const atEvent  = getNearestBefore(m, eventDate, 2);
    const before3d = getNearestBefore(m, offsetDate(eventDate, -3), 3);
    const after3d  = getNearestAfter(m, eventDate, 5);
    return {
      benchmarkId:   bid,
      priceAtEvent:  atEvent?.[1] ?? null,
      price3dBefore: before3d?.[1] ?? null,
      price3dAfter:  after3d?.[1] ?? null,
      deltaBefore:   deltaPct(atEvent?.[1] ?? null, before3d?.[1] ?? null),
      deltaAfter:    deltaPct(after3d?.[1] ?? null, atEvent?.[1] ?? null),
    };
  });

  return {
    eventId:             e.event_id,
    eventDate,
    eventType:           e.event.event_type,
    eventTitle:          e.event.title,
    countries:           e.geography.countries,
    escalationPotential: e.geopolitical_scores.escalation_potential,
    chokepointLabel:     label,
    benchmarkResponses,
  };
}

// ── Summary ───────────────────────────────────────────────────────────────────

function buildSummary(
  links:       StorylineBenchmarkLink[],
  disruptions: DisruptionPriceWindow[],
  volatility:  EscalationVolatilityEntry[],
  priceIndex:  PriceIndex,
  windowDays:  number,
): CrossDomainSummary {
  const energyLinked = links.filter(l => l.linkedBenchmarks.length > 0);
  const escalatingLinked = energyLinked.filter(l => l.storylineState === 'escalating');

  const allChangePcts = volatility
    .flatMap(v => v.benchmarkDailyChange.map(b => b.changePct))
    .filter((v): v is number => v !== null);

  const benchmarkCoverage = ALL_BENCHMARKS.map(bid => {
    const m = priceIndex[bid]!;
    const dates = [...m.keys()].sort();
    const daysWithPrice = dates.length;
    const pairedDays = volatility.filter(v =>
      v.benchmarkDailyChange.find(b => b.benchmarkId === bid && b.price !== null),
    ).length;
    return {
      benchmarkId:        bid,
      mostRecentDate:     dates.at(-1) ?? null,
      mostRecentPrice:    dates.length ? m.get(dates.at(-1)!) ?? null : null,
      daysWithPairedData: pairedDays,
    };
  });

  return {
    totalActiveStorylines:    links.length,
    energyLinkedStorylines:   energyLinked.length,
    escalatingLinked:         escalatingLinked.length,
    avgEscalationLinked:      avg(energyLinked.map(l => l.avgEscalation)),

    supplyDisruptionsRecent:  disruptions.filter(d => d.isSupplyDisruption).length,
    energyEventsRecent:       disruptions.length,
    hormuzEventsRecent:       disruptions.filter(d => d.isHormuzRelated).length,
    observationWindowDays:    windowDays,

    benchmarkCoverage,

    pairedObservationDays:    volatility.length,
    avgMaxEscalation:         avg(volatility.map(v => v.maxEscalation)),
    maxSingleDayEscalation:   volatility.length ? Math.max(...volatility.map(v => v.maxEscalation)) : 0,
    maxSingleDayPriceChangePct: allChangePcts.length
      ? Math.max(...allChangePcts.map(Math.abs))
      : null,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function runCrossDomainObservation(
  date:       string,
  events:     IntelligenceEvent[],
  storylines: Storyline[],
): CrossDomainSnapshot {
  logger.info('cross-domain', `Running observation for ${date} — ${events.length} events, ${storylines.length} storylines`);

  // Build price index for the observation window
  const windowFrom = offsetDate(date, -(OBSERVATION_WINDOW_DAYS + 7));  // extra buffer for lookbacks
  const priceIndex = buildPriceIndex(windowFrom, date);

  // Load event history for the full window
  const history = loadEventHistory(date, OBSERVATION_WINDOW_DAYS);
  const allHistoryEvents = history.flatMap(d => d.events);

  // 1. Storyline → benchmark linkage
  const storylineBenchmarkLinks = storylines
    .filter(s => s.storyline_state !== 'fading')
    .map(scoreStorylineBenchmarkLink)
    .sort((a, b) => b.linkStrength - a.linkStrength);

  // 2. Supply disruption price windows — from all events in observation window
  const disruptionEvents = allHistoryEvents.filter(isEnergyEvent);
  // Find the date for each event from history
  const eventDateMap = new Map<string, string>();
  for (const day of history) {
    for (const e of day.events) eventDateMap.set(e.event_id, day.date);
  }
  const disruptionPriceWindows = disruptionEvents
    .filter(e => ['supply_disruption','energy_infrastructure'].includes(e.event.event_type))
    .slice(0, 20)  // cap at 20 for readability
    .map(e => buildDisruptionPriceWindow(e, eventDateMap.get(e.event_id) ?? date, priceIndex));

  // 3. Escalation → volatility log — one entry per day in history
  const escalationVolatilityLog = history
    .map(day => buildEscalationVolatilityEntry(day, priceIndex))
    .filter(entry => entry.eventCount > 0);  // only days with event data

  // 4. Chokepoint → benchmark price observations
  const chokepointPriceObservations: ChokepointPriceObservation[] = [];
  for (const day of history) {
    for (const e of day.events) {
      const label = detectChokepointLabel(e);
      if (label) {
        chokepointPriceObservations.push(
          buildChokepointObservation(e, eventDateMap.get(e.event_id) ?? date, label, priceIndex),
        );
      }
    }
  }

  // 5. Summary
  const summary = buildSummary(
    storylineBenchmarkLinks,
    disruptionPriceWindows,
    escalationVolatilityLog,
    priceIndex,
    OBSERVATION_WINDOW_DAYS,
  );

  const snapshot: CrossDomainSnapshot = {
    date,
    generatedAt:               new Date().toISOString(),
    observationWindowDays:     OBSERVATION_WINDOW_DAYS,
    storylineBenchmarkLinks,
    disruptionPriceWindows,
    escalationVolatilityLog,
    chokepointPriceObservations,
    summary,
  };

  logger.info('cross-domain', [
    `Links: ${storylineBenchmarkLinks.filter(l=>l.linkedBenchmarks.length>0).length} energy-linked storylines`,
    `Disruptions: ${disruptionPriceWindows.length} events with price windows`,
    `Volatility log: ${escalationVolatilityLog.length} days`,
    `Chokepoints: ${chokepointPriceObservations.length} events`,
  ].join(' | '));

  return snapshot;
}

export function saveCrossDomainSnapshot(snapshot: CrossDomainSnapshot): void {
  const dir = join(PATHS.intelligence.metrics, 'cross-domain');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${snapshot.date}.json`);
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
  logger.info('cross-domain', `Snapshot → ${path}`);
}
