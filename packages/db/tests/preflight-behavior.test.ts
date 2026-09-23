import { describe, it, expect } from 'vitest'
import {
  provision, assertDisposableName, canonicalEndpoint, sameEndpoint,
  fixtureGrantStatements, assertFixtureGrantsAreNarrow, assertFixtureManifestIsNarrow,
  renderFixtureGrant, FIXTURE_GRANT_MANIFEST,
  FIXTURE_FORBIDDEN_SCHEMAS, FIXTURE_ALLOWED_SCHEMAS,
  assertRuntimePrincipalRestricted, assertClusterRolesPresent, assertNoStaleLedger,
  assertRuntimeCannotReachProtected,
  RUNTIME_ROLE, REQUIRED_CLUSTER_ROLES, PreflightError,
  type ProvisionDeps, type QueryClient,
} from '../testing/preflight.js'
import { liveDatabaseNames } from '../src/pool.js'

// BEHAVIORAL PROOFS. Not one assertion here reads source text.
//
// Round 1 proved these rules with regexes over global-setup.ts. A regex sees
// that a check EXISTS; it cannot see that the check RUNS BEFORE the first
// mutation — and in Round 1 the runtime-credential check ran at the very END,
// after the database had been created, bootstrapped, migrated and locked down.
// Every side effect is injected here, and an ordered event log is asserted.

const BOOT = 'postgres://boot:pw@localhost:5432/ai_capital_test'
const RUNTIME = `postgres://${RUNTIME_ROLE}:pw@localhost:5432/ai_capital_test`
const okEnv = () => ({ BOOTSTRAP_DATABASE_URL: BOOT, TEST_RUNTIME_DATABASE_URL: RUNTIME } as NodeJS.ProcessEnv)

/** A fake client that records every query, in order, into a shared log. */
function fakeClient(log: string[], label: string, rowsFor: (sql: string) => any[]) {
  return {
    query: async (text: string) => {
      log.push(`${label}:${summarise(text)}`)
      return { rows: rowsFor(text) }
    },
    end: async () => { log.push(`${label}:end`) },
  }
}
function summarise(sql: string): string {
  const s = sql.replace(/\s+/g, ' ').trim()
  if (/^SELECT 1 FROM pg_database/i.test(s)) return 'probe-db-exists'
  if (/FROM pg_roles WHERE rolname = ANY/i.test(s)) return 'read-cluster-roles'
  if (/rolcanlogin, rolsuper/i.test(s)) return 'read-runtime-attrs'
  if (/pg_has_role/i.test(s)) return 'read-runtime-membership'
  if (/pg_stat_activity/i.test(s)) return 'read-sessions'
  if (/^REVOKE CONNECT/i.test(s)) return 'MUTATE:revoke-connect'
  if (/ALLOW_CONNECTIONS true/i.test(s)) return 'MUTATE:allow-connections'
  if (/^ALTER DATABASE .* ALLOW_CONNECTIONS false/i.test(s)) return 'MUTATE:disable-connections'
  if (/datallowconn/i.test(s)) return 'read-allowconn'
  if (/^CREATE DATABASE .* ALLOW_CONNECTIONS false/i.test(s)) return 'MUTATE:create-database'
  if (/has_database_privilege/i.test(s)) return 'read-protected-connect'
  if (/current_user AS usr/i.test(s)) return 'runtime-probe'
  if (/nspname/i.test(s)) return 'verify-schema'
  if (/current_database\(\) AS db/i.test(s)) return 'verify-identity'
  if (/to_regclass/i.test(s)) return 'probe-ledger-exists'
  if (/FROM db\.schema_migrations/i.test(s)) return 'read-ledger'
  if (/^CREATE DATABASE/i.test(s)) return 'MUTATE:create-database'
  if (/^GRANT CONNECT/i.test(s)) return 'MUTATE:grant-connect'
  if (/^GRANT /i.test(s)) return `MUTATE:fixture-grant(${s})`
  if (/010_database_bootstrap/i.test(s)) return 'MUTATE:ops-010'
  if (/090_post_migration_lockdown/i.test(s)) return 'MUTATE:ops-090'
  return `other(${s.slice(0, 30)})`
}

const HEALTHY_ROLE_ROWS = [{
  rolname: RUNTIME_ROLE, rolcanlogin: true, rolsuper: false, rolcreatedb: false,
  rolcreaterole: false, rolbypassrls: false, rolreplication: false,
}]

function deps(log: string[], over: Partial<ProvisionDeps> = {}, opts: {
  dbExists?: boolean; roleRows?: any[]; memberRows?: any[]; ledger?: string[] | null
  protectedRows?: any[]; probeUser?: string; probeDb?: string; name?: string
} = {}): ProvisionDeps {
  const NAME = opts.name ?? 'ai_capital_test'
  const rowsFor = (sql: string): any[] => {
    const k = summarise(sql)
    if (k === 'probe-db-exists') return opts.dbExists ? [{ x: 1 }] : []
    if (k === 'read-cluster-roles') return [...REQUIRED_CLUSTER_ROLES, RUNTIME_ROLE].map(r => ({ rolname: r }))
    if (k === 'read-runtime-attrs') return opts.roleRows ?? HEALTHY_ROLE_ROWS
    if (k === 'read-runtime-membership') return opts.memberRows ?? []
    if (k === 'read-protected-connect') return opts.protectedRows ?? []
    if (k === 'read-allowconn') return [{ datallowconn: true }]
    if (k === 'runtime-probe') return [{ usr: opts.probeUser ?? RUNTIME_ROLE, db: opts.probeDb ?? NAME }]
    if (k === 'verify-schema') return [{ nspname: 'x' }]
    if (k === 'verify-identity') return [{ db: opts.probeDb === undefined ? NAME : NAME }]
    if (k === 'probe-ledger-exists') return [{ present: opts.ledger != null }]
    if (k === 'read-ledger') return (opts.ledger ?? []).map(f => ({ filename: f }))
    return []
  }
  return {
    connectAdmin: async () => { log.push('connect:admin'); return fakeClient(log, 'admin', rowsFor) },
    connectTarget: async () => { log.push('connect:target'); return fakeClient(log, 'target', rowsFor) },
    connectRuntime: async () => { log.push('connect:runtime'); return fakeClient(log, 'runtime', rowsFor) },
    verifySchema: async (c) => { log.push('verify-schema'); await c.query('SELECT nspname FROM pg_namespace') },
    readOpsScript: (rel) => `-- ${rel}`,
    migrationFilesOnDisk: () => ['001_portfolio.sql', '011_identity_foundation.sql'],
    runMigrations: async () => { log.push('MUTATE:migrations'); return { applied: [], alreadyApplied: [] } },
    log: () => {},
    ...over,
  }
}

const firstMutation = (log: string[]) => log.findIndex(e => e.includes('MUTATE:'))

describe('preflight refuses BEFORE any client is created', () => {
  const noClients: ProvisionDeps = deps([], {
    connectAdmin: async () => { throw new Error('A CLIENT WAS CREATED BEFORE PREFLIGHT PASSED') },
    connectTarget: async () => { throw new Error('A CLIENT WAS CREATED BEFORE PREFLIGHT PASSED') },
  })
  const refuses = async (env: NodeJS.ProcessEnv, re: RegExp) => {
    await expect(provision(env, noClients)).rejects.toThrow(re)
  }

  it('missing BOOTSTRAP_DATABASE_URL', async () =>
    refuses({ TEST_RUNTIME_DATABASE_URL: RUNTIME } as NodeJS.ProcessEnv, /BOOTSTRAP_DATABASE_URL is not set/))

  it('missing TEST_RUNTIME_DATABASE_URL', async () =>
    refuses({ BOOTSTRAP_DATABASE_URL: BOOT } as NodeJS.ProcessEnv, /TEST_RUNTIME_DATABASE_URL is not set/))

  it('both missing, and the message names both', async () =>
    refuses({} as NodeJS.ProcessEnv, /BOOTSTRAP_DATABASE_URL and TEST_RUNTIME_DATABASE_URL are not set/))

  it.each([
    // The property under test is "a malformed URL refuses BEFORE any client
    // exists", not which guard catches it. `pg-connection-string` is lenient:
    // 'not a url' parses as a bare database name, so the disposable-name policy
    // rejects it rather than the endpoint parser. Both are pre-client refusals.
    ['not a url',                       /not a plain lower-case identifier/],
    ['postgres://boot@/',               /names no database|names no host/],
    ['postgres://boot@localhost:5432/', /names no database|names no host/],
  ])('malformed bootstrap URL %s', async (url, re) =>
    refuses({ BOOTSTRAP_DATABASE_URL: url, TEST_RUNTIME_DATABASE_URL: RUNTIME } as NodeJS.ProcessEnv, re))

  it('bootstrap identical to DATABASE_URL', async () =>
    refuses({ BOOTSTRAP_DATABASE_URL: BOOT, TEST_RUNTIME_DATABASE_URL: RUNTIME, DATABASE_URL: BOOT } as NodeJS.ProcessEnv,
      /identical to DATABASE_URL/))

  it('maintenance database names', async () => {
    for (const db of ['postgres', 'template0', 'template1']) {
      await refuses({
        BOOTSTRAP_DATABASE_URL: `postgres://boot@localhost:5432/${db}`,
        TEST_RUNTIME_DATABASE_URL: `postgres://${RUNTIME_ROLE}@localhost:5432/${db}`,
      } as NodeJS.ProcessEnv, /MAINTENANCE database/)
    }
  })

  it('a live/protected database name', async () =>
    refuses({
      BOOTSTRAP_DATABASE_URL: 'postgres://boot@localhost:5432/ai_capital',
      TEST_RUNTIME_DATABASE_URL: `postgres://${RUNTIME_ROLE}@localhost:5432/ai_capital`,
    } as NodeJS.ProcessEnv, /protected\/live database/))

  it('an arbitrary name such as "scratch"', async () =>
    refuses({
      BOOTSTRAP_DATABASE_URL: 'postgres://boot@localhost:5432/scratch',
      TEST_RUNTIME_DATABASE_URL: `postgres://${RUNTIME_ROLE}@localhost:5432/scratch`,
    } as NodeJS.ProcessEnv, /is not a disposable test database/))

  it('an unexpected runtime username', async () =>
    refuses({ BOOTSTRAP_DATABASE_URL: BOOT,
      TEST_RUNTIME_DATABASE_URL: 'postgres://someone_else@localhost:5432/ai_capital_test' } as NodeJS.ProcessEnv,
      /authenticates as "someone_else"/))

  it('the runtime URL carrying the bootstrap username', async () =>
    refuses({ BOOTSTRAP_DATABASE_URL: BOOT,
      TEST_RUNTIME_DATABASE_URL: 'postgres://boot@localhost:5432/ai_capital_test' } as NodeJS.ProcessEnv,
      /authenticates as "boot"/))
})

