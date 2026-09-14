import { it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connectAs, roleUrl, probeDetached } from './fixture.js'
import { describeInPhase } from './phase.js'

// PHASE 1 — THE MIGRATION WINDOW IS OPEN.
//
// INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// Runs against a database where the roles and
// ops/bootstrap/010_database_bootstrap.sql are done, migrations 001-019 have
// been applied as `ai_capital_migrator` with
// MIGRATION_OWNER_ROLE=ai_capital_owner, and
// ops/bootstrap/090_post_migration_lockdown.sql has NOT yet run.
//
// WHY THIS IS A SEPARATE FILE FROM migration-postlockdown.test.ts. The facts
// below are TRUE ONLY BEFORE LOCKDOWN — the migrator still holds its role
// memberships and CREATE on the database, and re-running the migrator is still
// a legal no-op. The post-lockdown file asserts the negation of every one of
// them. A single suite asserting both would be asserting a contradiction, and
// the only way to make it pass would be to weaken one half until it said
// nothing at all. See phase.ts for the run order.

describeInPhase('pre-lockdown', 'the migration chain applied as the migrator', () => {
  let migrator: Client
  beforeAll(async () => { migrator = await connectAs('migrator') })
  afterAll(async () => { await migrator?.end() })

  it('all nineteen migrations are recorded, in order, with no gaps', async () => {
    const { rows } = await migrator.query<{ filename: string }>(
      'SELECT filename FROM db.schema_migrations ORDER BY filename')
    expect(rows.map(r => r.filename.slice(0, 3)))
      .toEqual(Array.from({ length: 19 }, (_, i) => String(i + 1).padStart(3, '0')))
  })

  it('identity was applied before the ledger referenced it', async () => {
    const { rows } = await migrator.query<{ filename: string; applied_at: string }>(
      `SELECT filename, applied_at FROM db.schema_migrations
        WHERE filename IN ('011_identity_foundation.sql','013_investment_ledger.sql')
        ORDER BY filename`)
    expect(rows).toHaveLength(2)
    expect(new Date(rows[0].applied_at).getTime())
      .toBeLessThanOrEqual(new Date(rows[1].applied_at).getTime())
  })

  it('the migrator is NOT a superuser and does not bypass RLS', async () => {
    // If it were either, every isolation assertion in this directory would pass
    // vacuously against a database that has no isolation at all.
    const { rows } = await migrator.query<{ super: boolean; bypass: boolean }>(
      'SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = session_user')
    expect(rows[0].super).toBe(false)
    expect(rows[0].bypass).toBe(false)
  })

  it('its memberships are SET-only: inherit_option false, set_option true', async () => {
    // THE EXACT COLUMNS, because this is the whole mechanism. `WITH INHERIT
    // FALSE, SET TRUE` means the migrator may deliberately ASSUME the owner
    // (which migrate.ts does, once per file, via SET LOCAL ROLE) and holds none
    // of its privileges the rest of the time. An earlier draft of this test
    // read `admin_option`, which is a different column and says nothing about
    // inheritance — it would have passed against a plainly-inherited grant,
    // i.e. against exactly the configuration this design refuses.
    const { rows } = await migrator.query<{
      granted: string; inherit_option: boolean; set_option: boolean
    }>(
      `SELECT granted.rolname AS granted, m.inherit_option, m.set_option
         FROM pg_auth_members m
         JOIN pg_roles granted ON granted.oid = m.roleid
         JOIN pg_roles grantee ON grantee.oid = m.member
        WHERE grantee.rolname = 'ai_capital_migrator'
        ORDER BY granted.rolname`)
    expect(rows.map(r => r.granted))
      .toEqual(['ai_capital_identity_authority', 'ai_capital_owner'])
    for (const row of rows) {
      expect(row.inherit_option, `${row.granted}: must NOT be inherited`).toBe(false)
      expect(row.set_option, `${row.granted}: must be assumable with SET ROLE`).toBe(true)
    }
  })

  it('the migrator can still CREATE — the window is open', async () => {
    const { rows } = await migrator.query<{ ok: boolean }>(
      "SELECT has_database_privilege(session_user, current_database(), 'CREATE') AS ok")
    expect(rows[0].ok).toBe(true)
  })

  it('every object it created is already owned by ai_capital_owner', async () => {
    // MIGRATION_OWNER_ROLE should make this true BEFORE lockdown's REASSIGN
    // OWNED runs. If it is false here, the reassign is doing real work rather
    // than being the backstop it is documented as, and any database migrated
    // without the variable set would be silently different.
    const { rows } = await migrator.query<{ nsp: string; name: string; owner: string }>(
      `SELECT n.nspname AS nsp, c.relname AS name, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('identity','investment_ledger','cash_ledger','portfolio','db')
          AND c.relkind IN ('r','v','m','S','p')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.objid = c.oid AND d.deptype = 'e')
          AND pg_get_userbyid(c.relowner) <> 'ai_capital_owner'
        ORDER BY 1, 2`)
    expect(rows.map(r => `${r.nsp}.${r.name} -> ${r.owner}`)).toEqual([])
  })

  it('re-running the migrator is an idempotent no-op', async () => {
    // ENVIRONMENT BEFORE IMPORT, deliberately and in this order.
    //
    // `getPool()` memoises on its FIRST CALL and prefers TEST_DATABASE_URL in a
    // test runtime, and the shared vitest isolation setup CLEARS DATABASE_URL.
    // So: close whatever pool exists, point both variables at the migrator's
    // disposable URL, and only then import migrate.ts. Importing first and
    // setting afterwards would have run the migrations against whatever the
    // pool had already latched onto — or thrown for a missing DATABASE_URL and
    // been read as "migrations are refused", which is the post-lockdown
    // expectation and would have made this test pass in the wrong phase.
    const pool = await import('../../../../db/src/pool.js')
    await pool.closePool()

    const savedDatabaseUrl = process.env.DATABASE_URL
    const savedTestUrl = process.env.TEST_DATABASE_URL
    process.env.DATABASE_URL = roleUrl('migrator')
    process.env.TEST_DATABASE_URL = roleUrl('migrator')
    try {
      const { runMigrations } = await import('../../../../db/src/migrate.js')
      const before = await migrator.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM db.schema_migrations')

      const result = await runMigrations()
      expect(result.applied, 'a second run must apply nothing').toEqual([])
      expect(result.alreadyApplied).toHaveLength(before.rows[0].n)

      const after = await migrator.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM db.schema_migrations')
      expect(after.rows[0].n).toBe(before.rows[0].n)
    } finally {
      await pool.closePool()
      if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = savedDatabaseUrl
      if (savedTestUrl === undefined) delete process.env.TEST_DATABASE_URL
      else process.env.TEST_DATABASE_URL = savedTestUrl
    }
  }, 60_000)

  it('an edited applied migration would be REFUSED, not silently re-run', async () => {
    // The hash gate, stated as a property of the stored rows: every recorded
    // sha256 still matches the file. migrate.ts throws when they differ, so
    // this is the precondition for the no-op above meaning anything.
    const { createHash } = await import('node:crypto')
    const { readFileSync } = await import('node:fs')
    const { join, dirname, resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = resolve(dirname(fileURLToPath(import.meta.url)),
      '..', '..', '..', '..', 'db', 'migrations')
    const { rows } = await migrator.query<{ filename: string; sha256: string }>(
      'SELECT filename, sha256 FROM db.schema_migrations ORDER BY filename')
    for (const row of rows) {
      const onDisk = createHash('sha256')
        .update(readFileSync(join(dir, row.filename), 'utf-8')).digest('hex')
      expect(onDisk, `${row.filename} was edited after it was applied`).toBe(row.sha256)
    }
  })

  it('the schema the chain built is complete: nine views, seventeen guarded tables', async () => {
    const views = await migrator.query<{ relname: string; opts: string[] | null }>(
      `SELECT c.relname, c.reloptions AS opts
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'v' ORDER BY 1`)
    expect(views.rows).toHaveLength(9)
    for (const row of views.rows) {
      expect(row.opts ?? [], row.relname).toContain('security_invoker=true')
    }

    const tables = await migrator.query<{ relname: string; en: boolean; force: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS en, c.relforcerowsecurity AS force
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r'
          AND c.relname <> 'instruments' ORDER BY 1`)
    expect(tables.rows).toHaveLength(17)
    for (const row of tables.rows) {
      expect(row.en, `${row.relname} ENABLE`).toBe(true)
      expect(row.force, `${row.relname} FORCE`).toBe(true)
    }
  })

  it('the migrator cannot read a single ledger row even now', async () => {
    // Being able to CREATE the schema is not being able to READ it. Worth
    // asserting in THIS phase, because it is the phase where the migrator is at
    // its most privileged.
    const result = await probeDetached(migrator, () =>
      migrator.query('SELECT count(*) FROM investment_ledger.transactions'))
    expect(result.code).toBe('42501')
  })
})
