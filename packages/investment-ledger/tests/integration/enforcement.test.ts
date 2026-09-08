// Round 3: the two enforcement gaps that survived round 2's verification.
//
//   G1  TRUNCATE erased append-only evidence. 011's guard is
//       `BEFORE UPDATE OR DELETE ... FOR EACH ROW`, and row triggers DO NOT
//       FIRE FOR TRUNCATE, while the restricted runtime role held TRUNCATE on
//       every ledger table.
//   G2  Several ROOT batches could share one series: the single-successor
//       constraint — today 015's `UNIQUE (workspace_id, changed_from_batch)`,
//       spelled `UNIQUE (changed_from_batch)` when this defect was found —
//       forbids two successors for one predecessor but permits unlimited
//       NULLs. Only the TypeScript advisory lock stopped it; PostgreSQL did
//       not.
//
// Everything here authenticates as the restricted ai_capital_test_runtime role
// and uses direct SQL, because the claim under test is about what the DATABASE
// refuses, not about what the publisher declines to attempt.
//
// SAFETY. Every destructive attempt runs inside a transaction that is always
// rolled back, so even a regression that let one through could not persist.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { publishArchive } from '../../src/publish.js'
import { LEGACY_SERIES } from '../../src/series.js'
import {
  fixtureRoot, connectToTestDatabase, expectRejected, fixtureInspection,
  isDisposableTestDatabase, testDatabaseUrl, uniqueSeries, uniqueSha256, withRollback, testWorkspace } from './support.js'
import { createClient } from '../../../db/src/pool.js'

let client: Client
const NESTED = { transaction: 'nested' } as const

/** Every base table in the schema, read from the catalogue so none is missed. */
let ledgerTables: string[] = []

beforeAll(async () => {
  client = await connectToTestDatabase()
  const { rows } = await client.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r' ORDER BY c.relname`)
  ledgerTables = rows.map(r => r.relname)
})
afterAll(() => client.end())

async function digestOf(table: string): Promise<{ n: number; digest: string }> {
  const { rows } = await client.query<{ n: number; digest: string }>(
    `SELECT count(*)::int AS n,
            md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
       FROM investment_ledger.${table} t`)
  return rows[0]
}

// ── G1: append-only survives UPDATE, DELETE, TRUNCATE and TRUNCATE CASCADE ───

