// THE CANONICAL EXPLICIT-CREDENTIAL VALIDATOR.
//
// Extracted from pool.ts in slice S4D so a THIRD consumer — the pipeline worker
// in `packages/queue` — can reuse it without pulling the database driver in.
//
// WHY ITS OWN MODULE. `pool.ts` imports the PostgreSQL driver, and through the
// package barrel reaches the embedded SQLite and vector stores too. The queue
// needs to validate a string, not open a connection; importing the pool for that
// would hand a long-running process drivers it never uses. This module imports
// ONE thing — the connection-string parser, a leaf dependency — and has NO side
// effect at import time: no pool, no client, no connection, no environment read.
//
// The forbidden module names are deliberately not spelled here, so the
// structural test can scan this file as raw text and stay strict.
//
// pool.ts re-exports it, so every S4A/S4B/S4C caller and its tests are unchanged.

import { parse as parseConnectionString } from 'pg-connection-string'

/** Schemes an explicit PostgreSQL credential may carry. Everything else is refused. */
const POSTGRES_URL_SCHEMES = ['postgres:', 'postgresql:']

/** The `scheme://` forms those schemes must actually be written in. */
const POSTGRES_URL_SCHEME_RE = /^postgres(ql)?:\/\//i

/**
 * Validate one explicit PostgreSQL credential — BEFORE any pool or client exists.
 *
 * SHARED, AND DELIBERATELY SO. This began as the dashboard's validator in slice
 * S4A and is now used by the claim writer as well (S4C). The logic encodes four
 * facts that were each measured rather than reasoned, and that a second copy
 * would eventually get wrong: the WHATWG parser is wrong in both directions for
 * this job; pg-connection-string reports a missing user/host as `''` and a
 * missing database as `null`; surrounding whitespace must be refused rather than
 * trimmed; and the original string must reach the driver byte-for-byte.
 *
 * Validation is a separate step and completes BEFORE construction, so an invalid
 * credential produces zero pg.Pool objects and zero connection attempts rather
 * than a pool that fails on first use.
 *
 * THERE IS NO FALLBACK, for any caller. Not DATABASE_URL, not TEST_DATABASE_URL,
 * not PGDATABASE, PGHOST, PGPORT, PGUSER or USER. A guarded fallback is still a
 * fallback, and the values it would reach for are exactly the ones that make an
 * incomplete URL resolve somewhere unintended.
 *
 * Errors name the VARIABLE and the failure, never the value: an operator needs
 * to know which credential is wrong, and a log needs not to contain it. No
 * message here interpolates the credential, its user, its host or its database.
 *
 * @param varName the environment variable being validated, for the message only
 * @param raw     its value, exactly as read
 */
export function requireExplicitPostgresUrl(varName: string, raw: string | undefined): string {
  if (raw === undefined) {
    throw new Error(
      `@common/db: ${varName} is not set. This credential has no fallback — it ` +
      'must never borrow DATABASE_URL, TEST_DATABASE_URL or any PG* variable.',
    )
  }
  // Empty and whitespace-only, in one check. `VAR=` is the ordinary way an
  // operator disables a credential in .env, and it must fail like `VAR` unset
  // rather than sliding into some other path.
  if (raw.trim() === '') {
    throw new Error(`@common/db: ${varName} is empty or whitespace-only.`)
  }
  // Surrounding whitespace is REJECTED, not trimmed. The WHATWG URL parser
  // silently strips leading and trailing spaces, so validating a trimmed copy and
  // then connecting with the untrimmed original would check one string and use
  // another. Refusing is honest; trimming would be a silent rewrite of a
  // credential.
  if (raw !== raw.trim()) {
    throw new Error(
      `@common/db: ${varName} has leading or trailing whitespace. It is refused ` +
      'rather than trimmed, so the value validated is the value used.',
    )
  }

  // Scheme allowlist, not a denylist. `file:` is the specific hazard this whole
  // seam exists for, but `http:`, `redis:` and anything else are refused by the
  // same rule rather than by enumeration.
  //
  // WHY A PREFIX TEST AND NOT `new URL()`. The WHATWG parser is wrong for this
  // job in BOTH directions, measured rather than assumed:
  //
  //   * it THROWS on a valid Unix-socket URL, because the authority is empty —
  //     `postgresql://dashboard@/db?host=%2Fvar%2Frun%2Fpostgresql` is a
  //     perfectly good target that `new URL()` calls malformed;
  //   * it ACCEPTS `postgres:foo` and `postgres:/db`, reporting protocol
  //     "postgres:", when neither names a server at all.
  //
  // Requiring the `scheme://` form admits every real PostgreSQL URI (TCP and
  // socket alike) and rejects the scheme-relative shapes outright, which leaves
  // pg-connection-string as the single parser of record below.
  if (!POSTGRES_URL_SCHEME_RE.test(raw)) {
    throw new Error(
      `@common/db: ${varName} must be a PostgreSQL URL beginning ` +
      `${POSTGRES_URL_SCHEMES.map(sc => `${sc}//`).join(' or ')}.`,
    )
  }

  // ── EXPLICIT COMPONENTS, OR NOTHING ──────────────────────────────────────
  //
  // Scheme validation alone is NOT enough, and the gap is not theoretical.
  // createPool() -> pinDestination() deliberately resolves a MISSING database
  // through PGDATABASE, then the connection-string user, then PGUSER, then USER,
  // because for the ordinary pool that is correct libpq behaviour. For this pool
  // it is a fallback by another name: the "no fallback" guarantee above would be
  // satisfied to the letter while the ambient environment silently supplied the
  // destination.
  //
  // Measured, not assumed, with PGDATABASE=ambient_dashboard_db set:
  //
  //   postgres://host.example        -> user '', host 'host.example', database null
  //   postgres://user@host.example   -> user 'user', host 'host.example', database null
  //   postgres:foo                   -> user '', host '', database 'oo'
  //
  // The first two then inherit `ambient_dashboard_db`; the third connects to a
  // database named by a typo. So the SUPPLIED VALUE must carry all three fields
  // itself. pg-connection-string is used here purely as a reader — it consults
  // no environment variable, which is exactly why it can answer "what did this
  // string actually say?" — and its answer is discarded afterwards.
  let fields: { user?: string | null; host?: string | null; database?: string | null }
  try {
    fields = parseConnectionString(raw)
  } catch {
    throw new Error(`@common/db: ${varName} could not be parsed as a connection string.`)
  }
  // Missing components come back as '' (user, host) or null (database), so
  // emptiness is the single test for all three.
  const missing = (['user', 'host', 'database'] as const)
    .filter(k => {
      const v = fields[k]
      return v === undefined || v === null || String(v).trim() === ''
    })
  if (missing.length > 0) {
    throw new Error(
      `@common/db: ${varName} must state its ${missing.join(', ')} explicitly. ` +
      'This credential never inherits connection fields from PGDATABASE, PGHOST, ' +
      'PGPORT, PGUSER or USER; an incomplete URL would be completed from the ambient ' +
      'environment, which is a fallback by another name. A Unix-socket target must ' +
      'supply the socket directory as an explicit ?host= parameter. A password is NOT ' +
      'required — passwordless authentication and .pgpass remain operator choices.',
    )
  }

  // The ORIGINAL string, byte for byte. Not parsed.href, not a normalised form,
  // and nothing reassembled from the fields above: URL round-tripping can alter
  // percent-encoding, and a rewritten database name is exactly the class of
  // mutation assertNotLiveDatabase() exists to catch.
  return raw
}
