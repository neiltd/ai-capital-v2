// The schema contract against LIVE PostgreSQL 17, on disposable clusters.
//
// One cluster hosts a V19 database that every drift test mutates and reverts; a
// second, independently built cluster is what makes "two V19 databases agree" a
// cross-database claim rather than a restatement of determinism.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import { extractContract, ARTIFACT_PATH, describeDrift } from '../../bin/pg-copy-contract.js'
import { CURRENT_V19_MANIFEST } from '../../src/inventory-queries.js'
import {
  parseArtifact, serializeArtifact, assertNoRawOids, canonicalJson,
} from '../../src/pg-copy/schema-contract.js'
import {
  startDisposableCluster, stopAllDisposableClusters, type DisposableCluster,
} from '../../testing/disposable-cluster.js'
import { buildV19Database } from '../../testing/v19-database.js'

const DB = 'expected_target_v19'

let A: DisposableCluster

beforeAll(async () => {
  A = await startDisposableCluster()
  await buildV19Database(A, DB)
}, 600_000)

afterAll(async () => { await stopAllDisposableClusters() })

/** Apply SQL, extract, revert — the contract must move and then come back. */
async function drift(mutate: string, revert: string): Promise<{ before: string; after: string }> {
  const before = (await extractContract(A, DB)).digest
  await A.sql(mutate, DB)
  try {
    const after = (await extractContract(A, DB)).digest
    return { before, after }
  } finally {
    await A.sql(revert, DB)
  }
}

/** Apply SQL, expect extraction to REFUSE, revert. */
async function refuses(mutate: string, revert: string, re: RegExp): Promise<void> {
  await A.sql(mutate, DB)
  try {
    await expect(extractContract(A, DB)).rejects.toThrow(re)
  } finally {
    await A.sql(revert, DB)
  }
}

describe('a clean V19 database', () => {
  it('matches the committed expected-target artifact byte for byte', async () => {
    const fresh = await extractContract(A, DB)
    const committed = parseArtifact(readFileSync(ARTIFACT_PATH, 'utf-8'))
    expect(fresh.digest).toBe(committed.digest)
    expect(serializeArtifact(fresh)).toBe(readFileSync(ARTIFACT_PATH, 'utf-8'))
    expect(describeDrift(committed, fresh)).toEqual(['  (no difference)'])
  }, 300_000)

  it('is byte-reproducible when extracted twice', async () => {
    const a = serializeArtifact(await extractContract(A, DB))
    const b = serializeArtifact(await extractContract(A, DB))
    expect(a).toBe(b)
  }, 300_000)

  it('is identical on a cluster initdb-ed under a different host timezone', async () => {
    // THE HOST-INDEPENDENCE CLAIM. initdb guesses `timezone` from the
    // environment, so this cluster's own default is Asia/Bangkok. If the
    // expected target inherited the host, the digest would differ here.
    const TZ = await startDisposableCluster({ tz: 'Asia/Bangkok' })
    try {
      const clusterDefault = (await TZ.rows(`SHOW timezone`))[0][0]
      expect(clusterDefault).toBe('Asia/Bangkok')
      await buildV19Database(TZ, DB)
      const here = await extractContract(TZ, DB)
      const committed = parseArtifact(readFileSync(ARTIFACT_PATH, 'utf-8'))
      expect(describeDrift(committed, here)).toEqual(['  (no difference)'])
      expect(here.digest).toBe(committed.digest)
      const platform = here.payload as unknown as { platform: { timezone: string } }
      expect(platform.platform.timezone).toBe('America/Los_Angeles')
    } finally {
      await TZ.stop()
    }
  }, 600_000)

  it('agrees with a SECOND, independently built V19 database', async () => {
    const B = await startDisposableCluster()
    try {
      await buildV19Database(B, DB)
      const a = await extractContract(A, DB)
      const b = await extractContract(B, DB)
      expect(b.digest).toBe(a.digest)
      expect(serializeArtifact(b)).toBe(serializeArtifact(a))
    } finally {
      await B.stop()
    }
  }, 600_000)

  it('carries 21 tables, 3 sequences and no raw catalogue OID', async () => {
    const a = await extractContract(A, DB)
    const p = a.payload as Record<string, unknown>
    expect((p.tables as unknown[]).length).toBe(21)
    expect((p.sequences as unknown[]).length).toBe(3)
    expect(() => assertNoRawOids(a)).not.toThrow()
    expect(canonicalJson(a.payload)).not.toMatch(/\/Users\/|\/tmp\/|pgcopy-/)
  }, 300_000)
})

