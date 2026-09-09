import { describe, it, expect, afterEach } from 'vitest'
import {
  resolveTestUrl, assertSafeTestTarget, migratorUrlFrom, MIGRATION_LOGIN_ROLE,
} from '../testing/global-setup.js'
import {
  assertDisposableName, canonicalEndpoint, usernameOf, APPROVED_DISPOSABLE_DATABASES,
} from '../testing/preflight.js'
import { databaseNameOfRaw } from '../src/pool.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// Fail-closed coverage for the test-database bootstrap.
//
// The 2026-08-25 incident happened because a fallback quietly chose production.
// So the property under test here is not "the happy path works" — it is
// "every failure path STOPS rather than falling back to DATABASE_URL".

const saved = {
  db: process.env.DATABASE_URL,
  test: process.env.TEST_DATABASE_URL,
  // Added 2026-08-26: resolveTestUrl now consults TEST_RUNTIME_DATABASE_URL,
  // at higher precedence than DATABASE_URL. Without clearing it these tests
  // short-circuit and stop exercising the derivation and fail-closed paths —
  // they would still pass green while testing nothing, which is the exact
  // shape of silent-hole this suite keeps finding elsewhere.
  //
  // Consulting it is about TARGET SELECTION, not about sufficiency: it names a
  // database, it does not confer bootstrap authority.
  runtime: process.env.TEST_RUNTIME_DATABASE_URL,
  bootstrap: process.env.BOOTSTRAP_DATABASE_URL,
}

