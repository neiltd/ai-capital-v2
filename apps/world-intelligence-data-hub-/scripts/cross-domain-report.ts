// cross-domain-report — prints the latest cross-domain observation snapshot.
// Run: npm run cross-domain
// Run: npm run cross-domain -- --date 2026-05-13
//
// Reads from intelligence/metrics/cross-domain/{date}.json
// Does not fetch or modify any data.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { PATHS } from '../lib/paths.ts';
import type { CrossDomainSnapshot } from '../intelligence/cross-domain/types.ts';

// ── Args ──────────────────────────────────────────────────────────────────────

function resolveDate(): string {
  const args = process.argv.slice(2);
  const dateFlag = args.indexOf('--date');
  if (dateFlag !== -1 && args[dateFlag + 1]) return args[dateFlag + 1]!;

  // Latest available snapshot
  const dir = join(PATHS.intelligence.metrics, 'cross-domain');
  if (!existsSync(dir)) {
    console.error('No cross-domain snapshots found. Run `npm run export` first.');
    process.exit(1);
  }
  const files = readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (files.length === 0) {
    console.error('No cross-domain snapshots found.');
    process.exit(1);
  }
  return files.at(-1)!.replace('.json', '');
}

// ── Formatting ────────────────────────────────────────────────────────────────

