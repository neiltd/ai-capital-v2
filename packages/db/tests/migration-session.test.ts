import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// THE MIGRATION SESSION — behavioural, and it opens no database.
//
// `packages/db/src/pool.ts` is replaced with a recording double, so
// `runMigrations()` executes for real against a fake client and this file can
// assert on the exact statement sequence it produces. No PostgreSQL, no
// network, no refactoring of production code to make it testable.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS EXISTS FOR.
//
// `ops/bootstrap/010_database_bootstrap.sql` installs `btree_gist` and `vector`
// into `public` and — since round 5 — refuses to continue unless they are
// really there. That fixes PLACEMENT. It does nothing about VISIBILITY.
//
// Two published, immutable migrations resolve names in that schema WITHOUT
// qualifying them:
//     006  `embedding vector(384)`, `USING hnsw (embedding vector_cosine_ops)`
//     011  `EXCLUDE USING gist (... WITH =)`   — btree_gist's operators
//
// Whether those resolve depends on the session's `search_path`, and the runner
// did not set one. `ALTER DATABASE ... SET`, `ALTER ROLE ... SET`, a connection
// parameter and `PGOPTIONS` can each supply one, and the server applies them
// before any client statement runs — so a deployment whose role or database
// carried `search_path = app` failed on migration 006 with
// `type "vector" does not exist`: a privilege-shaped error with no privilege
// cause, on a chain byte-identical to one that works elsewhere.
//
// The bootstrap cannot fix it. It governs the ADMINISTRATOR's session, not the
// migrator's. So the runner pins its own.
// ─────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = resolve(HERE, '..', 'migrations')

/** Every statement the runner issued, in order. */
let statements: string[] = []

function recordingClient() {
  return {
    query: (text: string, _values?: unknown[]) => {
      statements.push(typeof text === 'string' ? text : String(text))
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
    release: () => {},
  }
}

vi.mock('../src/pool.js', () => ({
  getPool: () => ({
    query: (text: string) => {
      statements.push(typeof text === 'string' ? text : String(text))
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
    connect: () => Promise.resolve(recordingClient()),
  }),
}))

/**
 * Run the migrator with a given MIGRATION_OWNER_ROLE and return its statements.
 *
 * The module reads the variable at LOAD time, so each case needs a fresh module
 * registry — which is also why this is a dynamic import rather than a top-level
 * one.
 */
async function runWith(ownerRole: string | undefined): Promise<string[]> {
  statements = []
  const saved = process.env.MIGRATION_OWNER_ROLE
  if (ownerRole === undefined) delete process.env.MIGRATION_OWNER_ROLE
  else process.env.MIGRATION_OWNER_ROLE = ownerRole
  vi.resetModules()
  try {
    const { runMigrations } = await import('../src/migrate.js')
    await runMigrations()
  } finally {
    if (saved === undefined) delete process.env.MIGRATION_OWNER_ROLE
    else process.env.MIGRATION_OWNER_ROLE = saved
  }
  return statements
}

/** Index of the first statement matching `pattern`, or -1. */
const at = (list: string[], pattern: RegExp) => list.findIndex(s => pattern.test(s))

const ROLE = /^SET LOCAL ROLE /
const PATH = /^SET LOCAL search_path/
const RESET = /^RESET ROLE$/
const LEDGER = /^INSERT INTO db\.schema_migrations/
/** A migration body: the runner passes whole files, which all begin with a comment. */
const BODY = /^--/

/**
 * The migrations that actually exist on disk.
 *
 * Hoisted to module scope because three of the six per-migration assertions live
 * in `it` blocks that never had the listing in scope. Read from the DIRECTORY,
 * never from CURRENT_V19_MANIFEST — see the anchor assertion below.
 */
const MIGRATION_FILES = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))