describe('destination equality compares the WHOLE endpoint', () => {
  const pair = (b: string, r: string) =>
    provision({ BOOTSTRAP_DATABASE_URL: b, TEST_RUNTIME_DATABASE_URL: r } as NodeJS.ProcessEnv,
      deps([], { connectAdmin: async () => { throw new Error('CLIENT CREATED') } }))

  it('same name, different host is refused', async () =>
    await expect(pair(BOOT, `postgres://${RUNTIME_ROLE}@other.host:5432/ai_capital_test`))
      .rejects.toThrow(/do not name the same destination/))

  it('same host and name, different port is refused', async () =>
    await expect(pair(BOOT, `postgres://${RUNTIME_ROLE}@localhost:5433/ai_capital_test`))
      .rejects.toThrow(/do not name the same destination/))

  it('TCP versus Unix socket is refused', async () =>
    await expect(pair(BOOT, `postgres://${RUNTIME_ROLE}@/ai_capital_test?host=/tmp/sock`))
      .rejects.toThrow(/do not name the same destination/))

  it('differing usernames alone are ACCEPTED — that is the design', () => {
    const a = canonicalEndpoint(BOOT, 'a')
    const b = canonicalEndpoint(RUNTIME, 'b')
    expect(sameEndpoint(a, b)).toBe(true)
  })

  it('an unspecified port normalises to 5432 rather than comparing unequal', () => {
    expect(sameEndpoint(
      canonicalEndpoint('postgres://u@localhost/ai_capital_test', 'a'),
      canonicalEndpoint('postgres://u@localhost:5432/ai_capital_test', 'b'),
    )).toBe(true)
  })
})

describe('the runtime principal is proven restricted from the catalogue', () => {
  const admin = (roleRows: any[], memberRows: any[] = [], protectedRows: any[] = []): QueryClient => ({
    query: async (sql: string) => ({
      rows: /pg_has_role/.test(sql) ? memberRows
          : /has_database_privilege/.test(sql) ? protectedRows
          : roleRows,
    }),
  })
  const attr = (over: Record<string, boolean>) => [{ ...HEALTHY_ROLE_ROWS[0], ...over }]

  it('accepts a genuinely restricted role', async () =>
    await expect(assertRuntimePrincipalRestricted(admin(HEALTHY_ROLE_ROWS), RUNTIME_ROLE)).resolves.toBeUndefined())

  it('refuses a role that does not exist', async () =>
    await expect(assertRuntimePrincipalRestricted(admin([]), RUNTIME_ROLE)).rejects.toThrow(/does not exist/))

  it.each([
    ['rolsuper', 'is SUPERUSER'], ['rolcreatedb', 'has CREATEDB'],
    ['rolcreaterole', 'has CREATEROLE'], ['rolbypassrls', 'has BYPASSRLS'],
    ['rolreplication', 'has REPLICATION'],
  ])('refuses a role that %s', async (flag, msg) =>
    await expect(assertRuntimePrincipalRestricted(admin(attr({ [flag]: true })), RUNTIME_ROLE))
      .rejects.toThrow(new RegExp(msg)))

  it('refuses a role that cannot log in', async () =>
    await expect(assertRuntimePrincipalRestricted(admin(attr({ rolcanlogin: false })), RUNTIME_ROLE))
      .rejects.toThrow(/cannot log in/))

  // TRANSITIVE AUTHORITY. The Round-3 cases that lived here manufactured a
  // `via_member` column and treated it as SET ROLE authority — which is the
  // very conflation Defect 2 identifies: on PostgreSQL 16+, MEMBER says nothing
  // about whether privileges are inherited or SET ROLE is permitted. They are
  // replaced by "ROUND 4 / DEFECT 2", which distinguishes MEMBER-only, USAGE
  // and SET properly, including the harmless MEMBER-only chain.
  it('accepts a role with NO privileged authority', async () =>
    await expect(assertRuntimePrincipalRestricted(admin(HEALTHY_ROLE_ROWS, []), RUNTIME_ROLE))
      .resolves.toBeUndefined())
})

describe('ORDER: nothing mutates until every preflight check has passed', () => {
  it('the full happy path runs in the contracted order', async () => {
    const log: string[] = []
    await provision(okEnv(), deps(log, {}, { dbExists: false }))
    const idx = (e: string) => log.findIndex(x => x === e || x.endsWith(e))

    // NON-MUTATING PREFACE, in order
    expect(idx('connect:admin')).toBeGreaterThan(-1)
    expect(idx('read-cluster-roles')).toBeGreaterThan(idx('connect:admin'))
    expect(idx('read-runtime-attrs')).toBeGreaterThan(idx('read-cluster-roles'))
    expect(idx('read-runtime-membership')).toBeGreaterThan(idx('read-runtime-attrs'))
    expect(idx('read-protected-connect')).toBeGreaterThan(idx('read-runtime-membership'))

    // FIRST MUTATION comes after ALL of it
    const mut = firstMutation(log)
    expect(mut).toBeGreaterThan(idx('read-protected-connect'))
    expect(log[mut]).toContain('MUTATE:create-database')

    // MUTATING SEQUENCE, in order — the grant is LAST
    expect(idx('MUTATE:ops-010')).toBeGreaterThan(idx('MUTATE:create-database'))
    expect(log.indexOf('MUTATE:migrations')).toBeGreaterThan(idx('MUTATE:ops-010'))
    expect(idx('MUTATE:ops-090')).toBeGreaterThan(log.indexOf('MUTATE:migrations'))
    expect(log.indexOf('verify-schema')).toBeGreaterThan(idx('MUTATE:ops-090'))
    expect(idx('MUTATE:grant-connect')).toBeGreaterThan(log.indexOf('verify-schema'))

    // ... and the runtime probe happens only after the grant
    expect(idx('connect:runtime')).toBeGreaterThan(idx('MUTATE:grant-connect'))
    expect(idx('runtime-probe')).toBeGreaterThan(idx('connect:runtime'))
  })

  it('a privileged runtime role stops the run with ZERO mutations', async () => {
    const log: string[] = []
    await expect(provision(okEnv(), deps(log, {}, { roleRows: [{ ...HEALTHY_ROLE_ROWS[0], rolsuper: true }] })))
      .rejects.toThrow(/is SUPERUSER/)
    expect(firstMutation(log), `a mutation ran anyway: ${log.join(' | ')}`).toBe(-1)
  })

  it('a missing cluster role stops the run with ZERO mutations', async () => {
    const log: string[] = []
    const d = deps(log)
    const orig = d.connectAdmin
    d.connectAdmin = async () => {
      const c = await orig()
      return { ...c, query: async (sql: string) => (/rolname = ANY/.test(sql) ? { rows: [] } : c.query(sql)) } as any
    }
    await expect(provision(okEnv(), d)).rejects.toThrow(/missing required role/)
    expect(firstMutation(log)).toBe(-1)
  })

  it('a STALE ledger stops the run before 010 or migrations', async () => {
    const log: string[] = []
    await expect(provision(okEnv(), deps(log, {}, {
      dbExists: true, ledger: ['011_investment_ledger.sql'],   // a superseded filename
    }))).rejects.toThrow(/DIFFERENT generation/)
    expect(log.join(' | ')).not.toContain('MUTATE:ops-010')
    expect(log.join(' | ')).not.toContain('MUTATE:migrations')
    expect(firstMutation(log), 'a mutation ran despite a stale ledger').toBe(-1)
  })

  it('a ledger whose filenames all still exist is accepted', async () => {
    const log: string[] = []
    await provision(okEnv(), deps(log, {}, { dbExists: true, ledger: ['001_portfolio.sql'] }))
    expect(log.join(' | ')).toContain('MUTATE:ops-010')
  })

  it('an existing database is NOT re-created, but IS re-granted CONNECT', async () => {
    const log: string[] = []
    await provision(okEnv(), deps(log, {}, { dbExists: true, ledger: [] }))
    expect(log.join(' | ')).not.toContain('MUTATE:create-database')
    expect(log.join(' | ')).toContain('MUTATE:grant-connect')
  })
})

describe('disposable-name policy, directly', () => {
  it('accepts the authorized disposable names', () => {
    expect(assertDisposableName('ai_capital_test')).toBe('ai_capital_test')
    expect(assertDisposableName('ai_capital_ledger_round4_test')).toBe('ai_capital_ledger_round4_test')
  })
  it.each(['postgres', 'template0', 'template1', 'ai_capital', 'scratch', 'Weird-Name', ''])(
    'refuses %s', n => expect(() => assertDisposableName(n)).toThrow(PreflightError))
  it('refuses a null name', () => expect(() => assertDisposableName(null)).toThrow(/could not be canonicalised/))
})

describe('cluster prerequisites include the test-only runtime role', () => {
  it('names ai_capital_test_runtime when it is absent, and says who creates it', async () => {
    const admin: QueryClient = { query: async () => ({ rows: REQUIRED_CLUSTER_ROLES.map(r => ({ rolname: r })) }) }
    await expect(assertClusterRolesPresent(admin)).rejects.toThrow(
      new RegExp(`missing the test-only role "${RUNTIME_ROLE}"`))
    await expect(assertClusterRolesPresent(admin)).rejects.toThrow(/NOT created by[\s\S]*000_cluster_roles/)
  })
  it('passes when every production role AND the runtime role exist', async () => {
    const admin: QueryClient = {
      query: async () => ({ rows: [...REQUIRED_CLUSTER_ROLES, RUNTIME_ROLE].map(r => ({ rolname: r })) }),
    }
    await expect(assertClusterRolesPresent(admin)).resolves.toBeUndefined()
  })
})

describe('stale-ledger guard in isolation', () => {
  const client = (present: boolean, files: string[]): QueryClient => ({
    query: async (sql: string) => /to_regclass/.test(sql)
      ? { rows: [{ present }] } : { rows: files.map(f => ({ filename: f })) },
  })
  it('is a no-op on a fresh database with no ledger', async () =>
    await expect(assertNoStaleLedger(client(false, []), 'x_test', [])).resolves.toBeUndefined())
  it('names every stale entry', async () =>
    await expect(assertNoStaleLedger(client(true, ['a.sql', 'b.sql']), 'x_test', ['a.sql']))
      .rejects.toThrow(/b\.sql/))
  it('refuses rather than offering to upgrade', async () =>
    await expect(assertNoStaleLedger(client(true, ['old.sql']), 'x_test', []))
      .rejects.toThrow(/not repaired automatically/))
})