function pct(v: number | null): string {
  if (v === null) return '  —   ';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function bar(v: number, max = 1, width = 20): string {
  const filled = Math.round((v / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function printSeparator(char = '─', width = 70): void {
  console.log(char.repeat(width));
}

// ── Main ──────────────────────────────────────────────────────────────────────

const date = resolveDate();
const path = join(PATHS.intelligence.metrics, 'cross-domain', `${date}.json`);

if (!existsSync(path)) {
  console.error(`No snapshot for ${date}. Run npm run export.`);
  process.exit(1);
}

const snap: CrossDomainSnapshot = JSON.parse(readFileSync(path, 'utf-8'));
const { summary } = snap;

console.log('\n' + '═'.repeat(70));
console.log(`  CROSS-DOMAIN OBSERVATION — ${snap.date}`);
console.log(`  Generated: ${snap.generatedAt.replace('T',' ').slice(0,19)} UTC`);
console.log(`  Window: ${snap.observationWindowDays} days`);
console.log('═'.repeat(70));

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n▸ OBSERVATION SUMMARY');
printSeparator();
console.log(`  Active storylines:     ${summary.totalActiveStorylines} total | ${summary.energyLinkedStorylines} energy-linked | ${summary.escalatingLinked} escalating`);
console.log(`  Avg escalation (linked): ${(summary.avgEscalationLinked * 100).toFixed(0)}%`);
console.log(`  Supply disruptions:    ${summary.supplyDisruptionsRecent} events in window`);
console.log(`  Energy events:         ${summary.energyEventsRecent} events in window`);
console.log(`  Chokepoint events:     ${summary.hormuzEventsRecent} Hormuz-related`);
console.log(`  Paired obs. days:      ${summary.pairedObservationDays} (events + prices)`);
console.log(`  Max single-day esc.:   ${(summary.maxSingleDayEscalation * 100).toFixed(0)}%`);
if (summary.maxSingleDayPriceChangePct !== null) {
  console.log(`  Max single-day Δprice: ±${summary.maxSingleDayPriceChangePct.toFixed(2)}%`);
}

console.log('\n  Benchmark coverage:');
for (const b of summary.benchmarkCoverage) {
  const price = b.mostRecentPrice !== null ? `$${b.mostRecentPrice.toFixed(2)}` : '—';
  console.log(`    ${b.benchmarkId.padEnd(20)} latest: ${(b.mostRecentDate ?? '—').padEnd(12)} ${price.padEnd(10)} paired-days: ${b.daysWithPairedData}`);
}

// ── Storyline → benchmark links ───────────────────────────────────────────────

const energyLinked = snap.storylineBenchmarkLinks.filter(l => l.linkedBenchmarks.length > 0);
if (energyLinked.length > 0) {
  console.log('\n▸ ENERGY-LINKED STORYLINES');
  printSeparator();
  for (const l of energyLinked) {
    const strength = bar(l.linkStrength, 1, 10);
    const state = l.storylineState.toUpperCase().padEnd(12);
    console.log(`  [${state}] ${l.storylineTitle.slice(0, 55).padEnd(55)}`);
    console.log(`   ${strength} ${(l.linkStrength * 100).toFixed(0).padStart(3)}%  ` +
      `esc:${(l.avgEscalation * 100).toFixed(0)}%  ` +
      `days:${l.daysActive}  ` +
      `benchmarks: ${l.linkedBenchmarks.join(', ')}`);
    if (l.linkReasons.length) {
      console.log(`   signals: ${l.linkReasons.slice(0, 3).join(' | ')}`);
    }
    console.log();
  }
} else {
  console.log('\n▸ No energy-linked storylines in current window.');
}

// ── Escalation → volatility log ───────────────────────────────────────────────

if (snap.escalationVolatilityLog.length > 0) {
  console.log('\n▸ ESCALATION ↔ PRICE CHANGE LOG');
  printSeparator();
  console.log('  Date        MaxEsc  EnergyEv  Brent Δ    WTI Δ     HHub Δ');
  printSeparator('-');
  for (const v of snap.escalationVolatilityLog) {
    const brent = v.benchmarkDailyChange.find(b => b.benchmarkId === 'brent_crude');
    const wti   = v.benchmarkDailyChange.find(b => b.benchmarkId === 'wti_crude');
    const hhub  = v.benchmarkDailyChange.find(b => b.benchmarkId === 'henry_hub');
    console.log(
      `  ${v.date}  ` +
      `${(v.maxEscalation * 100).toFixed(0).padStart(5)}%   ` +
      `${String(v.energyEventCount).padStart(2)}        ` +
      `${pct(brent?.changePct ?? null).padEnd(10)} ` +
      `${pct(wti?.changePct ?? null).padEnd(10)} ` +
      `${pct(hhub?.changePct ?? null)}`,
    );
  }
}

// ── Disruption price windows ───────────────────────────────────────────────────

const disruptions = snap.disruptionPriceWindows.filter(d => d.isSupplyDisruption);
if (disruptions.length > 0) {
  console.log('\n▸ SUPPLY DISRUPTION → PRICE WINDOWS');
  printSeparator();
  for (const d of disruptions.slice(0, 8)) {
    console.log(`  ${d.eventDate}  [${d.eventType}]  esc:${(d.escalationPotential*100).toFixed(0)}%`);
    console.log(`  ${d.eventTitle.slice(0, 68)}`);
    for (const w of d.benchmarkWindows.filter(b => b.priceOnDate !== null)) {
      const onDate = w.priceOnDate ? `$${w.priceOnDate.toFixed(2)}` : '—';
      console.log(
        `    ${w.benchmarkId.padEnd(15)} on-date: ${onDate.padEnd(9)} ` +
        `Δ7d: ${pct(w.delta7dPct).padEnd(9)} ` +
        `Δ3d-fwd: ${pct(w.delta3dForwardPct)}`,
      );
    }
    console.log();
  }
}

// ── Chokepoint observations ───────────────────────────────────────────────────

if (snap.chokepointPriceObservations.length > 0) {
  console.log('\n▸ CHOKEPOINT EVENTS → BENCHMARK RESPONSE');
  printSeparator();
  for (const c of snap.chokepointPriceObservations.slice(0, 6)) {
    console.log(`  ${c.eventDate}  [${c.chokepointLabel.toUpperCase()}]  esc:${(c.escalationPotential*100).toFixed(0)}%`);
    console.log(`  ${c.eventTitle.slice(0, 68)}`);
    for (const r of c.benchmarkResponses.filter(b => b.priceAtEvent !== null)) {
      const at = r.priceAtEvent ? `$${r.priceAtEvent.toFixed(2)}` : '—';
      console.log(
        `    ${r.benchmarkId.padEnd(15)} at-event: ${at.padEnd(9)} ` +
        `Δ3d-before: ${pct(r.deltaBefore).padEnd(9)} ` +
        `Δ3d-after: ${pct(r.deltaAfter)}`,
      );
    }
    console.log();
  }
}

console.log('═'.repeat(70));
console.log(`  Snapshot: intelligence/metrics/cross-domain/${snap.date}.json`);
console.log('═'.repeat(70) + '\n');
