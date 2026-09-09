import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// THE TEST-HARNESS CONTRACT.
//
// On 2026-09-08 `pnpm --filter @common/db test` — a command whose name promises
// nothing about databases — connected to ai_capital_test and attempted to
// migrate it. Two causes: vitest.config.ts re-read the root .env so a caller
// could not scrub the credential, and globalSetup ran runMigrations() directly.
//
// Every assertion below is database-free and is paired, in the mutation-control
// suite, with a mutation that must make it fail.

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const REPO = resolve(PKG, '..', '..')
const read = (rel: string) => readFileSync(join(PKG, rel), 'utf-8')
/** Executable text only: these files DISCUSS the removed patterns in prose. */
const code = (src: string) =>
  src.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')

async function loadConfig(rel: string): Promise<any> {
  const mod = await import(pathToFileURL(join(PKG, rel)).href)
  const d = mod.default
  return typeof d === 'function' ? await d({ command: 'serve', mode: 'test' }) : d
}

describe('1-2. the default and unit suites are database-free', () => {
  it('vitest.config.ts registers NO globalSetup', async () => {
    const cfg = await loadConfig('vitest.config.ts')
    expect(cfg.test?.globalSetup ?? [], 'the default config still prepares a database')
      .toEqual([])
  })

  it('vitest.config.ts does not read .env', () => {
    const c = code(read('vitest.config.ts'))
    expect(c, 'the .env reload is back').not.toMatch(/\.env/)
    expect(c).not.toMatch(/readFileSync|loadTestCredentialsFromDotEnv/)
  })

  it('vitest.config.ts hands workers no database credential', () => {
    const c = code(read('vitest.config.ts'))
    for (const v of ['TEST_DATABASE_URL', 'TEST_RUNTIME_DATABASE_URL',
                     'BOOTSTRAP_DATABASE_URL', 'DATABASE_URL']) {
      expect(c, `the default config still names ${v}`).not.toContain(v)
    }
  })

  it('...and BOTH commands resolve to that same config', () => {
    const s = JSON.parse(read('package.json')).scripts
    expect(s.test, 'test must use the default config').toBe('vitest run')
    expect(s['test:unit'], 'test:unit must use the default config').toBe('vitest run')
    expect(s.test).not.toMatch(/--config/)
    expect(s['test:unit']).not.toMatch(/--config/)
  })

  it('the shared database-isolation setup is RETAINED in both configs', async () => {
    for (const rel of ['vitest.config.ts', 'vitest.integration.config.ts']) {
      const cfg = await loadConfig(rel)
      const setup = ([] as string[]).concat(cfg.test?.setupFiles ?? [])
      expect(setup.some(f => f.includes('vitest-db-isolation')), `${rel} lost the isolation setup`)
        .toBe(true)
    }
  })
})

describe('3. the database-free suite opens zero PostgreSQL connections', () => {
  it('no file collected by the default config performs a live query', async () => {
    const cfg = await loadConfig('vitest.config.ts')
    expect(cfg.test?.include).toEqual(['tests/*.test.ts'])
    expect(cfg.test?.exclude ?? []).toContain('tests/integration/**')

    const collected = readdirSync(join(PKG, 'tests')).filter(f => f.endsWith('.test.ts'))
    expect(collected.length, 'no database-free tests were collected at all').toBeGreaterThan(3)
    const LIVE = /getPool\(\)\s*\.\s*query|\.\s*connect\(\)|createClientFromConfig\([^)]*\)\s*\.\s*connect/
    const offenders = collected.filter(f => LIVE.test(code(read(join('tests', f)))))
    expect(offenders, 'a database-free test performs a live connection').toEqual([])
  })

  it('a future integration test cannot silently join the unit suite', () => {
    // The boundary is a DIRECTORY, checked above via include/exclude, so a new
    // file under tests/integration/ is not collected by the default config at
    // all — it cannot be forgotten about.
    expect(existsSync(join(PKG, 'tests', 'integration'))).toBe(true)
    const live = readdirSync(join(PKG, 'tests', 'integration')).filter(f => f.endsWith('.test.ts'))
    expect(live.length, 'the integration directory is empty — the split lost coverage')
      .toBeGreaterThanOrEqual(3)
  })
})