describe('ROUND 3: database identity is RAW and case-exact', () => {
  const noClients: ProvisionDeps = deps([], {
    connectAdmin: async () => { throw new Error('A CLIENT WAS CREATED BEFORE PREFLIGHT PASSED') },
    connectTarget: async () => { throw new Error('A CLIENT WAS CREATED BEFORE PREFLIGHT PASSED') },
    connectRuntime: async () => { throw new Error('A CLIENT WAS CREATED BEFORE PREFLIGHT PASSED') },
  })
  const refusesName = async (db: string, re = /is not lower-case/) =>
    await expect(provision({
      BOOTSTRAP_DATABASE_URL: `postgres://boot@localhost:5432/${db}`,
      TEST_RUNTIME_DATABASE_URL: `postgres://${RUNTIME_ROLE}@localhost:5432/${db}`,
    } as NodeJS.ProcessEnv, noClients)).rejects.toThrow(re)

  it('refuses AI_CAPITAL_TEST before any client is created', () => refusesName('AI_CAPITAL_TEST'))
  it('refuses Ai_Capital_Test before any client is created', () => refusesName('Ai_Capital_Test'))
  it('refuses a mixed-case percent-encoded equivalent', () =>
    // AI%5FCAPITAL%5FTEST decodes to AI_CAPITAL_TEST — the driver would see the
    // decoded, still-upper-case name, so the refusal must survive the encoding.
    refusesName('AI%5FCAPITAL%5FTEST'))
  it('refuses ai_Capital_test even though it differs by one letter', () => refusesName('ai_Capital_test'))

  it('does NOT normalise: the accepted name is returned exactly as written', () => {
    expect(assertDisposableName('ai_capital_test')).toBe('ai_capital_test')
    expect(assertDisposableName('ai_capital_ledger_round4_test')).toBe('ai_capital_ledger_round4_test')
  })

  it('the RAW name is what reaches CREATE DATABASE, GRANT and the probe', async () => {
    const log: string[] = []
    const seen: string[] = []
    const d = deps(log, {}, { dbExists: false, name: 'ai_capital_ledger_round4_test' })
    const wrap = (f: any) => async (...a: any[]) => {
      const c = await f(...a)
      return { ...c, query: async (sql: string, v?: unknown[]) => { seen.push(sql); return c.query(sql, v) } }
    }
    d.connectAdmin = wrap(d.connectAdmin); d.connectTarget = wrap(d.connectTarget)
    await provision({
      BOOTSTRAP_DATABASE_URL: 'postgres://boot@localhost:5432/ai_capital_ledger_round4_test',
      TEST_RUNTIME_DATABASE_URL: `postgres://${RUNTIME_ROLE}@localhost:5432/ai_capital_ledger_round4_test`,
    } as NodeJS.ProcessEnv, d)
    expect(seen.some(q => q === 'CREATE DATABASE ai_capital_ledger_round4_test ALLOW_CONNECTIONS false')).toBe(true)
    expect(seen.some(q => q === `GRANT CONNECT ON DATABASE ai_capital_ledger_round4_test TO ${RUNTIME_ROLE}`)).toBe(true)
  })
})

describe('ROUND 3: the runtime role cannot reach a protected database', () => {
  const admin = (rows: any[]): QueryClient => ({ query: async () => ({ rows }) })

  it('accepts when every protected database is unreachable', async () =>
    await expect(assertRuntimeCannotReachProtected(
      admin([{ datname: 'ai_capital', can_connect: false }]), RUNTIME_ROLE)).resolves.toBeUndefined())

  it('refuses an explicit production CONNECT, naming the database', async () =>
    await expect(assertRuntimeCannotReachProtected(
      admin([{ datname: 'ai_capital', can_connect: true }]), RUNTIME_ROLE))
      .rejects.toThrow(/can CONNECT to protected database\(s\): ai_capital/))

  it('refuses CONNECT inherited through PUBLIC', async () => {
    // has_database_privilege resolves PUBLIC grants, so the shape is identical —
    // which is the point: role attributes would not have caught this.
    await expect(assertRuntimeCannotReachProtected(
      admin([{ datname: 'ai_capital', can_connect: true }]), RUNTIME_ROLE))
      .rejects.toThrow(/inherited through PUBLIC/)
  })

  it('refuses when ONE of several protected databases is reachable', async () =>
    await expect(assertRuntimeCannotReachProtected(admin([
      { datname: 'ai_capital', can_connect: false },
      { datname: 'other_prod', can_connect: true },
    ]), RUNTIME_ROLE)).rejects.toThrow(/other_prod/))

  it('safely skips a protected name absent from pg_database', async () =>
    // The query filters on pg_database, so a configured-but-absent name yields
    // no row at all — it cannot be reached, so it cannot fail.
    await expect(assertRuntimeCannotReachProtected(admin([]), RUNTIME_ROLE)).resolves.toBeUndefined())

  it('the permanent ai_capital protection floor is still configured', () => {
    expect(liveDatabaseNames()).toContain('ai_capital')
  })

  it('the permanent ai_capital_v3 protection floor is configured too', () => {
    // The 5433 migration target. Preflight reaches the protected set through
    // liveDatabaseNames(), so provisioning a test runtime must refuse a
    // CONNECT-capable runtime role on the new database exactly as it does on
    // the old one — without preflight naming either database itself.
    expect(liveDatabaseNames()).toContain('ai_capital_v3')
  })

  it('stops the run with ZERO mutations', async () => {
    const log: string[] = []
    await expect(provision(okEnv(), deps(log, {}, {
      protectedRows: [{ datname: 'ai_capital', can_connect: true }],
    }))).rejects.toThrow(/can CONNECT to protected/)
    expect(firstMutation(log), `a mutation ran anyway: ${log.join(' | ')}`).toBe(-1)
  })
})

describe('ROUND 3: GRANT CONNECT is last, and never survives a failure', () => {
  const grantHappened = (log: string[]) => log.some(e => e.includes('MUTATE:grant-connect'))

  it('a failed ops/010 prevents the grant', async () => {
    const log: string[] = []
    const d = deps(log, {}, { dbExists: false })
    const orig = d.connectTarget
    let n = 0
    d.connectTarget = async (u: string) => {
      const c = await orig(u)
      return { ...c, query: async (sql: string, v?: unknown[]) => {
        if (/010_database_bootstrap/.test(sql) && n++ === 0) throw new Error('010 exploded')
        return c.query(sql, v)
      } } as any
    }
    await expect(provision(okEnv(), d)).rejects.toThrow(/010 exploded/)
    expect(grantHappened(log), 'CONNECT was granted despite a failed bootstrap').toBe(false)
  })

  it('a failed migration prevents the grant', async () => {
    const log: string[] = []
    await expect(provision(okEnv(), deps(log, {
      runMigrations: async () => { throw new Error('migration exploded') },
    }, { dbExists: false }))).rejects.toThrow(/migration exploded/)
    expect(grantHappened(log), 'CONNECT was granted despite a failed migration').toBe(false)
  })

  it('a failed lockdown prevents the grant', async () => {
    const log: string[] = []
    const d = deps(log, {}, { dbExists: false })
    const orig = d.connectTarget
    d.connectTarget = async (u: string) => {
      const c = await orig(u)
      return { ...c, query: async (sql: string, v?: unknown[]) => {
        if (/090_post_migration_lockdown/.test(sql)) throw new Error('090 exploded')
        return c.query(sql, v)
      } } as any
    }
    await expect(provision(okEnv(), d)).rejects.toThrow(/090 exploded/)
    expect(grantHappened(log), 'CONNECT was granted despite a failed lockdown').toBe(false)
  })

  it('a failed schema verification prevents the grant', async () => {
    const log: string[] = []
    await expect(provision(okEnv(), deps(log, {
      verifySchema: async () => { throw new Error('schema is wrong') },
    }, { dbExists: false }))).rejects.toThrow(/schema is wrong/)
    expect(grantHappened(log), 'CONNECT was granted despite a failed verification').toBe(false)
  })

  it('a target-identity mismatch prevents the grant', async () => {
    const log: string[] = []
    const d = deps(log, {}, { dbExists: false })
    const orig = d.connectTarget
    d.connectTarget = async (u: string) => {
      const c = await orig(u)
      return { ...c, query: async (sql: string, v?: unknown[]) =>
        /current_database\(\) AS db/.test(sql) ? { rows: [{ db: 'somewhere_else_test' }] } : c.query(sql, v),
      } as any
    }
    await expect(provision(okEnv(), d)).rejects.toThrow(/but the approved target is/)
    expect(grantHappened(log)).toBe(false)
  })
})

