import type { IntelligenceEvent } from '../schema/intelligence-event.ts';
import type {
  StockExport, MarketEvent, MacroRiskSignal, MacroRiskType, SectorExposure, SectorName,
} from './types.ts';

// ── Market-relevant event types ───────────────────────────────────────────────

const MARKET_EVENT_TYPES = new Set([
  'central_bank_action', 'market_crash', 'economic_data_release',
  'debt_crisis', 'commodity_price_move', 'trade_dispute',
  'supply_disruption', 'sanctions',
]);

// ── Sector classification ─────────────────────────────────────────────────────

const SECTOR_TYPES: Record<SectorName, string[]> = {
  energy:      ['supply_disruption', 'energy_infrastructure', 'opec_decision', 'commodity_price_move'],
  defense:     ['airstrike', 'military_operation', 'armed_conflict', 'missile_attack', 'military_exercise'],
  finance:     ['central_bank_action', 'market_crash', 'debt_crisis', 'economic_data_release'],
  commodities: ['trade_dispute', 'commodity_price_move', 'opec_decision', 'supply_disruption'],
  tech:        [],  // detected via keyword
  other:       [],
};

const TECH_KEYWORDS = ['semiconductor', 'chip', 'tech', 'silicon', 'ai ', 'cyber', 'satellite', 'drone'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000;
}

function uniqueSourceIds(event: IntelligenceEvent): string[] {
  return [...new Set(event.sources.extracted_from.map(r => r.source_id))];
}

function isMarketEvent(e: IntelligenceEvent): boolean {
  if (e.sources.human_review_required) return false;
  if (MARKET_EVENT_TYPES.has(e.event.event_type)) return true;
  if ((e.market_impact?.relevance ?? 0) > 0.50) return true;
  return false;
}

function isTechRelated(e: IntelligenceEvent): boolean {
  const text = `${e.event.title} ${e.event.summary}`.toLowerCase();
  return TECH_KEYWORDS.some(k => text.includes(k));
}

// ── Macro risk signals ────────────────────────────────────────────────────────
// Pure heuristics — no AI involved.

function detectMacroRisks(events: IntelligenceEvent[]): MacroRiskSignal[] {
  const clean = events.filter(e => !e.sources.human_review_required);
  const signals: MacroRiskSignal[] = [];

  function addSignal(
    riskType:  MacroRiskType,
    relevant:  IntelligenceEvent[],
  ): void {
    if (relevant.length === 0) return;
    const storylineIds = [...new Set(
      relevant.map(e => e.lifecycle?.storyline_id).filter((id): id is string => Boolean(id)),
    )];
    const countries = [...new Set(relevant.flatMap(e => e.geography.countries))].slice(0, 6);
    signals.push({
      risk_type:         riskType,
      intensity:         avg(relevant.map(e => e.market_impact?.relevance ?? 0)),
      primary_countries: countries,
      event_count:       relevant.length,
      event_ids:         relevant.map(e => e.event_id),
      storyline_ids:     storylineIds,
    });
  }

  // Inflation / rate expectations: central_bank_action with inflation signals
  const inflationText = /inflation|rate.?hike|rate.?increase|cpi|price.?pressur/i;
  const cbEvents = clean.filter(e =>
    e.event.event_type === 'central_bank_action' &&
    inflationText.test(`${e.event.title} ${e.event.summary}`),
  );
  addSignal('inflation_rate', cbEvents);

  // Supply shock: supply disruptions with high market impact
  const shockEvents = clean.filter(e =>
    e.event.event_type === 'supply_disruption' &&
    (e.market_impact?.relevance ?? 0) > 0.60,
  );
  addSignal('supply_shock', shockEvents);

  // Sanctions: any sanctions event
  const sanctionEvents = clean.filter(e => e.event.event_type === 'sanctions');
  addSignal('sanctions', sanctionEvents);

  // Geopolitical conflict: armed events with severity >= 3 and market impact
  const conflictEvents = clean.filter(e =>
    ['airstrike', 'armed_conflict', 'military_operation', 'missile_attack'].includes(e.event.event_type) &&
    e.event.severity >= 3 &&
    (e.market_impact?.relevance ?? 0) > 0.30,
  );
  addSignal('geopolitical_conflict', conflictEvents);

  // Currency stress: trade_dispute + economic events mentioning FX/currency
  const fxText = /currency|rupee|yuan|yen|won|euro|ruble|exchange.?rate|devaluation|forex/i;
  const fxEvents = clean.filter(e =>
    ['trade_dispute', 'central_bank_action', 'economic_data_release'].includes(e.event.event_type) &&
    fxText.test(`${e.event.title} ${e.event.summary}`),
  );
  addSignal('currency_stress', fxEvents);

  // Debt crisis
  const debtEvents = clean.filter(e => e.event.event_type === 'debt_crisis');
  addSignal('debt_crisis', debtEvents);

  return signals.filter(s => s.intensity > 0);
}

