// Canonical list of real ingestion sources — single source of truth for which
// sources the production pipeline runs against.
//
// Keep this in sync with run.ts. History that shaped this list:
//   - newsapi was removed from this pipeline: GDELT covers the same
//     geopolitical queries for free. NewsAPI quota is reserved exclusively
//     for capital-intelligence-ingestion (company news) — see run.ts.
//   - ucdp is ACLED's fallback, instantiated by run.ts only when ACLED's last
//     successful fetch is more than 48h stale (see quota/quota-tracker.ts).
//     It is still a real production source — not test-only — so it belongs
//     in every pre-flight/dry-run/backfill list even though a given run.ts
//     invocation may not build a UCDPClient.
//
// scripts/dry-run.ts, scripts/validate-credentials.ts and scripts/backfill.ts
// all import SOURCE_NAMES (and createClient, where they need a live client
// instance rather than just the name) instead of hardcoding their own list,
// so they can't drift from run.ts again.

import { ACLEDClient }     from '../ingestion/clients/acled.ts';
import { EIAClient }       from '../ingestion/clients/eia.ts';
import { GDELTClient }     from '../ingestion/clients/gdelt.ts';
import { UCDPClient }      from '../ingestion/clients/ucdp.ts';
import { WorldBankClient } from '../ingestion/clients/worldbank.ts';
import type { SourceClient } from '../ingestion/clients/base.client.ts';

export const SOURCE_NAMES = ['gdelt', 'acled', 'ucdp', 'eia', 'worldbank'] as const;

export type SourceName = typeof SOURCE_NAMES[number];

// Build a fresh client instance for a canonical source name. Centralizing
// this avoids run.ts and backfill.ts each independently importing/instantiating
// every client class and drifting out of sync.
export function createClient(name: SourceName): SourceClient {
  switch (name) {
    case 'gdelt':     return new GDELTClient();
    case 'acled':     return new ACLEDClient();
    case 'ucdp':      return new UCDPClient();
    case 'eia':       return new EIAClient();
    case 'worldbank': return new WorldBankClient();
  }
}