describe('G1 the schema is guarded against TRUNCATE, not only UPDATE and DELETE', () => {
  it('carries BOTH guards on every base table, and misses none', async () => {
    const { rows } = await client.query<{ relname: string; guards: string }>(
      `SELECT c.relname,
              string_agg(g.tgname, ',' ORDER BY g.tgname) FILTER (WHERE NOT g.tgisinternal) AS guards
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_trigger g ON g.tgrelid = c.oid
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r'
        GROUP BY c.relname ORDER BY c.relname`)
    expect(rows.length, 'the schema must have tables to guard').toBeGreaterThan(10)
    for (const row of rows) {
      expect(row.guards ?? '', `${row.relname} is missing reject_mutation`).toContain('reject_mutation')
      expect(row.guards ?? '', `${row.relname} is missing reject_truncate`).toContain('reject_truncate')
    }
  })

  it('installs the TRUNCATE guard as a BEFORE TRUNCATE STATEMENT trigger', async () => {
    const { rows } = await client.query<{ def: string }>(
      `SELECT pg_get_triggerdef(g.oid) AS def FROM pg_trigger g
        WHERE g.tgrelid = 'investment_ledger.transactions'::regclass
          AND g.tgname = 'reject_truncate'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].def).toMatch(/BEFORE TRUNCATE ON investment_ledger\.transactions FOR EACH STATEMENT/)
  })

  it('refuses UPDATE and DELETE of immutable history, leaving counts and digests unchanged', async () => {
    await withRollback(client, async () => {
      const published = await publishArchive(
        client, fixtureInspection(2), fixtureRoot(), 'guard.csv', uniqueSeries('guard-update'), testWorkspace(), NESTED)
      const before = await digestOf('import_batches')

      await expectRejected(client, () => client.query(
        'UPDATE investment_ledger.import_batches SET source_name = $2 WHERE id = $1',
        [published.batchId, 'tampered.csv']), /permission denied|append-only/)
      await expectRejected(client, () => client.query(
        'DELETE FROM investment_ledger.import_batches WHERE id = $1',
        [published.batchId]), /permission denied|append-only/)

      expect(await digestOf('import_batches'), 'a refused mutation must change nothing').toEqual(before)
    })
  })

  it('refuses a direct TRUNCATE of immutable history', async () => {
    await withRollback(client, async () => {
      await publishArchive(client, fixtureInspection(2), fixtureRoot(), 'guard.csv',
        uniqueSeries('guard-truncate'), testWorkspace(), NESTED)
      const before = await digestOf('transactions')
      expect(before.n, 'there must be history to try to erase').toBeGreaterThan(0)

      await expectRejected(client, () => client.query('TRUNCATE investment_ledger.transactions'),
        /permission denied|append-only/)

      expect(await digestOf('transactions')).toEqual(before)
    })
  })

  it('refuses TRUNCATE ... CASCADE, which would otherwise reach the whole graph', async () => {
    await withRollback(client, async () => {
      await publishArchive(client, fixtureInspection(2), fixtureRoot(), 'guard.csv',
        uniqueSeries('guard-cascade'), testWorkspace(), NESTED)
      const before = {
        batches: await digestOf('import_batches'),
        rows: await digestOf('raw_import_rows'),
        transactions: await digestOf('transactions'),
        components: await digestOf('transaction_amount_components'),
      }
      // import_batches is the root of the FK graph: CASCADE from here reaches
      // raw_import_rows -> transactions -> amount components and findings.
      await expectRejected(client, () => client.query('TRUNCATE investment_ledger.import_batches CASCADE'),
        /permission denied|append-only/)

      expect({
        batches: await digestOf('import_batches'),
        rows: await digestOf('raw_import_rows'),
        transactions: await digestOf('transactions'),
        components: await digestOf('transaction_amount_components'),
      }).toEqual(before)
    })
  })

  it('refuses TRUNCATE of EVERY table individually, so no child can be erased alone', async () => {
    await withRollback(client, async () => {
      for (const table of ledgerTables) {
        await expectRejected(client, () => client.query(`TRUNCATE investment_ledger.${table}`),
          /permission denied|append-only/)
        await expectRejected(client, () => client.query(`TRUNCATE investment_ledger.${table} CASCADE`),
          /permission denied|append-only/)
      }
      expect(ledgerTables.length).toBeGreaterThan(10)
    })
  })

  it('leaves the legitimate INSERT and SELECT paths working', async () => {
    await withRollback(client, async () => {
      const series = uniqueSeries('still-works')
      const published = await publishArchive(
        client, fixtureInspection(3), fixtureRoot(), 'ok.csv', series, testWorkspace(), NESTED)
      expect(published.insertedTransactions).toBe(3)

      // Manual entry and reconciliation events must also still be possible.
      const caseRow = await client.query<{ id: string }>(
        `INSERT INTO investment_ledger.reconciliation_cases (case_key, case_type)
         VALUES ($1,'field_mismatch') RETURNING id`, [`enforcement-${randomUUID()}`])
      await client.query(
        `INSERT INTO investment_ledger.reconciliation_case_events (case_id, event_type, actor)
         VALUES ($1,'OPEN','enforcement-test')`, [caseRow.rows[0].id])

      const read = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM investment_ledger.current_transactions t
           JOIN investment_ledger.raw_import_rows r ON r.id = t.import_row_id
          WHERE r.batch_id = $1`, [published.batchId])
      expect(read.rows[0].n).toBe(3)
    })
  })

  it('NON-VACUITY: the pre-014 guard set really did permit TRUNCATE', async () => {
    // A session-local table carrying ONLY 011's row trigger — the exact
    // protection every ledger table had before this migration. No ledger table
    // is touched; the temp table disappears with the connection.
    const name = `pre014_${randomUUID().replace(/-/g, '')}`
    await client.query(`CREATE TEMP TABLE ${name} (id int primary key)`)
    try {
      await client.query(`CREATE TRIGGER reject_mutation BEFORE UPDATE OR DELETE ON pg_temp.${name}
                          FOR EACH ROW EXECUTE FUNCTION investment_ledger.reject_economic_mutation()`)
      await client.query(`INSERT INTO pg_temp.${name} VALUES (1),(2),(3)`)

      // The row trigger does stop UPDATE, which is why the gap was invisible.
      let updateRefused = false
      try { await client.query(`UPDATE pg_temp.${name} SET id = id`) } catch { updateRefused = true }
      expect(updateRefused, '011 does stop UPDATE').toBe(true)

      // ...and does nothing at all about TRUNCATE.
      await client.query(`TRUNCATE pg_temp.${name}`)
      const left = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_temp.${name}`)
      expect(left.rows[0].n, 'pre-014 protection let TRUNCATE erase every row — this is the gap').toBe(0)

      // Adding 014's guard closes it, on identical data. Note the connection
      // OWNS this temp table and holds every privilege on it, so the ACL cannot
      // be what refuses the next statement — the trigger is. That is the layer
      // which also protects against the schema owner and against a superuser.
      await client.query(`INSERT INTO pg_temp.${name} VALUES (1),(2),(3)`)
      await client.query(`CREATE TRIGGER reject_truncate BEFORE TRUNCATE ON pg_temp.${name}
                          FOR EACH STATEMENT EXECUTE FUNCTION investment_ledger.reject_economic_mutation()`)
      let truncateRefused = false
      try { await client.query(`TRUNCATE pg_temp.${name} CASCADE`) } catch { truncateRefused = true }
      expect(truncateRefused, '014 stops TRUNCATE').toBe(true)
      const kept = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_temp.${name}`)
      expect(kept.rows[0].n).toBe(3)
    } finally {
      await client.query(`DROP TABLE IF EXISTS pg_temp.${name}`)
    }
  })

  it('has removed TRUNCATE and DELETE from the runtime role, and kept exactly what row locking needs', async () => {
    const { rows } = await client.query<{ table_name: string; privileges: string }>(
      `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
         FROM information_schema.table_privileges
        WHERE table_schema = 'investment_ledger' AND grantee = current_user
          AND table_name IN (SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                              WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r')
        GROUP BY table_name ORDER BY table_name`)
    expect(rows.length).toBe(ledgerTables.length)
    for (const row of rows) {
      expect(row.privileges, `${row.table_name} still grants TRUNCATE`).not.toContain('TRUNCATE')
      expect(row.privileges, `${row.table_name} still grants DELETE`).not.toContain('DELETE')
      expect(row.privileges, `${row.table_name} lost INSERT`).toContain('INSERT')
      expect(row.privileges, `${row.table_name} lost SELECT`).toContain('SELECT')
      // UPDATE is deliberately RETAINED by the corrected 014 itself. A draft
      // migration 015 that restored it was WITHDRAWN and never committed; there
      // is no 015. PostgreSQL charges every row-locking clause to the UPDATE
      // privilege, so without it both foreign-key inserts (FOR KEY SHARE on the
      // parent) and the FOR UPDATE serialization locks in three trigger
      // functions fail. An actual UPDATE statement is still refused, by the
      // trigger.
      expect(row.privileges, `${row.table_name} lost UPDATE; row locking will fail`).toContain('UPDATE')
    }
  })

  it('the connected principal is a NON-OWNER, so that privilege claim means something', async () => {
    // An ACL claim about an owner is empty: an owner can re-grant at will. This
    // asserts the topology the claim above depends on, so the suite cannot pass
    // by accident on a database where the writer owns the schema.
    const { rows } = await client.query<{ owned: number; superuser: boolean }>(
      `SELECT count(*)::int AS owned,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r'
          AND pg_get_userbyid(c.relowner) = current_user`)
    expect(rows[0].owned, 'the test writer must not own ledger tables').toBe(0)
    expect(rows[0].superuser, 'the test writer must not be a superuser').toBe(false)
  })

  it('PUBLIC and the unrelated application roles hold no ledger write privilege', async () => {
    // Read the STORED acl (relacl), not has_table_privilege: the latter answers
    // "could this role do it", which is always true for a superuser and so can
    // neither prove nor disprove a restriction.
    const { rows } = await client.query<{ leaked: string | null }>(
      `SELECT string_agg(format('%s->%s:%s', c.relname, a.grantee::regrole::text, a.privilege_type),
                         ', ' ORDER BY c.relname) AS leaked
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) a
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r'
          AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
          AND (a.grantee = 0
               OR a.grantee::regrole::text IN ('ai_capital_agent','ai_capital_claim_writer'))`)
    expect(rows[0].leaked, 'PUBLIC or an unrelated role holds a ledger write grant').toBeNull()
  })

  it('NON-VACUITY: the withdrawn 014->015 pair would abort on this ownership topology', async () => {
    // The deleted migration 015 asserted the negative with has_table_privilege
    // against the table OWNER. Where the owner is a superuser — which is what
    // the configured production migration user is — that function returns true
    // for everything, so the assertion fired and the chain stopped at 015.
    // Run that exact predicate here; it must report violations.
    const { rows } = await client.query<{ wrong: string | null }>(
      `SELECT string_agg(format('%s(%s)', c.relname, m), ', ' ORDER BY c.relname) AS wrong
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL (SELECT CASE
             WHEN has_table_privilege(pg_get_userbyid(c.relowner), c.oid, 'DELETE') THEN 'still holds DELETE'
             WHEN has_table_privilege(pg_get_userbyid(c.relowner), c.oid, 'TRUNCATE') THEN 'still holds TRUNCATE'
           END AS m) x
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r' AND m IS NOT NULL`)
    const owner = await client.query<{ owner: string; superuser: boolean }>(
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner,
              (SELECT rolsuper FROM pg_roles WHERE rolname = pg_get_userbyid(c.relowner)) AS superuser
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger' AND c.relkind = 'r'`)
    expect(owner.rows).toHaveLength(1)
    if (owner.rows[0].superuser) {
      expect(rows[0].wrong, 'the withdrawn 015 assertion must fire against a superuser owner').not.toBeNull()
      expect(rows[0].wrong!.split(', ').length).toBe(ledgerTables.length)
    } else {
      // On a non-superuser-owned database the old assertion happened to pass —
      // which is precisely why the defect stayed invisible for a whole round.
      expect(owner.rows[0].superuser).toBe(false)
    }
  })

  it('keeps UPDATE only so row locking works — an actual UPDATE is still refused', async () => {
    await withRollback(client, async () => {
      const published = await publishArchive(
        client, fixtureInspection(1), fixtureRoot(), 'lock.csv', uniqueSeries('lock-privilege'), testWorkspace(), NESTED)

      // The privilege is real: a row lock succeeds.
      const locked = await client.query(
        'SELECT id FROM investment_ledger.import_batches WHERE id = $1 FOR UPDATE', [published.batchId])
      expect(locked.rowCount).toBe(1)

      // And the statement it is named after is still impossible.
      await expectRejected(client, () => client.query(
        'UPDATE investment_ledger.import_batches SET row_count = row_count + 1 WHERE id = $1',
        [published.batchId]), /append-only/)
    })
  })

  it('applied the consolidated enforcement migration, and only that one', async () => {
    const { rows } = await client.query<{ filename: string }>(
      `SELECT filename FROM db.schema_migrations
        WHERE filename ~ '^01[4-9]_' ORDER BY filename`)
    // 015 was withdrawn, not superseded: the corrected enforcement is
    // consolidated into 014 and there is no repair migration behind it.
    expect(rows.map(r => r.filename)).toEqual(['014_investment_ledger_enforcement.sql'])
  })

  it('does not hand the runtime writer migration authority', async () => {
    // Migrations run as the bootstrap principal, which owns the schema. The
    // runtime writer deliberately cannot record one.
    const { rows } = await client.query<{ privileges: string | null }>(
      `SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
         FROM information_schema.table_privileges
        WHERE table_schema = 'db' AND table_name = 'schema_migrations' AND grantee = current_user`)
    expect(rows[0].privileges ?? '', 'the writer must not be able to record migrations').not.toContain('INSERT')
  })
})

