// Validates credentials without fetching real data or consuming quota.
// Usage: npx tsx scripts/validate-credentials.ts
//
// ACLED: performs a real OAuth token exchange to confirm credentials work.
// EIA / UCDP: presence check only (format validation, no API call).
//
// Sources checked here come from lib/sources-config.ts's SOURCE_NAMES (the
// same canonical list run.ts, dry-run.ts and backfill.ts use) — newsapi is
// not a production source of this pipeline, so it's intentionally absent.

import { env } from '../lib/env.ts';
import { acquireToken, clearTokenCache } from '../ingestion/clients/acled.ts';
import { logger } from '../lib/logger.ts';
import { SOURCE_NAMES, type SourceName } from '../lib/sources-config.ts';

type Result = 'ok' | 'missing' | 'failed';

const results: Partial<Record<SourceName, Result>> = {};

// ── EIA ───────────────────────────────────────────────────────────────────────

if (env.EIA_KEY) {
  // EIA keys are 40-char alphanumeric strings
  const looksValid = /^[A-Za-z0-9]{20,50}$/.test(env.EIA_KEY);
  results['eia'] = looksValid ? 'ok' : 'failed';
  if (!looksValid) logger.warn('validate', 'EIA_KEY does not match expected format');
} else {
  results['eia'] = 'missing';
}

// ── ACLED OAuth ───────────────────────────────────────────────────────────────
// This makes a real HTTP request to the token endpoint.
// It acquires (and immediately discards) a token — confirms credentials are valid.

if (env.ACLED_USERNAME && env.ACLED_PASSWORD) {
  try {
    clearTokenCache();                 // ensure a fresh exchange, not a cached hit
    await acquireToken();              // throws on bad credentials
    clearTokenCache();                 // discard token — not needed for validation only
    results['acled'] = 'ok';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('validate', `ACLED credential check failed: ${msg}`);
    results['acled'] = 'failed';
  }
} else {
  results['acled'] = 'missing';
}

// ── UCDP ──────────────────────────────────────────────────────────────────────
// Token-based auth; presence check only (no API call, matches EIA above).

if (env.UCDP_TOKEN) {
  const looksValid = env.UCDP_TOKEN.length >= 8;
  results['ucdp'] = looksValid ? 'ok' : 'failed';
  if (!looksValid) logger.warn('validate', 'UCDP_TOKEN looks too short to be valid');
} else {
  results['ucdp'] = 'missing';
}

// ── GDELT / World Bank ────────────────────────────────────────────────────────
// No credentials required
results['gdelt']     = 'ok';
results['worldbank'] = 'ok';

// Safety net: if a future source is added to SOURCE_NAMES without a
// corresponding check above, flag it loudly instead of silently omitting it
// from the summary.
for (const name of SOURCE_NAMES) {
  if (!(name in results)) {
    logger.warn('validate', `No credential check implemented for source: ${name}`);
    results[name] = 'missing';
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n── Credential validation results ──────────────────');
for (const [source, result] of Object.entries(results)) {
  const icon = result === 'ok' ? '✓' : result === 'missing' ? '○' : '✗';
  const note = result === 'missing' ? '(key not set — source will be skipped)' : '';
  console.log(`  ${icon}  ${source.padEnd(12)} ${result} ${note}`);
}
console.log('───────────────────────────────────────────────────\n');

const failed = Object.values(results).filter(r => r === 'failed').length;
if (failed > 0) {
  logger.error('validate', `${failed} source(s) failed credential check`);
  process.exit(1);
} else {
  logger.info('validate', 'All configured credentials validated successfully');
}
