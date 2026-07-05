#!/usr/bin/env node
// Run the memory-agent across a target event file and mutate it in-place with
// causal_links + expected_consequences populated.
//
// Usage:
//   npm run memory                       # today's events (skips if file missing)
//   npm run memory -- 2026-06-14         # specific date
//   npm run memory -- 2026-06-14 --dry   # dry run, log only
//
// Reads the surrounding 90 days of event files as the candidate pool.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

import type { IntelligenceEvent } from '../intelligence/schema/intelligence-event.js';
import { emptyGraph } from '../intelligence/schema/intelligence-event.js';
import { enrichEvent } from '../intelligence/agents/memory-agent.js';

const EVENTS_DIR = join(process.cwd(), 'intelligence', 'outputs', 'events');

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadEventsFromFile(file: string): IntelligenceEvent[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    return Array.isArray(raw) ? raw : (raw.events ?? []);
  } catch (err) {
    console.error(`[memory] failed to load ${file}: ${(err as Error).message}`);
    return [];
  }
}

function listEventFilesInRange(targetDate: string, days: number): string[] {
  if (!existsSync(EVENTS_DIR)) return [];
  return readdirSync(EVENTS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .filter(d => {
      const diff = (new Date(targetDate).getTime() - new Date(d).getTime()) / (24 * 60 * 60 * 1000);
      return diff >= 0 && diff <= days;
    })
    .map(d => join(EVENTS_DIR, `${d}.json`));
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  const positional = args.filter(a => !a.startsWith('--'));
  const targetDate = positional[0] || todayIso();
  const targetFile = join(EVENTS_DIR, `${targetDate}.json`);

  if (!existsSync(targetFile)) {
    console.log(`[memory] no event file for ${targetDate} — nothing to enrich.`);
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is required.');
    process.exit(1);
  }

  const targets = loadEventsFromFile(targetFile);
  if (targets.length === 0) {
    console.log(`[memory] ${targetDate}.json has 0 events — nothing to enrich.`);
    return;
  }

  // Build candidate pool: this file + the 90 prior days.
  const poolFiles = listEventFilesInRange(targetDate, 90);
  const pool: IntelligenceEvent[] = [];
  for (const f of poolFiles) {
    pool.push(...loadEventsFromFile(f));
  }
  console.log(`[memory] ${targetDate}: ${targets.length} target event(s), pool size ${pool.length} from ${poolFiles.length} file(s).`);

  let enrichedCount = 0; // also serves as the success count
  let totalLinks    = 0;
  let totalCons     = 0;
  let failCount     = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    try {
      const result = await enrichEvent(t, pool, { apiKey, dryRun });
      console.log(`[${i + 1}/${targets.length}] ${t.event_id} ${t.event.title.slice(0, 70)}`);
      console.log(`         ${result.causalLinks.length} causal_link(s), ${result.expectedConsequences.length} consequence(s), confidence=${result.causalConfidence.toFixed(2)}`);

      if (!dryRun) {
        // Mutate the target event's graph in place; init from emptyGraph if
        // the event predates the graph field (legacy fixture or older schema).
        const baseGraph = t.graph ?? emptyGraph();
        t.graph = {
          ...baseGraph,
          causal_links:          result.causalLinks,
          expected_consequences: result.expectedConsequences,
          causal_confidence:     result.causalConfidence,
          counterfactual:        result.counterfactual,
          graph_version:         (baseGraph.graph_version ?? 0) + 1,
        };
        // Also populate the existing predecessor_ids index from the new
        // causal_links so legacy consumers see something useful too.
        const predIds = result.causalLinks
          .filter(l => l.kind === 'caused_by')
          .map(l => l.event_id);
        const existingPred = t.graph.predecessor_ids ?? [];
        t.graph.predecessor_ids = Array.from(new Set([...existingPred, ...predIds]));
      }

      enrichedCount++;
      totalLinks += result.causalLinks.length;
      totalCons  += result.expectedConsequences.length;
    } catch (err) {
      console.error(`[${i + 1}/${targets.length}] ${t.event_id} FAILED: ${(err as Error).message}`);
      failCount++;
    }
  }

  if (dryRun) {
    console.log(`[memory] dry run complete — would enrich ${enrichedCount} event(s)`);
    return;
  }

  if (enrichedCount > 0) {
    writeFileSync(targetFile, JSON.stringify(targets, null, 2));
    console.log(`[memory] wrote enriched ${targetFile} — ${enrichedCount} event(s), ${totalLinks} link(s), ${totalCons} consequence(s)`);
  }

  console.log(`[memory] enriched ${enrichedCount}/${enrichedCount + failCount} events`);

  if (failCount > 0 && enrichedCount === 0) {
    console.error(`[memory] ALL ${failCount} event(s) failed enrichment — aborting with non-zero exit.`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