describe('the suite refuses to run anywhere it should not', () => {
  it('admits exactly the two approved databases', () => {
    for (const ok of ['ai_capital_test', 'ai_capital_ledger_round4_test']) {
      expect(isDisposableTestDatabase(ok), `${ok} must be allowed`).toBe(true)
      expect(isDisposableTestDatabase(ok.toUpperCase()), `${ok} uppercase must be allowed`).toBe(true)
      expect(isDisposableTestDatabase(`  ${ok}  `), `${ok} padded must be allowed`).toBe(true)
    }
  })

  it('refuses the live database in every casing', () => {
    for (const live of ['ai_capital', 'AI_CAPITAL', 'Ai_Capital', 'aI_cApItAl']) {
      expect(isDisposableTestDatabase(live), `${live} must be refused`).toBe(false)
    }
  })

  it('refuses any other name, however test-like it looks', () => {
    // These tests COMMIT and hand a URL to an --apply subprocess, so a name
    // merely ending in _test is not good enough: it could be someone else's
    // database. Only the allowlist passes.
    for (const other of [
      'customer_test', 'production_copy_test', 'postgres', 'ai_capital_testing',
      'ai_capital_prod', 'template1', 'ledger_test', 'ai_capital_test_2', '',
    ]) {
      expect(isDisposableTestDatabase(other), `${other || '(empty)'} must be refused`).toBe(false)
    }
  })

  it('is in fact connected to one of the approved databases', async () => {
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db')
    expect(isDisposableTestDatabase(rows[0].db)).toBe(true)
  })
})

