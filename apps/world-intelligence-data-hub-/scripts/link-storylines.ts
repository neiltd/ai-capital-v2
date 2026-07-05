// Storyline linker CLI — run after npm run dedup.
// Links today's events to persistent cross-day storylines.
// Usage:
//   npm run link                  — link today's events
//   npm run link -- 2026-05-13   — specific date
//   npm run link -- --dry-run    — preview without writing

import { linkEventsToStorylines, getStorylines } from '../intelligence/storylines/storyline-linker.ts';
import type { StorylineState, SignalBreakdown }   from '../intelligence/schema/storyline.ts';

// ── Args ──────────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const dryRun  = args.includes('--dry-run');
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date    = dateArg ?? new Date().toISOString().slice(0, 10);

// ── Colors ────────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const G  = (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const R  = (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const Y  = (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const D  = (s: string) => isTTY ? `\x1b[90m${s}\x1b[0m` : s;
const B  = (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m`  : s;
const C  = (s: string) => isTTY ? `\x1b[36m${s}\x1b[0m` : s;
const M  = (s: string) => isTTY ? `\x1b[35m${s}\x1b[0m` : s;

function stateColor(state: StorylineState): (s: string) => string {
  switch (state) {
    case 'escalating':  return R;
    case 'active':      return G;
    case 'stabilizing': return Y;
    case 'emerging':    return C;
    case 'fading':      return D;
  }
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('');
console.log(B('World Intelligence — Storyline Linker'));
console.log(D(`Date: ${date}${dryRun ? '  |  DRY RUN' : ''}`));
console.log('');

const result = linkEventsToStorylines(date, dryRun);

if (result.events_processed === 0) {
  console.log(D('No events found. Run `npm run dedup` first.'));
  console.log('');
  process.exit(0);
}

// ── Link decisions ────────────────────────────────────────────────────────────

console.log(B(`Linking decisions  (${result.events_processed} events)`));
console.log('─'.repeat(100));

function fmtSignals(sig: SignalBreakdown | undefined, score: number): string {
  if (!sig || score === 0) return D('[already]');
  const c  = sig.country  ? G('ctr') : D('ctr');
  const a  = sig.actor    ? G('act') : D('act');
  const t  = sig.type === 3 ? G('typ★') : sig.type === 1 ? Y('typ△') : D('typ·');
  const tl = sig.title    ? G('ttl') : D('ttl');
  const tm = sig.temporal ? G('tmp') : D('tmp');
  const p  = sig.penalty  < 0 ? R(`pen${sig.penalty}`) : '';
  const parts = [c, a, t, tl, tm, ...(p ? [p] : [])].join(' ');
  return `[${score}: ${parts}]`;
}

for (const d of result.decisions) {
  const actionIcon = d.action === 'created' ? C('◆ new ') : d.action === 'updated' ? G('→ link') : D('≡ same');
  const sigStr     = fmtSignals(d.signals, d.score);
  const warnStr    = d.uncertain ? ' ' + Y('⚠') : d.gravity ? ' ' + M('⬛grav') : '';

  console.log(
    `${actionIcon}  ${sigStr}  ` +
    d.event_title.slice(0, 48).padEnd(49) + D(' → ') +
    M(d.storyline_id.slice(0, 8) + '…') + ' ' +
    d.storyline_title.slice(0, 30) +
    warnStr,
  );
}

// ── Uncertain matches ─────────────────────────────────────────────────────────

if (result.uncertain.length > 0) {
  console.log('');
  console.log(Y(`⚠  ${result.uncertain.length} uncertain link(s) (score = threshold) — verify manually:`));
  for (const d of result.uncertain) {
    console.log(`  [score=${d.score}]  "${d.event_title.slice(0, 60)}"  →  "${d.storyline_title.slice(0, 40)}"`);
  }
}

// ── Storyline state summary ───────────────────────────────────────────────────

const all       = getStorylines();
const stateCounts: Record<StorylineState, number> = {
  emerging: 0, active: 0, escalating: 0, stabilizing: 0, fading: 0,
};
for (const s of all) stateCounts[s.storyline_state]++;

console.log('');
console.log(B(`Storyline store  (${all.length} total)`));
console.log('─'.repeat(100));

// Sort by state priority then by total_events desc
const sorted = [...all].sort((a, b) => {
  const priority: Record<StorylineState, number> = { escalating: 0, active: 1, stabilizing: 2, emerging: 3, fading: 4 };
  const pd = priority[a.storyline_state] - priority[b.storyline_state];
  return pd !== 0 ? pd : b.total_events - a.total_events;
});

const stateHeader = D(
  padEnd('ID', 10) + padEnd('State', 14) + padEnd('Ev', 4) + padEnd('Art', 5) +
  padEnd('Src', 5) + padEnd('Conf', 6) + padEnd('Esc', 6) +
  padEnd('Days', 5) + padEnd('Cohes', 8) + padEnd('Countries', 14) + 'Families / Title',
);
console.log(stateHeader);

function cohesionColor(sig: string | undefined): (s: string) => string {
  switch (sig) {
    case 'country':  return Y;   // geographic pull
    case 'actor':    return C;   // actor-driven
    case 'type':     return G;   // thematic
    case 'title':    return G;   // textual similarity
    case 'mixed':    return D;
    default:         return D;
  }
}

for (const s of sorted) {
  const col       = stateColor(s.storyline_state);
  const stateStr  = col(padEnd(s.storyline_state, 12));
  const countries = s.countries.slice(0, 3).join(',');
  const familyStr = Object.entries(s.family_composition ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${f.slice(0,3)}:${n}`)
    .join(' ');
  const cohStr = s.cohesion_signal
    ? cohesionColor(s.cohesion_signal)(padEnd(s.cohesion_signal.slice(0,6), 6))
    : D(padEnd('—', 6));
  console.log(
    D(s.storyline_id.slice(0, 8) + '… ') +
    stateStr + '  ' +
    padEnd(String(s.total_events), 4) +
    padEnd(String(s.total_sources), 5) +
    padEnd(String((s.unique_source_ids ?? []).length), 5) +
    padEnd(s.avg_confidence.toFixed(2), 6) +
    padEnd(s.avg_escalation.toFixed(2), 6) +
    padEnd(String(s.days_active), 5) +
    cohStr + '  ' +
    padEnd(countries, 14) +
    D(`[${familyStr}] `) + s.title.slice(0, 28),
  );
}

// ── State distribution bar ────────────────────────────────────────────────────

console.log('');
console.log(B('State distribution:'));
const states: StorylineState[] = ['escalating', 'active', 'stabilizing', 'emerging', 'fading'];
for (const state of states) {
  const n   = stateCounts[state];
  const col = stateColor(state);
  const bar = '█'.repeat(n);
  console.log(`  ${col(padEnd(state, 12))}  ${bar || '░'}  ${n}`);
}

// ── Cross-day comparison ──────────────────────────────────────────────────────

if (result.snapshot_date) {
  console.log('');
  console.log(B(`Cross-day changes  (vs snapshot ${result.snapshot_date})`));
  console.log('─'.repeat(100));

  if (result.changes.length === 0) {
    console.log(D('  No cross-day changes (first run on this date vs snapshot)'));
  } else {
    for (const ch of result.changes) {
      const stateChange = ch.state_before !== ch.state_after
        ? ` ${D(ch.state_before)} → ${stateColor(ch.state_after as StorylineState)(ch.state_after)}`
        : '';
      const cohChange = ch.cohesion_before !== ch.cohesion_after
        ? ` cohesion: ${D(ch.cohesion_before ?? '—')} → ${G(ch.cohesion_after ?? '—')}`
        : '';
      const evStr = ch.events_added > 0 ? G(`+${ch.events_added} events`) : D('no new events');
      const fadingTag = ch.newly_fading ? ' ' + R('→ FADING') : '';
      console.log(
        `  ${M(ch.storyline_id.slice(0, 8) + '…')}  ${evStr}  [day ${ch.days_active}]` +
        stateChange + cohChange + fadingTag +
        `  "${ch.title.slice(0, 45)}"`,
      );
    }
  }
}

// ── Gravity links ─────────────────────────────────────────────────────────────

if (result.gravity_links.length > 0) {
  console.log('');
  console.log(M(`⬛ Narrative gravity (score≤${5+1}, target≥8 events — verify thematic fit):`));
  for (const d of result.gravity_links) {
    console.log(`  [score=${d.score}]  "${d.event_title.slice(0, 55)}"  →  "${d.storyline_title.slice(0, 40)}"`);
  }
}

// ── Fragments ─────────────────────────────────────────────────────────────────

if (result.fragments.length > 0) {
  console.log('');
  console.log(Y(`🔀 Fragmentation candidates (same country+family across multiple storylines):`));
  for (const f of result.fragments) {
    console.log(`  ${f.country}/${f.family}:`);
    for (let i = 0; i < f.storyline_ids.length; i++) {
      console.log(`    ${D(f.storyline_ids[i]!.slice(0, 8) + '…')}  "${f.storyline_titles[i]?.slice(0, 55)}"`);
    }
  }
}

// ── Observation flags ─────────────────────────────────────────────────────────

const OVER_AGGREGATION_THRESHOLD = 12;
const overAggregated = all.filter(s => s.total_events >= OVER_AGGREGATION_THRESHOLD);
if (overAggregated.length > 0) {
  console.log('');
  console.log(Y(`⚠  Over-aggregation candidates (≥${OVER_AGGREGATION_THRESHOLD} events — may need sub-storylines):`));
  for (const s of overAggregated) {
    const families = [...new Set(s.event_types.map(t => {
      const fm: Record<string, string> = {
        armed_conflict:'mil', airstrike:'mil', missile_attack:'mil', military_operation:'mil',
        military_exercise:'mil', nuclear_incident:'mil', assassination:'mil', terrorist_attack:'mil',
        diplomatic_incident:'dip', peace_negotiation:'dip', treaty:'dip', sanctions:'dip',
        referendum:'dip', coup:'dip', election:'dip', protest:'dip', regime_change:'dip',
        supply_disruption:'eco', trade_dispute:'eco', market_crash:'eco', central_bank_action:'eco',
        economic_data_release:'eco', debt_crisis:'eco', commodity_price_move:'eco',
        opec_decision:'eco', energy_infrastructure:'eco',
        humanitarian_crisis:'hum', refugee_movement:'hum', natural_disaster:'hum', epidemic:'hum',
      };
      return fm[t] ?? 'oth';
    }))].join('+');
    console.log(`  ${M(s.storyline_id.slice(0, 8) + '…')}  ${s.total_events} events  [${families}]  "${s.title.slice(0, 60)}"`);
  }
}

// Branching candidates: large storylines with diverse event-type families
const branchCandidates = all.filter(s => {
  const families = new Set(s.event_types.map(t => {
    const FAMILIES: Record<string,string> = {
      armed_conflict:'mil',airstrike:'mil',missile_attack:'mil',military_operation:'mil',
      nuclear_incident:'mil',terrorist_attack:'mil',assassination:'mil',military_exercise:'mil',
      diplomatic_incident:'dip',peace_negotiation:'dip',treaty:'dip',sanctions:'dip',
      coup:'dip',election:'dip',protest:'dip',regime_change:'dip',referendum:'dip',
      supply_disruption:'eco',trade_dispute:'eco',market_crash:'eco',central_bank_action:'eco',
      economic_data_release:'eco',commodity_price_move:'eco',energy_infrastructure:'eco',
      debt_crisis:'eco',opec_decision:'eco',
      humanitarian_crisis:'hum',refugee_movement:'hum',natural_disaster:'hum',epidemic:'hum',
    };
    return FAMILIES[t] ?? 'oth';
  }));
  return families.size >= 3 && s.total_events >= 6;
});
if (branchCandidates.length > 0) {
  console.log('');
  console.log(Y(`⚡ Natural branching candidates (≥3 event families, ≥6 events):`));
  for (const s of branchCandidates) {
    console.log(`  ${M(s.storyline_id.slice(0, 8) + '…')}  ${s.total_events} events  "${s.title.slice(0, 60)}"`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
const persistPct = Math.round(result.persistence_rate * 100);
console.log(
  `${C(String(result.storylines_new))} new  ` +
  `${G(String(result.storylines_updated))} updated  ` +
  `persistence=${persistPct}%  ` +
  (result.gravity_links.length > 0 ? M(`${result.gravity_links.length} gravity`) + '  ' : '') +
  (result.fragments.length > 0     ? Y(`${result.fragments.length} fragment`) + '  '  : '') +
  (result.uncertain.length  > 0    ? Y(`${result.uncertain.length} uncertain`) + '  ' : '') +
  D(`| ${all.length} storylines in store`),
);
if (result.snapshot_date) {
  console.log(D(`  snapshot: ${result.snapshot_date} → compared ${result.changes.length} change(s)`));
} else {
  console.log(D(`  snapshot saved for tomorrow's comparison`));
}
if (dryRun) console.log(Y('  DRY RUN — nothing written.'));
console.log('');