describe('with MIGRATION_OWNER_ROLE configured', () => {
  let issued: string[]
  beforeEach(async () => { issued = await runWith('ai_capital_owner') })

  it('actually ran the migrations (a silent no-op must not read as a pass)', () => {
    // ONE INDEPENDENT LITERAL, and only one. This number is NOT derived from
    // CURRENT_V19_MANIFEST: this file proves the runner's behaviour against the
    // migrations that exist ON DISK, and the manifest is a separate authority
    // that must be able to disagree with the directory. Deriving it would
    // rebuild the self-consistency hole where a test builds its fixture from the
    // manifest, so a wrong manifest passes against itself.
    expect(MIGRATION_FILES.length, 'the migrations directory changed size').toBe(19)
    // The per-migration counts derive from the disk listing rather than
    // repeating the number, so they cannot drift apart from it.
    expect(issued.filter(s => ROLE.test(s))).toHaveLength(MIGRATION_FILES.length)
    expect(issued.filter(s => BODY.test(s))).toHaveLength(MIGRATION_FILES.length)
  })

  it('sets a transaction-local search path', () => {
    const paths = issued.filter(s => PATH.test(s))
    expect(paths).toHaveLength(MIGRATION_FILES.length)
    // SET LOCAL, not SET: it must revert at COMMIT *and* ROLLBACK, so nothing
    // leaks onto the next borrower of a pooled connection.
    for (const p of paths) expect(p).toMatch(/^SET LOCAL search_path = /)
  })

  it('the path is exactly pg_catalog, public', () => {
    const path = issued.find(s => PATH.test(s))!
    expect(path).toBe('SET LOCAL search_path = pg_catalog, public')
  })

  it('the path contains no "$user"', () => {
    // `"$user"` resolves against the CURRENT role — `ai_capital_owner` here. No
    // such schema exists; if one were ever created it would silently outrank
    // `public` for every unqualified name.
    const path = issued.find(s => PATH.test(s))!
    expect(path).not.toContain('$user')
  })

  it('the path contains no application-owned schema', () => {
    const path = issued.find(s => PATH.test(s))!
    for (const schema of ['identity', 'investment_ledger', 'cash_ledger',
                          'portfolio', 'capital', 'db', 'thesis', 'graph']) {
      expect(path, `${schema} must not be searched implicitly`)
        .not.toMatch(new RegExp(`\\b${schema}\\b`))
    }
  })

  it('ORDER: SET LOCAL ROLE comes before the search path', () => {
    // `"$user"` is evaluated against whichever role is current, so a path set
    // first would describe the wrong session.
    expect(at(issued, ROLE)).toBeLessThan(at(issued, PATH))
  })

  it('ORDER: the search path comes before the migration SQL', () => {
    // The only statement whose name resolution it exists to govern.
    expect(at(issued, PATH)).toBeLessThan(at(issued, BODY))
  })

  it('ORDER: role, path, body, RESET ROLE, ledger INSERT — unchanged around the addition', () => {
    const first = issued.slice(0, at(issued, LEDGER) + 1)
    expect(at(first, ROLE)).toBeLessThan(at(first, PATH))
    expect(at(first, PATH)).toBeLessThan(at(first, BODY))
    expect(at(first, BODY)).toBeLessThan(at(first, RESET))
    expect(at(first, RESET)).toBeLessThan(at(first, LEDGER))
  })

  it('the ledger INSERT still runs as the CONNECTING role, after RESET ROLE', () => {
    // The migrator holds INSERT on db.schema_migrations; the owner does not
    // need to. Round 4 established this and it must survive the addition.
    const reset = at(issued, RESET)
    const ledger = at(issued, LEDGER)
    expect(reset).toBeGreaterThan(-1)
    expect(ledger).toBeGreaterThan(reset)
    expect(issued.slice(reset, ledger).filter(s => PATH.test(s) || ROLE.test(s))).toEqual([])
  })

  it('each migration gets its own BEGIN/COMMIT with the pair inside', () => {
    const begin = at(issued, /^BEGIN$/)
    const commit = at(issued, /^COMMIT$/)
    expect(begin).toBeGreaterThan(-1)
    expect(commit).toBeGreaterThan(commit === -1 ? 0 : begin)
    expect(at(issued, ROLE)).toBeGreaterThan(begin)
    expect(at(issued, PATH)).toBeLessThan(commit)
  })
})

describe('with MIGRATION_OWNER_ROLE unset', () => {
  let issued: string[]
  beforeEach(async () => { issued = await runWith(undefined) })

  it('no search path is set', () => {
    // The variable is the switch for the whole ownership arrangement. Unset, it
    // must reproduce the previous behaviour exactly — this is what makes the
    // change safe for any database migrated without it.
    expect(issued.filter(s => PATH.test(s))).toEqual([])
  })

  it('no role is assumed and none is reset', () => {
    expect(issued.filter(s => ROLE.test(s))).toEqual([])
    expect(issued.filter(s => RESET.test(s))).toEqual([])
  })

  it('the migrations and the ledger INSERT still run', () => {
    expect(issued.filter(s => BODY.test(s))).toHaveLength(MIGRATION_FILES.length)
    expect(issued.filter(s => LEDGER.test(s))).toHaveLength(MIGRATION_FILES.length)
  })
})

