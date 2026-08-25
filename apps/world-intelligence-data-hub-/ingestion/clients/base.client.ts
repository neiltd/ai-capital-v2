// Contract every source client must fulfill.
// The client is responsible for one thing: fetch raw data from its API.
// Normalization happens outside the client in processing/normalizers/.

export interface SourceClient {
  readonly name: string;

  // Returns raw API response. Throws on hard failure.
  // Callers are responsible for retry logic.
  fetch(since?: string): Promise<unknown>;
}

// ── Shared fetch helper with timeout ─────────────────────────────────────────

/**
 * True when an error is a request-deadline abort rather than a real protocol
 * or parse failure.
 *
 * The deadline can fire in two places: inside `fetchWithTimeout` (headers
 * phase), where it is wrapped into a named SourceFetchError, or during the
 * caller's own `await res.json()` (body phase), where it surfaces as the
 * platform's raw TimeoutError. Callers that wrap a body read in their own
 * catch must use this before claiming the payload was malformed — a timed-out
 * read is not invalid JSON, and saying so sends the next debugger down the
 * wrong path.
 */
export function isDeadlineError(err: unknown): boolean {
  if (err instanceof SourceFetchError) return err.message.includes('deadline exceeded');
  const name = (err as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * Default total deadline per request. Raised from 15s when the deadline was
 * extended to cover body reads, so a legitimately slow-but-progressing
 * response is not cut off by the wider scope.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetch under a TOTAL deadline — headers *and* body.
 *
 * The previous implementation armed an AbortController, then cleared its timer
 * in a `finally` that ran the moment the response headers arrived. Every caller
 * then does `await res.json()` / `await res.text()`, and that body read was
 * left with no deadline at all. A server that sends headers and then stalls the
 * body — exactly what a connection surviving a laptop sleep/wake does — hung
 * the client forever.
 *
 * That is the mechanism behind the 2026-08-22/23/24 pipeline failures:
 * `world-intel-pipeline` was SIGTERM'd by the queue's 30-minute cap on three
 * consecutive days (32–42 min each), while a healthy run of the same stage
 * takes ~9.6 minutes. The stage had no way to give up on one wedged source.
 *
 * `AbortSignal.timeout` stays armed until the request fully settles, so the
 * deadline now covers the body read too. Any caller-supplied signal is honored
 * alongside it rather than being clobbered.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
  try {
    return await fetch(url, { ...options, signal });
  } catch (err) {
    // Name the deadline explicitly. A bare "This operation was aborted" in a
    // stage log tells you nothing about which source wedged or for how long.
    if (deadline.aborted) {
      throw new SourceFetchError(
        'fetch',
        `deadline exceeded after ${timeoutMs}ms (headers+body) for ${url}`,
      );
    }
    throw err;
  }
}

// ── Error types ───────────────────────────────────────────────────────────────

export class SourceFetchError extends Error {
  constructor(
    public readonly source: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(`[${source}] ${message}`);
    this.name = 'SourceFetchError';
  }
}

export class QuotaExceededError extends Error {
  constructor(public readonly source: string, reason: string) {
    super(`[${source}] Quota exceeded: ${reason}`);
    this.name = 'QuotaExceededError';
  }
}
