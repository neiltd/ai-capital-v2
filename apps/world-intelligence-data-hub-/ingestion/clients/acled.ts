import { requireKey, env } from '../../lib/env.ts';
import { logger } from '../../lib/logger.ts';
import { fetchWithTimeout, SourceFetchError, type SourceClient } from './base.client.ts';

// ── Raw shapes returned by ACLED API ─────────────────────────────────────────

export interface ACLEDEvent {
  event_id_cnty: string;
  event_date:    string;
  year:          string;
  event_type:    string;
  sub_event_type: string;
  actor1:        string;
  actor2:        string;
  country:       string;
  iso3:          string;
  region:        string;
  admin1:        string;
  admin2:        string;
  location:      string;
  latitude:      string;
  longitude:     string;
  geo_precision: number;
  source:        string;
  notes:         string;
  fatalities:    number;
}

export interface ACLEDResponse {
  status:  number;
  success: boolean;
  count:   number;
  data:    ACLEDEvent[];
}

// ── In-memory token cache ─────────────────────────────────────────────────────
// Token lives in memory only. Never written to disk, never logged.

interface TokenCache {
  token:     string;
  expiresAt: number; // Date.now() milliseconds
}

const REFRESH_BUFFER_MS = 120_000; // refresh 2 min before real expiry
let _tokenCache: TokenCache | null = null;

// ── OAuth2 token acquisition ──────────────────────────────────────────────────

export async function acquireToken(): Promise<string> {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt - REFRESH_BUFFER_MS) {
    logger.debug('acled', 'Using cached OAuth token');
    return _tokenCache.token;
  }

  // requireKey throws ConfigurationError (never retried) if var is absent
  const username = requireKey('ACLED_USERNAME', 'acled');
  const password = requireKey('ACLED_PASSWORD', 'acled');

  // These have defaults from the schema, so env.* is always defined
  const tokenUrl = env.ACLED_TOKEN_URL!;
  const clientId = env.ACLED_CLIENT_ID!;
  const scope    = env.ACLED_SCOPE!;

  logger.info('acled', `Acquiring OAuth token from ${tokenUrl}`);

  const body = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
    client_id: clientId,
    scope,
  });

  let res: Response;
  try {
    res = await fetchWithTimeout(
      tokenUrl,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    body.toString(),
      },
      15_000,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SourceFetchError('acled', `Token endpoint unreachable: ${msg}`);
  }

  if (!res.ok) {
    // Body intentionally NOT read — it may echo credentials in some auth server implementations
    throw new SourceFetchError('acled', `Token exchange failed: HTTP ${res.status}`, res.status);
  }

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new SourceFetchError('acled', 'Token response was not valid JSON');
  }

  const token = data['access_token'];
  if (typeof token !== 'string' || !token) {
    throw new SourceFetchError('acled', 'Token response missing access_token field');
  }

  const expiresIn   = typeof data['expires_in'] === 'number' ? data['expires_in'] : 3600;
  const expiresInMs = expiresIn * 1000;

  _tokenCache = { token, expiresAt: Date.now() + expiresInMs };

  // Log expiry only — never log token value
  logger.info('acled', `OAuth token acquired (expires in ${Math.round(expiresIn / 60)}min)`);
  return token;
}

// ── Reset cache (useful for testing) ─────────────────────────────────────────

export function clearTokenCache(): void {
  _tokenCache = null;
}

// ── ACLED data client ─────────────────────────────────────────────────────────

const FIELDS = [
  'event_id_cnty', 'event_date', 'year', 'event_type', 'sub_event_type',
  'actor1', 'actor2', 'country', 'iso3', 'region', 'admin1', 'admin2',
  'location', 'latitude', 'longitude', 'geo_precision', 'source', 'notes', 'fatalities',
].join('|');

export class ACLEDClient implements SourceClient {
  readonly name = 'acled';

  async fetch(since?: string): Promise<ACLEDResponse> {
    const token   = await acquireToken();
    const apiBase = env.ACLED_API_BASE_URL!;
    const from    = since ?? new Date(Date.now() - 7 * 24 * 3_600_000).toISOString().slice(0, 10);

    const url = new URL(apiBase);
    url.searchParams.set('event_date',       from);
    url.searchParams.set('event_date_where', '>=');
    url.searchParams.set('limit',            '500');
    url.searchParams.set('fields',           FIELDS);

    // Log URL params only — Authorization header is never included in logs
    logger.info(this.name, `Fetching events since ${from} [auth: bearer]`);

    const res = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        'application/json',
        },
      },
      30_000,
    );

    if (!res.ok) {
      // Truncate body: avoid accidentally echoing auth details from server error messages
      const body = (await res.text()).slice(0, 300);
      throw new SourceFetchError(this.name, `HTTP ${res.status}: ${body}`, res.status);
    }

    const data = (await res.json()) as ACLEDResponse;

    if (!data.success) {
      // Log count only — never log full response (may contain request metadata)
      throw new SourceFetchError(
        this.name,
        `API returned success=false (count: ${data.count ?? '?'})`,
      );
    }

    if (!Array.isArray(data.data) || data.data.length === 0) {
      // A 7-day+ global window never legitimately has 0 events — this is the
      // account-level read-permission failure presenting as an empty 200, so
      // treat it as a failure to let the UCDP fallback engage (see run.ts).
      throw new SourceFetchError(
        this.name,
        `Returned ${data.count ?? 0} events for a global window since ${from} — treating as failure`,
      );
    }

    logger.info(this.name, `Got ${data.count} events`);
    return data;
  }
}
