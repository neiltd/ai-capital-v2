// Cross-domain observation types — purely observational, no causal claims.
// These types record what the system can measure; interpretation is left to humans.

// ── Storyline → Benchmark linkage ─────────────────────────────────────────────

export interface StorylineBenchmarkLink {
  storylineId:     string;
  storylineTitle:  string;
  storylineState:  string;   // emerging | active | escalating | stabilizing | fading
  daysActive:      number;
  avgEscalation:   number;   // 0–1
  maxSeverity:     number;   // 1–5
  countries:       string[];
  eventTypes:      string[];
  linkedBenchmarks: string[]; // e.g. ['brent_crude', 'wti_crude']
  linkStrength:    number;   // 0–1 composite score — stronger = more signals
  linkReasons:     string[]; // human-readable signal labels
}

// ── Supply disruption → price window ──────────────────────────────────────────

export interface BenchmarkPriceWindow {
  benchmarkId:       string;
  // Reference point: nearest available price on or before the event date
  priceOnDate:       number | null;
  priceOnDateDate:   string | null;
  // Lookback: price N days prior (baseline)
  price7dBefore:     number | null;
  price7dBeforeDate: string | null;
  delta7dPct:        number | null;  // (priceOnDate - price7dBefore) / price7dBefore
  // Forward: price 3 trading days after (may be null for recent events)
  price3dAfter:      number | null;
  price3dAfterDate:  string | null;
  delta3dForwardPct: number | null;
}

export interface DisruptionPriceWindow {
  eventId:            string;
  eventDate:          string;
  eventType:          string;
  eventTitle:         string;
  countries:          string[];
  escalationPotential: number;
  isSupplyDisruption: boolean;
  isHormuzRelated:    boolean;
  benchmarkWindows:   BenchmarkPriceWindow[];
}

// ── Escalation ↔ price volatility log ────────────────────────────────────────
// One entry per day where both event data and price data exist.
// No causal direction implied.

export interface EscalationVolatilityEntry {
  date:                  string;
  maxEscalation:         number;   // highest escalation_potential among that day's events
  avgEscalation:         number;
  eventCount:            number;
  supplyDisruptionCount: number;
  energyEventCount:      number;   // energy_infrastructure + opec_decision + commodity_price_move
  hormuzEventCount:      number;
  benchmarkDailyChange: {
    benchmarkId:  string;
    price:        number | null;
    priorPrice:   number | null;  // prior trading day
    changePct:    number | null;
  }[];
}

// ── Chokepoint → benchmark price observation ──────────────────────────────────

export interface ChokepointBenchmarkResponse {
  benchmarkId:    string;
  priceAtEvent:   number | null;
  price3dBefore:  number | null;
  price3dAfter:   number | null;  // null if prices not yet published
  deltaBefore:    number | null;  // (priceAtEvent - price3dBefore) / price3dBefore
  deltaAfter:     number | null;  // (price3dAfter - priceAtEvent) / priceAtEvent
}

export interface ChokepointPriceObservation {
  eventId:            string;
  eventDate:          string;
  eventType:          string;
  eventTitle:         string;
  countries:          string[];
  escalationPotential: number;
  chokepointLabel:    string;  // 'hormuz', 'suez', 'bab_el_mandeb', 'malacca', 'red_sea', 'general'
  benchmarkResponses: ChokepointBenchmarkResponse[];
}

// ── Summary ────────────────────────────────────────────────────────────────────

export interface CrossDomainSummary {
  // Storyline overview
  totalActiveStorylines:    number;
  energyLinkedStorylines:   number;
  escalatingLinked:         number;  // storylines in 'escalating' state that are energy-linked
  avgEscalationLinked:      number;

  // Recent event density (events within observation window)
  supplyDisruptionsRecent:  number;
  energyEventsRecent:       number;
  hormuzEventsRecent:       number;
  observationWindowDays:    number;

  // Price coverage
  benchmarkCoverage: {
    benchmarkId: string;
    mostRecentDate: string | null;
    mostRecentPrice: number | null;
    daysWithPairedData: number;  // days where both event data and price exist
  }[];

  // Escalation-volatility observation quality
  pairedObservationDays:    number;  // days with both event + price data
  avgMaxEscalation:         number;
  maxSingleDayEscalation:   number;
  maxSingleDayPriceChangePct: number | null;  // across all benchmarks in window
}

// ── Snapshot ───────────────────────────────────────────────────────────────────

export interface CrossDomainSnapshot {
  date:                      string;
  generatedAt:               string;
  observationWindowDays:     number;
  storylineBenchmarkLinks:   StorylineBenchmarkLink[];
  disruptionPriceWindows:    DisruptionPriceWindow[];
  escalationVolatilityLog:   EscalationVolatilityEntry[];
  chokepointPriceObservations: ChokepointPriceObservation[];
  summary:                   CrossDomainSummary;
}
