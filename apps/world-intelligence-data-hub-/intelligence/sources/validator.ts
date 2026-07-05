import type { NewsSource } from '../../lib/types.ts';
import { SourceHealthMonitor } from './health.ts';
import { rssSources } from './registry.ts';

// ── Result type ───────────────────────────────────────────────────────────────

export interface SourceValidationResult {
  source_id:     string;
  source_name:   string;
  url:           string;
  reachable:     boolean;
  http_status?:  number;
  content_type?: string;
  is_valid_feed: boolean;
  response_ms?:  number;
  error?:        string;
}

// ── Feed detection ────────────────────────────────────────────────────────────

function looksLikeFeed(body: string): boolean {
  // Match the opening of any valid RSS 2.0 or Atom feed.
  // Check first 1 KB — avoids loading full body into regex engine.
  const head = body.trimStart().slice(0, 1_000);
  return /(<\?xml|<rss[\s>]|<feed[\s>]|<channel[\s>])/i.test(head);
}

// ── Single source check ───────────────────────────────────────────────────────

export async function validateSource(source: NewsSource): Promise<SourceValidationResult> {
  const url    = source.rss_url!;
  const result: SourceValidationResult = {
    source_id:     source.id,
    source_name:   source.name,
    url,
    reachable:     false,
    is_valid_feed: false,
  };

  const t0 = Date.now();

  try {
    const res = await fetch(url, {
      signal:  AbortSignal.timeout(20_000),
      headers: {
        'User-Agent': 'WorldIntelligenceHub/1.0 (feed-validator)',
        'Accept':     'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });

    result.response_ms  = Date.now() - t0;
    result.http_status  = res.status;
    result.content_type = res.headers.get('content-type') ?? undefined;
    result.reachable    = res.ok;

    if (res.ok) {
      // Read a bounded slice of the body — enough to identify feed type.
      // Avoids loading large feeds entirely for this check.
      const reader = res.body?.getReader();
      let body = '';
      if (reader) {
        const decoder = new TextDecoder();
        while (body.length < 4_000) {
          const { value, done } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
        reader.cancel();
      } else {
        body = await res.text();
      }

      result.is_valid_feed = looksLikeFeed(body);
      if (!result.is_valid_feed) {
        result.error = `Response does not look like RSS or Atom (content-type: ${result.content_type ?? 'none'})`;
      }
    } else {
      result.error = `HTTP ${res.status}`;
    }

  } catch (err) {
    result.response_ms = Date.now() - t0;
    const e     = err as Error & { cause?: Error };
    const base  = e.message ?? String(err);
    const cause = e.cause?.message;
    result.error = cause ? `${base} — ${cause}` : base;
  }

  return result;
}

// ── Batch check ───────────────────────────────────────────────────────────────

export async function validateAllRssSources(
  health?: SourceHealthMonitor,
): Promise<SourceValidationResult[]> {
  const sources = rssSources();

  // Run all checks concurrently — one request per source, no rate-limit risk.
  const results = await Promise.all(
    sources.map(async s => {
      const r = await validateSource(s);

      if (health) {
        if (r.reachable && r.is_valid_feed) {
          health.recordSuccess(s.id, r.response_ms ?? 0);
        } else {
          health.recordFailure(s.id, r.error ?? 'unknown');
        }
      }

      return r;
    }),
  );

  return results.sort((a, b) => a.source_id.localeCompare(b.source_id));
}
