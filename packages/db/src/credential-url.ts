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
 * The NON-SECRET endpoint fields a credential states, plus the credential
 * itself unchanged.
 *
 * WHY THIS EXISTS. A caller that must prove WHERE a connection was asked to go
 * — not merely that the request was well formed — needs the decoded host,
 * port, database and role. Re-parsing the URL at the call site would mean a
 * second parser with a second set of rules, which is exactly what this module
 * was extracted to prevent. So the one parse that already happens is made
 * available, and `url` carries the original string byte for byte for the driver.
 *
 * `port` is the credential's own text, NOT normalised and NOT defaulted: the
 * generic validator does not require a port (a TCP consumer may legitimately
 * rely on the server default), so callers that DO require one impose that rule
 * themselves and can say precisely what was wrong. An absent port reads as ''.
 *
 * THE PASSWORD IS DELIBERATELY ABSENT. pg-connection-string returns it; nothing
 * here copies it, so no caller can accidentally log an endpoint description and
 * leak a secret with it.
 */
export interface CredentialEndpoint {
  /** The credential exactly as supplied. Never reassembled or normalised. */
  url: string
  /** The DECODED role. Percent-encoding is resolved by the parser. */
  user: string
  /** The DECODED host: a socket directory for a Unix target, else a hostname. */
  host: string
  /** The DECODED database name. */
  database: string
  /** The port exactly as the credential stated it; '' when it stated none. */
  port: string
}

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
 * AN OPTIONAL ROLE CONSTRAINT, SHARING THE SAME PARSE. Some credentials are not
 * merely "explicit" but must belong to one named role — the pipeline worker must
 * hold `ai_capital_pipeline` and nothing else, because a valid URL for a broader
 * role is exactly the escalation the boundary exists to prevent. That check
 * reuses the fields parsed below rather than introducing a second parser: one
 * parse, one set of rules, one place to get them wrong. Callers that omit
 * `expected` are unaffected — the dashboard pool and the claim writer pass
 * nothing and behave exactly as before.
 *
 * THIS FUNCTION IS THE WHOLE VALIDATOR, and the endpoint it returns is the one
 * parse everything else reuses. requireExplicitPostgresUrl below is a thin
 * wrapper over it that returns `url` alone, so every existing caller and its
 * tests are unaffected in signature, behaviour and error text; a caller that also
 * needs to know WHERE the credential points calls this function instead.
 *
 * @param varName  the environment variable being validated, for the message only
 * @param raw      its value, exactly as read
 * @param expected optional constraint on the DECODED username
 */
export function describeExplicitPostgresUrl(
  varName: string,
  raw: string | undefined,
  expected?: { user: string },
): CredentialEndpoint {
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

  // ── OPTIONAL EXACT ROLE ───────────────────────────────────────────────────
  //
  // Compared against the DECODED username. pg-connection-string percent-decodes
  // the userinfo, measured rather than assumed:
  //
  //   postgres://ai%5Fcapital%5Fpipeline@h:5432/d  ->  user 'ai_capital_pipeline'
  //
  // so a percent-encoded spelling of the right role is accepted and a different
  // role spelled plainly is not. The comparison is exact and case-sensitive:
  // PostgreSQL folds unquoted identifiers to lower case, so a credential naming
  // `AI_Capital_Pipeline` is either a quoted identifier for a DIFFERENT role or
  // an operator mistake, and guessing which one is not this function's job.
  //
  // The error names the variable and the role that was required. It never names
  // the role that was found: that value came from the credential, and a message
  // is one `tee` away from a log file.
  if (expected !== undefined) {
    const actual = fields.user === undefined || fields.user === null ? '' : String(fields.user)
    if (actual !== expected.user) {
      throw new Error(
        `@common/db: ${varName} must name the ${expected.user} role. ` +
        'A credential for any other role is refused here even when it is otherwise ' +
        'valid — a broader role would satisfy every syntactic check and still be an ' +
        'escalation. The role actually named is not reported.',
      )
    }
  }

  // The ORIGINAL string, byte for byte. Not parsed.href, not a normalised form,
  // and nothing reassembled from the fields above: URL round-tripping can alter
  // percent-encoding, and a rewritten database name is exactly the class of
  // mutation assertNotLiveDatabase() exists to catch.
  const str = (v: string | null | undefined): string =>
    v === undefined || v === null ? '' : String(v)
  return {
    url: raw,
    user: str(fields.user),
    host: str(fields.host),
    database: str(fields.database),
    port: str((fields as { port?: string | null }).port),
  }
}

/**
 * The credential, validated, returned byte for byte. UNCHANGED in signature and
 * in behaviour: it is describeExplicitPostgresUrl's `.url`, so the dashboard
 * pool, the claim writer and the pipeline worker see exactly what they saw.
 */
export function requireExplicitPostgresUrl(
  varName: string,
  raw: string | undefined,
  expected?: { user: string },
): string {
  return describeExplicitPostgresUrl(varName, raw, expected).url
}