// ── Sector exposure ───────────────────────────────────────────────────────────

function buildSectorExposure(events: IntelligenceEvent[]): SectorExposure[] {
  const clean = events.filter(e => !e.sources.human_review_required);
  const result: SectorExposure[] = [];

  const sectors: SectorName[] = ['energy', 'defense', 'finance', 'commodities', 'tech'];

  for (const sector of sectors) {
    let relevant: IntelligenceEvent[];

    if (sector === 'tech') {
      relevant = clean.filter(isTechRelated);
    } else {
      const types = new Set(SECTOR_TYPES[sector]);
      relevant = clean.filter(e => types.has(e.event.event_type));
    }

    if (relevant.length === 0) continue;

    const maxSev   = Math.max(...relevant.map(e => e.event.severity));
    const maxMkt   = Math.max(...relevant.map(e => e.market_impact?.relevance ?? 0));
    const exposure = maxSev >= 4 || maxMkt >= 0.80 ? 'high'
                   : maxSev >= 2 || maxMkt >= 0.50 ? 'medium'
                   : 'low';

    result.push({
      sector,
      exposure:             exposure as SectorExposure['exposure'],
      event_count:          relevant.length,
      max_severity:         maxSev,
      max_market_relevance: maxMkt,
      event_ids:            relevant.map(e => e.event_id),
    });
  }

  return result.sort((a, b) =>
    ['high', 'medium', 'low'].indexOf(a.exposure) -
    ['high', 'medium', 'low'].indexOf(b.exposure),
  );
}

// ── Event projection ──────────────────────────────────────────────────────────

function projectMarketEvent(e: IntelligenceEvent): MarketEvent {
  return {
    event_id:         e.event_id,
    storyline_id:     e.lifecycle?.storyline_id,
    title:            e.event.title,
    summary:          e.event.summary,
    event_type:       e.event.event_type,
    severity:         e.event.severity,
    confidence_score: e.event.confidence_score,
    countries:        e.geography.countries,
    market_relevance: e.market_impact?.relevance ?? 0,
    market_direction: e.market_impact?.direction ?? 'uncertain',
    first_seen_at:    e.identity.first_seen_at,
    source_ids:       uniqueSourceIds(e),
  };
}

// ── Public builder ────────────────────────────────────────────────────────────

export function buildStockExport(
  date:       string,
  events:     IntelligenceEvent[],
  extractionVersion: string,
): StockExport {
  const marketEvents = events.filter(isMarketEvent);

  const excluded = events.filter(e => e.sources.human_review_required);
  const srcIds   = new Set(marketEvents.flatMap(e => e.sources.extracted_from.map(r => r.source_id)));

  return {
    schema_version:        '1.0',
    export_type:           'stock-project',
    generated_at:          new Date().toISOString(),
    date,
    extraction_version:    extractionVersion,
    event_count:           marketEvents.length,
    review_excluded_count: excluded.length,
    unique_source_count:   srcIds.size,
    market_events:         marketEvents.map(projectMarketEvent),
    macro_risk_signals:    detectMacroRisks(events),
    sector_exposure:       buildSectorExposure(events),
  };
}