describe('ROUND 3: the runtime credential is asserted, not logged', () => {
  it('refuses when the probe authenticates as the wrong principal', async () => {
    const log: string[] = []
    await expect(provision(okEnv(), deps(log, {}, { dbExists: false, probeUser: 'thanapold' })))
      .rejects.toThrow(/authenticated as "thanapold", not "ai_capital_test_runtime"/)
  })

  it('refuses when the probe lands in the wrong database', async () => {
    const log: string[] = []
    await expect(provision(okEnv(), deps(log, {}, { dbExists: false, probeDb: 'elsewhere_test' })))
      .rejects.toThrow(/connected to "elsewhere_test" but the approved target is/)
  })

  it('accepts the correct principal in the correct database', async () => {
    const log: string[] = []
    await expect(provision(okEnv(), deps(log, {}, { dbExists: false }))).resolves.toBeTruthy()
    expect(log.join(' | ')).toContain('runtime-probe')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ROUND 4 — a STATEFUL authorization model.
//
// Round 3 proved "no GRANT statement was emitted". That is not the property
// that matters: PostgreSQL grants CONNECT to PUBLIC on every new database, and
// an existing target keeps the explicit grant from the last successful run — so
// the runtime role could connect while no GRANT appeared in the log at all.
//
// This fake therefore MODELS the ACL. It answers has_database_privilege from
// state that REVOKE/GRANT/CREATE actually mutate, so every assertion below is
// about effective CONNECT rather than about statement bookkeeping.
// ═════════════════════════════════════════════════════════════════════════════
class FakeCluster {
  /**
   * THE MODEL. Six pieces of state, tracked separately because PostgreSQL
   * tracks them separately and Round 4's single boolean hid a real hole:
   *
   *   allowConnections  datallowconn — the database-level gate
   *   publicConnect     CONNECT granted to PUBLIC (PostgreSQL's own default)
   *   roleConnect       CONNECT granted directly to the runtime role
   *   groupConnect      CONNECT reaching the role through a GROUP — a path the
   *                     harness must detect and must NOT revoke
   *   sessions          established backends, which a revoke cannot close
   *   existence         presence in the map
   */
  db = new Map<string, {
    allowConnections: boolean; publicConnect: boolean
    roleConnect: boolean; groupConnect: boolean
  }>()
  sessions: Array<{ pid: number; datname: string; usename: string }> = []
  events: string[] = []
  failOn: RegExp | null = null
  failRevoke = false
  failRevokePublic = false
  failRevokeDirect = false
  failEnable = false
  failDisable = false
  failPrivilegeQuery = false
  /** a fresh database is born already reachable through a GROUP role. */
  groupGrantOnCreate = false
  /**
   * ROUND 6. CREATE DATABASE COMMITS and the client then loses the answer —
   * the ambiguous completion Codex identified. 'closed' and 'open' say what
   * datallowconn ends up as; null means CREATE behaves normally (and failOn
   * still models the fail-BEFORE-mutation case).
   */
  createThenThrow: null | 'closed' | 'open' = null
  /** the runtime probe's own backend, if it should be modelled at all. */
  probeSessionPid: number | null = null
  /** the close reports success but the backend does not actually go away. */
  probeSessionLingers = false
  /** probe.end() rejects. */
  probeEndFails = false
  /** connectAdmin() throws from the Nth call onwards (1-based). */
  adminConnectFailFrom: number | null = null
  adminConnects = 0

  constructor(opts: {
    existing?: boolean; priorGrant?: boolean; sessions?: number; groupGrant?: boolean
  } = {}) {
    if (opts.existing) {
      this.db.set('ai_capital_test', {
        allowConnections: true,
        publicConnect: true,                       // PostgreSQL's default
        roleConnect: opts.priorGrant ?? false,     // left by a previous run
        groupConnect: opts.groupGrant ?? false,    // someone else's grant
      })
    }
    for (let i = 0; i < (opts.sessions ?? 0); i++) {
      this.sessions.push({ pid: 100 + i, datname: 'ai_capital_test', usename: RUNTIME_ROLE })
    }
  }

  /** has_database_privilege(role, db, 'CONNECT') — the ACL ALONE. */
  hasConnectPrivilege(name: string): boolean {
    const d = this.db.get(name)
    return !!d && (d.publicConnect || d.roleConnect || d.groupConnect)
  }

  /** datallowconn AND the ACL — whether a NEW connection would be accepted. */
  canOpenNewConnection(name: string): boolean {
    const d = this.db.get(name)
    return !!d && d.allowConnections && this.hasConnectPrivilege(name)
  }

  allowsConnections(name: string): boolean {
    return this.db.get(name)?.allowConnections === true
  }

  client(label: string) {
    const self = this
    return {
      query: async (text: string, values?: unknown[]) => {
        const s = text.replace(/\s+/g, ' ').trim()
        self.events.push(`${label}:${summarise(text)}`)
        if (self.failOn && self.failOn.test(s)) throw new Error(`INJECTED FAILURE: ${s.slice(0, 40)}`)

        let m: RegExpMatchArray | null
        if ((m = s.match(/^CREATE DATABASE (\w+)( ALLOW_CONNECTIONS false)?$/i))) {
          if (self.createThenThrow) {
            // PostgreSQL committed it; the client never received the answer.
            self.db.set(m[1], {
              allowConnections: self.createThenThrow === 'open', publicConnect: true,
              roleConnect: false, groupConnect: self.groupGrantOnCreate,
            })
            throw new Error('INJECTED FAILURE: connection lost after CREATE DATABASE')
          }
          self.db.set(m[1], {
            allowConnections: !m[2], publicConnect: true, roleConnect: false,
            groupConnect: self.groupGrantOnCreate,
          })
          return { rows: [] }
        }
        if ((m = s.match(/^ALTER DATABASE (\w+) WITH ALLOW_CONNECTIONS (true|false)$/i))) {
          const on = m[2].toLowerCase() === 'true'
          if (on && self.failEnable) throw new Error('INJECTED FAILURE: enable')
          if (!on && self.failDisable) throw new Error('INJECTED FAILURE: disable')
          self.db.get(m[1])!.allowConnections = on
          return { rows: [] }
        }
        if ((m = s.match(/^REVOKE CONNECT ON DATABASE (\w+) FROM (\S+)$/i))) {
          const toPublic = m[2].toUpperCase() === 'PUBLIC'
          if (self.failRevoke) throw new Error('INJECTED FAILURE: revoke')
          if (toPublic && self.failRevokePublic) throw new Error('INJECTED FAILURE: revoke PUBLIC')
          if (!toPublic && self.failRevokeDirect) throw new Error('INJECTED FAILURE: revoke direct')
          const d = self.db.get(m[1])!
          // A group's grant belongs to another role: REVOKE ... FROM <role> and
          // FROM PUBLIC do not touch it, and neither does this model.
          if (toPublic) d.publicConnect = false; else d.roleConnect = false
          return { rows: [] }
        }
        if ((m = s.match(/^GRANT CONNECT ON DATABASE (\w+) TO (\S+)$/i))) {
          self.db.get(m[1])!.roleConnect = true; return { rows: [] }
        }
        if (/datallowconn/.test(s)) {
          const name = (values as any[])?.[0]
          return self.db.has(name)
            ? { rows: [{ datallowconn: self.allowsConnections(name) }] }
            : { rows: [] }
        }
        if (/has_database_privilege/.test(s)) {
          // Serves BOTH the protected-database sweep (values[1] is an ARRAY of
          // protected names) and the single-target quarantine check (a string).
          const name = (values as any[])?.[1]
          if (typeof name === 'string') {
            if (self.failPrivilegeQuery) throw new Error('INJECTED FAILURE: privilege query')
            return self.db.has(name)
              ? { rows: [{ datname: name, can_connect: self.hasConnectPrivilege(name) }] }
              : { rows: [] }
          }
          return { rows: [] }   // protected sweep: nothing reachable
        }
        if (/pg_stat_activity/.test(s)) {
          return { rows: self.sessions.filter(x => x.datname === (values as any[])[0]) }
        }
        if (/SELECT 1 FROM pg_database/.test(s)) {
          return { rows: self.db.has((values as any[])[0]) ? [{ x: 1 }] : [] }
        }
        if (/rolname = ANY/.test(s)) return { rows: [...REQUIRED_CLUSTER_ROLES, RUNTIME_ROLE].map(r => ({ rolname: r })) }
        if (/rolcanlogin, rolsuper/.test(s)) return { rows: HEALTHY_ROLE_ROWS }
        if (/pg_has_role/.test(s)) return { rows: [] }
        if (/to_regclass/.test(s)) return { rows: [{ present: false }] }
        if (/current_user AS usr/.test(s)) return { rows: [{ usr: RUNTIME_ROLE, db: 'ai_capital_test' }] }
        if (/current_database\(\) AS db/.test(s)) return { rows: [{ db: 'ai_capital_test' }] }
        if (/nspname/.test(s)) return { rows: [{ nspname: 'x' }] }
        return { rows: [] }
      },
      end: async () => {},
    }
  }

  deps(over: Partial<ProvisionDeps> = {}): ProvisionDeps {
    return {
      connectAdmin: async () => {
        this.adminConnects += 1
        if (this.adminConnectFailFrom !== null && this.adminConnects >= this.adminConnectFailFrom) {
          throw new Error('INJECTED FAILURE: admin connection refused')
        }
        return this.client('admin') as any
      },
      connectTarget: async () => this.client('target') as any,
      connectRuntime: async () => {
        const cl = this.client('runtime') as any
        if (this.probeSessionPid !== null) {
          this.sessions.push({
            pid: this.probeSessionPid, datname: 'ai_capital_test', usename: RUNTIME_ROLE,
          })
        }
        return {
          query: cl.query,
          end: async () => {
            if (this.probeEndFails) throw new Error('INJECTED FAILURE: probe close')
            if (this.probeSessionPid !== null && !this.probeSessionLingers) {
              this.sessions = this.sessions.filter(x => x.pid !== this.probeSessionPid)
            }
            await cl.end()
          },
        } as any
      },
      readOpsScript: rel => `-- ${rel}`,
      migrationFilesOnDisk: () => ['001_portfolio.sql'],
      runMigrations: async () => { this.events.push('MUTATE:migrations'); return { applied: [], alreadyApplied: [] } },
      verifySchema: async () => { this.events.push('verify-schema') },
      log: () => {},
      ...over,
    }
  }
}

describe('ROUND 4 / DEFECT 1: effective CONNECT is gated, not just the GRANT', () => {
  it('a FRESH target is never created with connections open', async () => {
    const c = new FakeCluster()
    await provision(okEnv(), c.deps())
    const created = c.events.findIndex(e => e.includes('MUTATE:create-database'))
    expect(created).toBeGreaterThan(-1)
    // Connections are enabled only AFTER the ACL has been fixed.
    const allow = c.events.findIndex(e => e.includes('MUTATE:allow-connections'))
    const revoke = c.events.findIndex(e => e.includes('MUTATE:revoke-connect'))
    expect(revoke).toBeGreaterThan(created)
    expect(allow).toBeGreaterThan(revoke)
  })

  it('effective CONNECT is FALSE for the whole preparation window', async () => {
    const c = new FakeCluster()
    const seen: boolean[] = []
    await provision(okEnv(), c.deps({
      // Sample the model at each preparation step.
      runMigrations: async () => { seen.push(c.hasConnectPrivilege('ai_capital_test')); return { applied: [], alreadyApplied: [] } },
      verifySchema: async () => { seen.push(c.hasConnectPrivilege('ai_capital_test')) },
    }))
    expect(seen, 'the runtime role could connect during preparation').toEqual([false, false])
    // ... and TRUE only at the very end.
    expect(c.hasConnectPrivilege('ai_capital_test')).toBe(true)
  })

  it('an EXISTING target with a prior grant is re-quarantined before preparation', async () => {
    const c = new FakeCluster({ existing: true, priorGrant: true })
    expect(c.hasConnectPrivilege('ai_capital_test')).toBe(true)      // the hazard
    const seen: boolean[] = []
    await provision(okEnv(), c.deps({
      runMigrations: async () => { seen.push(c.hasConnectPrivilege('ai_capital_test')); return { applied: [], alreadyApplied: [] } },
    }))
    expect(seen).toEqual([false])
  })

  it('PUBLIC CONNECT on an existing target is revoked', async () => {
    const c = new FakeCluster({ existing: true, priorGrant: false })
    expect(c.db.get('ai_capital_test')!.publicConnect).toBe(true)
    await provision(okEnv(), c.deps())
    expect(c.db.get('ai_capital_test')!.publicConnect).toBe(false)
  })

  it('refuses — without terminating — when the runtime role already holds a session', async () => {
    const c = new FakeCluster({ existing: true, sessions: 2 })
    await expect(provision(okEnv(), c.deps())).rejects.toThrow(/already has 2 open session/)
    expect(c.events.join(' | '), 'sessions were terminated silently').not.toMatch(/terminate/i)
  })

  it('fails closed if CONNECT survives quarantine by another path', async () => {
    // ROUND 5 CORRECTION. This previously asserted only that something was
    // thrown. That is precisely the assertion that let the Round 4 defect
    // through: the throw happened, and the database was left OPEN anyway. The
    // FINAL STATE of both gates is now what is asserted.
    const c = new FakeCluster({ existing: true, groupGrant: true })
    await expect(provision(okEnv(), c.deps())).rejects.toThrow(/can still CONNECT .* after quarantine/)
    expect(c.hasConnectPrivilege('ai_capital_test'),
      'the surviving group path must be reported, not hidden').toBe(true)
    expect(c.db.get('ai_capital_test')!.roleConnect,
      'the direct grant must be gone even though the group path is not').toBe(false)
    expect(c.events.some(e => e.includes('MUTATE:ops-010')),
      '010 ran against a database the runtime role can reach').toBe(false)
  })
})

describe('ROUND 4 / DEFECT 1: every failed path ends with CONNECT false', () => {
  const failAt = async (opts: { failOn?: RegExp; over?: Partial<ProvisionDeps> }, re: RegExp) => {
    const c = new FakeCluster({ existing: true, priorGrant: true })
    if (opts.failOn) c.failOn = opts.failOn
    await expect(provision(okEnv(), c.deps(opts.over))).rejects.toThrow(re)
    expect(c.hasConnectPrivilege('ai_capital_test'),
      `the runtime role can still connect after: ${re}`).toBe(false)
    expect(c.canOpenNewConnection('ai_capital_test'),
      `a NEW connection would still be accepted after: ${re}`).toBe(false)
    return c
  }

  it('failed 010', () => failAt({ failOn: /010_database_bootstrap/ }, /INJECTED FAILURE/))
  it('failed migrations', () =>
    failAt({ over: { runMigrations: async () => { throw new Error('migrations exploded') } } }, /migrations exploded/))
  it('failed 090', () => failAt({ failOn: /090_post_migration_lockdown/ }, /INJECTED FAILURE/))
  it('failed schema verification', () =>
    failAt({ over: { verifySchema: async () => { throw new Error('schema is wrong') } } }, /schema is wrong/))

  it('failed identity verification', async () => {
    const c = new FakeCluster({ existing: true, priorGrant: true })
    const d = c.deps()
    const orig = d.connectTarget
    d.connectTarget = async (u: string) => {
      const cl = await orig(u)
      return { ...cl, query: async (t: string, v?: unknown[]) =>
        /current_database\(\) AS db/.test(t) ? { rows: [{ db: 'elsewhere_test' }] } : cl.query(t, v) } as any
    }
    await expect(provision(okEnv(), d)).rejects.toThrow(/but the approved target is/)
    expect(c.hasConnectPrivilege('ai_capital_test')).toBe(false)
  })

  it('failed runtime probe AFTER the final grant — the grant is undone', async () => {
    const c = new FakeCluster()
    const d = c.deps()
    const orig = d.connectRuntime
    d.connectRuntime = async (u: string) => {
      const cl = await orig(u)
      return { ...cl, query: async () => ({ rows: [{ usr: 'thanapold', db: 'ai_capital_test' }] }) } as any
    }
    await expect(provision(okEnv(), d)).rejects.toThrow(/authenticated as "thanapold"/)
    expect(c.hasConnectPrivilege('ai_capital_test'), 'the grant survived a failed probe').toBe(false)
  })

  it('a FAILING cleanup revoke is surfaced, not swallowed', async () => {
    const c = new FakeCluster({ existing: true, priorGrant: true })
    c.failOn = /010_database_bootstrap/
    const d = c.deps()
    const orig = d.connectAdmin
    let first = true
    d.connectAdmin = async () => {
      const cl = await orig()
      if (first) { first = false; return cl }        // quarantine works
      c.failRevoke = true                            // cleanup does not
      return cl
    }
    await expect(provision(okEnv(), d)).rejects.toThrow(
      /setup failed AND containment could not be completed[\s\S]*containment     :/)
  })
})

describe('ROUND 4 / DEFECT 2: USAGE and SET, not MEMBER', () => {
  const admin = (reach: any[]): QueryClient => ({
    query: async (sql: string) => ({
      rows: /pg_has_role/.test(sql) ? reach
          : /has_database_privilege/.test(sql) ? []
          : HEALTHY_ROLE_ROWS,
    }),
  })
  const row = (r: string, o: Partial<{ via_usage: boolean; via_set: boolean; is_member: boolean }>) =>
    ({ rolname: r, via_usage: false, via_set: false, is_member: false, ...o })

  it('MEMBER-only with INHERIT FALSE and SET FALSE is HARMLESS and accepted', async () =>
    // A real catalogue edge that confers nothing. Refusing it would be a false
    // positive, and labelling MEMBER as "SET ROLE" is what Round 3 got wrong.
    await expect(assertRuntimePrincipalRestricted(
      admin([row('ai_capital_owner', { is_member: true })]), RUNTIME_ROLE)).resolves.toBeUndefined())

  it('refuses effective INHERITED authority (USAGE)', async () =>
    await expect(assertRuntimePrincipalRestricted(
      admin([row('ai_capital_owner', { is_member: true, via_usage: true })]), RUNTIME_ROLE))
      .rejects.toThrow(/ai_capital_owner\(inherits\)/))

  it('refuses effective SET ROLE authority (SET)', async () =>
    await expect(assertRuntimePrincipalRestricted(
      admin([row('ai_capital_migrator', { is_member: true, via_set: true })]), RUNTIME_ROLE))
      .rejects.toThrow(/ai_capital_migrator\(SET ROLE\)/))

  it('refuses a TRANSITIVE SET-capable chain', async () =>
    // runtime -> intermediate -> owner, SET permitted along the way.
    await expect(assertRuntimePrincipalRestricted(
      admin([row('ai_capital_owner', { is_member: true, via_set: true })]), RUNTIME_ROLE))
      .rejects.toThrow(/holds usable authority/))

  it('the query actually ASKS PostgreSQL for USAGE and SET, not MEMBER', async () => {
    // The fake above answers from canned rows, so swapping the predicate in the
    // SQL would not change its verdict. This captures the statement that is
    // really issued and asserts the three predicates are used for what each
    // one means — the distinction Defect 2 is about.
    let sql = ''
    const capturing: QueryClient = {
      query: async (t: string) => {
        if (/pg_has_role/.test(t)) { sql = t; return { rows: [] } }
        return { rows: /has_database_privilege/.test(t) ? [] : HEALTHY_ROLE_ROWS }
      },
    }
    await assertRuntimePrincipalRestricted(capturing, RUNTIME_ROLE)
    const flat = sql.replace(/\s+/g, ' ')
    expect(flat, 'USAGE is not queried').toMatch(/pg_has_role\(\$1, p, 'USAGE'\) *AS via_usage/)
    expect(flat, 'SET is not queried').toMatch(/pg_has_role\(\$1, p, 'SET'\) *AS via_set/)
    // MEMBER may be selected for the diagnostic, but never AS the SET column.
    expect(flat, 'MEMBER is being used as the SET column')
      .not.toMatch(/pg_has_role\(\$1, p, 'MEMBER'\) *AS via_set/)
    expect(flat, 'MEMBER is being used as the USAGE column')
      .not.toMatch(/pg_has_role\(\$1, p, 'MEMBER'\) *AS via_usage/)
  })

  it('reports both when both apply', async () =>
    await expect(assertRuntimePrincipalRestricted(
      admin([row('ai_capital_owner', { via_usage: true, via_set: true })]), RUNTIME_ROLE))
      .rejects.toThrow(/ai_capital_owner\(inherits\+SET ROLE\)/))
})

/** Await a rejection and return it TYPED, so its message can be asserted. */
async function failed(p: Promise<unknown>): Promise<Error> {
  try { await p } catch (e) { return e as Error }
  throw new Error('expected a rejection, but the call resolved')
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUND 5 — CONTAINMENT IS A FINAL STATE, NOT AN EXCEPTION.
//
// Round 4 enabled connections and THEN checked the ACL, and set its
// `quarantined` flag only after quarantineTarget() returned. Codex reproduced
// the consequence with no PostgreSQL at all:
//
//   { "error": "can still CONNECT after quarantine",
//     "allowConnections": true, "effectiveConnect": true }
//
// The throw happened before the flag was set, so the failure handler never ran
// and the database was left OPEN and REACHABLE. Every assertion below therefore
// checks the FINAL STATE of both gates, not merely that something was thrown.
// ═════════════════════════════════════════════════════════════════════════════
describe('ROUND 5: fresh-target containment', () => {
  const NAME = 'ai_capital_test'
  const started010 = (c: FakeCluster) => c.events.some(e => e.includes('MUTATE:ops-010'))

  /** The exact state Codex reproduced must never be the outcome of a failure. */
  const assertContained = (c: FakeCluster) => {
    expect(c.allowsConnections(NAME), 'the database was left accepting connections').toBe(false)
    expect(c.canOpenNewConnection(NAME), 'the runtime role could open a new connection').toBe(false)
    expect(started010(c), '010 ran against an uncontained database').toBe(false)
  }

  it('1. an alternate GROUP grant survives the revokes: refuse, stay closed, never bootstrap', async () => {
    const c = new FakeCluster()
    c.groupGrantOnCreate = true
    const err = await failed(provision(okEnv(), c.deps()))
    expect(err.message).toMatch(/can still CONNECT/)
    // The proof that fires must be the one taken while the database is STILL
    // closed. Being caught only after the enable would mean the ACL check had
    // been conflated with datallowconn and was vacuous during the window.
    expect(err.message, 'the closed-window proof did not catch it').toMatch(/after quarantine/)
    assertContained(c)
    // The group's grant belongs to another role and was NOT revoked.
    expect(c.db.get(NAME)!.groupConnect, 'another role\'s grant was silently revoked').toBe(true)
    expect(c.hasConnectPrivilege(NAME), 'the ACL path is real and is reported honestly').toBe(true)
  })

  it('2. a throwing effective-privilege query leaves the database disabled', async () => {
    const c = new FakeCluster()
    c.failPrivilegeQuery = true
    await expect(provision(okEnv(), c.deps())).rejects.toThrow(/INJECTED FAILURE: privilege query/)
    assertContained(c)
  })

  it('3. a failing PUBLIC revoke leaves the database disabled', async () => {
    const c = new FakeCluster()
    c.failRevokePublic = true
    await expect(provision(okEnv(), c.deps())).rejects.toThrow(/INJECTED FAILURE: revoke PUBLIC/)
    assertContained(c)
    expect(c.db.get(NAME)!.publicConnect, 'PUBLIC still holds CONNECT — correctly reported by state').toBe(true)
  })

  it('4. a failing direct revoke leaves the database disabled', async () => {
    const c = new FakeCluster()
    c.failRevokeDirect = true
    await expect(provision(okEnv(), c.deps())).rejects.toThrow(/INJECTED FAILURE: revoke direct/)
    assertContained(c)
  })

  it('5. a failing ALLOW_CONNECTIONS true leaves the database disabled', async () => {
    const c = new FakeCluster()
    c.failEnable = true
    await expect(provision(okEnv(), c.deps())).rejects.toThrow(/INJECTED FAILURE: enable/)
    assertContained(c)
  })

  it('6. a POST-ENABLE verification failure RESTORES ALLOW_CONNECTIONS false', async () => {
    // The Round 4 hole exactly: containment is re-checked once the database is
    // open, and that check fails. The database must not be left open.
    const c = new FakeCluster()
    const d = c.deps()
    const orig = d.connectAdmin
    d.connectAdmin = async () => {
      const cl = await orig()
      return { ...cl, query: async (t: string, v?: unknown[]) => {
        const r = await cl.query(t, v)
        if (/ALLOW_CONNECTIONS true/i.test(t)) c.db.get(NAME)!.groupConnect = true
        return r
      } } as any
    }
    await expect(provision(okEnv(), d)).rejects.toThrow(/after connections were re-enabled/)
    assertContained(c)
    expect(c.hasConnectPrivilege(NAME), 'the ACL path is still there and still reported').toBe(true)
  })

  it('a failing CREATE DATABASE leaves nothing to contain, and nothing is touched', async () => {
    const c = new FakeCluster()
    c.failOn = /^CREATE DATABASE/
    await expect(provision(okEnv(), c.deps())).rejects.toThrow(/INJECTED FAILURE/)
    expect(c.db.has(NAME), 'a database exists that CREATE never finished').toBe(false)
    expect(c.events.filter(e => /MUTATE:(revoke|grant|allow|disable)/.test(e)),
      'containment acted on a database that was never created').toEqual([])
  })

  it('a failing MUTATING admin connection is contained by doing nothing', async () => {
    // The one reachable state in which the lifecycle is still 'untouched'
    // INSIDE the containment handler.
    const c = new FakeCluster({ existing: true })
    c.adminConnectFailFrom = 2
    const err = await failed(provision(okEnv(), c.deps()))
    expect(err.message).toMatch(/INJECTED FAILURE: admin connection refused/)
    expect(err.message, 'containment ran against an unmutated target')
      .not.toMatch(/containment could not be completed/)
    expect(c.adminConnects, 'a cleanup connection was opened for nothing').toBe(2)
  })

  it('8. a failure DURING quarantine cannot bypass the containment handler', async () => {
    // Codex's reproduction, asserted as a state rather than as a message.
    const c = new FakeCluster()
    c.groupGrantOnCreate = true
    const err = await failed(provision(okEnv(), c.deps()))
    expect(err).toBeInstanceOf(Error)
    expect({
      allowConnections: c.allowsConnections(NAME),
      canOpenNewConnection: c.canOpenNewConnection(NAME),
    }).toEqual({ allowConnections: false, canOpenNewConnection: false })
  })
})

describe('ROUND 5: existing-target behavior', () => {
  const NAME = 'ai_capital_test'

  it('7. an alternate grant on an EXISTING target refuses before 010, honestly', async () => {
    const c = new FakeCluster({ existing: true, priorGrant: true, groupGrant: true })
    const err = await failed(provision(okEnv(), c.deps()))
    expect(err.message).toMatch(/can still CONNECT/)
    expect(err.message, 'the diagnostic must not claim containment succeeded')
      .toMatch(/NOT inaccessible/)
    expect(err.message).toMatch(/grant to PUBLIC or to a group role/)
    expect(c.events.some(e => e.includes('MUTATE:ops-010')), '010 ran anyway').toBe(false)
    // Someone else's grant is left exactly as it was found.
    expect(c.db.get(NAME)!.groupConnect).toBe(true)
    // A pre-existing database is NOT disabled by this harness.
    expect(c.allowsConnections(NAME), 'a database this run did not create was disabled').toBe(true)
    // What the harness CAN close, it closed.
    expect(c.db.get(NAME)!.publicConnect).toBe(false)
    expect(c.db.get(NAME)!.roleConnect).toBe(false)
  })
})

describe('ROUND 5: late-failure session race and cleanup honesty', () => {
  const NAME = 'ai_capital_test'

  it('11. a runtime session opened after the final grant makes cleanup INCOMPLETE', async () => {
    const c = new FakeCluster()
    const d = c.deps()
    const orig = d.connectRuntime
    d.connectRuntime = async (u: string) => {
      // A worker connects the moment the grant lands; then the probe fails.
      c.sessions.push({ pid: 4242, datname: NAME, usename: RUNTIME_ROLE })
      // ...and the HARNESS's own probe is a runtime session too, which it must
      // close before counting leftovers or it will report itself.
      c.sessions.push({ pid: 999, datname: NAME, usename: RUNTIME_ROLE })
      const cl = await orig(u)
      return {
        query: async () => ({ rows: [{ usr: 'thanapold', db: NAME }] }),
        end: async () => {
          c.sessions = c.sessions.filter(x => x.pid !== 999)
          await cl.end()
        },
      } as any
    }
    const err = await failed(provision(okEnv(), d))
    expect(err.message).toMatch(/CONTAINMENT IS INCOMPLETE/)
    expect(err.message, 'the surviving session must be named by pid').toMatch(/pid 4242/)
    expect(err.message, "the harness counted its OWN probe as a leftover session")
      .not.toMatch(/999/)
    expect(err.message).toMatch(/1 "ai_capital_test_runtime" session\(s\) remain open/)
    expect(err.message, 'the original cause must survive').toMatch(/authenticated as "thanapold"/)
    expect(c.events.join(' | '), 'a session was terminated automatically').not.toMatch(/terminate/i)
    // The ACL was closed even though the session was not.
    expect(c.hasConnectPrivilege(NAME)).toBe(false)
  })

  it('12. a failing cleanup CONNECTION is surfaced with the original error', async () => {
    const c = new FakeCluster()
    c.adminConnectFailFrom = 3          // 1 catalogue, 2 create+quarantine, 3 grant
    const err = await failed(provision(okEnv(), c.deps()))
    expect(err.message).toMatch(/could not open a cleanup connection/)
    expect(err.message).toMatch(/INJECTED FAILURE: admin connection refused/)
  })

  it('13. a failing cleanup REVOKE is surfaced, not swallowed', async () => {
    const c = new FakeCluster({ existing: true, priorGrant: true })
    c.failOn = /010_database_bootstrap/
    const d = c.deps()
    const orig = d.connectAdmin
    d.connectAdmin = async () => {
      const cl = await orig()
      if (c.adminConnects >= 3) c.failRevoke = true    // quarantine worked; cleanup will not
      return cl
    }
    const err = await failed(provision(okEnv(), d))
    expect(err.message).toMatch(/setup failed AND containment could not be completed/)
    expect(err.message).toMatch(/INJECTED FAILURE: revoke/)
    expect(err.message).toMatch(/original failure: .*010_database_bootstrap/s)
  })

  it('14. a failing cleanup ALLOW_CONNECTIONS false is surfaced', async () => {
    const c = new FakeCluster()
    c.failDisable = true
    const d = c.deps()
    const orig = d.connectAdmin
    d.connectAdmin = async () => {
      const cl = await orig()
      return { ...cl, query: async (t: string, v?: unknown[]) => {
        const r = await cl.query(t, v)
        if (/ALLOW_CONNECTIONS true/i.test(t)) c.db.get(NAME)!.groupConnect = true
        return r
      } } as any
    }
    const err = await failed(provision(okEnv(), d))
    expect(err.message).toMatch(/setup failed AND containment could not be completed/)
    expect(err.message).toMatch(/INJECTED FAILURE: disable/)
    expect(err.message).toMatch(/after connections were re-enabled/)
  })

  it('a target that was never mutated gets NO cleanup at all', async () => {
    // A catalogue failure happens before the first mutation: containment must
    // not connect, must not revoke, and must not touch anything.
    const c = new FakeCluster({ existing: true })
    const before = c.adminConnects
    c.failOn = /rolcanlogin/
    await expect(provision(okEnv(), c.deps())).rejects.toThrow(/INJECTED FAILURE/)
    expect(c.events.some(e => e.includes('MUTATE:')), 'something was mutated').toBe(false)
    expect(c.adminConnects - before, 'a cleanup connection was opened for nothing').toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ROUND 6 / DEFECT 1 — the probe's CLOSE is part of the contract.
//
// Round 5 wrote `await probe.end().catch(() => {})`. A failed close was
// therefore invisible: provisioning returned SUCCESS with a runtime-role
// connection possibly still attached, the outer catch never ran, containment
// never ran, and no leftover-session sweep happened. The source comment claimed
// the probe closes before containment; the code only tried to.
// ═════════════════════════════════════════════════════════════════════════════
describe('ROUND 6 / DEFECT 1: runtime-probe closure is enforced', () => {
  const NAME = 'ai_capital_test'

  it('a clean close with no residual session provisions successfully', async () => {
    const c = new FakeCluster()
    c.probeSessionPid = 555                  // the probe really does open a backend
    await expect(provision(okEnv(), c.deps())).resolves.toBeTruthy()
    expect(c.sessions, 'the probe left a backend behind').toEqual([])
    expect(c.hasConnectPrivilege(NAME), 'the final grant must survive success').toBe(true)
  })

  it('a REJECTING probe.end() fails the run and runs containment', async () => {
    const c = new FakeCluster()
    c.probeEndFails = true
    const err = await failed(provision(okEnv(), c.deps()))
    expect(err.message).toMatch(/could not be closed/)
    expect(err.message).toMatch(/INJECTED FAILURE: probe close/)
    // Containment ran: the final grant was undone and the ACL proven closed.
    expect(c.db.get(NAME)!.roleConnect, 'containment did not run').toBe(false)
    expect(c.hasConnectPrivilege(NAME)).toBe(false)
    expect(c.canOpenNewConnection(NAME)).toBe(false)
  })

  it('a close that REPORTS success but leaves a session fails the run', async () => {
    const c = new FakeCluster()
    c.probeSessionPid = 777
    c.probeSessionLingers = true             // end() resolves; the backend stays
    const err = await failed(provision(okEnv(), c.deps()))
    expect(err.message).toMatch(/the setup probe left 1 .* session\(s\) open/)
    expect(err.message, 'the residual session must be named by pid').toMatch(/pid 777/)
    expect(err.message).toMatch(/after reporting a clean close/)
  })

  it('a residual probe session is REPORTED, never terminated', async () => {
    const c = new FakeCluster()
    c.probeSessionPid = 777
    c.probeSessionLingers = true
    const err = await failed(provision(okEnv(), c.deps()))
    expect(err.message).toMatch(/NOT terminated automatically/)
    expect(c.events.join(' | '), 'a session was terminated').not.toMatch(/terminate/i)
    expect(c.sessions.map(x => x.pid), 'the session was closed behind the operator\'s back')
      .toEqual([777])
    // Containment still ran and still closed what it CAN close.
    expect(c.hasConnectPrivilege(NAME)).toBe(false)
    expect(err.message).toMatch(/CONTAINMENT IS INCOMPLETE/)
  })

  it('a probe assertion failure AND a close failure are BOTH reported', async () => {
    const c = new FakeCluster()
    c.probeEndFails = true
    const d = c.deps()
    const orig = d.connectRuntime
    d.connectRuntime = async (u: string) => {
      const cl = await orig(u)
      return { ...cl, query: async () => ({ rows: [{ usr: 'thanapold', db: NAME }] }) } as any
    }
    const err = await failed(provision(okEnv(), d))
    expect(err.message).toMatch(/probe failure: .*authenticated as "thanapold"/)
    expect(err.message).toMatch(/close failure: .*INJECTED FAILURE: probe close/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ROUND 6 / DEFECT 2 — an ambiguous CREATE is not a pre-existing database.
//
// If PostgreSQL commits CREATE DATABASE and the client then receives an error,
// containment sees phase 'creating' with createdByUs still false. Round 5 fell
// through to the pre-existing branch and issued a REVOKE against a database
// whose ownership it did not know — and could report it "NOT inaccessible"
// purely because PUBLIC still held CONNECT, which says nothing while
// datallowconn is false.
// ═════════════════════════════════════════════════════════════════════════════
describe('ROUND 6 / DEFECT 2: ambiguous CREATE completion', () => {
  const NAME = 'ai_capital_test'
  const mutations = (c: FakeCluster) =>
    c.events.filter(e => /MUTATE:(revoke|grant|allow|disable)/.test(e))

  it('ABSENT: CREATE failed before it committed — nothing exists, nothing is touched', async () => {
    const c = new FakeCluster()
    c.failOn = /^CREATE DATABASE/
    const err = await failed(provision(okEnv(), c.deps()))
    expect(err.message).toMatch(/INJECTED FAILURE/)
    expect(err.message, 'containment invented a problem').not.toMatch(/containment could not be completed/)
    expect(c.db.has(NAME)).toBe(false)
    expect(mutations(c), 'containment mutated a database that does not exist').toEqual([])
  })

  it('CLOSED: the database exists with datallowconn=false — verifiably closed, no ACL claim', async () => {
    const c = new FakeCluster()
    c.createThenThrow = 'closed'
    const err = await failed(provision(okEnv(), c.deps()))
    expect(err.message).toMatch(/connection lost after CREATE DATABASE/)
    // It exists, and PUBLIC still holds CONNECT in the ACL...
    expect(c.db.get(NAME)!.publicConnect).toBe(true)
    expect(c.hasConnectPrivilege(NAME)).toBe(true)
    // ...but datallowconn=false means no new connection is possible, so the
    // report must NOT claim the database is reachable.
    expect(c.canOpenNewConnection(NAME)).toBe(false)
    expect(err.message, 'PUBLIC CONNECT was misreported as reachability')
      .not.toMatch(/STILL holds CONNECT/)
    expect(err.message).not.toMatch(/NOT inaccessible/)
    expect(err.message, 'a verifiably closed target must not be escalated')
      .not.toMatch(/containment could not be completed/)
    expect(mutations(c), 'a database of unknown ownership was mutated').toEqual([])
  })

  it('OPEN: the database exists and accepts connections — refuse, claim nothing, mutate nothing', async () => {
    const c = new FakeCluster()
    c.createThenThrow = 'open'
    const err = await failed(provision(okEnv(), c.deps()))
    expect(err.message).toMatch(/AMBIGUOUS CREATE/)
    expect(err.message).toMatch(/CANNOT be determined/)
    expect(err.message).toMatch(/neither disabled nor adopted/)
    expect(err.message, 'the original cause must survive')
      .toMatch(/connection lost after CREATE DATABASE/)
    expect(err.message).toMatch(/No containment is claimed|no containment is claimed/i)
    // Ownership is unknown, so it is neither disabled nor adopted.
    expect(c.allowsConnections(NAME), 'a database of unknown ownership was disabled').toBe(true)
    expect(mutations(c), 'a database of unknown ownership was mutated').toEqual([])
  })

  it('an ambiguous CREATE never claims ownership of the target', async () => {
    // The guard against "hide the ambiguity by setting createdByUs early".
    const c = new FakeCluster()
    c.createThenThrow = 'open'
    const err = await failed(provision(okEnv(), c.deps()))
    expect(err.message, 'the ambiguous target was silently adopted as ours')
      .not.toMatch(/left with ALLOW_CONNECTIONS false/)
    expect(c.events.some(e => e.includes('MUTATE:disable-connections'))).toBe(false)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// ROUND 9 — DISPOSABLE-TEST FIXTURE ACCESS.
//
// After ops/bootstrap/090 the test runtime holds CONNECT and nothing else, so
// the three legacy @common/db integration tests failed 17 assertions with
// SQLSTATE 42501 on the 2026-09-08 gate. The fix must NOT widen a production
// role: these grants are issued by the harness, on the validated disposable
// database, after lockdown has already proven the production shape, and they
// appear nowhere in migrations or ops/.
//
// What matters is therefore ORDER and NARROWNESS, and both are asserted here.
// ═════════════════════════════════════════════════════════════════════════════
describe('ROUND 9: fixture grants are narrow, by construction', () => {
  const stmts = fixtureGrantStatements(RUNTIME_ROLE)

  it('every statement names the test runtime and nothing else', () => {
    for (const sql of stmts) expect(sql).toMatch(/ TO ai_capital_test_runtime$/)
  })

  it('no schema-wide ALL TABLES / SEQUENCES / FUNCTIONS form appears', () => {
    const flat = stmts.join(' | ')
    expect(flat).not.toMatch(/ALL\s+TABLES/i)
    expect(flat).not.toMatch(/ALL\s+SEQUENCES/i)
    expect(flat).not.toMatch(/ALL\s+FUNCTIONS|ALL\s+ROUTINES/i)
    expect(flat).not.toMatch(/ALL\s+PRIVILEGES/i)
  })

  it('no V3 tenancy schema is reachable through these grants', () => {
    const flat = stmts.join(' | ')
    for (const schema of FIXTURE_FORBIDDEN_SCHEMAS) {
      expect(flat, `fixture grants reach ${schema}`).not.toMatch(new RegExp(`\\b${schema}\\b`))
    }
  })

  it('only desk and portfolio are named', () => {
    expect([...FIXTURE_ALLOWED_SCHEMAS]).toEqual(['desk', 'portfolio'])
    const objects = stmts.map(s => s.replace(/^GRANT .*? ON (SCHEMA |SEQUENCE )?/, '')
      .replace(/ TO .*$/, ''))
    for (const o of objects) expect(o).toMatch(/^(desk|portfolio)(\.|$)/)
  })

  it('confers no structural authority', () => {
    const flat = stmts.join(' | ')
    expect(flat).not.toMatch(/\bCREATE\b/)
    expect(flat).not.toMatch(/\bTRUNCATE\b/)
    expect(flat).not.toMatch(/\bREFERENCES\b/)
    expect(flat).not.toMatch(/\bTRIGGER\b/)
  })

  it('the exact object set is the one the two test files actually use', () => {
    expect(stmts).toEqual([
      'GRANT USAGE ON SCHEMA desk TO ai_capital_test_runtime',
      'GRANT USAGE ON SCHEMA portfolio TO ai_capital_test_runtime',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON desk.agent_claims TO ai_capital_test_runtime',
      'GRANT SELECT, INSERT, DELETE ON desk.agent_runs TO ai_capital_test_runtime',
      'GRANT SELECT ON desk.non_emission TO ai_capital_test_runtime',
      'GRANT SELECT, INSERT, DELETE ON portfolio.positions TO ai_capital_test_runtime',
      'GRANT USAGE ON SEQUENCE desk.agent_claims_id_seq TO ai_capital_test_runtime',
      'GRANT USAGE ON SEQUENCE desk.agent_runs_id_seq TO ai_capital_test_runtime',
    ])
  })

  it('the runtime self-check refuses ANY statement outside the approved eight', () => {
    // ROUND 10. This used to pass single statements and assert on prohibition
    // messages — and the prohibitions had holes, so `GRANT ALL` sailed through.
    // Validation is now exact equality with the manifest, so a widened batch is
    // refused for being a different SET, whatever the extra statement says.
    const withExtra = (sql: string) => () =>
      assertFixtureGrantsAreNarrow([...stmts, sql], RUNTIME_ROLE)
    for (const sql of [
      'GRANT SELECT ON ALL TABLES IN SCHEMA desk TO ai_capital_test_runtime',
      'GRANT SELECT ON identity.principals TO ai_capital_test_runtime',
      'GRANT SELECT ON investment_ledger.transactions TO ai_capital_test_runtime',
      'GRANT SELECT ON cash_ledger.entries TO ai_capital_test_runtime',
      'GRANT CREATE ON SCHEMA desk TO ai_capital_test_runtime',
    ]) {
      expect(withExtra(sql), sql).toThrow(/is NOT one of the 8 approved statements/)
    }
  })

  it('the self-check refuses any grantee other than the test runtime', () => {
    expect(() => assertFixtureGrantsAreNarrow(
      ['GRANT SELECT ON desk.agent_claims TO ai_capital_app'], 'ai_capital_app'))
      .toThrow(/may only be issued to "ai_capital_test_runtime"/)
  })
})

describe('ROUND 9: fixture access sits in the right place in the lifecycle', () => {
  const NAME = 'ai_capital_test'
  const idx = (c: FakeCluster, re: RegExp) => c.events.findIndex(e => re.test(e))

  it('grants happen AFTER 090 and schema verification, BEFORE the CONNECT grant', async () => {
    const c = new FakeCluster()
    await provision(okEnv(), c.deps())
    const lockdown = idx(c, /MUTATE:ops-090/)
    const verify = c.events.findIndex(e => e === 'verify-schema')
    const firstFixture = idx(c, /MUTATE:fixture-grant/)
    const connect = idx(c, /MUTATE:grant-connect/)
    const probe = idx(c, /runtime-probe/)
    expect(lockdown).toBeGreaterThan(-1)
    expect(verify).toBeGreaterThan(lockdown)
    expect(firstFixture, 'fixtures were granted before lockdown').toBeGreaterThan(verify)
    expect(connect, 'CONNECT was granted before the fixtures').toBeGreaterThan(firstFixture)
    expect(probe, 'the runtime probe must still come last').toBeGreaterThan(connect)
  })

  it('all eight grants are issued, and none before 090', async () => {
    const c = new FakeCluster()
    await provision(okEnv(), c.deps())
    const fixtures = c.events.filter(e => /MUTATE:fixture-grant/.test(e))
    expect(fixtures).toHaveLength(8)
    const lockdown = idx(c, /MUTATE:ops-090/)
    for (const f of fixtures) expect(c.events.indexOf(f)).toBeGreaterThan(lockdown)
  })

  it('a FAILED fixture grant prevents the CONNECT grant and the probe', async () => {
    const c = new FakeCluster()
    c.failOn = /^GRANT SELECT, INSERT, UPDATE, DELETE ON desk\.agent_claims/
    await expect(provision(okEnv(), c.deps())).rejects.toThrow(/INJECTED FAILURE/)
    expect(idx(c, /MUTATE:grant-connect/), 'CONNECT was granted after a failed fixture grant')
      .toBe(-1)
    expect(idx(c, /runtime-probe/), 'the probe ran after a failed fixture grant').toBe(-1)
  })

  it('a FAILED fixture grant leaves the runtime unable to connect at all', async () => {
    const c = new FakeCluster()
    c.failOn = /^GRANT USAGE ON SCHEMA desk/
    await expect(provision(okEnv(), c.deps())).rejects.toThrow(/INJECTED FAILURE/)
    expect(c.hasConnectPrivilege(NAME), 'containment did not run after a fixture failure')
      .toBe(false)
    expect(c.canOpenNewConnection(NAME)).toBe(false)
  })

  it('a failed 090 means no fixture grant is ever attempted', async () => {
    const c = new FakeCluster()
    c.failOn = /090_post_migration_lockdown/
    await expect(provision(okEnv(), c.deps())).rejects.toThrow(/INJECTED FAILURE/)
    expect(idx(c, /MUTATE:fixture-grant/), 'fixtures were granted despite a failed lockdown')
      .toBe(-1)
  })

  it('a failed schema verification means no fixture grant is ever attempted', async () => {
    const c = new FakeCluster()
    await expect(provision(okEnv(), c.deps({
      verifySchema: async () => { throw new Error('schema is wrong') },
    }))).rejects.toThrow(/schema is wrong/)
    expect(idx(c, /MUTATE:fixture-grant/)).toBe(-1)
  })

  it('the fixture statements reaching PostgreSQL are exactly the narrow set', async () => {
    const c = new FakeCluster()
    await provision(okEnv(), c.deps())
    const issued = c.events
      .filter(e => /MUTATE:fixture-grant/.test(e))
      .map(e => e.replace(/^.*MUTATE:fixture-grant\((.*)\)$/, '$1'))
    expect(issued).toEqual(fixtureGrantStatements(RUNTIME_ROLE))
  })

  it('credential erasure and the zero-session guarantee still hold with fixtures present', async () => {
    const c = new FakeCluster()
    c.probeSessionPid = 606
    await expect(provision(okEnv(), c.deps())).resolves.toBeTruthy()
    expect(c.sessions, 'the probe left a session behind').toEqual([])
    expect(c.hasConnectPrivilege(NAME)).toBe(true)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// ROUND 10 / DEFECT 2 — the runtime validator is now actually fail-closed.
//
// Round 9's validator declared FIXTURE_ALLOWED_SCHEMAS and never consulted it,
// and its "no GRANT ALL" rule stripped `" ALL "` before testing for `ALL` —
// which cannot match. Codex confirmed it accepted `GRANT ALL ON
// desk.agent_claims`, `GRANT SELECT ON public.any_table` and `GRANT UPDATE ON
// desk.agent_runs`. The Round 9 report's fail-closed claim was false.
//
// Validation is now exact equality with the rendered manifest, so extra,
// missing, duplicated, reordered and alternative-form statements are all one
// rule rather than a list of prohibitions with holes in it.
// ═════════════════════════════════════════════════════════════════════════════
describe('ROUND 10: fixture-grant validation is exact', () => {
  const approved = fixtureGrantStatements(RUNTIME_ROLE)
  const check = (stmts: string[], role = RUNTIME_ROLE) => () =>
    assertFixtureGrantsAreNarrow(stmts, role)

  it('the manifest and the statements are ONE source, not two lists', () => {
    expect(FIXTURE_GRANT_MANIFEST).toHaveLength(8)
    expect(FIXTURE_GRANT_MANIFEST.map(g => renderFixtureGrant(g, RUNTIME_ROLE)))
      .toEqual(approved)
  })

  it('the exact approved eight are accepted', () => {
    expect(check(approved)).not.toThrow()
  })

  it.each(approved.map((s, i) => [i + 1, s] as const))(
    'statement %i is one of the approved set: %s', (_i, sql) => {
      expect(approved).toContain(sql)
    })

  it.each(approved.map((_s, i) => i))('removing approved statement %i is refused', i => {
    expect(check(approved.filter((_, j) => j !== i))).toThrow(/missing 1 approved statement/)
  })

  it.each([
    ['object-level GRANT ALL', 'GRANT ALL ON desk.agent_claims TO ai_capital_test_runtime'],
    ['GRANT ALL PRIVILEGES', 'GRANT ALL PRIVILEGES ON desk.agent_claims TO ai_capital_test_runtime'],
    ['public schema', 'GRANT SELECT ON public.any_table TO ai_capital_test_runtime'],
    ['pg_catalog', 'GRANT SELECT ON pg_catalog.pg_authid TO ai_capital_test_runtime'],
    ['information_schema', 'GRANT SELECT ON information_schema.tables TO ai_capital_test_runtime'],
    ['extra verb on desk.agent_runs', 'GRANT UPDATE ON desk.agent_runs TO ai_capital_test_runtime'],
    ['unapproved desk object', 'GRANT SELECT ON desk.some_other_table TO ai_capital_test_runtime'],
    ['unapproved portfolio object', 'GRANT SELECT ON portfolio.lots TO ai_capital_test_runtime'],
    ['identity', 'GRANT SELECT ON identity.principals TO ai_capital_test_runtime'],
    ['investment_ledger', 'GRANT SELECT ON investment_ledger.transactions TO ai_capital_test_runtime'],
    ['cash_ledger', 'GRANT SELECT ON cash_ledger.entries TO ai_capital_test_runtime'],
    ['db schema', 'GRANT INSERT ON db.schema_migrations TO ai_capital_test_runtime'],
    ['schema-wide tables', 'GRANT SELECT ON ALL TABLES IN SCHEMA desk TO ai_capital_test_runtime'],
    ['schema-wide sequences', 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA desk TO ai_capital_test_runtime'],
    ['CREATE on a schema', 'GRANT CREATE ON SCHEMA desk TO ai_capital_test_runtime'],
    ['TRUNCATE', 'GRANT TRUNCATE ON desk.agent_claims TO ai_capital_test_runtime'],
  ])('an extra statement is refused — %s', (_label, sql) => {
    expect(check([...approved, sql])).toThrow(/is NOT one of the 8 approved statements/)
    // ...and it is refused on its own, too, not only as an addition.
    expect(check([sql])).toThrow()
  })

  it('a duplicated approved statement is refused', () => {
    expect(check([...approved, approved[0]])).toThrow(/issued more than once/)
    expect(check([...approved, approved[4]])).toThrow(/issued more than once/)
  })

  it('a reordered batch is refused — manifest order is the contract', () => {
    expect(check([approved[1], approved[0], ...approved.slice(2)]))
      .toThrow(/out of manifest order/)
  })

  it('an alternative privilege spelling of an approved object is refused', () => {
    const reworded = approved.map(s =>
      s.replace('SELECT, INSERT, UPDATE, DELETE', 'DELETE, INSERT, SELECT, UPDATE'))
    expect(check(reworded)).toThrow(/is NOT one of the 8 approved statements/)
  })

  it('an empty batch is refused rather than treated as harmless', () => {
    expect(check([])).toThrow(/missing 8 approved statement/)
  })

  it.each(['ai_capital_app', 'ai_capital_agent', 'ai_capital_owner', 'thanapold'])(
    'a different grantee (%s) is refused', role => {
      expect(check(approved.map(s => s.replace(/ TO .*$/, ` TO ${role}`)), role))
        .toThrow(/may only be issued to "ai_capital_test_runtime"/)
    })

  it('whitespace and a trailing semicolon do not change identity', () => {
    // The normaliser must be honest: a cosmetic difference is not a widening,
    // and pretending it is would hide the rule that actually matters.
    expect(check(approved.map(s => `  ${s.replace(/ /g, '  ')} ;`))).not.toThrow()
  })
})

describe('ROUND 10: the manifest itself is held narrow', () => {
  const entry = (over: Partial<(typeof FIXTURE_GRANT_MANIFEST)[number]>) =>
    [{ kind: 'table', object: 'desk.agent_claims', privileges: ['SELECT'],
       because: 'test', ...over }] as any

  it('the shipped manifest passes its own categorical rules', () => {
    expect(() => assertFixtureManifestIsNarrow()).not.toThrow()
  })

  it.each([...FIXTURE_FORBIDDEN_SCHEMAS])('a manifest entry in %s is refused', schema => {
    expect(() => assertFixtureManifestIsNarrow(entry({ object: `${schema}.anything` })))
      .toThrow(/protected schema/)
  })

  it('a schema outside desk/portfolio is refused even if not on the forbidden list', () => {
    expect(() => assertFixtureManifestIsNarrow(entry({ object: 'somewhere_new.t' })))
      .toThrow(/which is not one of desk, portfolio/)
  })

  it.each(['ALL', 'ALL PRIVILEGES', 'CREATE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])(
    'a manifest privilege of %s is refused', priv => {
      expect(() => assertFixtureManifestIsNarrow(entry({ privileges: [priv] })))
        .toThrow(/structural privilege|confers/)
    })

  it('a duplicated manifest object is refused', () => {
    const dup = [...FIXTURE_GRANT_MANIFEST, FIXTURE_GRANT_MANIFEST[2]]
    expect(() => assertFixtureManifestIsNarrow(dup)).toThrow(/twice/)
  })

  it('an unqualified object name is refused', () => {
    expect(() => assertFixtureManifestIsNarrow(entry({ object: 'agent_claims' })))
      .toThrow(/not schema-qualified/)
  })

  it('an entry that grants nothing is refused', () => {
    expect(() => assertFixtureManifestIsNarrow(entry({ privileges: [] })))
      .toThrow(/grants nothing/)
  })

  it('generation refuses to render a widened manifest at all', () => {
    // fixtureGrantStatements() runs the manifest guard first, so a widening
    // edit cannot even produce statements to validate.
    expect(() => fixtureGrantStatements(RUNTIME_ROLE)).not.toThrow()
    expect(FIXTURE_GRANT_MANIFEST.every(g => g.because.length > 0),
      'every grant must carry the statement that made it necessary').toBe(true)
  })
})
