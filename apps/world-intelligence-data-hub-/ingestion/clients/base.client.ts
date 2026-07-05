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

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
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