describe("014's ACL check catches an unexpected non-owner grant", () => {
  // The predicate below is migration 014's, verbatim apart from the schema it
  // scans: every stored DELETE/TRUNCATE entry whose grantee is not that table's
  // owner. The migration's REVOKE is deliberately bounded to PUBLIC and the
  // named application roles, so this check is what would catch a grant nobody
  // planned — a default privilege, a group role, an old operator's GRANT.
  const ACL_PREDICATE = `
    SELECT string_agg(format('%s->%s:%s',
                             c.relname,
                             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                             a.privilege_type),
                      ', ' ORDER BY c.relname) AS leaked
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = $1 AND c.relkind = 'r'
       AND a.privilege_type IN ('DELETE', 'TRUNCATE')
       AND a.grantee <> c.relowner`

  it('reports nothing against the real schema as migrated', async () => {
    const { rows } = await client.query<{ leaked: string | null }>(ACL_PREDICATE, ['investment_ledger'])
    expect(rows[0].leaked, 'a non-owner already holds DELETE/TRUNCATE on the ledger').toBeNull()
  })

  it('NON-VACUITY: it detects a planted DELETE grant, and a planted TRUNCATE grant', async () => {
    // A session-local table this connection owns, so the grant can be made and
    // then discarded without touching a ledger table.
    const temp = `acl_probe_${randomUUID().replace(/-/g, '')}`
    // pg_my_temp_schema() is 0 until this session owns a temp object, so the
    // table has to exist before the schema can be named.
    await client.query(`CREATE TEMP TABLE ${temp} (id int primary key)`)
    const { rows: schema } = await client.query<{ nspname: string }>(
      'SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()')
    const tempSchema = schema[0].nspname
    try {
      const scan = async () => (await client.query<{ leaked: string | null }>(
        ACL_PREDICATE, [tempSchema])).rows[0].leaked

      // Clean to begin with: only the owner has anything.
      expect(await scan(), 'the probe table must start clean').toBeNull()

      // Plant exactly the kind of grant the migration must refuse to ignore.
      await client.query(`GRANT DELETE ON pg_temp.${temp} TO ai_capital_agent`)
      const withDelete = await scan()
      expect(withDelete, 'a planted non-owner DELETE grant must be reported').not.toBeNull()
      expect(withDelete!).toContain('ai_capital_agent')
      expect(withDelete!).toContain('DELETE')

      await client.query(`REVOKE DELETE ON pg_temp.${temp} FROM ai_capital_agent`)
      expect(await scan(), 'revoking it must clear the report').toBeNull()

      // And the TRUNCATE half, to a different principal.
      await client.query(`GRANT TRUNCATE ON pg_temp.${temp} TO PUBLIC`)
      const withTruncate = await scan()
      expect(withTruncate, 'a planted PUBLIC TRUNCATE grant must be reported').not.toBeNull()
      expect(withTruncate!).toContain('PUBLIC')
      expect(withTruncate!).toContain('TRUNCATE')

      // CONTROL: the owner's own DELETE/TRUNCATE entry must NOT be reported —
      // an owner is not ACL-constrained and the check does not pretend it is.
      const ownerEntries = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN LATERAL aclexplode(c.relacl) a
          WHERE n.nspname = $1 AND c.relname = $2
            AND a.privilege_type IN ('DELETE','TRUNCATE') AND a.grantee = c.relowner`,
        [tempSchema, temp])
      expect(ownerEntries.rows[0].n, 'the owner does hold them').toBeGreaterThan(0)
      expect(await scan(), 'yet only the planted PUBLIC grant is reported').not.toContain('ai_capital_test_runtime')
    } finally {
      await client.query(`DROP TABLE IF EXISTS pg_temp.${temp}`)
    }
  })
})

// ── The restricted non-owner writer: sufficient, and no more ─────────────────

describe('a restricted non-owner writer can do the whole job and nothing else', () => {
  it('holds exactly SELECT, INSERT and UPDATE — never DELETE, TRUNCATE or ownership', async () => {
    const { rows } = await client.query<{ privileges: string }>(
      `SELECT DISTINCT string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
         FROM information_schema.table_privileges
        WHERE table_schema = 'investment_ledger' AND grantee = current_user
        GROUP BY table_name`)
    expect(rows.map(r => r.privileges)).toEqual(['INSERT,SELECT,UPDATE'])
  })

  it('completes every write path the ledger needs', async () => {
    await withRollback(client, async () => {
      // 1. Publication — this alone exercises foreign-key inserts across
      //    import_batches -> raw_import_rows -> transactions -> components,
      //    each of which takes FOR KEY SHARE on its parent row.
      const series = uniqueSeries('writer-capability')
      const published = await publishArchive(
        client, fixtureInspection(3), fixtureRoot(), 'writer.csv', series, testWorkspace(), NESTED)
      expect(published.insertedTransactions).toBe(3)

      // 2. An explicit row lock, the privilege UPDATE is actually retained for.
      const locked = await client.query(
        'SELECT id FROM investment_ledger.import_batches WHERE id = $1 FOR UPDATE', [published.batchId])
      expect(locked.rowCount).toBe(1)

      // 3. Account resolution — its trigger takes SELECT ... FOR UPDATE on accounts.
      const mk = async (suffix: string, resolved: boolean) => {
        const key = `TEST:writer-${suffix}:${randomUUID()}`
        const r = await client.query<{ id: string }>(
          `INSERT INTO investment_ledger.accounts
             (account_key, platform, external_account_id, display_name, resolution_status, unresolved_reason)
           VALUES ($1,'TestBroker',$2,$1,$3,$4) RETURNING id`,
          [key, resolved ? key : null, resolved ? 'resolved' : 'unresolved', resolved ? null : 'writer test'])
        return r.rows[0].id
      }
      const placeholder = await mk('placeholder', false)
      const canonical = await mk('canonical', true)
      await client.query(
        `INSERT INTO investment_ledger.account_resolutions
           (placeholder_account_id, resolved_account_id, resolution_kind, actor, reason)
         VALUES ($1,$2,'resolve','writer-test','capability proof')`, [placeholder, canonical])
      const effective = await client.query<{ effective_account_id: string }>(
        'SELECT effective_account_id FROM investment_ledger.effective_accounts WHERE account_id = $1', [placeholder])
      expect(effective.rows[0].effective_account_id).toBe(canonical)

      // 4. Reconciliation events — its trigger takes SELECT ... FOR UPDATE on the case.
      const caseRow = await client.query<{ id: string }>(
        `INSERT INTO investment_ledger.reconciliation_cases (case_key, case_type)
         VALUES ($1,'field_mismatch') RETURNING id`, [`writer-${randomUUID()}`])
      await client.query(
        `INSERT INTO investment_ledger.reconciliation_case_events (case_id, event_type, actor)
         VALUES ($1,'OPEN','writer-test')`, [caseRow.rows[0].id])
      await client.query(
        `INSERT INTO investment_ledger.reconciliation_case_events (case_id, event_type, actor)
         VALUES ($1,'MATCH','writer-test')`, [caseRow.rows[0].id])
      const state = await client.query<{ state: string }>(
        'SELECT state FROM investment_ledger.reconciliation_case_current_state WHERE case_id = $1',
        [caseRow.rows[0].id])
      expect(state.rows[0].state).toBe('matched')

      // 5. Document-verification events — its trigger takes SELECT ... FOR UPDATE
      //    on the variant. No PDF is opened; the digest is synthetic.
      const doc = await client.query<{ id: string }>(
        `INSERT INTO investment_ledger.logical_documents (platform, logical_key, document_type, source_filename)
         VALUES ('TestBroker',$1,'confirmation',$1) RETURNING id`, [`writer-doc-${randomUUID()}`])
      const variant = await client.query<{ id: string }>(
        `INSERT INTO investment_ledger.document_file_variants (logical_document_id, variant_kind, observed_path)
         VALUES ($1,'unlocked',$2) RETURNING id`, [doc.rows[0].id, `/nonexistent/${randomUUID()}.pdf`])
      await client.query(
        `INSERT INTO investment_ledger.document_verification_events
           (variant_id, event_kind, content_sha256, actor, reason)
         VALUES ($1,'verified',$2,'writer-test','capability proof')`,
        [variant.rows[0].id, 'b'.repeat(64)])
      const verified = await client.query<{ verification_state: string }>(
        'SELECT verification_state FROM investment_ledger.current_document_verification WHERE variant_id = $1',
        [variant.rows[0].id])
      expect(verified.rows[0].verification_state).toBe('verified')
    })
  })

  it('still cannot mutate: UPDATE, DELETE and TRUNCATE are all refused', async () => {
    await withRollback(client, async () => {
      const published = await publishArchive(
        client, fixtureInspection(1), fixtureRoot(), 'writer.csv', uniqueSeries('writer-immutable'), testWorkspace(), NESTED)
      const before = await digestOf('import_batches')
      await expectRejected(client, () => client.query(
        'UPDATE investment_ledger.import_batches SET row_count = row_count + 1 WHERE id = $1',
        [published.batchId]), /append-only/)
      await expectRejected(client, () => client.query(
        'DELETE FROM investment_ledger.import_batches WHERE id = $1', [published.batchId]),
        /permission denied|append-only/)
      await expectRejected(client, () => client.query(
        'TRUNCATE investment_ledger.import_batches CASCADE'), /permission denied|append-only/)
      expect(await digestOf('import_batches')).toEqual(before)
    })
  })
})

// ── G2: one root per real series, enforced by PostgreSQL ─────────────────────

async function insertRoot(c: Client, series: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO investment_ledger.import_batches
       (series_key, source_kind, source_name, source_sha256, importer_version, row_count, status)
     VALUES ($1,'archive_csv','direct.csv',$2,'round3-test',0,'published') RETURNING id`,
    [series, uniqueSha256()])
  return rows[0].id
}

describe('G2 a real series may have exactly one root batch', () => {
  it('accepts the first root and refuses a second one inserted directly', async () => {
    await withRollback(client, async () => {
      const series = uniqueSeries('one-root')
      const first = await insertRoot(client, series)
      expect(first).toBeTruthy()
      await expectRejected(client, () => insertRoot(client, series),
        /import_batches_one_root_per_series|duplicate key/)
    })
  })

  it('still accepts a linked successor, so revisions keep working', async () => {
    await withRollback(client, async () => {
      const series = uniqueSeries('successor')
      const root = await insertRoot(client, series)
      const successor = await client.query<{ id: string }>(
        `INSERT INTO investment_ledger.import_batches
           (series_key, source_kind, source_name, source_sha256, importer_version, row_count, status, changed_from_batch)
         VALUES ($1,'archive_csv','v2.csv',$2,'round3-test',0,'published',$3) RETURNING id`,
        [series, uniqueSha256(), root])
      expect(successor.rows[0].id).toBeTruthy()
      const heads = await client.query<{ id: string }>(
        'SELECT id FROM investment_ledger.current_import_batches WHERE series_key = $1', [series])
      expect(heads.rows.map(r => r.id)).toEqual([successor.rows[0].id])
    })
  })

  it('lets different series each hold their own root', async () => {
    await withRollback(client, async () => {
      const a = uniqueSeries('root-a')
      const b = uniqueSeries('root-b')
      const rootA = await insertRoot(client, a)
      const rootB = await insertRoot(client, b)
      expect(rootA).not.toBe(rootB)
      const heads = await client.query<{ series_key: string }>(
        'SELECT series_key FROM investment_ledger.current_import_batches WHERE series_key = ANY($1::text[]) ORDER BY 1',
        [[a, b]])
      expect(heads.rows.map(r => r.series_key)).toEqual([a, b].sort())
    })
  })

  it('refuses a new insert using the reserved legacy series key', async () => {
    await withRollback(client, async () => {
      await expectRejected(client, () => insertRoot(client, LEGACY_SERIES),
        /import_batches_no_new_legacy_series/)
    })
  })

  it('never creates, rewrites or removes a legacy-residue row', async () => {
    // The residue predates series identity and is append-only: 014 exempts it
    // from the root index rather than rewriting it. The count is a property of
    // the DATABASE, not of this code — a fresh database legitimately has none —
    // so what is asserted is that running the ledger does not disturb whatever
    // is there, and that nothing can join it.
    const snapshot = async () => (await client.query<{ n: number; digest: string | null }>(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(id::text, '|' ORDER BY id::text), '')) AS digest
         FROM investment_ledger.import_batches WHERE series_key = 'legacy:unclassified'`)).rows[0]

    const before = await snapshot()
    await withRollback(client, async () => {
      await publishArchive(client, fixtureInspection(2), fixtureRoot(), 'legacy-probe.csv',
        uniqueSeries('legacy-untouched'), testWorkspace(), NESTED)
      await expectRejected(client, () => insertRoot(client, LEGACY_SERIES),
        /import_batches_no_new_legacy_series/)
    })
    expect(await snapshot(), 'the legacy residue must be byte-identical afterwards').toEqual(before)

    // Whatever residue exists is exempt from the one-root rule by construction.
    const indexed = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM investment_ledger.import_batches
        WHERE series_key = 'legacy:unclassified' AND changed_from_batch IS NULL`)
    expect(indexed.rows[0].n, 'legacy roots are exempt, however many there are').toBeGreaterThanOrEqual(0)
  })

  it('holds the invariant globally: no non-legacy series has more than one head', async () => {
    const { rows } = await client.query<{ series_key: string; heads: number }>(
      `SELECT series_key, count(*)::int AS heads
         FROM investment_ledger.current_import_batches
        WHERE series_key <> 'legacy:unclassified'
        GROUP BY series_key HAVING count(*) > 1`)
    expect(rows).toEqual([])
  })

  it('two concurrent root attempts cannot both succeed', async () => {
    const url = testDatabaseUrl()
    const a = createClient(url); const b = createClient(url)
    await a.connect(); await b.connect()
    const series = uniqueSeries('root-race')
    try {
      await a.query('BEGIN'); await b.query('BEGIN')
      await insertRoot(a, series)

      let settled = false
      const second = insertRoot(b, series).then(
        r => { settled = true; return r }, e => { settled = true; throw e })

      // NON-VACUITY: the partial unique index is the only thing serialising
      // these. Without it writer-b would insert a second root immediately.
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(settled, 'writer-b was not serialized behind writer-a').toBe(false)

      await a.query('COMMIT')
      const outcome = await second.then(() => 'ok', (e: Error) => e.message)
      expect(outcome, 'writer-b must not create a second root').not.toBe('ok')
      expect(String(outcome)).toMatch(/import_batches_one_root_per_series|duplicate key/)
      await b.query('ROLLBACK')

      const roots = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM investment_ledger.import_batches
          WHERE series_key = $1 AND changed_from_batch IS NULL`, [series])
      expect(roots.rows[0].n, 'exactly one root survives the race').toBe(1)
    } finally { await a.end(); await b.end() }
  }, 60_000)
})