describe('a hostile search_path cannot redirect catalog resolution', () => {
  it('ignores shadow catalog relations and functions', async () => {
    const before = (await extractContract(A, DB)).digest
    await A.sql(`
      CREATE SCHEMA evil;
      CREATE TABLE evil.pg_class (oid oid, relname name, relnamespace oid, relkind "char",
                                  relpersistence "char", relowner oid,
                                  relrowsecurity boolean, relforcerowsecurity boolean);
      CREATE FUNCTION evil.format_type(oid, integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'shadowed' $$;
      CREATE FUNCTION evil.pg_get_userbyid(oid) RETURNS name LANGUAGE sql IMMUTABLE AS $$ SELECT 'evil'::name $$;
      CREATE FUNCTION evil.pg_get_constraintdef(oid, boolean) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'shadowed' $$;
      ALTER DATABASE ${DB} SET search_path = evil, public, pg_catalog;
    `, DB)
    try {
      const path = await A.rows(`SHOW search_path`, DB)
      expect(path[0][0]).toContain('evil')
      const proof = await A.rows(`SELECT format_type(0::oid, 0)`, DB)
      expect(proof[0][0]).toBe('shadowed')
      expect((await extractContract(A, DB)).digest).toBe(before)
    } finally {
      await A.sql(`ALTER DATABASE ${DB} RESET search_path; DROP SCHEMA evil CASCADE;`, DB)
    }
  }, 300_000)
})

describe('drift is detected', () => {
  it('a column default appearing or changing', async () => {
    const add = await drift(
      `ALTER TABLE capital.watchlist ALTER COLUMN cik SET DEFAULT 'x'`,
      `ALTER TABLE capital.watchlist ALTER COLUMN cik DROP DEFAULT`)
    expect(add.after).not.toBe(add.before)
    const change = await drift(
      `ALTER TABLE portfolio.positions ALTER COLUMN current_price SET DEFAULT 1`,
      `ALTER TABLE portfolio.positions ALTER COLUMN current_price SET DEFAULT 0`)
    expect(change.after).not.toBe(change.before)
  }, 300_000)

  it('a sequence option', async () => {
    const d = await drift(
      `ALTER SEQUENCE briefing.qa_id_seq INCREMENT BY 2`,
      `ALTER SEQUENCE briefing.qa_id_seq INCREMENT BY 1`)
    expect(d.after).not.toBe(d.before)
    const c = await drift(
      `ALTER SEQUENCE briefing.qa_id_seq CACHE 5`,
      `ALTER SEQUENCE briefing.qa_id_seq CACHE 1`)
    expect(c.after).not.toBe(c.before)
    const y = await drift(
      `ALTER SEQUENCE briefing.qa_id_seq CYCLE`,
      `ALTER SEQUENCE briefing.qa_id_seq NO CYCLE`)
    expect(y.after).not.toBe(y.before)
  }, 300_000)

  it('sequence-backed default linkage', async () => {
    const d = await drift(
      `ALTER TABLE portfolio.trade_log ALTER COLUMN id DROP DEFAULT`,
      `ALTER TABLE portfolio.trade_log ALTER COLUMN id SET DEFAULT nextval('portfolio.trade_log_id_seq'::regclass)`)
    expect(d.after).not.toBe(d.before)
  }, 300_000)

  it('a column added, renamed or retyped, and a dropped column counted', async () => {
    const add = await drift(
      `ALTER TABLE graph.nodes ADD COLUMN extra text`,
      `ALTER TABLE graph.nodes DROP COLUMN extra`)
    expect(add.after).not.toBe(add.before)
    const ren = await drift(
      `ALTER TABLE graph.nodes RENAME COLUMN company TO company2`,
      `ALTER TABLE graph.nodes RENAME COLUMN company2 TO company`)
    expect(ren.after).not.toBe(ren.before)
    // A dropped column leaves an attnum gap that the contract COUNTS. The
    // count is relative: the add/drop pair above already left one behind, and
    // asserting an absolute 1 would make this test depend on the order of its
    // own earlier statements.
    const priorArtifact = await extractContract(A, DB)
    const countOf = (a: Awaited<ReturnType<typeof extractContract>>): number =>
      (a.payload as { tables: { qname: string; dropped_column_count: number }[] })
        .tables.find(t => t.qname === 'graph.nodes')!.dropped_column_count
    const prior = countOf(priorArtifact)
    await A.sql(`ALTER TABLE graph.nodes ADD COLUMN tmp text`, DB)
    await A.sql(`ALTER TABLE graph.nodes DROP COLUMN tmp`, DB)
    const after = await extractContract(A, DB)
    expect(after.digest).not.toBe(priorArtifact.digest)
    expect(countOf(after)).toBe(prior + 1)
  }, 300_000)

  it('a PK, UNIQUE, CHECK, FK or index change', async () => {
    const chk = await drift(
      `ALTER TABLE graph.nodes ADD CONSTRAINT c_x CHECK (ticker <> '')`,
      `ALTER TABLE graph.nodes DROP CONSTRAINT c_x`)
    expect(chk.after).not.toBe(chk.before)
    const uq = await drift(
      `ALTER TABLE graph.nodes ADD CONSTRAINT u_x UNIQUE (company)`,
      `ALTER TABLE graph.nodes DROP CONSTRAINT u_x`)
    expect(uq.after).not.toBe(uq.before)
    const ix = await drift(
      `CREATE INDEX i_x ON graph.nodes (company)`,
      `DROP INDEX graph.i_x`)
    expect(ix.after).not.toBe(ix.before)
    const fk = await drift(
      `ALTER TABLE graph.edges ADD CONSTRAINT f_x FOREIGN KEY (from_ticker) REFERENCES graph.nodes(ticker)`,
      `ALTER TABLE graph.edges DROP CONSTRAINT f_x`)
    expect(fk.after).not.toBe(fk.before)
  }, 300_000)

  it('a collation identity change', async () => {
    const d = await drift(
      `ALTER TABLE graph.nodes ALTER COLUMN company TYPE text COLLATE "C"`,
      `ALTER TABLE graph.nodes ALTER COLUMN company TYPE text COLLATE "default"`)
    expect(d.after).not.toBe(d.before)
  }, 300_000)

  it('a table owner change', async () => {
    const d = await drift(
      `ALTER TABLE graph.nodes OWNER TO ai_capital_migrator`,
      `ALTER TABLE graph.nodes OWNER TO ai_capital_owner`)
    expect(d.after).not.toBe(d.before)
  }, 300_000)
})

