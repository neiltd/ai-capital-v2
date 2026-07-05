// UCDP GED (Georeferenced Events Dataset) client. Scaffolded 2026-06-26
// while waiting on the free access token from mertcan.yilmaz@pcr.uu.se.
//
// When UCDP_TOKEN is not set, fetch() throws SourceFetchError with a clear
// "token not configured" message — the pipeline treats this as a soft failure
// per run.ts's anyOk gate, so the rest of the ingestion keeps running.
//
// Once the token arrives, drop it in apps/world-intelligence-data-hub-/.env:
//   UCDP_TOKEN=<token>
// No code change required — the run.ts client list already includes UCDP.

import { env } from '../../lib/env.ts';
import { logger } from '../../lib/logger.ts';
import { fetchWithTimeout, SourceFetchError, type SourceClient } from './base.client.ts';

// ── Raw shapes from UCDP API ─────────────────────────────────────────────────

export interface UCDPEvent {
  id:                 number;
  year:               number;
  type_of_violence:   number;       // 1=state-based, 2=non-state, 3=one-sided
  conflict_name:      string | null;
  dyad_name:          string | null;
  side_a:             string | null;
  side_b:             string | null;
  date_start:         string;        // YYYY-MM-DD
  date_end:           string;
  date_prec:          number;
  // Casualty estimates — `best` is UCDP's most-likely figure.
  best:               number | null;
  low:                number | null;
  high:               number | null;
  deaths_a:           number | null;
  deaths_b:           number | null;
  deaths_civilians:   number | null;
  deaths_unknown:     number | null;
  // Geography
  latitude:           number | string | null;
  longitude:          number | string | null;
  geom_wkt:           string | null;
  country:            string;       // free-text country name
  country_id:         number | null; // Gleditsch-Ward code, NOT ISO3
  region:             string;
  // Source citation
  source_article:     string | null;
  source_office:      string | null;
  source_date:        string | null;
  source_headline:    string | null;
  source_original:    string | null;
}

export interface UCDPResponse {
  Result:        UCDPEvent[];
  TotalCount:    number;
  TotalPages:    number;
  PageCount:     number;
  Page:          number;
  PreviousPageUrl: string | null;
  NextPageUrl:   string | null;
}

// ── Client ───────────────────────────────────────────────────────────────────

export class UCDPClient implements SourceClient {
  readonly name = 'ucdp';

  async fetch(since?: string): Promise<UCDPResponse> {
    const token = env.UCDP_TOKEN;
    if (!token) {
      // Soft fail — keeps the rest of the pipeline running. The run manifest
      // will list ucdp as 'failed' with this exact message so it's grep-able.
      throw new SourceFetchError(
        this.name,
        'UCDP_TOKEN not configured — email mertcan.yilmaz@pcr.uu.se to request access',
      );
    }

    const apiBase = env.UCDP_API_BASE_URL!;
    const version = env.UCDP_DATASET_VERSION!;
    // UCDP GED is an academic dataset with a ~6-month publication lag.
    // The most recent events in any given dataset version are typically
    // 4–8 months behind today. To ensure we always land inside the covered
    // window, we look back at least 400 days — if `since` is more recent
    // than that (e.g. a daily cursor from yesterday), we ignore it and use
    // the 400-day floor instead. This way each run picks up any newly
    // published/revised events from the latest dataset version.
    const floor = new Date(Date.now() - 400 * 24 * 3_600_000).toISOString().slice(0, 10);
    const sinceDate = since ?? floor;
    const startDate = sinceDate < floor ? sinceDate : floor;
    const endDate   = new Date().toISOString().slice(0, 10);

    const url = new URL(`${apiBase}/gedevents/${version}`);
    url.searchParams.set('StartDate', startDate);
    url.searchParams.set('EndDate',   endDate);
    url.searchParams.set('pagesize',  '500');

    logger.info(this.name, `Fetching events ${startDate} → ${endDate} (dataset ${version}) [auth: token]`);

    const res = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          'x-ucdp-access-token': token,
          'Accept':              'application/json',
        },
      },
      30_000,
    );

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new SourceFetchError(this.name, `HTTP ${res.status}: ${body}`, res.status);
    }

    const data = (await res.json()) as UCDPResponse;
    const count = Array.isArray(data.Result) ? data.Result.length : 0;
    logger.info(this.name, `Got ${count} events (page 1 of ${data.TotalPages ?? '?'})`);

    // Multi-page walk. The 400-day lookback floor means a single 500-event
    // page can no longer be assumed to cover the whole window — hot regions
    // routinely produce more than that over 400 days. Follow NextPageUrl
    // until the API stops returning one, capped at MAX_PAGES as a safety net
    // against an unbounded/looping pagination response.
    const MAX_PAGES = 20;
    const results: UCDPEvent[] = Array.isArray(data.Result) ? [...data.Result] : [];
    let page = 1;
    let nextPageUrl = data.NextPageUrl;

    while (nextPageUrl && page < MAX_PAGES) {
      const pageRes = await fetchWithTimeout(
        nextPageUrl,
        {
          headers: {
            'x-ucdp-access-token': token,
            'Accept':              'application/json',
          },
        },
        30_000,
      );

      if (!pageRes.ok) {
        const body = (await pageRes.text()).slice(0, 300);
        throw new SourceFetchError(this.name, `HTTP ${pageRes.status}: ${body}`, pageRes.status);
      }

      const pageData = (await pageRes.json()) as UCDPResponse;
      if (Array.isArray(pageData.Result)) {
        results.push(...pageData.Result);
      }
      page += 1;
      nextPageUrl = pageData.NextPageUrl;
    }

    if (nextPageUrl && page >= MAX_PAGES) {
      logger.warn(this.name, `Hit MAX_PAGES (${MAX_PAGES}) cap — more pages remain (NextPageUrl still set). Some events may be missing.`);
    }

    logger.info(this.name, `Fetched ${results.length} total events${typeof data.TotalCount === 'number' ? ` (of ${data.TotalCount} reported by TotalCount)` : ''} across ${page} page(s)`);

    return { ...data, Result: results };
  }
}