afterEach(() => {
  if (saved.db === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = saved.db
  if (saved.test === undefined) delete process.env.TEST_DATABASE_URL
  else process.env.TEST_DATABASE_URL = saved.test
  if (saved.runtime === undefined) delete process.env.TEST_RUNTIME_DATABASE_URL
  else process.env.TEST_RUNTIME_DATABASE_URL = saved.runtime
  if (saved.bootstrap === undefined) delete process.env.BOOTSTRAP_DATABASE_URL
  else process.env.BOOTSTRAP_DATABASE_URL = saved.bootstrap
})

// SCOPE OF THESE CASES: resolveTestUrl decides WHICH DATABASE is targeted. It
// does not decide, and these cases do not assert, whether the resolved
// credential has the authority bootstrap needs. Resolution and migration
// authority are separate concerns: a URL can resolve perfectly here and still
// fail in globalSetup with "permission denied for database …" because the
// restricted role cannot run `CREATE SCHEMA IF NOT EXISTS db`. Read a passing
// case below as "the right database was chosen", never as "this configuration
// is runnable".

describe('resolveTestUrl', () => {
  // resolveTestUrl() now delegates to preflight(), which validates BOTH
  // credentials together. The exhaustive behavioural coverage lives in
  // tests/preflight-behavior.test.ts; what is kept here is the named export's
  // own contract, since other code imports it directly.
  const RUNTIME = 'postgres://ai_capital_test_runtime@localhost:5432/ai_capital_test'

  it('resolves BOOTSTRAP_DATABASE_URL, and only that', () => {
    delete process.env.TEST_DATABASE_URL
    delete process.env.DATABASE_URL
    process.env.TEST_RUNTIME_DATABASE_URL = RUNTIME
    process.env.BOOTSTRAP_DATABASE_URL = 'postgres://boot@localhost:5432/ai_capital_test'
    expect(resolveTestUrl()).toBe('postgres://boot@localhost:5432/ai_capital_test')
  })

  it('FAILS CLOSED when BOOTSTRAP_DATABASE_URL is absent — never guesses', () => {
    delete process.env.BOOTSTRAP_DATABASE_URL
    delete process.env.DATABASE_URL
    process.env.TEST_RUNTIME_DATABASE_URL = RUNTIME
    expect(() => resolveTestUrl()).toThrow(/BOOTSTRAP_DATABASE_URL is not set/)
  })

  it('FAILS CLOSED when TEST_RUNTIME_DATABASE_URL is absent', () => {
    // Round 1 discovered this only at the END of setup, after the database had
    // been created, bootstrapped, migrated and locked down.
    delete process.env.TEST_RUNTIME_DATABASE_URL
    delete process.env.DATABASE_URL
    process.env.BOOTSTRAP_DATABASE_URL = 'postgres://boot@localhost:5432/ai_capital_test'
    expect(() => resolveTestUrl()).toThrow(/TEST_RUNTIME_DATABASE_URL is not set/)
  })

  it('does NOT fall back to TEST_DATABASE_URL', () => {
    delete process.env.BOOTSTRAP_DATABASE_URL
    process.env.TEST_DATABASE_URL = 'postgres://x@localhost:5432/ai_capital_test'
    process.env.TEST_RUNTIME_DATABASE_URL = RUNTIME
    expect(() => resolveTestUrl()).toThrow(/BOOTSTRAP_DATABASE_URL is not set/)
  })

  it('does NOT derive a _test target from DATABASE_URL', () => {
    delete process.env.BOOTSTRAP_DATABASE_URL
    delete process.env.TEST_DATABASE_URL
    process.env.TEST_RUNTIME_DATABASE_URL = RUNTIME
    process.env.DATABASE_URL = 'postgres://thanapold@db.internal:5432/ai_capital'
    expect(() => resolveTestUrl()).toThrow(/BOOTSTRAP_DATABASE_URL is not set/)
  })

  it('refuses a bootstrap credential identical to DATABASE_URL', () => {
    const shared = 'postgres://thanapold@db.internal:5432/ai_capital'
    process.env.DATABASE_URL = shared
    process.env.BOOTSTRAP_DATABASE_URL = shared
    process.env.TEST_RUNTIME_DATABASE_URL = RUNTIME
    expect(() => resolveTestUrl()).toThrow(/identical to DATABASE_URL/)
  })

  it('the refusal names both credentials the operator must supply', () => {
    delete process.env.BOOTSTRAP_DATABASE_URL
    delete process.env.TEST_RUNTIME_DATABASE_URL
    delete process.env.DATABASE_URL
    try {
      resolveTestUrl()
      throw new Error('expected a refusal')
    } catch (e) {
      const m = (e as Error).message
      expect(m).toContain('BOOTSTRAP_DATABASE_URL')
      expect(m).toContain('TEST_RUNTIME_DATABASE_URL')
      expect(m).toContain('pnpm --filter @common/db test')
    }
  })
})


describe('assertSafeTestTarget — the bootstrap must never touch a live database', () => {
  it('refuses the live database outright', () => {
    expect(() => assertSafeTestTarget('postgres://localhost:5432/ai_capital'))
      .toThrow(/is a protected\/live database/)
  })

  it('refuses percent-encoded spellings of the live name', () => {
    // Same canonicaliser as the pool guard, so the bootstrap cannot be tricked
    // by an encoding the connection layer would decode.
    expect(() => assertSafeTestTarget('postgres://localhost:5432/ai%5Fcapital'))
      .toThrow(/protected\/live database/)
    // ROUND 10: AI_CAPITAL is now refused by the PROTECTED check, which runs
    // first and compares case-insensitively — reaching a live database must not
    // depend on which guard happens to fire. (Before Round 10 the case guard
    // caught it first; both are refusals, but naming the protected one is the
    // honest reason.) Case-exactness is still enforced, and still asserted
    // below on a name that is not protected.
    expect(() => assertSafeTestTarget('postgres://localhost:5432/AI_CAPITAL'))
      .toThrow(/protected\/live database/)
    expect(() => assertSafeTestTarget('postgres://localhost:5432/AI_CAPITAL_TEST'))
      .toThrow(/is not lower-case/)
  })

  it('refuses a URL whose database cannot be determined', () => {
    expect(() => assertSafeTestTarget('')).toThrow(/could not be canonicalised/)
    expect(() => assertSafeTestTarget('postgres://localhost:5432')).toThrow(/could not be canonicalised/)
    expect(() => assertSafeTestTarget('postgres://localhost:5432/ai_capital%00')).toThrow(/could not be canonicalised/)
  })

  it('refuses the socket: form that bypassed an earlier version of the guard', () => {
    expect(() => assertSafeTestTarget('socket:/tmp?db=ai_capital')).toThrow(/protected\/live database/)
  })

  it('honours LIVE_DATABASE_NAMES', () => {
    const prev = process.env.LIVE_DATABASE_NAMES
    process.env.LIVE_DATABASE_NAMES = 'ai_capital,other_prod'
    try {
      expect(() => assertSafeTestTarget('postgres://localhost:5432/other_prod')).toThrow(/protected\/live database/)
    } finally {
      if (prev === undefined) delete process.env.LIVE_DATABASE_NAMES
      else process.env.LIVE_DATABASE_NAMES = prev
    }
  })

  it('allows an authorized disposable database and returns its canonical name', () => {
    expect(assertSafeTestTarget('postgres://localhost:5432/ai_capital_test')).toBe('ai_capital_test')
    expect(assertSafeTestTarget('postgres://localhost:5432/ai_capital_ledger_round4_test'))
      .toBe('ai_capital_ledger_round4_test')
  })

  it('NO LONGER allows an arbitrary name such as "scratch"', () => {
    // Round 1 accepted anything not on the live list, so a typo or a scratch
    // database passed. Round 2-9 required a `_test` SUFFIX, which this file
    // called an allowlist and which it was not. Round 10 made it one.
    expect(() => assertSafeTestTarget('postgres://localhost:5432/scratch'))
      .toThrow(/is not a disposable test database/)
  })

  it('REGRESSION: the exported helper does NOT lowercase a mixed-case name', () => {
    // Codex reproduced this directly against the compatibility export:
    //   assertSafeTestTarget('.../AI_CAPITAL_TEST')  ->  'ai_capital_test'
    // Round 3 fixed the provisioning path but left this helper calling the
    // LOWERCASING databaseNameOf(), so the exported guard normalised an identity
    // the real path refuses. PostgreSQL database names are case-sensitive, so a
    // folded name is a DIFFERENT database.
    for (const db of ['AI_CAPITAL_TEST', 'Ai_Capital_Test', 'ai_Capital_test']) {
      expect(() => assertSafeTestTarget(`postgres://localhost:5432/${db}`),
        `${db} was accepted or normalised`).toThrow(/is not lower-case/)
    }
    // ... including percent-encoded spellings the driver would decode.
    expect(() => assertSafeTestTarget('postgres://localhost:5432/AI%5FCAPITAL%5FTEST'))
      .toThrow(/is not lower-case/)
  })

  it('ONE policy: the helper and the provisioning path agree exactly', () => {
    // Both must delegate to assertDisposableName, so they cannot drift.
    expect(assertSafeTestTarget('postgres://localhost:5432/ai_capital_test'))
      .toBe(assertDisposableName('ai_capital_test'))
    for (const bad of ['AI_CAPITAL_TEST', 'scratch', 'postgres']) {
      const viaHelper = (() => { try { assertSafeTestTarget(`postgres://localhost:5432/${bad}`); return null }
                                catch (e) { return (e as Error).message } })()
      const viaPolicy = (() => { try { assertDisposableName(bad); return null }
                                catch (e) { return (e as Error).message } })()
      expect(viaHelper, `${bad}: helper and policy disagree`).toBe(viaPolicy)
    }
  })

  it('refuses the maintenance databases explicitly', () => {
    for (const db of ['postgres', 'template0', 'template1']) {
      expect(() => assertSafeTestTarget(`postgres://localhost:5432/${db}`))
        .toThrow(/is a MAINTENANCE database/)
    }
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// ROUND 7 — the migrator endpoint is the bootstrap endpoint, minus the identity.
//
// Requirement: host, port and database must be IDENTICAL to the destination
// preflight already approved. Only the principal changes, and the password is
// dropped rather than reused — a cluster-administrator password is not the
// migrator's, and carrying one over would be a credential leak by another name.
// ═════════════════════════════════════════════════════════════════════════════
describe('ROUND 7: migratorUrlFrom preserves the destination exactly', () => {
  const cases = [
    ['unix socket', 'postgresql://thanapold@/ai_capital_ledger_round4_test?host=/private/tmp/g/sock&port=55432'],
    ['tcp with a password', 'postgres://boot:s3cr3t@localhost:5433/ai_capital_test'],
    ['tcp with the default port', 'postgres://boot@localhost/ai_capital_test'],
  ] as const

  for (const [label, url] of cases) {
    it(`6. host, port and database are unchanged — ${label}`, () => {
      const derived = migratorUrlFrom(url)
      expect(canonicalEndpoint(derived, 'migrator'))
        .toEqual(canonicalEndpoint(url, 'bootstrap'))
    })

    it(`the principal becomes ai_capital_migrator — ${label}`, () => {
      expect(usernameOf(migratorUrlFrom(url))).toBe(MIGRATION_LOGIN_ROLE)
      expect(MIGRATION_LOGIN_ROLE).toBe('ai_capital_migrator')
    })

    it(`no credential from the bootstrap URL survives — ${label}`, () => {
      const derived = migratorUrlFrom(url)
      expect(derived).not.toMatch(/s3cr3t/)
      expect(derived, 'a password was carried into the derived URL')
        .not.toMatch(/:[^/@]*@/)
    })
  }

  it('the derived URL still passes the disposable-name policy', () => {
    const derived = migratorUrlFrom('postgres://boot@localhost:5433/ai_capital_ledger_round4_test')
    expect(assertSafeTestTarget(derived)).toBe('ai_capital_ledger_round4_test')
  })

  it('refuses a bootstrap URL with no host, rather than inventing one', () => {
    expect(() => migratorUrlFrom('postgres:///ai_capital_test'))
      .toThrow(/names no host or socket directory/)
  })

  it('refuses a bootstrap URL with no database', () => {
    expect(() => migratorUrlFrom('postgres://boot@localhost:5433'))
      .toThrow(/names no database/)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// ROUND 8 / DEFECT 2 — transport policy is part of the destination.
//
// Round 7 rebuilt host, port and database and dropped everything else, so a
// bootstrap URL carrying `sslmode=verify-full&sslrootcert=/etc/ca.pem` produced
// a migrator URL with neither. The connection still worked; it just no longer
// verified the server it was migrating. A downgrade nobody chose is worse than
// a refusal, because it succeeds.
// ═════════════════════════════════════════════════════════════════════════════
describe('ROUND 8: migratorUrlFrom preserves transport policy', () => {
  const q = (url: string) => new URLSearchParams(url.slice(url.indexOf('?') + 1))

  it('7. the unix-socket form the disposable gate uses still works', () => {
    const src = 'postgresql://thanapold@/ai_capital_ledger_round4_test' +
      '?host=/private/tmp/g/sock&port=55432'
    const out = migratorUrlFrom(src)
    expect(canonicalEndpoint(out, 'migrator')).toEqual(canonicalEndpoint(src, 'bootstrap'))
    expect(q(out).get('host')).toBe('/private/tmp/g/sock')
    expect(q(out).get('port')).toBe('55432')
    expect(usernameOf(out)).toBe(MIGRATION_LOGIN_ROLE)
  })

  it('sslmode=verify-full survives — the headline downgrade', () => {
    const out = migratorUrlFrom(
      'postgres://boot:s3cr3t@db.internal:5433/ai_capital_test?sslmode=verify-full')
    expect(q(out).get('sslmode'), 'TLS policy was silently weakened').toBe('verify-full')
  })

  it('the whole non-secret policy set survives, byte for byte', () => {
    const policy = {
      sslmode: 'verify-full',
      // pg-connection-string OPENS these while parsing, so they must exist.
      sslrootcert: '/etc/hosts',
      sslcrl: '/etc/hosts',
      ssl_min_protocol_version: 'TLSv1.3',
      channel_binding: 'require',
      connect_timeout: '7',
      target_session_attrs: 'read-write',
      application_name: 'ai-capital-gate',
      keepalives_idle: '30',
      options: '-c statement_timeout=0',
    }
    const src = 'postgres://boot@db.internal:5433/ai_capital_test?' +
      new URLSearchParams(policy).toString()
    const out = q(migratorUrlFrom(src))
    for (const [k, v] of Object.entries(policy)) {
      expect(out.get(k), `${k} was dropped`).toBe(v)
    }
  })

  it('policy parameters are preserved regardless of case', () => {
    const out = q(migratorUrlFrom(
      'postgres://boot@db.internal:5433/ai_capital_test?SSLMode=verify-full'))
    expect(out.get('sslmode')).toBe('verify-full')
  })

  it('the bootstrap password is removed, and no credential survives', () => {
    const out = migratorUrlFrom(
      'postgres://boot:s3cr3t@db.internal:5433/ai_capital_test?sslmode=require&password=other')
    expect(out).not.toMatch(/s3cr3t/)
    expect(out).not.toMatch(/other/)
    expect(out, 'a password reached the derived URL').not.toMatch(/:[^/@]*@/)
    expect(q(out).has('password')).toBe(false)
    expect(q(out).has('user')).toBe(false)
    expect(q(out).get('sslmode'), 'policy was lost along with the credential').toBe('require')
  })

  for (const param of ['sslcert', 'sslkey', 'sslpassword', 'passfile']) {
    it(`3. an identity-bearing ${param} FAILS CLOSED rather than being copied or dropped`, () => {
      const src = `postgres://boot@db.internal:5433/ai_capital_test?${param}=/etc/ssl/boot.pem`
      expect(() => migratorUrlFrom(src)).toThrow(/identity-bearing parameter/)
      expect(() => migratorUrlFrom(src)).toThrow(new RegExp(param))
      // Actionable: it says what to do instead.
      expect(() => migratorUrlFrom(src)).toThrow(/Supply a separate ai_capital_migrator credential/)
    })
  }

  it('an unknown parameter is NOT silently discarded', () => {
    const src = 'postgres://boot@db.internal:5433/ai_capital_test?sslmode=require&hocus=pocus'
    expect(() => migratorUrlFrom(src)).toThrow(/does not\n {2}classify: hocus/)
    expect(() => migratorUrlFrom(src)).toThrow(/quietly losing it would weaken/)
  })

  it('every unclassified parameter is named, not just the first', () => {
    const src = 'postgres://boot@db.internal:5433/ai_capital_test?alpha=1&beta=2'
    expect(() => migratorUrlFrom(src)).toThrow(/alpha, beta/)
  })

  it('identity material is reported even when an unknown parameter is also present', () => {
    const src = 'postgres://boot@db.internal:5433/ai_capital_test?sslkey=/k.pem&hocus=1'
    expect(() => migratorUrlFrom(src)).toThrow(/identity-bearing parameter/)
  })

  it('8/9. host, port, database and principal are unchanged under full policy', () => {
    const src = 'postgres://boot:pw@db.internal:5433/ai_capital_test' +
      '?sslmode=verify-full&sslrootcert=/etc/hosts&connect_timeout=5'
    const out = migratorUrlFrom(src)
    expect(canonicalEndpoint(out, 'migrator')).toEqual(canonicalEndpoint(src, 'bootstrap'))
    expect(usernameOf(out)).toBe('ai_capital_migrator')
  })

  it('the destination parameters are rebuilt, never duplicated', () => {
    const src = 'postgresql://boot@/ai_capital_test?host=/s&port=6000&dbname=ai_capital_test'
    const out = migratorUrlFrom(src)
    expect(q(out).getAll('host')).toEqual(['/s'])
    expect(q(out).getAll('port')).toEqual(['6000'])
    expect(q(out).has('dbname')).toBe(false)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// ROUND 9 — DATABASE IDENTITY IS PARSED, NOT PATTERN-MATCHED.
//
// tests/integration/db-isolation-live.test.ts asserted `/_test$/` against the
// WHOLE URL and then extracted the name with WHATWG `new URL()`. Both are wrong
// for the URLs this repository actually uses, and the 2026-09-08 gate failed on
// both: a socket URL ends in `&port=55433`, not in the database name, and
// `new URL()` has no notion of `?host=/private/tmp/g/sock` at all.
//
// The cases below are the ones that broke, plus the ones that would break next.
// ═════════════════════════════════════════════════════════════════════════════
describe('ROUND 9: socket-safe database identity', () => {
  const SOCKET = 'postgresql://ai_capital_test_runtime@/ai_capital_ledger_round4_test' +
    '?host=/private/tmp/aicap/sock&port=55433'

  it('a socket URL with host and port query parameters yields the NAME', () => {
    expect(databaseNameOfRaw(SOCKET)).toBe('ai_capital_ledger_round4_test')
  })

  it('the socket URL does NOT end in the database name — the old assertion was wrong', () => {
    expect(SOCKET).not.toMatch(/_test$/)
    expect(databaseNameOfRaw(SOCKET)).toMatch(/_test$/)
  })

  it('WHATWG new URL() cannot be used for this — it does not survive the socket form', () => {
    // Documents WHY the helper is mandatory rather than merely preferred.
    let whatwg: string | null = null
    try {
      whatwg = new URL(SOCKET).pathname.replace(/^\//, '')
    } catch { whatwg = null }
    expect(whatwg, 'new URL() agreed with the driver — the guard would be untested')
      .not.toBe('ai_capital_ledger_round4_test')
  })

  it('a plain TCP URL yields the name', () => {
    expect(databaseNameOfRaw('postgres://u:p@localhost:5433/ai_capital_test'))
      .toBe('ai_capital_test')
  })

  it('a query string AFTER an _test name does not confuse the parse', () => {
    expect(databaseNameOfRaw(
      'postgres://u@localhost:5433/ai_capital_test?sslmode=verify-full&connect_timeout=5'))
      .toBe('ai_capital_test')
  })

  it('percent-encoding is decoded to the real identity, and then judged', () => {
    // `ai%5Fcapital` decodes to `ai_capital` — a PROTECTED name wearing a
    // disguise. The parse must reveal it, and the policy must refuse it.
    const encoded = 'postgres://u@localhost:5433/ai%5Fcapital'
    expect(databaseNameOfRaw(encoded)).toBe('ai_capital')
    expect(() => assertDisposableName(databaseNameOfRaw(encoded)))
      .toThrow(/protected\/live database/)
  })

  it('the allowlist is the repository policy, not a local rule', () => {
    expect(assertDisposableName('ai_capital_ledger_round4_test'))
      .toBe('ai_capital_ledger_round4_test')
    expect(assertDisposableName('ai_capital_test')).toBe('ai_capital_test')
    expect(() => assertDisposableName('scratch')).toThrow(/not a disposable test database/)
    expect(() => assertDisposableName('postgres')).toThrow(/MAINTENANCE database/)
    expect(() => assertDisposableName('ai_capital')).toThrow(/protected\/live database/)
    expect(() => assertDisposableName('AI_CAPITAL_TEST')).toThrow(/is not lower-case/)
  })

  it('a malformed destination yields no name, and the policy refuses it', () => {
    expect(databaseNameOfRaw('postgres://u@localhost:5433')).toBeFalsy()
    expect(() => assertDisposableName(databaseNameOfRaw('postgres://u@localhost:5433')))
      .toThrow(/could not be canonicalised/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ROUND 9 — SOURCE CONTRACTS for the two integration files.
//
// These files are only executed by `test:integration`, so a database-free suite
// cannot observe their behaviour. What it CAN do is hold the line on the two
// specific constructs that failed the gate, and on the one "fix" that would be
// worse than the bug.
// ═════════════════════════════════════════════════════════════════════════════
describe('ROUND 9: integration-file source contracts', () => {
  const readSrc = (rel: string) => readFileSync(join(HERE, rel), 'utf-8')
  /** Executable text only — these files DISCUSS the removed patterns in prose. */
  const exec = (src: string) => src.split('\n')
    .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join('\n')

  it('db-isolation-live no longer suffix-matches the URL', () => {
    const c = exec(readSrc('integration/db-isolation-live.test.ts'))
    expect(c, 'the /_test$/ whole-URL assertion is back').not.toMatch(/toMatch\(\/_test\\\$\//)
  })

  it('db-isolation-live no longer uses WHATWG new URL()', () => {
    const c = exec(readSrc('integration/db-isolation-live.test.ts'))
    expect(c, 'new URL() is back and will throw on socket URLs').not.toMatch(/new URL\(/)
  })

  it('db-isolation-live uses the repository parser and the repository policy', () => {
    const c = exec(readSrc('integration/db-isolation-live.test.ts'))
    expect(c).toMatch(/databaseNameOfRaw\(/)
    expect(c).toMatch(/assertDisposableName\(/)
  })

  it('BOTH explicit not-production assertions are still there', () => {
    // One guards the identity check, one guards the fixture write. Counting
    // matters: a single surviving occurrence made an earlier mutation control
    // pass while half the protection had been deleted.
    const c = exec(readSrc('integration/db-isolation-live.test.ts'))
    const occurrences = c.split('\n').filter(l => l.includes("not.toBe('ai_capital')"))
    expect(occurrences, 'an explicit not-production assertion was dropped').toHaveLength(2)
  })

  it('privilege-model never names production outside the gated helper', () => {
    const c = exec(readSrc('integration/privilege-model.test.ts'))
    const calls = c.split('\n').filter(l => l.includes('has_database_privilege'))
    expect(calls, 'has_database_privilege moved out of productionAcl()').toHaveLength(1)
    expect(c).toMatch(/FROM pg_database WHERE datname = \$1/)
  })

  it('the productionAcl helper REFUSES when production is absent', () => {
    // The guard itself, not merely the message it would print. Disabling this
    // condition is the difference between "no evidence" and a fabricated false.
    const c = exec(readSrc('integration/privilege-model.test.ts'))
    expect(c, 'the productionExists() guard was removed or disabled')
      .toMatch(/if \(!\(await productionExists\(\)\)\) \{\s*\n\s*throw new Error\(/)
  })

  it('the suite ASSERTS that absence produces a refusal, not a value', () => {
    const c = exec(readSrc('integration/privilege-model.test.ts'))
    expect(c, 'nothing proves absence is refused rather than answered')
      .toMatch(/rejects\.toThrow\(\/Absence is not proof of safety\/\)/)
  })

  it('privilege-model never converts an ABSENT production database into a pass', () => {
    const c = exec(readSrc('integration/privilege-model.test.ts'))
    expect(c).toMatch(/Absence is not proof of safety/)
    // A catch that swallows the "does not exist" error and asserts false is the
    // one shape that must never appear.
    expect(c, 'a missing production database is being reported as safe')
      .not.toMatch(/catch[\s\S]{0,120}toBe\(false\)/)
  })

  it('the cluster-local checks that work everywhere were KEPT', () => {
    const c = exec(readSrc('integration/privilege-model.test.ts'))
    expect(c).toMatch(/toBe\('ai_capital_test_runtime'\)/)   // runtime identity
    expect(c).toMatch(/not\.toBe\(PRODUCTION\)/)             // not connected to production
    expect(c).toMatch(/rolbypassrls/)                        // attribute drift
    expect(c).toMatch(/pg_auth_members/)                     // membership drift
    expect(c).toMatch(/rolsuper AND rolname NOT LIKE/)       // sole superuser
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// ROUND 10 / DEFECT 1 — an allowlist, not a suffix.
//
// Rounds 2-9 accepted "any lower-case identifier ending in _test" and the
// source called it an allowlist. Codex confirmed `customer_test` and
// `unrelated_test` were accepted — either could be somebody else's real
// database, which this harness would then migrate and write fixtures into.
// ═════════════════════════════════════════════════════════════════════════════
describe('ROUND 10: the disposable-database allowlist is exact', () => {
  const savedLive = process.env.LIVE_DATABASE_NAMES
  afterEach(() => {
    if (savedLive === undefined) delete process.env.LIVE_DATABASE_NAMES
    else process.env.LIVE_DATABASE_NAMES = savedLive
  })

  it('the approved set is exactly two names', () => {
    expect([...APPROVED_DISPOSABLE_DATABASES])
      .toEqual(['ai_capital_test', 'ai_capital_ledger_round4_test'])
  })

  it.each([...APPROVED_DISPOSABLE_DATABASES])('%s is accepted', name => {
    expect(assertDisposableName(name)).toBe(name)
  })

  it.each(['customer_test', 'unrelated_test', 'scratch_test', 'x_test', 'my_test'])(
    '%s is REFUSED despite the _test suffix', name => {
      expect(() => assertDisposableName(name)).toThrow(/is not a disposable test database/)
      expect(() => assertDisposableName(name)).toThrow(/SUFFIX IS NOT AUTHORIZATION/)
    })

  it.each(['AI_CAPITAL_TEST', 'Ai_Capital_Test', 'ai_Capital_test',
           'AI_CAPITAL_LEDGER_ROUND4_TEST'])(
    'the mixed-case variant %s is refused, never folded into an approved name', name => {
      expect(() => assertDisposableName(name)).toThrow(/is not lower-case/)
    })

  it('a protected name is refused FIRST, even if it is also on the approved list', () => {
    // The ordering guarantee: LIVE_DATABASE_NAMES always wins. Declaring an
    // approved name live must lock it out, not create a contradiction the
    // allowlist resolves in favour of access.
    process.env.LIVE_DATABASE_NAMES = 'ai_capital,ai_capital_test'
    expect((APPROVED_DISPOSABLE_DATABASES as readonly string[])).toContain('ai_capital_test')
    expect(() => assertDisposableName('ai_capital_test')).toThrow(/protected\/live database/)
    // ...and the other approved name still works, so this is a targeted lockout.
    expect(assertDisposableName('ai_capital_ledger_round4_test'))
      .toBe('ai_capital_ledger_round4_test')
  })

  it('protected and maintenance refusals still precede the allowlist', () => {
    expect(() => assertDisposableName('ai_capital')).toThrow(/protected\/live database/)
    expect(() => assertDisposableName('postgres')).toThrow(/MAINTENANCE database/)
    expect(() => assertDisposableName('template1')).toThrow(/MAINTENANCE database/)
    expect(() => assertDisposableName('AI_CAPITAL'), 'case must not evade the live check')
      .toThrow(/protected\/live database/)
  })

  it('a non-identifier is refused before it can be compared to anything', () => {
    expect(() => assertDisposableName('ai capital test')).toThrow(/not a plain lower-case identifier/)
    expect(() => assertDisposableName('drop--table_test')).toThrow(/not a plain lower-case identifier/)
    expect(() => assertDisposableName(null)).toThrow(/could not be canonicalised/)
  })

})

// ═════════════════════════════════════════════════════════════════════════════
// CROSS-PACKAGE ALLOWLIST PARITY — EXACT, NOT "CONTAINS".
//
// The previous version of this check found the line declaring
// ALLOWED_TEST_DATABASES in the investment-ledger support module and asserted
// that each of THIS package's two approved names appeared somewhere in it. That
// is a substring search, and it is vacuous against the failure that matters:
// a ledger allowlist widened to
//
//     ['ai_capital_test', 'ai_capital_ledger_round4_test', 'customer_test']
//
// still contains both names, so the test still passed while the two halves of
// the repository had begun to disagree about which databases are disposable.
//
// The set is now PARSED and compared both ways round, with duplicates detected.
// The ledger source is read as TEXT: importing it would execute an integration
// support module that opens connections, which this database-free suite must
// never do.
// ═════════════════════════════════════════════════════════════════════════════

/** Where the other package declares its allowlist. Text only, never imported. */
const LEDGER_SUPPORT = join(
  HERE, '..', '..', 'investment-ledger', 'tests', 'integration', 'support.ts')

/**
 * Extract the complete `ALLOWED_TEST_DATABASES` array from source text.
 *
 * Deliberately a narrow regex rather than an AST parser: the declaration is a
 * flat array of string literals and is asserted to stay that way. Anything the
 * parser cannot fully account for — a spread, an identifier, a template string,
 * a concatenation — is a THROW, not a silent partial read, because a partial
 * read is exactly how a widening would slip past.
 */
function parseLedgerAllowlist(src: string): string[] {
  const decl = /\bALLOWED_TEST_DATABASES\s*(?::[^=]*)?=\s*\[([\s\S]*?)\]/.exec(src)
  if (!decl) {
    throw new Error(
      'could not locate the ALLOWED_TEST_DATABASES array declaration in ' +
      'packages/investment-ledger/tests/integration/support.ts. It was renamed, ' +
      'moved, or is no longer a literal array — the cross-package contract ' +
      'cannot be checked and must not be assumed.')
  }
  const body = decl[1]
  const names = [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map(m => m[1] ?? m[2])
  if (names.length === 0) {
    throw new Error(`ALLOWED_TEST_DATABASES parsed to zero names; body was: ${body.trim()}`)
  }
  // Everything that is NOT a string literal, comma, or whitespace is unaccounted
  // for. A spread or a variable reference lands here and fails loudly.
  const residue = body
    .replace(/'[^']*'|"[^"]*"/g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/[\s,]/g, '')
  if (residue) {
    throw new Error(
      `ALLOWED_TEST_DATABASES contains tokens this check cannot account for: ` +
      `"${residue}". Only plain string literals are supported, so that a widening ` +
      'cannot hide behind a spread or an identifier.')
  }
  return names
}

/** Order-independent comparison. Reports all three failure shapes at once. */
function compareAllowlists(ledger: string[], approved: readonly string[]) {
  const duplicates = [...new Set(ledger.filter((n, i) => ledger.indexOf(n) !== i))]
  const extra   = [...new Set(ledger.filter(n => !approved.includes(n)))]
  const missing = approved.filter(n => !ledger.includes(n))
  return { duplicates, extra, missing }
}

describe('ROUND 14: cross-package allowlist parity is EXACT', () => {
  const realSource = () => readFileSync(LEDGER_SUPPORT, 'utf-8')

  it('the ledger declaration is present and fully parseable', () => {
    expect(() => parseLedgerAllowlist(realSource())).not.toThrow()
    expect(parseLedgerAllowlist(realSource()).length).toBeGreaterThan(0)
  })

  it('the ledger allowlist equals APPROVED_DISPOSABLE_DATABASES exactly', () => {
    const ledger = parseLedgerAllowlist(realSource())
    const { duplicates, extra, missing } = compareAllowlists(
      ledger, APPROVED_DISPOSABLE_DATABASES)
    expect(extra, `the ledger allows names this package does not: ${extra.join(', ')}`)
      .toEqual([])
    expect(missing, `the ledger is missing approved names: ${missing.join(', ')}`)
      .toEqual([])
    expect(duplicates, `the ledger repeats names: ${duplicates.join(', ')}`).toEqual([])
    // ...and therefore the two sets are equal as sets.
    expect([...ledger].sort()).toEqual([...APPROVED_DISPOSABLE_DATABASES].sort())
  })

  it('ORDER is irrelevant, and that is a fact about the code, not a concession', () => {
    // Both sides test membership with Array.prototype.includes, so no behaviour
    // depends on the order of either array. Asserted from the ledger source so
    // a change to an order-sensitive lookup would surface here.
    const src = realSource()
    expect(src, 'the ledger no longer uses includes() for membership')
      .toMatch(/ALLOWED_TEST_DATABASES as readonly string\[\]\)\.includes\(/)
  })

  // ── NON-VACUITY: mutate the source TEXT IN MEMORY. The real ledger file is
  //    never written to; each case proves the comparison actually bites.
  const mutate = (from: string, to: string) => {
    const src = realSource()
    expect(src.includes(from), `mutation anchor not found: ${from}`).toBe(true)
    return src.replace(from, to)
  }
  const APPROVED_LIST = "['ai_capital_test', 'ai_capital_ledger_round4_test']"

  it('CONTROL 1 — an added name (customer_test) FAILS parity', () => {
    const src = mutate(APPROVED_LIST,
      "['ai_capital_test', 'ai_capital_ledger_round4_test', 'customer_test']")
    const r = compareAllowlists(parseLedgerAllowlist(src), APPROVED_DISPOSABLE_DATABASES)
    expect(r.extra).toEqual(['customer_test'])
    expect(r.missing).toEqual([])
    expect(r.duplicates).toEqual([])
  })

  it('CONTROL 2 — a removed approved name FAILS parity', () => {
    const src = mutate(APPROVED_LIST, "['ai_capital_test']")
    const r = compareAllowlists(parseLedgerAllowlist(src), APPROVED_DISPOSABLE_DATABASES)
    expect(r.missing).toEqual(['ai_capital_ledger_round4_test'])
    expect(r.extra).toEqual([])
    // ...and the other direction too.
    const src2 = mutate(APPROVED_LIST, "['ai_capital_ledger_round4_test']")
    expect(compareAllowlists(parseLedgerAllowlist(src2), APPROVED_DISPOSABLE_DATABASES).missing)
      .toEqual(['ai_capital_test'])
  })

  it('CONTROL 3 — a duplicated name FAILS parity', () => {
    const src = mutate(APPROVED_LIST,
      "['ai_capital_test', 'ai_capital_test', 'ai_capital_ledger_round4_test']")
    const r = compareAllowlists(parseLedgerAllowlist(src), APPROVED_DISPOSABLE_DATABASES)
    expect(r.duplicates).toEqual(['ai_capital_test'])
    expect(r.extra).toEqual([])
    expect(r.missing).toEqual([])
  })

  it('CONTROL 4 — REORDERING the two approved names remains ACCEPTED', () => {
    const src = mutate(APPROVED_LIST,
      "['ai_capital_ledger_round4_test', 'ai_capital_test']")
    const r = compareAllowlists(parseLedgerAllowlist(src), APPROVED_DISPOSABLE_DATABASES)
    expect(r).toEqual({ duplicates: [], extra: [], missing: [] })
  })

  // ── The parser must fail loudly rather than read partially.
  it('a missing declaration THROWS rather than passing vacuously', () => {
    const src = mutate('ALLOWED_TEST_DATABASES = [', 'SOMETHING_ELSE_ENTIRELY = [')
    expect(() => parseLedgerAllowlist(src)).toThrow(/could not locate/)
  })

  it('a spread or identifier in the array THROWS rather than being ignored', () => {
    const spread = mutate(APPROVED_LIST,
      "[...SOME_OTHER_LIST, 'ai_capital_test', 'ai_capital_ledger_round4_test']")
    expect(() => parseLedgerAllowlist(spread)).toThrow(/cannot account for/)
    const ident = mutate(APPROVED_LIST, "[NAME_CONSTANT, 'ai_capital_test']")
    expect(() => parseLedgerAllowlist(ident)).toThrow(/cannot account for/)
  })

  it('an empty array THROWS rather than comparing as trivially disjoint', () => {
    const src = mutate(APPROVED_LIST, '[]')
    expect(() => parseLedgerAllowlist(src)).toThrow(/parsed to zero names/)
  })
})
