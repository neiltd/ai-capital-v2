import { Agent, fetch as undiciFetch } from 'undici';
import { logger } from '../../lib/logger.ts';
import { SourceFetchError, type SourceClient } from './base.client.ts';

// GDELT DOC 2.0 API — no auth, no fixed rate limit.
// Practical limit: 5-6s between requests to avoid 429 / connection drops.
// We treat each query independently: collect successes, skip failures.
// The whole source only hard-fails if every query fails.

export interface GDELTArticle {
  url:           string;
  url_mobile:    string;
  title:         string;
  seendate:      string; // YYYYMMDDTHHMMSSZ
  socialimage:   string;
  domain:        string;
  language:      string;
  sourcecountry: string;
}

export interface GDELTResponse {
  articles: GDELTArticle[];
}

// Expanded 2026-06-26 — ACLED has been 403-blocked for a month, so we're
// leaning harder on GDELT. Each query targets a different geopolitical event
// class so the union covers what ACLED would normally tag:
//   - direct conflict (kinetic events, war news)
//   - energy / supply disruption (pipelines, refineries, LNG, Iran/oil)
//   - protest / political crisis (revolutions, coups, civil unrest)
//   - sanctions / trade dispute (economic statecraft)
//   - maritime chokepoints (Hormuz / Suez / Malacca / Taiwan Strait)
//   - nuclear / proliferation (Iran, NK weapons programs)
//   - cyberattack / critical-infra
//   - diplomatic incident (summits, treaty breakdowns)
//   - election / regime change
//   - alliance / treaty activity (NATO/BRICS/G7 news)
const QUERIES = [
  'conflict attack military battle war',
  'oil pipeline energy supply disruption refinery',
  'protest riot coup political crisis civil unrest',
  'sanctions embargo tariff trade dispute trade war',
  'strait hormuz suez malacca panama blockade shipping',
  'nuclear weapon iran north korea proliferation',
  'cyberattack ransomware critical infrastructure attack',
  'diplomatic incident summit treaty breakdown negotiation',
  'election coup regime change opposition crackdown',
  'NATO alliance BRICS G7 G20 treaty defense pact',
];

const INTER_QUERY_DELAY_MS = 6_000;
// Retry once on 429 / transient 5xx after a longer backoff. The whole pipeline
// has plenty of budget (30-min timeout) for this.
const RETRY_BACKOFF_MS = 12_000;

// Custom undici Agent: raises TCP connect timeout from 10s → 30s.
const gdeltAgent = new Agent({
  connect:        { timeout: 30_000 },
  headersTimeout: 40_000,
  bodyTimeout:    20_000,
});

async function gdeltFetch(url: string): Promise<Response> {
  return undiciFetch(url, {
    dispatcher: gdeltAgent,
    signal:     AbortSignal.timeout(45_000),
  }) as unknown as Response;
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class GDELTClient implements SourceClient {
  readonly name = 'gdelt';

  async fetch(_since?: string): Promise<GDELTResponse> {
    const allArticles: GDELTArticle[] = [];
    let successCount = 0;
    let failCount    = 0;

    for (let i = 0; i < QUERIES.length; i++) {
      const q = QUERIES[i]!;

      // Respect GDELT's dynamic rate limit between queries
      if (i > 0) {
        logger.debug(this.name, `Waiting ${INTER_QUERY_DELAY_MS / 1000}s before next query`);
        await delay(INTER_QUERY_DELAY_MS);
      }

      const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
      url.searchParams.set('query',      q);
      url.searchParams.set('mode',       'artlist');
      // Bumped from 25 → 50 to widen the net per query. Still well below
      // GDELT's per-call ceiling and won't slow the pipeline meaningfully.
      url.searchParams.set('maxrecords', '50');
      url.searchParams.set('timespan',   '24h');
      url.searchParams.set('format',     'json');

      logger.info(this.name, `Fetching query (${i + 1}/${QUERIES.length}): "${q}"`);

      let res: Response | null = null;
      let attempts = 0;
      const MAX_ATTEMPTS = 2;
      try {
        // Retry once on 429 / transient 5xx after RETRY_BACKOFF_MS.
        while (attempts < MAX_ATTEMPTS) {
          attempts++;
          res = await gdeltFetch(url.toString());
          if (res.ok) break;
          const retryable = res.status === 429 || res.status >= 500;
          if (!retryable || attempts >= MAX_ATTEMPTS) break;
          logger.warn(this.name, `HTTP ${res.status} on "${q}" — retrying after ${RETRY_BACKOFF_MS / 1000}s`);
          await delay(RETRY_BACKOFF_MS);
        }

        if (!res || !res.ok) {
          logger.warn(this.name, `HTTP ${res?.status ?? 'no-response'} on query "${q}" — skipping after ${attempts} attempt(s)`);
          failCount++;
          continue;
        }

        const text = await res.text();
        if (!text.trim()) {
          logger.warn(this.name, `Empty response for query "${q}"`);
          failCount++;
          continue;
        }

        let data: GDELTResponse;
        try {
          data = JSON.parse(text) as GDELTResponse;
        } catch {
          logger.warn(this.name, `Invalid JSON for query "${q}": ${text.slice(0, 120)}`);
          failCount++;
          continue;
        }

        const articles = data.articles ?? [];
        logger.info(this.name, `Got ${articles.length} articles for query "${q}"`);
        allArticles.push(...articles);
        successCount++;

      } catch (err) {
        const msg   = (err instanceof Error) ? err.message : String(err);
        const causeErr = (err instanceof Error) ? (err as Error & { cause?: Error }).cause : undefined;
        const cause = causeErr?.message;
        logger.warn(this.name, `Query "${q}" failed — skipping`, { error: msg, cause });
        failCount++;
      }
    }

    // Hard-fail only if every query failed — a partial result is still useful
    if (successCount === 0 && failCount > 0) {
      throw new SourceFetchError(
        this.name,
        `All ${failCount} queries failed — GDELT may be unavailable or rate limiting`,
      );
    }

    logger.info(this.name, `Done: ${successCount} queries succeeded, ${failCount} skipped`);
    return { articles: allArticles };
  }
}