describe('the assumptions the fixed path relies on', () => {
  it('every object in every migration is schema-qualified', () => {
    // The path deliberately excludes application schemas, which is only safe
    // because no migration creates or alters an unqualified object. If one ever
    // did it would target `public` — where the owner has no CREATE — and fail
    // loudly, which is the intended outcome; this test says so out loud.
    const offenders: string[] = []
    for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
      const raw = readFileSync(join(MIGRATIONS, f), 'utf-8')
      const code = raw.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
        .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, '$BODY$')
      for (const m of code.matchAll(
        /\bCREATE\s+(?:OR REPLACE\s+)?(?:UNIQUE\s+)?(TABLE|VIEW|FUNCTION|TYPE|SEQUENCE)\s+(?:IF NOT EXISTS\s+)?([A-Za-z_][\w.]*)/gi)) {
        if (!m[2].includes('.')) offenders.push(`${f}: ${m[1]} ${m[2]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('migration 006 is byte-identical to the published revision', () => {
    // The reason the path must contain `public` at all, and immutable: any edit
    // makes migrate.ts refuse to run on every database that already applied it.
    const bytes = readFileSync(join(MIGRATIONS, '006_vectors.sql'))
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('948c04ee131362647b07bfe6313ca59a8f15c3d24b29cdd7f8013ffe9c6916cb')
  })

  it('006 really does depend on unqualified names from public', () => {
    // Non-vacuity for the whole file: if 006 ever qualified these, the fixed
    // path would still be right but this suite's premise would be stale.
    const m006 = readFileSync(join(MIGRATIONS, '006_vectors.sql'), 'utf-8')
    expect(m006).toMatch(/embedding\s+vector\(384\)/)
    expect(m006).toMatch(/vector_cosine_ops/)
    expect(m006).not.toContain('public.vector')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ROUND 7 — configuration is resolved WHEN runMigrations() IS CALLED.
//
// It used to be a module-scope const. `testing/global-setup.ts` imports
// `runMigrations` at the top of the file and assigned MIGRATION_OWNER_ROLE
// later, so the constant was already frozen at null: no SET LOCAL ROLE, no
// pinned search path, every schema owned by the bootstrap login, and migration
// 012 failing with SQLSTATE 42501 on the 2026-09-08 disposable-cluster gate.
//
// The tests below deliberately do NOT call vi.resetModules(): the whole point
// is that a module imported EARLY still honours configuration supplied LATE.
// ═════════════════════════════════════════════════════════════════════════════
describe('ROUND 7: owner configuration is resolved at invocation, not at import', () => {
  // Import ONCE, LAZILY, with the variable unset — the Round 6 starting
  // condition. Lazily because doing it at collection time would race the
  // vi.resetModules() the suites above use; and once because the property under
  // test is precisely that ONE module instance honours LATER configuration.
  let earlyMod: typeof import('../src/migrate.js') | null = null
  async function importedEarly(): Promise<typeof import('../src/migrate.js')> {
    if (earlyMod) return earlyMod
    const saved = process.env.MIGRATION_OWNER_ROLE
    delete process.env.MIGRATION_OWNER_ROLE
    vi.resetModules()
    try {
      earlyMod = await import('../src/migrate.js')
    } finally {
      if (saved === undefined) delete process.env.MIGRATION_OWNER_ROLE
      else process.env.MIGRATION_OWNER_ROLE = saved
    }
    return earlyMod
  }

  /** Invoke the ALREADY-IMPORTED module; no module registry reset anywhere. */
  async function invoke(
    env: string | undefined, options?: { ownerRole?: string | null },
  ): Promise<string[]> {
    statements = []
    const mod = await importedEarly()
    const saved = process.env.MIGRATION_OWNER_ROLE
    if (env === undefined) delete process.env.MIGRATION_OWNER_ROLE
    else process.env.MIGRATION_OWNER_ROLE = env
    try {
      await (options === undefined ? mod.runMigrations() : mod.runMigrations(options))
    } finally {
      if (saved === undefined) delete process.env.MIGRATION_OWNER_ROLE
      else process.env.MIGRATION_OWNER_ROLE = saved
    }
    return statements
  }

  it('1. imported BEFORE the variable was set, then set before the call — the new value wins', async () => {
    const issued = await invoke('ai_capital_owner')
    expect(at(issued, ROLE), 'the module froze the value at import').toBeGreaterThan(-1)
    expect(issued.find(s => ROLE.test(s))).toBe('SET LOCAL ROLE "ai_capital_owner"')
    expect(at(issued, PATH)).toBeGreaterThan(-1)
  })

  it('2. an explicit option works on a module that was already imported', async () => {
    const issued = await invoke(undefined, { ownerRole: 'ai_capital_owner' })
    expect(issued.find(s => ROLE.test(s))).toBe('SET LOCAL ROLE "ai_capital_owner"')
  })

  it('3. an explicit option BEATS a conflicting environment value', async () => {
    const issued = await invoke('some_other_role', { ownerRole: 'ai_capital_owner' })
    expect(issued.find(s => ROLE.test(s))).toBe('SET LOCAL ROLE "ai_capital_owner"')
    expect(issued.join(' | ')).not.toMatch(/some_other_role/)
  })

  it('an explicit null overrides the environment and switches no role', async () => {
    const issued = await invoke('ai_capital_owner', { ownerRole: null })
    expect(at(issued, ROLE)).toBe(-1)
    expect(at(issued, PATH)).toBe(-1)
    expect(at(issued, RESET)).toBe(-1)
    expect(at(issued, LEDGER), 'the migrations must still run').toBeGreaterThan(-1)
  })

  it('10. a caller supplying nothing, with nothing in the environment, is unchanged', async () => {
    const issued = await invoke(undefined)
    expect(at(issued, ROLE)).toBe(-1)
    expect(at(issued, PATH)).toBe(-1)
    expect(at(issued, RESET)).toBe(-1)
    expect(at(issued, LEDGER)).toBeGreaterThan(-1)
  })

  it('7/8. ORDER survives: BEGIN then ROLE then search_path then body then RESET then ledger', async () => {
    const issued = await invoke(undefined, { ownerRole: 'ai_capital_owner' })
    const begin = issued.findIndex(s => /^BEGIN$/.test(s))
    expect(begin).toBeGreaterThan(-1)
    expect(at(issued, ROLE)).toBeGreaterThan(begin)
    expect(at(issued, PATH)).toBeGreaterThan(at(issued, ROLE))
    expect(at(issued, BODY)).toBeGreaterThan(at(issued, PATH))
    expect(at(issued, RESET)).toBeGreaterThan(at(issued, BODY))
    expect(at(issued, LEDGER), 'the ledger row must be written AFTER RESET ROLE')
      .toBeGreaterThan(at(issued, RESET))
  })

  it('rejects configuration that could silently become a DIFFERENT role', async () => {
    const mod = await importedEarly()
    await expect(mod.runMigrations({ ownerRole: '   ' })).rejects.toThrow(/is empty/)
    await expect(mod.runMigrations({ ownerRole: 'r'.repeat(64) })).rejects.toThrow(/truncates identifiers/)
    await expect(mod.runMigrations({ ownerRole: `role${String.fromCharCode(0)}x` }))
      .rejects.toThrow(/NUL byte/)
  })

  it('the role name is still quoted, not interpolated raw', async () => {
    const issued = await invoke(undefined, { ownerRole: 'weird role"name' })
    expect(issued.find(s => ROLE.test(s))).toBe('SET LOCAL ROLE "weird role""name"')
  })

  it('resolveMigrationOwnerRole is the ONE policy, and reads the environment live', async () => {
    const mod = await importedEarly()
    const saved = process.env.MIGRATION_OWNER_ROLE
    try {
      delete process.env.MIGRATION_OWNER_ROLE
      expect(mod.resolveMigrationOwnerRole()).toBeNull()
      process.env.MIGRATION_OWNER_ROLE = 'ai_capital_owner'
      expect(mod.resolveMigrationOwnerRole()).toBe('ai_capital_owner')
      process.env.MIGRATION_OWNER_ROLE = '   '
      expect(mod.resolveMigrationOwnerRole(), 'an empty variable means unset').toBeNull()
      expect(mod.resolveMigrationOwnerRole({ ownerRole: 'x' })).toBe('x')
      expect(mod.resolveMigrationOwnerRole({ ownerRole: null })).toBeNull()
    } finally {
      if (saved === undefined) delete process.env.MIGRATION_OWNER_ROLE
      else process.env.MIGRATION_OWNER_ROLE = saved
    }
  })
})