// SUPERSEDED BY BEHAVIOURAL TESTS.
//
// Round 1 proved the refusal rules and the provisioning order by grepping
// testing/global-setup.ts. Those assertions passed while the runtime-credential
// check still ran at the END of setup — after the database had been created,
// bootstrapped, migrated and locked down — because a regex can see that a check
// exists but not when it runs.
//
// tests/preflight-behavior.test.ts now drives the whole state machine with
// injected fake clients and an ordered event log, and asserts that the FIRST
// mutating event cannot occur before every preflight check has passed. The
// source-text versions were removed rather than kept alongside: two statements
// of one rule drift, and the weaker one is the one that keeps passing.

describe('9. bootstrap credentials never reach test workers', () => {
  it('the integration config exposes only the restricted credential', () => {
    const c = code(read('vitest.integration.config.ts'))
    expect(c).toMatch(/TEST_DATABASE_URL: process\.env\.TEST_RUNTIME_DATABASE_URL/)
    expect(c, 'a privileged URL is placed in test.env').not.toMatch(/env:\s*\{[^}]*BOOTSTRAP_DATABASE_URL/)
  })

  it('global-setup deletes the privileged variables before workers start', () => {
    const g = read('testing/global-setup.ts')
    expect(g).toMatch(/delete process\.env\.BOOTSTRAP_DATABASE_URL/)
    expect(g).toMatch(/delete process\.env\.DATABASE_URL/)
  })
})

describe('13. the removed helper and derived fallback are gone', () => {
  it('testDatabaseUrl() no longer exists anywhere in the package', () => {
    for (const rel of ['vitest.config.ts', 'vitest.integration.config.ts', 'testing/global-setup.ts', 'testing/preflight.ts']) {
      expect(code(read(rel)), `${rel} still defines or calls testDatabaseUrl()`)
        .not.toMatch(/testDatabaseUrl/)
    }
  })

  it('no DATABASE_URL-derived "_test" target survives', () => {
    for (const rel of ['vitest.config.ts', 'vitest.integration.config.ts', 'testing/global-setup.ts', 'testing/preflight.ts']) {
      expect(code(read(rel)), `${rel} still derives a target from DATABASE_URL`)
        .not.toMatch(/u\.pathname = `\/\$\{name\}_test`|name\}_test/)
    }
  })

  it('the hardcoded localhost fallback is gone', () => {
    expect(code(read('vitest.config.ts')))
      .not.toMatch(/postgres:\/\/localhost/)
  })
})

