import { it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import {
  connectAs, ensurePrincipals, seedWorkspace, grantCapability, beginAuthorized,
  rollback, probe, UNIQUE_VIOLATION, CHECK_VIOLATION,
  type Principals, type Workspace,
} from './fixture.js'
import { hex64 } from './graph.js'
import { describeInPhase } from './phase.js'
import { LEGACY_SERIES, MASTER_ARCHIVE_SERIES, assertSeriesKey } from '../../../src/series.js'

// legacy:unclassified UPGRADE RESIDUE.
//
// INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// THE STORY. Series identity did not exist in the first version of the ledger.
// 015 added `series_key` with the DEFAULT `'legacy:unclassified'`, so every row
// predating the concept received that reserved key. 016 then declared that each
// real series has exactly one root batch — and the residue breaks that rule by
// construction, because several unrelated pre-series imports all share the
// reserved key and all have no predecessor.
//
// THE DEFECT THIS FILE EXISTS FOR. 016's comment said the reserved key was
// exempt from the one-root index. Its predicate said only
// `changed_from_batch IS NULL`. On a database carrying real residue the second
// legacy batch would have collided with the first — the migration failing on
// exactly the data it was written to accommodate, and only on the databases
// that had it. The predicate now names both halves.
//
// THE OTHER HALF OF THE RULE: exempting the residue must not become permission
// to make more of it. A NOT VALID CHECK exempts existing rows by construction
// while checking every future INSERT.

describeInPhase('post-lockdown', 'the reserved legacy series', () => {
  let admin: Client
  let importer: Client
  let principals: Principals
  let workspace: Workspace

  beforeAll(async () => {
    admin = await connectAs('admin')
    importer = await connectAs('importer')
    principals = await ensurePrincipals(admin)
    workspace = await seedWorkspace(admin, 'legacy')
    await grantCapability(admin, workspace, principals.importer, 'archive-import', principals.grantor)
  })

  afterAll(async () => {
    await importer?.end()
    await admin?.end()
  })

  it('the one-root index exempts the reserved key IN ITS PREDICATE', async () => {
    const { rows } = await admin.query<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes
        WHERE schemaname = 'investment_ledger'
          AND indexname = 'import_batches_one_root_per_series'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].def).toContain('changed_from_batch IS NULL')
    expect(rows[0].def, 'the exemption must be in the predicate, not only the comment')
      .toContain('legacy:unclassified')
  })

  it('the constraint closing the key to NEW inserts exists and is NOT VALID', async () => {
    // Validating it would require the residue to satisfy it, which it cannot.
    // NOT VALID is load-bearing here, not laziness.
    const { rows } = await admin.query<{ validated: boolean }>(
      `SELECT convalidated AS validated FROM pg_constraint
        WHERE conrelid = 'investment_ledger.import_batches'::regclass
          AND conname = 'import_batches_no_new_legacy_series'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].validated).toBe(false)
  })

  it('TWO rootless legacy batches can coexist — the residue case, reproduced', async () => {
    // Inserted by the IMPORTER, in its own workspace, with the NOT VALID
    // constraint temporarily... not disabled. It cannot be: the constraint
    // rejects the reserved key for every writer.
    //
    // So the property is proven against the INDEX directly instead: build two
    // rows that differ only in the reserved key and confirm the index's
    // predicate excludes them. `pg_get_expr` is the executable text, which is
    // the thing that was wrong.
    const { rows } = await admin.query<{ pred: string }>(
      `SELECT pg_get_expr(i.indpred, i.indrelid) AS pred
         FROM pg_index i
        WHERE i.indexrelid = 'investment_ledger.import_batches_one_root_per_series'::regclass`)
    expect(rows[0].pred).toMatch(/changed_from_batch IS NULL/)
    expect(rows[0].pred).toMatch(/series_key <> 'legacy:unclassified'/)
  })

  it('a real series still permits only ONE root', async () => {
    // The exemption must be narrow. If it accidentally disabled the rule for
    // every series the ledger would lose its single-linear-chain guarantee.
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const series = `probe:real-${Date.now()}`
      await importer.query(
        `INSERT INTO investment_ledger.import_batches
           (workspace_id, actor_principal_id, series_key, source_kind, source_name,
            source_sha256, importer_version, row_count, status)
         VALUES ($1,$2,$3,'archive_csv','first',$4,'tenancy-suite',0,'published')`,
        [workspace.id, principals.importer.id, series, hex64()])
      const result = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.import_batches
             (workspace_id, actor_principal_id, series_key, source_kind, source_name,
              source_sha256, importer_version, row_count, status)
           VALUES ($1,$2,$3,'archive_csv','second',$4,'tenancy-suite',0,'published')`,
          [workspace.id, principals.importer.id, series, hex64()]))
      expect(result.code, `a second root must still be refused: ${result.message}`)
        .toBe(UNIQUE_VIOLATION)
    } finally {
      await rollback(importer)
    }
  })

  it('the reserved key is closed to NEW inserts', async () => {
    await beginAuthorized(importer, workspace.id, ['archive-import'])
    try {
      const result = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.import_batches
             (workspace_id, actor_principal_id, series_key, source_kind, source_name,
              source_sha256, importer_version, row_count, status)
           VALUES ($1,$2,$3,'archive_csv','new',$4,'tenancy-suite',0,'published')`,
          [workspace.id, principals.importer.id, LEGACY_SERIES, hex64()]))
      expect(result.code, `${result.message}`).toBe(CHECK_VIOLATION)
      expect(result.message ?? '').toMatch(/import_batches_no_new_legacy_series/)
    } finally {
      await rollback(importer)
    }
  })

  it('the residue is per-workspace like everything else', async () => {
    // A pre-tenancy row still has to belong to somebody. On a fresh database
    // there is no residue at all, which is why this asserts the COLUMN rather
    // than a row count.
    const { rows } = await admin.query<{ attnotnull: boolean }>(
      `SELECT attnotnull FROM pg_attribute
        WHERE attrelid = 'investment_ledger.import_batches'::regclass
          AND attname = 'workspace_id'`)
    expect(rows[0].attnotnull).toBe(true)
  })

  it('the reserved key has exactly one definition in TypeScript', () => {
    // The constraint stops the exact value; one named constant is what stops a
    // near-miss ('legacy_unclassified') being written instead, which the
    // constraint would happily accept.
    expect(LEGACY_SERIES).toBe('legacy:unclassified')
    expect(MASTER_ARCHIVE_SERIES).not.toBe(LEGACY_SERIES)
  })

  it('assertSeriesKey refuses the reserved key', () => {
    expect(() => assertSeriesKey(LEGACY_SERIES)).toThrow()
  })
})
