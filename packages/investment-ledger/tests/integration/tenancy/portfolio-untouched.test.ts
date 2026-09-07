import { it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connectAs } from './fixture.js'
import { describeInPhase } from './phase.js'

// portfolio.positions AND portfolio.trade_log ARE UNTOUCHED.
//
// INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// WHY THIS IS A TEST AND NOT A COMMENT. The investment ledger is a SECOND,
// parallel record of the same underlying reality as the existing portfolio
// tables. The tempting design — make the ledger the source of truth and have
// portfolio read from it — would have coupled a live pipeline that real money
// decisions ride on to a schema that has never been run in production.
//
// So the ledger is additive and inert with respect to portfolio: no foreign
// key, no trigger, no view, no tenancy column, no row-level security. Every one
// of those absences is asserted below, because each is a distinct way the
// coupling could arrive by accident.
//
// The migration files 001-010 are also immutable — migrate.ts refuses a changed
// hash — so a change here would not merely be undesirable, it would break every
// database that has already applied them.

describeInPhase('post-lockdown', 'the pre-existing portfolio schema', () => {
  let migrator: Client
  /** STRUCTURAL assertions run as the ADMINISTRATOR, and read pg_catalog.
   *
   *  `information_schema.columns` shows only columns the CURRENT ROLE holds
   *  some privilege on, so asking the locked-down migrator for portfolio's
   *  column list returns ZERO ROWS — and `expect(names).not.toContain(...)`
   *  passes against an empty list for entirely the wrong reason. These are
   *  assertions about SCHEMA STRUCTURE, not about a migrator permission
   *  boundary, so they use a role that can see the structure and a catalogue
   *  that does not filter. */
  let admin: Client
  beforeAll(async () => {
    migrator = await connectAs('migrator')
    admin = await connectAs('admin')
  })
  afterAll(async () => {
    await admin?.end()
    await migrator?.end()
  })

  /** Column names straight from pg_attribute — unfiltered by privilege. */
  async function columnsOf(table: string): Promise<string[]> {
    const { rows } = await admin.query<{ attname: string }>(
      `SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = ('portfolio.' || $1)::regclass
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [table])
    return rows.map(r => r.attname)
  }

  it('the tables exist — otherwise every absence below is vacuous', async () => {
    const { rows } = await admin.query<{ positions: string | null; trade_log: string | null }>(
      `SELECT to_regclass('portfolio.positions')::text AS positions,
              to_regclass('portfolio.trade_log')::text  AS trade_log`)
    expect(rows[0].positions).toBe('portfolio.positions')
    expect(rows[0].trade_log).toBe('portfolio.trade_log')
  })

  it('positions still has its original single-owner shape', async () => {
    const names = await columnsOf('positions')
    // NON-VACUITY FIRST: a non-empty list, and a column we know is there.
    expect(names.length, 'no columns read — the check would be vacuous').toBeGreaterThan(0)
    expect(names).toContain('ticker')
    expect(names, 'portfolio must not have acquired tenancy').not.toContain('workspace_id')
    expect(names).not.toContain('actor_principal_id')
  })

  it('trade_log likewise', async () => {
    const names = await columnsOf('trade_log')
    expect(names.length, 'no columns read — the check would be vacuous').toBeGreaterThan(0)
    expect(names).not.toContain('workspace_id')
    expect(names).not.toContain('actor_principal_id')
  })

  it('neither table has row-level security', async () => {
    const { rows } = await admin.query<{ relname: string; en: boolean }>(
      `SELECT relname, relrowsecurity AS en FROM pg_class
        WHERE oid IN ('portfolio.positions'::regclass, 'portfolio.trade_log'::regclass)`)
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.en, row.relname).toBe(false)
  })

  it('no ledger object references portfolio, and no portfolio object references the ledger', async () => {
    const { rows } = await admin.query<{ conname: string }>(
      `SELECT k.conname FROM pg_constraint k
         JOIN pg_class src ON src.oid = k.conrelid
         JOIN pg_namespace sn ON sn.oid = src.relnamespace
         JOIN pg_class tgt ON tgt.oid = k.confrelid
         JOIN pg_namespace tn ON tn.oid = tgt.relnamespace
        WHERE k.contype = 'f'
          AND ((sn.nspname = 'investment_ledger' AND tn.nspname = 'portfolio')
            OR (sn.nspname = 'portfolio' AND tn.nspname = 'investment_ledger'))`)
    expect(rows.map(r => r.conname)).toEqual([])
  })

  it('no trigger on a portfolio table came from the ledger work', async () => {
    const { rows } = await admin.query<{ tgname: string }>(
      `SELECT t.tgname FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'portfolio' AND NOT t.tgisinternal
          -- The TRIGGER names this work installs. An earlier draft listed
          -- reject_economic_mutation, which is the FUNCTION's name and no
          -- trigger's, so that element of the list matched nothing.
          AND t.tgname IN ('actor_is_authorized','reject_mutation','reject_truncate',
                           'reconciliation_event_scope')`)
    expect(rows.map(r => r.tgname)).toEqual([])
  })

  it('no ledger view reads a portfolio table', async () => {
    const { rows } = await admin.query<{ viewname: string }>(
      `SELECT viewname FROM pg_views
        WHERE schemaname = 'investment_ledger' AND definition LIKE '%portfolio.%'`)
    expect(rows.map(r => r.viewname)).toEqual([])
  })

  it('migrations 001-010 are recorded with their ORIGINAL hashes', async () => {
    // The strongest available statement that the published half of the schema
    // was not edited: migrate.ts stores the sha256 it applied, and refuses to
    // re-run a file whose content no longer matches.
    const { createHash } = await import('node:crypto')
    const { readFileSync } = await import('node:fs')
    const { join, dirname, resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = resolve(dirname(fileURLToPath(import.meta.url)),
      '..', '..', '..', '..', 'db', 'migrations')

    const { rows } = await migrator.query<{ filename: string; sha256: string }>(
      `SELECT filename, sha256 FROM db.schema_migrations
        WHERE filename < '011' ORDER BY filename`)
    expect(rows).toHaveLength(10)
    for (const row of rows) {
      const onDisk = createHash('sha256')
        .update(readFileSync(join(dir, row.filename), 'utf-8')).digest('hex')
      expect(onDisk, `${row.filename} was edited after it was applied`).toBe(row.sha256)
    }
  })
})