describe('live refusals', () => {
  it('refuses a non-internal INSERT trigger, and tolerates the internal FK ones', async () => {
    // The clean V19 database already carries internal FK triggers.
    await expect(extractContract(A, DB)).resolves.toBeTruthy()
    await A.sql(`CREATE FUNCTION public.t_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`, DB)
    for (const spec of ['BEFORE INSERT ON graph.nodes FOR EACH ROW',
                        'AFTER INSERT ON graph.nodes FOR EACH ROW',
                        'AFTER INSERT ON graph.nodes FOR EACH STATEMENT']) {
      await refuses(
        `CREATE TRIGGER t_x ${spec} EXECUTE FUNCTION public.t_noop()`,
        `DROP TRIGGER t_x ON graph.nodes`,
        /fires for INSERT/)
    }
    // Disabled is still refused.
    await refuses(
      `CREATE TRIGGER t_x BEFORE INSERT ON graph.nodes FOR EACH ROW EXECUTE FUNCTION public.t_noop();
       ALTER TABLE graph.nodes DISABLE TRIGGER t_x;`,
      `DROP TRIGGER t_x ON graph.nodes`,
      /fires for INSERT/)
    // An UPDATE-only trigger is not an INSERT trigger.
    await A.sql(`CREATE TRIGGER t_u BEFORE UPDATE ON graph.nodes FOR EACH ROW EXECUTE FUNCTION public.t_noop()`, DB)
    try {
      await expect(extractContract(A, DB)).resolves.toBeTruthy()
    } finally {
      await A.sql(`DROP TRIGGER t_u ON graph.nodes; DROP FUNCTION public.t_noop();`, DB)
    }
  }, 300_000)

  it('refuses both row-security flags', async () => {
    await refuses(`ALTER TABLE graph.nodes ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE graph.nodes DISABLE ROW LEVEL SECURITY`, /relrowsecurity enabled/)
    await refuses(`ALTER TABLE graph.nodes FORCE ROW LEVEL SECURITY`,
      `ALTER TABLE graph.nodes NO FORCE ROW LEVEL SECURITY`, /relforcerowsecurity enabled/)
  }, 300_000)

  it('refuses an identity column and a stored generated column', async () => {
    await refuses(
      `ALTER TABLE graph.nodes ADD COLUMN n integer GENERATED BY DEFAULT AS IDENTITY`,
      `ALTER TABLE graph.nodes DROP COLUMN n`, /COMPATIBILITY POLICY/)
    await refuses(
      `ALTER TABLE graph.nodes ADD COLUMN g text GENERATED ALWAYS AS (ticker || 'x') STORED`,
      `ALTER TABLE graph.nodes DROP COLUMN g`, /stored generated column/)
  }, 300_000)

  it('refuses an unsupported type BEFORE any artifact is produced', async () => {
    await refuses(`ALTER TABLE graph.nodes ADD COLUMN f double precision`,
      `ALTER TABLE graph.nodes DROP COLUMN f`, /not in the reviewed set/)
    await refuses(`ALTER TABLE graph.nodes ADD COLUMN arr text[]`,
      `ALTER TABLE graph.nodes DROP COLUMN arr`, /not in the reviewed set/)
  }, 300_000)

  it('refuses a NOT VALID or DEFERRABLE foreign key', async () => {
    await refuses(
      `ALTER TABLE graph.edges ADD CONSTRAINT f_nv FOREIGN KEY (from_ticker) REFERENCES graph.nodes(ticker) NOT VALID`,
      `ALTER TABLE graph.edges DROP CONSTRAINT f_nv`, /NOT VALID/)
    await refuses(
      `ALTER TABLE graph.edges ADD CONSTRAINT f_df FOREIGN KEY (from_ticker) REFERENCES graph.nodes(ticker) DEFERRABLE`,
      `ALTER TABLE graph.edges DROP CONSTRAINT f_df`, /DEFERRABLE/)
  }, 300_000)

  it('refuses a missing required table', async () => {
    // A table OUTSIDE the 21 is out of scope by construction: the extraction
    // queries name the 21 explicitly, so an unrelated table in the same schema
    // is not read and cannot drift the contract. What must be caught is one of
    // the 21 going missing, which a rename produces without a destructive drop.
    await refuses(`ALTER TABLE graph.nodes RENAME TO nodes_gone`,
      `ALTER TABLE graph.nodes_gone RENAME TO nodes`, /required table graph.nodes is missing/)
  }, 300_000)

  it('refuses a 19-row ledger whose hashes are wrong', async () => {
    // THE CASE A COUNT CANNOT SEE. Nineteen rows, all nineteen filenames
    // correct, every SHA-256 replaced. Recognition must fail on the hashes.
    const restoreAll = CURRENT_V19_MANIFEST
      .map(m => `UPDATE db.schema_migrations SET sha256 = '${m.sha256}' WHERE filename = '${m.filename}';`)
      .join('\n')
    await refuses(
      `UPDATE db.schema_migrations SET sha256 = repeat('0', 64)`,
      restoreAll,
      /hash-mismatched \[/)
    const one = CURRENT_V19_MANIFEST[CURRENT_V19_MANIFEST.length - 1]
    await refuses(
      `UPDATE db.schema_migrations SET sha256 = repeat('a', 64) WHERE filename = '${one.filename}'`,
      `UPDATE db.schema_migrations SET sha256 = '${one.sha256}' WHERE filename = '${one.filename}'`,
      new RegExp(`hash-mismatched \\[${one.filename.replace('.', '\\.')}\\]`))
  }, 300_000)

  it('refuses a missing, renamed or extra ledger row', async () => {
    const m = CURRENT_V19_MANIFEST[CURRENT_V19_MANIFEST.length - 1]
    const reinsert = `INSERT INTO db.schema_migrations (filename, sha256, applied_at)
         VALUES ('${m.filename}', '${m.sha256}', now())`
    await refuses(
      `DELETE FROM db.schema_migrations WHERE filename = '${m.filename}'`,
      reinsert, /missing \[/)
    // A rename keeps the count at 19 and still must not be recognised.
    await refuses(
      `UPDATE db.schema_migrations SET filename = '${m.filename}.bak' WHERE filename = '${m.filename}'`,
      `UPDATE db.schema_migrations SET filename = '${m.filename}' WHERE filename = '${m.filename}.bak'`,
      /missing \[/)
    await refuses(
      `INSERT INTO db.schema_migrations (filename, sha256, applied_at)
         VALUES ('999_rogue.sql', repeat('0', 64), now())`,
      `DELETE FROM db.schema_migrations WHERE filename = '999_rogue.sql'`,
      /unexpected \[999_rogue\.sql\]/)
  }, 300_000)

  it('carries the ordered ledger and its digest, not just a count', async () => {
    const c = await extractContract(A, DB)
    const p = c.payload as unknown as {
      migrations: { count: number; ledger: { filename: string; sha256: string }[]; ledger_digest: string }
    }
    expect(p.migrations.count).toBe(19)
    expect(p.migrations.ledger.map(r => r.filename))
      .toEqual([...CURRENT_V19_MANIFEST].map(x => x.filename).sort())
    for (const m of CURRENT_V19_MANIFEST) {
      expect(p.migrations.ledger.find(r => r.filename === m.filename)?.sha256).toBe(m.sha256)
    }
    expect(p.migrations.ledger_digest).toMatch(/^[0-9a-f]{64}$/)
  }, 300_000)

  it('refuses a collation whose recorded version disagrees with the provider', async () => {
    // pg_collation.collversion is what was recorded when the collation was
    // created; pg_collation_actual_version() is what the provider reports now.
    // Forcing them apart is the only way to simulate an OS collation upgrade
    // offline. On a libc provider without versioning both are NULL, which is
    // NOT drift - so the mutant sets a version where the provider reports none.
    const target = `SELECT DISTINCT a.attcollation::pg_catalog.text
                      FROM pg_catalog.pg_attribute a
                     WHERE a.attcollation <> 0
                       AND a.attrelid = 'capital.chunks'::pg_catalog.regclass`
    const oids = (await A.rows(target, DB)).map(r => r[0])
    // NON-VACUITY: if capital.chunks had no collated column the mutation below
    // would change nothing and the test would pass by doing nothing.
    expect(oids.length).toBeGreaterThan(0)

    await refuses(
      `UPDATE pg_catalog.pg_collation SET collversion = 'bogus.0'
         WHERE oid IN (${oids.join(', ')})`,
      `UPDATE pg_catalog.pg_collation
          SET collversion = pg_catalog.pg_collation_actual_version(oid)
        WHERE oid IN (${oids.join(', ')})`,
      /collation .* (records version "bogus\.0"|records NO version)/)
  }, 300_000)

  it('records both collation versions for every collated column', async () => {
    const c = await extractContract(A, DB)
    const p = c.payload as unknown as {
      tables: { qname: string; columns: { name: string; collation: null | Record<string, unknown> }[] }[]
    }
    const collated = p.tables.flatMap(t => t.columns).filter(col => col.collation !== null)
    expect(collated.length).toBeGreaterThan(0)
    for (const col of collated) {
      expect(col.collation).toHaveProperty('version')
      expect(col.collation).toHaveProperty('actual_version')
    }
  }, 300_000)

  it('extracts a real identity sequence, with options and linkage, before refusing', async () => {
    // A LIVE fixture, so the pg_depend join and pg_sequences options are proved
    // against PostgreSQL rather than against a hand-written row.
    await A.sql(`ALTER TABLE graph.nodes ADD COLUMN surrogate bigint
                   GENERATED ALWAYS AS IDENTITY (START WITH 7 INCREMENT BY 3 CACHE 11 CYCLE)`, DB)
    try {
      let message = ''
      try { await extractContract(A, DB) } catch (e) { message = (e as Error).message }
      expect(message).toMatch(/graph\.nodes\.surrogate is an identity column/)
      // The options and the dependency, read from the catalogue - not a name
      // returned by pg_get_serial_sequence.
      expect(message).toMatch(/graph\.nodes_surrogate_seq/)
      expect(message).toMatch(/data_type=bigint/)
      expect(message).toMatch(/start=7 increment=3/)
      expect(message).toMatch(/cache=11 cycle=true/)
      expect(message).toMatch(/linkage=pg_depend\(deptype=i,refobjsubid=\d+\)/)
      // And the policy statement is still what it was.
      expect(message).toMatch(/COMPATIBILITY POLICY, not a claim that COPY cannot accept identity/)
    } finally {
      // The drop leaves an attisdropped gap, which the contract deliberately
      // counts, so this database is no longer byte-identical to the committed
      // artifact afterwards. That is the same trade the ADD COLUMN / DROP COLUMN
      // mutants above already make: the clean-state comparison is the FIRST
      // describe in this file and runs before any of them.
      await A.sql(`ALTER TABLE graph.nodes DROP COLUMN surrogate`, DB)
    }
  }, 300_000)

  it('refuses an unreviewed extension', async () => {
    await refuses(`CREATE EXTENSION IF NOT EXISTS pg_trgm`,
      `DROP EXTENSION pg_trgm`, /is not in the reviewed set/)
  }, 300_000)
})

describe('the committed artifact is the thing that fails the build', () => {
  it('a drifted committed artifact is detected, and a bad digest is refused', () => {
    const text = readFileSync(ARTIFACT_PATH, 'utf-8')
    const a = parseArtifact(text)
    const tampered = JSON.parse(text) as { payload: { migrations: { count: number } }; digest: string }
    tampered.payload.migrations.count = 18
    // The digest no longer matches its payload: refused before any comparison.
    expect(() => parseArtifact(`${JSON.stringify(tampered, null, 2)}\n`))
      .toThrow(/does not match its payload/)
    // And a re-digested tamper still differs from the live contract.
    expect(a.digest).not.toBe('0'.repeat(64))
  })
})