describe('14. workspace isolation coverage remains meaningful', () => {
  it('the coverage meta-test still exists and still resolves configs', () => {
    const c = read('tests/isolation-coverage.test.ts')
    expect(c).toMatch(/pathToFileURL/)
    expect(c, 'the coverage test degraded to grepping text').toMatch(/loadConfig/)
    expect(c).toMatch(/setupFiles/)
  })

  it('this package is still enumerated by it', () => {
    expect(existsSync(join(REPO, 'packages', 'db', 'vitest.config.ts'))).toBe(true)
    const s = JSON.parse(read('package.json')).scripts
    // The coverage test asserts `test` does not redirect config; keep it true.
    expect(s.test).not.toMatch(/--config|--no-/)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// ROUND 7 — the migration principal. Behavioural, and it opens no database.
//
// The 2026-09-08 disposable-cluster gate ran migrations through
// BOOTSTRAP_DATABASE_URL, i.e. the cluster administrator. ops/README.md step 3
// says `ai_capital_migrator`, and the difference is load-bearing: the migrator
// holds its owner membership WITH INHERIT FALSE and loses CREATE at lockdown,
// so a chain only ever exercised as a superuser proves nothing about the
// privileges production uses.
//
// preflight.js and migrate.js are replaced with doubles so setup() runs for
// real and this file can assert WHICH credential and WHICH options it passes.
// ═════════════════════════════════════════════════════════════════════════════
const captured = vi.hoisted(() => ({
  urlAtCall: undefined as string | undefined,
  testUrlAtCall: undefined as string | undefined,
  options: undefined as unknown,
  closeCalls: 0,
  throwOnMigrate: false,
  /**
   * ROUND 8. Per-call closePool() outcomes, consumed in order; anything beyond
   * the queue succeeds. Counting calls is NOT enough — the defect was that a
   * REJECTING close was swallowed, and a counter cannot see the difference.
   */
  closeOutcomes: [] as Array<'ok' | 'reject'>,
}))

vi.mock('../src/migrate.js', () => ({
  runMigrations: async (options?: unknown) => {
    captured.urlAtCall = process.env.DATABASE_URL
    captured.testUrlAtCall = process.env.TEST_DATABASE_URL
    captured.options = options
    if (captured.throwOnMigrate) throw new Error('INJECTED migration failure')
    return { applied: [], alreadyApplied: [], skipped: [] }
  },
}))

vi.mock('../src/pool.js', async importActual => {
  const actual = await importActual<typeof import('../src/pool.js')>()
  return {
    ...actual,
    closePool: async () => {
      const outcome = captured.closeOutcomes[captured.closeCalls] ?? 'ok'
      captured.closeCalls += 1
      if (outcome === 'reject') {
        // What pool.end() rejecting really means: closePool() clears its
        // singleton only afterwards, so the pool is STILL CACHED.
        throw new Error(`INJECTED close failure #${captured.closeCalls}`)
      }
    },
  }
})

vi.mock('../testing/preflight.js', async importActual => {
  const actual = await importActual<typeof import('../testing/preflight.js')>()
  return {
    ...actual,
    // Drive ONLY the dependency under test; nothing else in provision matters
    // here and everything it would do needs a real server.
    provision: async (_env: NodeJS.ProcessEnv, deps: any) => {
      await deps.runMigrations()
      return { name: 'ai_capital_test', runtimeUrl: RUNTIME_URL, bootstrapUrl: BOOT_URL, runtimeUser: 'ai_capital_test_runtime' }
    },
  }
})

const BOOT_URL = 'postgres://boot_admin:s3cr3t@localhost:5433/ai_capital_test'
const RUNTIME_URL = 'postgres://ai_capital_test_runtime:pw@localhost:5433/ai_capital_test'

describe('ROUND 7: migrations run as ai_capital_migrator, owned by ai_capital_owner', () => {
  const savedEnv = { ...process.env }
  const restore = () => {
    for (const k of ['DATABASE_URL', 'TEST_DATABASE_URL', 'BOOTSTRAP_DATABASE_URL',
                     'TEST_RUNTIME_DATABASE_URL', 'MIGRATION_OWNER_ROLE']) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]
    }
  }
  const runSetup = async () => {
    captured.urlAtCall = undefined; captured.testUrlAtCall = undefined
    captured.options = undefined; captured.closeCalls = 0
    process.env.BOOTSTRAP_DATABASE_URL = BOOT_URL
    process.env.TEST_RUNTIME_DATABASE_URL = RUNTIME_URL
    delete process.env.DATABASE_URL
    delete process.env.MIGRATION_OWNER_ROLE
    const { setup } = await import('../testing/global-setup.js')
    return setup()
  }
  afterEach(restore)

  it('5. the runner is NOT handed the bootstrap principal', async () => {
    await runSetup()
    expect(captured.urlAtCall, 'the bootstrap credential reached the migration runner')
      .not.toBe(BOOT_URL)
    expect(captured.urlAtCall).not.toMatch(/boot_admin/)
    expect(captured.urlAtCall, 'the bootstrap PASSWORD was carried over').not.toMatch(/s3cr3t/)
  })

  it('5. the runner connects as ai_capital_migrator', async () => {
    await runSetup()
    expect(captured.urlAtCall).toMatch(/^postgresql:\/\/ai_capital_migrator@/)
    expect(captured.testUrlAtCall, 'both variables must name the same principal')
      .toBe(captured.urlAtCall)
  })

  it('4. the owner role is supplied EXPLICITLY, not via the environment', async () => {
    await runSetup()
    expect(captured.options).toEqual({ ownerRole: 'ai_capital_owner' })
    expect(process.env.MIGRATION_OWNER_ROLE, 'the harness still mutates the environment')
      .toBeUndefined()
  })

  it('9. the pool is closed and the environment restored on SUCCESS', async () => {
    captured.throwOnMigrate = false
    await runSetup()
    expect(captured.closeCalls, 'close before AND after').toBe(2)
    expect(process.env.DATABASE_URL, 'setup hands workers no privileged URL').toBeUndefined()
  })

  it('9. the pool is closed and the environment restored on FAILURE', async () => {
    captured.throwOnMigrate = true
    const before = process.env.DATABASE_URL
    await expect(runSetup()).rejects.toThrow(/INJECTED migration failure/)
    expect(captured.closeCalls).toBe(2)
    expect(process.env.DATABASE_URL, 'a migrator URL leaked out of the window')
      .toBe(before)
    captured.throwOnMigrate = false
  })

  it('11. an inherited production DATABASE_URL never reaches the runner', async () => {
    // Behavioural, not textual: the ambient variable is set to something that
    // would be catastrophic to migrate, and the runner must still see only the
    // migrator URL derived from the approved bootstrap destination.
    process.env.DATABASE_URL = 'postgres://someone@prod.internal:5432/ai_capital'
    captured.urlAtCall = undefined
    process.env.BOOTSTRAP_DATABASE_URL = BOOT_URL
    process.env.TEST_RUNTIME_DATABASE_URL = RUNTIME_URL
    delete process.env.MIGRATION_OWNER_ROLE
    const { setup } = await import('../testing/global-setup.js')
    await setup()
    expect(captured.urlAtCall).toMatch(/^postgresql:\/\/ai_capital_migrator@/)
    expect(captured.urlAtCall).not.toMatch(/prod\.internal|ai_capital$/)
    expect(captured.urlAtCall).toContain('ai_capital_test')
  })

  it('11. the migrator URL is derived from BOOTSTRAP only, with no fallback operator', () => {
    const c = code(read('testing/global-setup.ts'))
    expect(c).toMatch(/migratorUrlFrom\(process\.env\.BOOTSTRAP_DATABASE_URL!\)/)
    // save/restore of the caller's DATABASE_URL is fine; a FALLBACK is not.
    expect(c, 'a DATABASE_URL fallback was introduced')
      .not.toMatch(/(\|\||\?\?)\s*process\.env\.DATABASE_URL/)
    expect(c).not.toMatch(/process\.env\.DATABASE_URL\s*(\|\||\?\?)/)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// ROUND 8 / DEFECT 1 — a pool reset that FAILS is not a pool reset.
//
// Round 7 wrote `await closePool().catch(() => {})` on both sides of the
// migration credential window. `closePool()` clears its singleton only after
// `pool.end()` resolves, so a rejecting end() leaves the OLD pool cached:
//
//   pre-window  → getPool() hands the runner the PREVIOUS credential, and the
//                 run reports migrations executed as ai_capital_migrator when
//                 they did not.
//   post-window → a pool holding MIGRATOR authority stays in the singleton and
//                 is handed to ordinary tests once the environment is restored.
//
// Counting the calls cannot see either. These tests make each call reject
// independently and assert what actually happened.
// ═════════════════════════════════════════════════════════════════════════════
/** Await a rejection and return it TYPED, so its message can be asserted. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try { await p } catch (e) { return e as Error }
  throw new Error('expected setup() to reject, but it resolved')
}

describe('ROUND 8: the migration pool reset is mandatory on both sides', () => {
  const savedEnv = { ...process.env }
  const AMBIENT = 'postgres://ambient@localhost:5432/ambient_db'
  const restore = () => {
    for (const k of ['DATABASE_URL', 'TEST_DATABASE_URL', 'BOOTSTRAP_DATABASE_URL',
                     'TEST_RUNTIME_DATABASE_URL', 'MIGRATION_OWNER_ROLE']) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]
    }
    captured.closeOutcomes = []
    captured.throwOnMigrate = false
  }
  afterEach(restore)

  /** Run setup() with an AMBIENT DATABASE_URL, so restoration is observable. */
  const run = async () => {
    captured.urlAtCall = undefined; captured.testUrlAtCall = undefined
    captured.options = undefined; captured.closeCalls = 0
    process.env.BOOTSTRAP_DATABASE_URL = BOOT_URL
    process.env.TEST_RUNTIME_DATABASE_URL = RUNTIME_URL
    process.env.DATABASE_URL = AMBIENT
    process.env.TEST_DATABASE_URL = AMBIENT
    delete process.env.MIGRATION_OWNER_ROLE
    const { setup } = await import('../testing/global-setup.js')
    return setup()
  }

  it('a rejecting PRE-window close prevents runMigrations entirely', async () => {
    captured.closeOutcomes = ['reject']
    await expect(run()).rejects.toThrow(/could not be closed BEFORE the migration window/)
    expect(captured.options, 'runMigrations was called after a failed pool reset')
      .toBeUndefined()
    expect(captured.urlAtCall).toBeUndefined()
    expect(captured.closeCalls, 'the window continued past the failed reset').toBe(1)
  })

  it('a rejecting PRE-window close never claims the migrator principal was used', async () => {
    captured.closeOutcomes = ['reject']
    const err = await rejection(run())
    expect(err.message).toMatch(/would NOT have connected as ai_capital_migrator/)
    expect(err.message).toMatch(/no migration was attempted/)
  })

  it('a rejecting PRE-window close leaves the environment untouched', async () => {
    captured.closeOutcomes = ['reject']
    await expect(run()).rejects.toThrow()
    expect(process.env.DATABASE_URL, 'the migrator URL was installed anyway').toBe(AMBIENT)
    expect(process.env.TEST_DATABASE_URL).toBe(AMBIENT)
  })

  it('migration SUCCEEDS but the POST-window close rejects → setup fails, env restored', async () => {
    captured.closeOutcomes = ['ok', 'reject']
    const err = await rejection(run())
    expect(err.message).toMatch(/could not be closed after the migration window/)
    expect(err.message).toMatch(/still holds ai_capital_migrator authority/)
    expect(captured.options, 'the migration should still have run')
      .toEqual({ ownerRole: 'ai_capital_owner' })
    expect(process.env.DATABASE_URL, 'the migrator URL survived the window').toBe(AMBIENT)
    expect(process.env.TEST_DATABASE_URL).toBe(AMBIENT)
  })

  it('migration FAILS and the POST-window close rejects → BOTH are reported', async () => {
    captured.throwOnMigrate = true
    captured.closeOutcomes = ['ok', 'reject']
    const err = await rejection(run())
    expect(err.message).toMatch(/migration failure: .*INJECTED migration failure/)
    expect(err.message).toMatch(/pool close failure: .*INJECTED close failure #2/)
  })

  it('a migration failure alone is NOT replaced by cleanup wording', async () => {
    captured.throwOnMigrate = true
    captured.closeOutcomes = ['ok', 'ok']
    const err = await rejection(run())
    expect(err.message).toMatch(/INJECTED migration failure/)
    expect(err.message, 'the cause was replaced by cleanup text')
      .not.toMatch(/could not be closed/)
  })

  it('NO runtime credential handoff follows either close failure', async () => {
    for (const outcomes of [['reject'], ['ok', 'reject']] as Array<Array<'ok' | 'reject'>>) {
      restore()
      captured.closeOutcomes = outcomes
      await expect(run()).rejects.toThrow()
      expect(process.env.TEST_DATABASE_URL,
        `workers were handed the runtime credential after ${outcomes.join('+')}`)
        .not.toBe(RUNTIME_URL)
      expect(process.env.BOOTSTRAP_DATABASE_URL,
        'setup reached its handoff and deleted the bootstrap variable')
        .toBe(BOOT_URL)
    }
  })

  it('both resets still happen, and setup succeeds, when neither rejects', async () => {
    captured.closeOutcomes = ['ok', 'ok']
    await expect(run()).resolves.toBeUndefined()
    expect(captured.closeCalls).toBe(2)
    expect(process.env.TEST_DATABASE_URL, 'the handoff must happen on the happy path')
      .toBe(RUNTIME_URL)
  })
})
