// The schema contract — slice 2 of the PostgreSQL→PostgreSQL copy.
//
// WHAT IT IS. A deterministic, OID-independent description of exactly the 21
// tables the copy moves, their columns, constraints, indexes and sequences, and
// the platform facts that make those descriptions comparable at all. It is
// generated from a live catalogue and compared against a COMMITTED artifact, so
// "the target is the target we reviewed" becomes a byte comparison rather than
// a belief.
//
// WHY IT REFUSES RATHER THAN RECORDS, IN SOME CASES. `COPY ... FROM` is not a
// bulk bypass. It fires row-level and statement-level INSERT triggers, enforces
// CHECK, NOT NULL and foreign-key constraints, and is NOT SUPPORTED AT ALL on a
// table with row-level security enabled. A source with RLS is worse still:
// `COPY ... TO` applies the relevant SELECT policies, so it would silently
// export a filtered subset and the digest would faithfully attest to the subset.
// So the refusals below are not belt-and-braces; each one names a way the copy
// could otherwise land values the source never held, or miss values it did.
//
// WHAT IS RECORDED BUT NOT REFUSED. Extra non-identity indexes and extra
// VALIDATED, NON-DEFERRABLE foreign keys on the target: an index cannot change a
// stored value, and a validated immediate FK constrains without transforming. A
// NOT VALID or DEFERRABLE foreign key IS refused - the first would admit rows
// the constraint claims to forbid, and the second moves the violation to COMMIT,
// turning a clean in-transaction failure into the indeterminate case.
//
// IDENTITY IS RESOLVED, NEVER NAMED. Every OID is resolved to a stable
// qualified name, every catalogue function and cast is schema-qualified, and
// `search_path` is pinned to `pg_catalog` for the extraction session, so nothing
// a source can create changes what the contract reads.

import { createHash } from 'node:crypto'

import { recognizeManifest } from '../inventory-facts.js'
import { CURRENT_V19_MANIFEST, type ManifestEntry } from '../inventory-queries.js'

/**
 * Bumped when the contract's shape or digest domain changes.
 *
 * 1 -> 2: the migration ledger replaced a bare row count; collation records both
 * the catalogue version and the provider's ACTUAL version; columns carry a
 * nullable identity-sequence structure. All three change the payload shape, so a
 * v1 artifact must not be comparable with a v2 extraction.
 */
export const SCHEMA_CONTRACT_VERSION = 2

/**
 * Settings the reviewed V3 target FIXES, and which the expected-target database
 * must therefore establish explicitly.
 *
 * WHY THEY ARE CENTRALISED HERE AND SET BY THE BUILDER, NOT BY THE EXTRACTOR.
 * `initdb` derives `TimeZone` from the host, so the first version of this
 * contract recorded `America/Los_Angeles` because that is where it happened to
 * be generated - the artifact was a fact about one machine. Setting them on the
 * expected-target DATABASE makes generation host-independent. Setting them
 * inside extraction would instead make the extractor blind to the drift it
 * exists to catch, because it would be reading back its own assignment.
 */
export const REVIEWED_TARGET_SETTINGS: Readonly<Record<string, string>> = Object.freeze({
  TimeZone: 'America/Los_Angeles',
  default_text_search_config: 'pg_catalog.english',
})

/** The reviewed copy set, in the order the copy uses (parents before children). */
export const COPY_TABLES: readonly string[] = Object.freeze([
  'portfolio.positions',
  'portfolio.trade_log',
  'capital.watchlist',
  'capital.documents',
  'capital.fetch_log',
  'capital.short_interest',
  'capital.api_budget',
  'capital.pending_manual_input',
  'capital.chunks',
  'thesis.theses',
  'thesis.assumptions',
  'thesis.narratives',
  'thesis.proposals',
  'thesis.proposal_changes',
  'thesis.theme_memberships',
  'briefing.predictions',
  'briefing.qa',
  'graph.nodes',
  'graph.edges',
  'graph.proposals',
  'graph.proposal_edges',
])

/** The three generated sequences behind the three serial columns. */
export const COPY_SEQUENCES: readonly string[] = Object.freeze([
  'portfolio.trade_log_id_seq',
  'capital.fetch_log_id_seq',
  'briefing.qa_id_seq',
])

/** The migration set a V19 target must recognise, exactly. */
export const EXPECTED_MIGRATION_COUNT = 19
export const EXPECTED_MIGRATION_RECOGNITION = 'CURRENT_V19'

/**
 * The reviewed production SOURCE ledger: CURRENT_V10, exactly these ten.
 *
 * WHY THE SOURCE NEEDS ITS OWN PROFILE. The source is not a V19 database and
 * never was. An extractor that recognises only V19 cannot describe it at all -
 * it refuses at the ledger before it reads a single column - so Stage 1 and
 * Stage 2 would have nothing to derive a manifest from.
 *
 * RECOGNITION IS THE ORDERED FILENAME/HASH LEDGER, NEVER A COUNT OR A PREFIX.
 * Ten rows is not CURRENT_V10; these ten filenames carrying these ten SHA-256s
 * is. A count would accept ten of anything, and a prefix would accept a
 * half-applied eleventh.
 *
 * AUTHORITY, recorded because a hash list is unreadable without it: a
 * privileged read-only audit proved production's ten recorded hashes match
 * repository migrations 001-010; D5.0.1 independently established that 5432 is
 * CURRENT_V10; and Git proves these ten files are byte-identical from
 * f19911cd684d7e7369cc81c40a54eedf73c9ad9e through HEAD.
 */
export const CURRENT_V10_MANIFEST: readonly ManifestEntry[] = Object.freeze([
  { filename: '001_portfolio.sql', sha256: '326fe2c3d266f62a6a3f1525ec95b0489906bd44aec7c5628e026d049626b13d' },
  { filename: '002_capital.sql', sha256: 'a41f43c8f3784dcc4c40b4de5d0da029c884517a8e9444bc41e1f8abeae46ec1' },
  { filename: '003_thesis.sql', sha256: 'e5dae3cc3c9952190a3fb8e8008a8f27997a3695dd2fd1413e32cce55087befa' },
  { filename: '004_briefing.sql', sha256: '8bd054743d2028ae9ef7e4492b8b9b9ebe009825327489bce0e927c9c5ed5d36' },
  { filename: '005_graph.sql', sha256: '45d6f496fc24f21e7b9eb8cc76dbde439504cc4a350cb6cc38811be262073686' },
  { filename: '006_vectors.sql', sha256: '948c04ee131362647b07bfe6313ca59a8f15c3d24b29cdd7f8013ffe9c6916cb' },
  { filename: '007_trade.sql', sha256: '9f387f8016f1d8362ce3e8858a0aa8e468492d935357604e8c5a7ccd7277e2d3' },
  { filename: '008_desk.sql', sha256: '70b1d380f6163bde19bf4e9896f7f5e54c5df861c3c760b82092f9db53e78db4' },
  { filename: '009_claim_governance.sql', sha256: '3f8dfef4e9e1a3ba0a75121f3b4f58be4669c057681a7dcb275cf8488f9852eb' },
  { filename: '010_correct_claim_history.sql', sha256: '52a23fe5e60c350c9c9cac4a7c5c081ac19ceb01095f6c5593a2c673b010f38f' },
])

/**
 * WHICH database a contract is being extracted from, and what it must be.
 *
 * The two profiles are checked INDEPENDENTLY and are never compared with each
 * other: a V10 source and a V19 target are supposed to have different ledgers,
 * and requiring them to match would refuse every legitimate copy.
 */
/** The extensions the reviewed V19 target carries, exactly. */
export const REVIEWED_EXTENSIONS: readonly string[] = Object.freeze(['btree_gist', 'plpgsql', 'vector'])

/**
 * WHICH extensions a profile demands, and whether anything else is tolerated.
 *
 * THE TWO SIDES ARE NOT THE SAME QUESTION. The reviewed TARGET is a database
 * this project builds, so its extension set is exactly what was reviewed and
 * anything else is a contract change. The SOURCE is a database that already
 * exists and was not built to this contract: it must carry what the copy
 * depends on and it is none of the copy's business what else is installed
 * beside it. Requiring the source to carry `btree_gist` - which no migration
 * 001-010 installs, and which only the target's bootstrap adds - would refuse
 * every real source there is.
 *
 * WHAT STILL CONSTRAINS THE SOURCE. Tolerating an unrelated extension is not
 * tolerating an unrelated TYPE: `assertSupportedColumns` still refuses any
 * column outside the reviewed built-in set and the one reviewed extension
 * type, and C1 still requires the two sides' `vector` versions to be equal.
 * So an extra extension can exist; it cannot reach a copied column.
 */
export interface ExtensionPolicy {
  /** Must be installed. Refused if absent. */
  readonly required: readonly string[]
  /** true: anything outside `required` is refused. false: extras are ignored. */
  readonly exact: boolean
}

export interface MigrationProfile {
  readonly recognition: string
  readonly manifest: readonly ManifestEntry[]
  readonly extensions: ExtensionPolicy
}

export const TARGET_V19_PROFILE: MigrationProfile = Object.freeze({
  recognition: EXPECTED_MIGRATION_RECOGNITION,
  manifest: CURRENT_V19_MANIFEST,
  extensions: Object.freeze({ required: REVIEWED_EXTENSIONS, exact: true }),
})

/** The source needs `plpgsql` and `vector`. It does NOT need `btree_gist`. */
export const SOURCE_REQUIRED_EXTENSIONS: readonly string[] =
  Object.freeze(['plpgsql', 'vector'])

export const SOURCE_V10_PROFILE: MigrationProfile = Object.freeze({
  recognition: 'CURRENT_V10',
  manifest: CURRENT_V10_MANIFEST,
  extensions: Object.freeze({ required: SOURCE_REQUIRED_EXTENSIONS, exact: false }),
})

/** A refusal: the schema is not one this contract is willing to describe. */
export class ContractRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContractRefused'
  }
}

// ---------------------------------------------------------------------------
// CANONICAL SERIALISATION
// ---------------------------------------------------------------------------

export type Canonical =
  | string | number | boolean | null
  | readonly Canonical[]
  | { readonly [k: string]: Canonical }

/**
 * Deterministic JSON: object keys sorted, no incidental whitespace.
 *
 * The committed artifact is written pretty-printed for review, but the DIGEST
 * is taken over this form, so a reformatting cannot change the digest and a
 * value change cannot hide behind formatting.
 */
export function canonicalJson(value: Canonical): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const o = value as { readonly [k: string]: Canonical }
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex')
}

// ---------------------------------------------------------------------------
// EXTRACTION SQL — every OID resolved, every helper qualified
// ---------------------------------------------------------------------------
//
// The extraction session sets `search_path = pg_catalog` (see CONTRACT_PRELUDE),
// so even an unqualified reference could not reach a schema a source created.
// The statements qualify everything anyway: pinning and qualifying are two
// independent guards, and a mutant that removes one is caught by the other.

export const CONTRACT_PRELUDE = 'SET search_path = pg_catalog;'

export const PLATFORM_SQL = `
SELECT pg_catalog.current_setting('server_version_num')            AS server_version_num,
       pg_catalog.pg_encoding_to_char(d.encoding)                  AS encoding,
       d.datcollate                                                AS lc_collate,
       d.datctype                                                  AS lc_ctype,
       pg_catalog.current_setting('TimeZone')                      AS timezone,
       pg_catalog.current_setting('default_text_search_config')    AS default_text_search_config
  FROM pg_catalog.pg_database d
 WHERE d.datname = pg_catalog.current_database()`

export const EXTENSIONS_SQL = `
SELECT e.extname, e.extversion, n.nspname
  FROM pg_catalog.pg_extension e
  JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
 ORDER BY e.extname`

/**
 * The migration LEDGER, not a count.
 *
 * A count of 19 says nothing about WHICH nineteen. Recognition is delegated to
 * `recognizeManifest` and `CURRENT_V19_MANIFEST` - the same published list and
 * the same comparison the inventory uses - so exactly one place in this
 * repository knows what V19 means.
 */
export const MIGRATIONS_SQL = `
SELECT m.filename, m.sha256 FROM db.schema_migrations m ORDER BY m.filename`

export const RELATIONS_SQL = `
SELECT n.nspname, c.relname,
       c.relkind::pg_catalog.text, c.relpersistence::pg_catalog.text,
       pg_catalog.pg_get_userbyid(c.relowner),
       c.relrowsecurity::pg_catalog.text, c.relforcerowsecurity::pg_catalog.text
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname || '.' || c.relname = ANY ($1)
 ORDER BY n.nspname, c.relname`

/**
 * Columns in physical `attnum` order, with every identity resolved.
 *
 * Dropped columns are excluded from the list but COUNTED, because the copy
 * transports an explicit live-column list and is unaffected by the attnum gap,
 * while a reviewer still needs to see that a gap exists.
 */
export const COLUMNS_SQL = `
SELECT n.nspname || '.' || c.relname                              AS qname,
       a.attnum::pg_catalog.text                                  AS attnum,
       a.attname                                                  AS name,
       pg_catalog.format_type(a.atttypid, a.atttypmod)            AS format_type,
       tn.nspname                                                 AS type_schema,
       t.typname                                                  AS type_name,
       t.typtype::pg_catalog.text                                 AS typtype,
       t.typcategory::pg_catalog.text                             AS typcategory,
       a.atttypmod::pg_catalog.text                               AS typmod,
       te.extname                                                 AS type_extension,
       te.extversion                                              AS type_extension_version,
       a.attnotnull::pg_catalog.text                              AS notnull,
       a.atthasdef::pg_catalog.text                               AS hasdefault,
       pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)               AS default_expr,
       a.attidentity::pg_catalog.text                             AS identity,
       a.attgenerated::pg_catalog.text                            AS generated,
       pg_catalog.pg_get_serial_sequence(pg_catalog.quote_ident(n.nspname) || '.' ||
                                         pg_catalog.quote_ident(c.relname), a.attname) AS serial_sequence,
       coll_n.nspname                                             AS collation_schema,
       coll.collname                                              AS collation_name,
       coll.collprovider::pg_catalog.text                         AS collation_provider,
       coll.collisdeterministic::pg_catalog.text                  AS collation_deterministic,
       coll.collencoding::pg_catalog.text                         AS collation_encoding,
       coll.collcollate                                           AS collation_collate,
       coll.collctype                                             AS collation_ctype,
       coll.colllocale                                            AS collation_locale,
       coll.collicurules                                          AS collation_icu_rules,
       coll.collversion                                           AS collation_version,
       pg_catalog.pg_collation_actual_version(coll.oid)           AS collation_actual_version,
       idseq.qname                                                AS identity_sequence,
       idseq.data_type                                            AS identity_seq_data_type,
       idseq.start_value                                          AS identity_seq_start,
       idseq.increment_by                                         AS identity_seq_increment,
       idseq.min_value                                            AS identity_seq_min,
       idseq.max_value                                            AS identity_seq_max,
       idseq.cache_size                                           AS identity_seq_cache,
       idseq.cycle                                                AS identity_seq_cycle,
       idseq.linkage                                              AS identity_seq_linkage
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c      ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n  ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_type t       ON t.oid = a.atttypid
  JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
  LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  LEFT JOIN pg_catalog.pg_depend dt ON dt.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
                                   AND dt.objid = t.oid AND dt.deptype = 'e'
  LEFT JOIN pg_catalog.pg_extension te ON te.oid = dt.refobjid
  LEFT JOIN pg_catalog.pg_collation coll  ON coll.oid = a.attcollation AND a.attcollation <> 0
  LEFT JOIN pg_catalog.pg_namespace coll_n ON coll_n.oid = coll.collnamespace
  -- The identity sequence, reached through pg_depend rather than only through
  -- pg_get_serial_sequence: the dependency IS the linkage, and a name-returning
  -- helper cannot show why the two objects are connected or what the sequence's
  -- options are.
  --
  -- STATIC CATALOGUE ONLY. An earlier revision joined pg_catalog.pg_sequences,
  -- whose target list calls pg_sequence_last_value(). That function takes the
  -- same RowExclusiveLock nextval() does, so the view cannot be read while the
  -- source fence is held - and the fence is exactly when this contract must be
  -- taken. pg_catalog.pg_sequence carries every field below as static
  -- definition and takes no such lock.
  LEFT JOIN LATERAL (
    SELECT sn.nspname || '.' || sq.relname             AS qname,
           pg_catalog.format_type(s.seqtypid, NULL)    AS data_type,
           s.seqstart::pg_catalog.text                 AS start_value,
           s.seqincrement::pg_catalog.text             AS increment_by,
           s.seqmin::pg_catalog.text                   AS min_value,
           s.seqmax::pg_catalog.text                   AS max_value,
           s.seqcache::pg_catalog.text                 AS cache_size,
           s.seqcycle::pg_catalog.text                 AS cycle,
           'pg_depend(deptype=' || dep.deptype::pg_catalog.text || ',refobjsubid=' ||
             dep.refobjsubid::pg_catalog.text || ')'   AS linkage
      FROM pg_catalog.pg_depend dep
      JOIN pg_catalog.pg_class sq     ON sq.oid = dep.objid AND sq.relkind = 'S'
      JOIN pg_catalog.pg_namespace sn ON sn.oid = sq.relnamespace
      JOIN pg_catalog.pg_sequence s   ON s.seqrelid = sq.oid
     WHERE dep.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
       AND dep.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
       AND dep.refobjid = a.attrelid
       AND dep.refobjsubid = a.attnum
       AND dep.deptype = 'i'
     ORDER BY 1
     LIMIT 1
  ) idseq ON true
 WHERE n.nspname || '.' || c.relname = ANY ($1)
   AND a.attnum > 0 AND NOT a.attisdropped
 ORDER BY n.nspname, c.relname, a.attnum`

export const DROPPED_COLUMNS_SQL = `
SELECT n.nspname || '.' || c.relname, pg_catalog.count(*)::pg_catalog.text
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c     ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname || '.' || c.relname = ANY ($1) AND a.attnum > 0 AND a.attisdropped
 GROUP BY 1 ORDER BY 1`

export const CONSTRAINTS_SQL = `
SELECT n.nspname || '.' || c.relname                    AS qname,
       k.conname                                        AS name,
       k.contype::pg_catalog.text                       AS contype,
       pg_catalog.pg_get_constraintdef(k.oid, false)    AS definition,
       k.convalidated::pg_catalog.text                  AS validated,
       k.condeferrable::pg_catalog.text                 AS deferrable,
       k.condeferred::pg_catalog.text                   AS deferred,
       COALESCE((SELECT pg_catalog.string_agg(ca.attname, ',' ORDER BY u.ord)
                   FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord)
                   JOIN pg_catalog.pg_attribute ca
                     ON ca.attrelid = k.conrelid AND ca.attnum = u.attnum), '') AS columns
  FROM pg_catalog.pg_constraint k
  JOIN pg_catalog.pg_class c     ON c.oid = k.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname || '.' || c.relname = ANY ($1)
 ORDER BY n.nspname, c.relname, k.contype, k.conname`

export const INDEXES_SQL = `
SELECT n.nspname || '.' || c.relname                      AS qname,
       ic.relname                                         AS index_name,
       pg_catalog.pg_get_indexdef(i.indexrelid, 0, true)  AS definition,
       i.indisprimary::pg_catalog.text                    AS is_primary,
       i.indisunique::pg_catalog.text                     AS is_unique,
       i.indisvalid::pg_catalog.text                      AS is_valid,
       i.indisready::pg_catalog.text                      AS is_ready,
       COALESCE(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '')    AS predicate,
       COALESCE(pg_catalog.pg_get_expr(i.indexprs, i.indrelid), '')   AS expressions
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c      ON c.oid = i.indrelid
  JOIN pg_catalog.pg_class ic     ON ic.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace n  ON n.oid = c.relnamespace
 WHERE n.nspname || '.' || c.relname = ANY ($1)
 ORDER BY n.nspname, c.relname, ic.relname`

export const TRIGGERS_SQL = `
SELECT n.nspname || '.' || c.relname          AS qname,
       g.tgname                               AS name,
       g.tgtype::pg_catalog.int4::pg_catalog.text AS tgtype,
       g.tgisinternal::pg_catalog.text        AS internal,
       g.tgenabled::pg_catalog.text           AS enabled
  FROM pg_catalog.pg_trigger g
  JOIN pg_catalog.pg_class c     ON c.oid = g.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname || '.' || c.relname = ANY ($1)
 ORDER BY n.nspname, c.relname, g.tgname`

/**
 * Sequence DEFINITION, never sequence state.
 *
 * `pg_catalog.pg_sequences` was the obvious source and is the wrong one: its
 * target list calls `pg_sequence_last_value()`, which acquires the same
 * RowExclusiveLock `nextval()` takes, so the view blocks under the source fence.
 * It is also privilege-filtered, which would silently hide a sequence from a
 * reader holding no privilege on it. `pg_catalog.pg_sequence` has neither
 * property, and carries every field this contract records. The join is on
 * `seqrelid = pg_class.oid` rather than on matching names.
 */
export const SEQUENCES_SQL = `
SELECT n.nspname || '.' || c.relname                              AS qname,
       pg_catalog.format_type(sq.seqtypid, NULL)                  AS data_type,
       sq.seqstart::pg_catalog.text                               AS start_value,
       sq.seqincrement::pg_catalog.text                           AS increment_by,
       sq.seqmin::pg_catalog.text                                 AS min_value,
       sq.seqmax::pg_catalog.text                                 AS max_value,
       sq.seqcache::pg_catalog.text                               AS cache_size,
       sq.seqcycle::pg_catalog.text                               AS cycle,
       COALESCE(dn.nspname || '.' || dc.relname || '.' || da.attname,
                ''::pg_catalog.text)                              AS owned_by
  FROM pg_catalog.pg_sequence sq
  JOIN pg_catalog.pg_class     c ON c.oid = sq.seqrelid AND c.relkind = 'S'
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                                  AND d.objid = c.oid AND d.deptype = 'a'
  LEFT JOIN pg_catalog.pg_class     dc ON dc.oid = d.refobjid
  LEFT JOIN pg_catalog.pg_namespace dn ON dn.oid = dc.relnamespace
  LEFT JOIN pg_catalog.pg_attribute da ON da.attrelid = d.refobjid AND da.attnum = d.refobjsubid
 WHERE n.nspname || '.' || c.relname = ANY ($1)
 ORDER BY 1`

/** Every statement the extractor sends, so a test can assert the whole set. */
export const CONTRACT_QUERIES: readonly string[] = Object.freeze([
  PLATFORM_SQL, EXTENSIONS_SQL, MIGRATIONS_SQL, RELATIONS_SQL, COLUMNS_SQL,
  DROPPED_COLUMNS_SQL, CONSTRAINTS_SQL, INDEXES_SQL, TRIGGERS_SQL, SEQUENCES_SQL,
])

// ---------------------------------------------------------------------------
// RAW CATALOGUE INPUT — one row set per query, as text
// ---------------------------------------------------------------------------

export interface RawCatalog {
  readonly platform: readonly string[][]
  readonly extensions: readonly string[][]
  readonly migrations: readonly (readonly string[])[]
  readonly relations: readonly string[][]
  readonly columns: readonly string[][]
  readonly droppedColumns: readonly string[][]
  readonly constraints: readonly string[][]
  readonly indexes: readonly string[][]
  readonly triggers: readonly string[][]
  readonly sequences: readonly string[][]
}

const isTrue = (v: string): boolean => v === 't' || v === 'true'
const orNull = (v: string): string | null => (v === '' ? null : v)

/** `tgtype` bit 2 (value 4) is the INSERT event, whatever the timing or level. */
export const TRIGGER_INSERT_BIT = 4

/** The reviewed extension set. A new extension is a contract change. */

/** Types accepted in a copied column, by `schema.typename`. */
const SUPPORTED_BUILTIN = new Set([
  'pg_catalog.text', 'pg_catalog.numeric', 'pg_catalog.int4', 'pg_catalog.int8',
  'pg_catalog.bool', 'pg_catalog.date', 'pg_catalog.timestamptz',
  'pg_catalog.jsonb', 'pg_catalog.uuid',
])

// ---------------------------------------------------------------------------
// BUILD — refusals first, then the canonical payload
// ---------------------------------------------------------------------------

export interface ContractArtifact {
  readonly pgcopy_schema_contract_version: number
  readonly digest: string
  readonly payload: Canonical
}

export function buildContract(
  raw: RawCatalog, profile: MigrationProfile = TARGET_V19_PROFILE,
): ContractArtifact {
  // ---- platform -----------------------------------------------------------
  if (raw.platform.length !== 1) {
    throw new ContractRefused(`expected exactly one platform row, got ${raw.platform.length}.`)
  }
  const [svn, encoding, lcCollate, lcCtype, timezone, tsConfig] = raw.platform[0]
  const major = Math.floor(Number(svn) / 10_000)
  if (major !== 17) {
    throw new ContractRefused(`PostgreSQL major ${major} is not the reviewed 17.`)
  }

  const extensions = raw.extensions.map(r => ({ name: r[0], version: r[1], schema: r[2] }))
  const extNames = extensions.map(e => e.name)
  if (new Set(extNames).size !== extNames.length) {
    throw new ContractRefused('an extension name appears more than once.')
  }
  if (profile.extensions.exact) {
    for (const e of extNames) {
      if (!profile.extensions.required.includes(e)) {
        throw new ContractRefused(
          `extension "${e}" is not in the reviewed set; that is a contract change.`)
      }
    }
  }
  for (const e of profile.extensions.required) {
    if (!extNames.includes(e)) throw new ContractRefused(`reviewed extension "${e}" is not installed.`)
  }

  // ---- migration recognition ---------------------------------------------
  // Recognition is by LEDGER, never by count. `recognizeManifest` is the
  // inventory's own comparison against `CURRENT_V19_MANIFEST`; duplicates are
  // rejected here first, because a map-based comparison collapses them.
  const ledgerRows = raw.migrations.map(r => ({ filename: r[0], sha256: r[1], applied_at: '' }))
  const seenMigration = new Set<string>()
  for (const row of ledgerRows) {
    if (seenMigration.has(row.filename)) {
      throw new ContractRefused(`migration "${row.filename}" appears more than once in db.schema_migrations.`)
    }
    seenMigration.add(row.filename)
  }
  const manifestFacts = recognizeManifest(ledgerRows, profile.manifest)
  // EXACTNESS IS READ FROM THE FACTS, NOT FROM THE LABEL. `recognizeManifest`
  // returns the literal string 'CURRENT_V19' as its "matched" sentinel whatever
  // manifest it was given, which is fine for the inventory that named it and
  // wrong to build a second profile on. The four facts below say the same thing
  // without depending on that word.
  const exact =
    manifestFacts.missing.length === 0 &&
    manifestFacts.additional.length === 0 &&
    manifestFacts.hash_mismatched.length === 0 &&
    manifestFacts.recorded_count === profile.manifest.length
  if (!exact) {
    throw new ContractRefused(
      `the migration ledger is not ${profile.recognition}: ` +
      `${manifestFacts.recorded_count} recorded vs ${manifestFacts.expected_count} expected; ` +
      `missing [${manifestFacts.missing.join(', ')}]; ` +
      `unexpected [${manifestFacts.additional.join(', ')}]; ` +
      `hash-mismatched [${manifestFacts.hash_mismatched.map(h => h.filename).join(', ')}]. ` +
      'A row count is not recognition - every filename and every SHA-256 must match.',
    )
  }
  const migrationCount = ledgerRows.length

  // ---- relations ----------------------------------------------------------
  const relByName = new Map<string, string[]>()
  for (const r of raw.relations) {
    const q = `${r[0]}.${r[1]}`
    if (relByName.has(q)) throw new ContractRefused(`relation ${q} appears more than once.`)
    relByName.set(q, r)
  }
  for (const q of COPY_TABLES) {
    if (!relByName.has(q)) throw new ContractRefused(`required table ${q} is missing.`)
  }
  for (const q of relByName.keys()) {
    if (!COPY_TABLES.includes(q)) throw new ContractRefused(`unexpected table ${q} in the copy set.`)
  }

  const droppedByTable = new Map(raw.droppedColumns.map(r => [r[0], Number(r[1])]))
  const colsByTable = new Map<string, string[][]>()
  for (const r of raw.columns) {
    const list = colsByTable.get(r[0]) ?? []
    list.push(r)
    colsByTable.set(r[0], list)
  }
  const group = <T extends string[]>(rows: readonly T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>()
    for (const r of rows) { const l = m.get(r[0]) ?? []; l.push(r); m.set(r[0], l) }
    return m
  }
  const consByTable = group(raw.constraints)
  const idxByTable = group(raw.indexes)
  const trgByTable = group(raw.triggers)

  const tables = COPY_TABLES.map(q => {
    const rel = relByName.get(q) as string[]
    const [nsp, rname, relkind, relpersistence, owner, rls, forceRls] = rel

    if (relkind !== 'r') throw new ContractRefused(`${q} has relkind "${relkind}", not an ordinary table.`)
    if (relpersistence !== 'p') {
      throw new ContractRefused(`${q} has relpersistence "${relpersistence}", not permanent.`)
    }
    // COPY FROM is NOT SUPPORTED on an RLS table, and COPY TO on the source
    // would apply SELECT policies and export a filtered subset. Unconditional.
    if (isTrue(rls)) throw new ContractRefused(`${q} has relrowsecurity enabled; refused unconditionally.`)
    if (isTrue(forceRls)) {
      throw new ContractRefused(`${q} has relforcerowsecurity enabled; refused unconditionally.`)
    }

    for (const t of trgByTable.get(q) ?? []) {
      const [, tname, tgtype, internal, enabled] = t
      if (isTrue(internal)) continue  // FK enforcement triggers are expected
      if ((Number(tgtype) & TRIGGER_INSERT_BIT) !== 0) {
        throw new ContractRefused(
          `${q} carries non-internal trigger "${tname}" that fires for INSERT (tgtype=${tgtype}, ` +
          `tgenabled=${enabled}). COPY FROM fires row- and statement-level INSERT triggers, so a ` +
          'trigger could transform the values between the wire and storage. Disabled is not exempt: ' +
          'enabling it is one statement away.',
        )
      }
    }

    const colRows = colsByTable.get(q) ?? []
    if (colRows.length === 0) throw new ContractRefused(`${q} has no live columns.`)
    const seenCols = new Set<string>()
    const columns = colRows.map((r, i) => {
      const [, attnum, name, formatType, typeSchema, typeName, typtype, typcategory, typmod,
             typeExt, typeExtVer, notnull, hasdef, defExpr, identity, generated, serialSeq,
             collSchema, collName, collProvider, collDet, collEnc, collCollate, collCtype,
             collIcu, collIcuRules, collVersion, collActualVersion,
             idSeqName, idSeqType, idSeqStart, idSeqIncrement, idSeqMin, idSeqMax,
             idSeqCache, idSeqCycle, idSeqLinkage] = r

      // Extracted BEFORE the compatibility-policy refusal below, so the refusal
      // can name the object it rejected. A refusal that cannot describe what it
      // found is a refusal nobody can act on.
      const identitySequence = orNull(idSeqName) === null ? null : {
        qname: idSeqName,
        data_type: idSeqType,
        start_value: idSeqStart,
        increment_by: idSeqIncrement,
        min_value: idSeqMin,
        max_value: idSeqMax,
        cache_size: idSeqCache,
        cycle: isTrue(idSeqCycle),
        linkage: idSeqLinkage,
      }
      if (seenCols.has(name)) throw new ContractRefused(`${q} column "${name}" appears more than once.`)
      seenCols.add(name)

      if (identity !== '') {
        throw new ContractRefused(
          `${q}.${name} is an identity column (attidentity="${identity}"); its identity sequence is ` +
          `${identitySequence
            ? `${identitySequence.qname} [data_type=${identitySequence.data_type} ` +
              `start=${identitySequence.start_value} increment=${identitySequence.increment_by} ` +
              `min=${identitySequence.min_value} max=${identitySequence.max_value} ` +
              `cache=${identitySequence.cache_size} cycle=${String(identitySequence.cycle)} ` +
              `linkage=${identitySequence.linkage}]`
            : 'ABSENT'}. ` +
          `This is COMPATIBILITY ` +
          'POLICY, not a claim that COPY cannot accept identity values - COPY FROM behaves as if ' +
          'OVERRIDING SYSTEM VALUE were given. The reviewed design does not model that semantic.',
        )
      }
      if (generated === 's') {
        throw new ContractRefused(
          `${q}.${name} is a stored generated column; it cannot appear in a COPY column list.`,
        )
      }
      const typeId = `${typeSchema}.${typeName}`
      const supported = SUPPORTED_BUILTIN.has(typeId) ||
        (typeName === 'vector' && typeExt === 'vector' && typtype === 'b')
      if (!supported) {
        throw new ContractRefused(
          `${q}.${name} has type ${formatType} identified as ${typeId} ` +
          `(typtype=${typtype}, extension=${typeExt ?? 'none'}), which is not in the reviewed set.`,
        )
      }
      if (collName !== '') {
        if (!isTrue(collDet)) {
          throw new ContractRefused(
            `${q}.${name} uses nondeterministic collation ${collSchema}.${collName}; equality would ` +
            'not be the relation the primary-key-ordered digest relies on.',
          )
        }
        // A versioned provider records a version at CREATE time; the actual
        // version is what the provider reports NOW. If they differ, the
        // operating system's collation moved under an existing index and the
        // ordering on disk may no longer be the ordering the digest assumes.
        // A provider with no versioning (the C locale) reports NULL for both,
        // and NULL == NULL is not drift.
        const recordedCollVersion = orNull(collVersion)
        const actualCollVersion = orNull(collActualVersion)
        if (recordedCollVersion !== null && actualCollVersion !== null &&
            recordedCollVersion !== actualCollVersion) {
          throw new ContractRefused(
            `${q}.${name} collation ${collSchema}.${collName} records version ` +
            `"${recordedCollVersion}" but the provider now reports "${actualCollVersion}". ` +
            'Index ordering may no longer match the collation.',
          )
        }
        if (recordedCollVersion === null && actualCollVersion !== null) {
          throw new ContractRefused(
            `${q}.${name} collation ${collSchema}.${collName} records NO version while the ` +
            `provider reports "${actualCollVersion}"; catalogue and provider disagree.`,
          )
        }
        if (recordedCollVersion !== null && actualCollVersion === null) {
          throw new ContractRefused(
            `${q}.${name} collation ${collSchema}.${collName} records version ` +
            `"${recordedCollVersion}" while the provider reports none; catalogue and provider disagree.`,
          )
        }
      }
      return {
        position: i + 1,
        attnum: Number(attnum),
        name,
        format_type: formatType,
        type_schema: typeSchema,
        type_name: typeName,
        typtype,
        typcategory,
        typmod: Number(typmod),
        type_extension: orNull(typeExt),
        type_extension_version: orNull(typeExtVer),
        not_null: isTrue(notnull),
        has_default: isTrue(hasdef),
        default_expression: orNull(defExpr),
        identity: identity === '' ? null : identity,
        generated: generated === '' ? null : generated,
        serial_sequence: orNull(serialSeq),
        identity_sequence: identitySequence,
        collation: collName === '' ? null : {
          schema: collSchema, name: collName, provider: collProvider,
          deterministic: isTrue(collDet), encoding: Number(collEnc),
          collate: orNull(collCollate), ctype: orNull(collCtype),
          locale: orNull(collIcu), icu_rules: orNull(collIcuRules),
          version: orNull(collVersion), actual_version: orNull(collActualVersion),
        },
      }
    })

    const cons = (consByTable.get(q) ?? []).map(r => {
      const [, name, contype, definition, validated, deferrable, deferred, cols] = r
      if (contype === 'f') {
        if (!isTrue(validated)) {
          throw new ContractRefused(
            `${q} foreign key "${name}" is NOT VALID; it would admit rows it claims to forbid.`,
          )
        }
        if (isTrue(deferrable)) {
          throw new ContractRefused(
            `${q} foreign key "${name}" is DEFERRABLE; a deferred violation surfaces at COMMIT, ` +
            'which is exactly the indeterminate case the copy must not create.',
          )
        }
      }
      return {
        name, type: contype, definition, columns: cols,
        validated: isTrue(validated), deferrable: isTrue(deferrable), deferred: isTrue(deferred),
      }
    })

    const indexes = (idxByTable.get(q) ?? []).map(r => {
      const [, name, definition, isPrimary, isUnique, isValid, isReady, predicate, expressions] = r
      const identityIndex = isTrue(isPrimary) || isTrue(isUnique)
      if (identityIndex && (!isTrue(isValid) || !isTrue(isReady))) {
        throw new ContractRefused(
          `${q} identity index "${name}" is not valid/ready (indisvalid=${isValid}, indisready=${isReady}).`,
        )
      }
      return {
        name, definition,
        is_primary: isTrue(isPrimary), is_unique: isTrue(isUnique),
        is_valid: isTrue(isValid), is_ready: isTrue(isReady),
        predicate, expressions,
      }
    })

    return {
      qname: q, schema: nsp, name: rname,
      relkind, relpersistence, owner,
      row_security: isTrue(rls), force_row_security: isTrue(forceRls),
      dropped_column_count: droppedByTable.get(q) ?? 0,
      columns,
      constraints: cons,
      indexes,
    }
  })

  // ---- sequences ----------------------------------------------------------
  const seqByName = new Map<string, string[]>()
  for (const r of raw.sequences) {
    if (seqByName.has(r[0])) throw new ContractRefused(`sequence ${r[0]} appears more than once.`)
    seqByName.set(r[0], r)
  }
  const sequences = COPY_SEQUENCES.map(q => {
    const r = seqByName.get(q)
    if (!r) throw new ContractRefused(`required sequence ${q} is missing.`)
    const [, dataType, start, increment, minValue, maxValue, cache, cycle, ownedBy] = r
    if (ownedBy === '') throw new ContractRefused(`sequence ${q} has no owning table column.`)
    return {
      qname: q, data_type: dataType, start_value: start, increment_by: increment,
      min_value: minValue, max_value: maxValue, cache_size: cache,
      cycle: isTrue(cycle), owned_by: ownedBy,
    }
  })
  for (const q of seqByName.keys()) {
    if (!COPY_SEQUENCES.includes(q)) throw new ContractRefused(`unexpected sequence ${q}.`)
  }

  const payload = {
    platform: {
      server_version_major: major,
      encoding, lc_collate: lcCollate, lc_ctype: lcCtype,
      timezone, default_text_search_config: tsConfig,
      extensions,
    },
    migrations: {
      recognition: profile.recognition,
      count: migrationCount,
      // The ordered ledger itself, plus its own digest. Carrying both lets a
      // reader see WHICH nineteen without recomputing, and lets a comparison
      // fail on one filename or one hash instead of on a count.
      ledger: ledgerRows.map(r => ({ filename: r.filename, sha256: r.sha256 })),
      ledger_digest: sha256Hex(ledgerRows.map(r => `${r.filename}:${r.sha256}`).join('\n')),
    },
    table_order: [...COPY_TABLES],
    tables,
    sequences,
  } as unknown as Canonical

  return {
    pgcopy_schema_contract_version: SCHEMA_CONTRACT_VERSION,
    digest: contractDigest(payload),
    payload,
  }
}

/**
 * The digest domain is the canonical JSON of the PAYLOAD and the version, and
 * nothing else. The `digest` field is a sibling of `payload`, so it cannot
 * appear in its own input, and the version is included so a shape change under
 * the same bytes is impossible.
 */
export function contractDigest(payload: Canonical): string {
  return sha256Hex(
    canonicalJson({ version: SCHEMA_CONTRACT_VERSION, payload } as unknown as Canonical),
  )
}

/** The committed artifact's exact bytes: pretty for review, newline-terminated. */
export function serializeArtifact(artifact: ContractArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`
}

/** Parse and re-verify: an artifact whose digest does not match is refused. */
export function parseArtifact(text: string): ContractArtifact {
  const a = JSON.parse(text) as ContractArtifact
  if (a.pgcopy_schema_contract_version !== SCHEMA_CONTRACT_VERSION) {
    throw new ContractRefused(
      `artifact version ${String(a.pgcopy_schema_contract_version)} is not ${SCHEMA_CONTRACT_VERSION}.`,
    )
  }
  const recomputed = contractDigest(a.payload)
  if (recomputed !== a.digest) {
    throw new ContractRefused(
      `artifact digest ${a.digest} does not match its payload (recomputed ${recomputed}).`,
    )
  }
  return a
}

/** No raw catalogue OID may reach the artifact. Checked, not assumed. */
export function assertNoRawOids(artifact: ContractArtifact): void {
  const text = canonicalJson(artifact.payload)
  for (const key of ['oid', 'relfilenode', 'atttypid', 'attrelid', 'conrelid', 'indexrelid', 'refobjid']) {
    if (text.includes(`"${key}"`)) {
      throw new ContractRefused(`the artifact carries a raw catalogue key "${key}".`)
    }
  }
}

// ---------------------------------------------------------------------------
// Session-bound extraction
// ---------------------------------------------------------------------------

/** A PostgreSQL text array literal, for `= ANY ($1)` without a bind parameter. */
export function pgTextArray(values: readonly string[]): string {
  return `'{${values.map(v => `"${v}"`).join(',')}}'::pg_catalog.text[]`
}

/**
 * One backend that stays open, with the PID it claims to be.
 *
 * Deliberately tiny, and deliberately in production source: the copy's Stage 1
 * runs against a real source database, not a disposable one, so the extraction
 * primitive cannot live in the test harness. It also takes no connection
 * parameters - it cannot open anything, which is what makes "no second
 * connection" a property of the type rather than a rule someone has to follow.
 */
export interface ContractQueryExecutor {
  readonly pid: string
  rows(sql: string): Promise<string[][]>
}

/**
 * The three session facts, read in ONE statement.
 *
 * Separately they can be observed in different states: a session could be read
 * only when its PID is checked and read write by the time the first catalogue
 * query runs. One statement makes them one observation.
 */
export const SESSION_GUARD_SQL = `
SELECT pg_catalog.pg_backend_pid()::pg_catalog.text,
       pg_catalog.current_setting('transaction_read_only'),
       pg_catalog.current_setting('transaction_isolation')`

/** Just the PID, for the re-read after the last catalogue query. */
export const SESSION_PID_SQL = 'SELECT pg_catalog.pg_backend_pid()::pg_catalog.text'

export const REQUIRED_TRANSACTION_ISOLATION = 'repeatable read'

/**
 * Read the whole contract through ONE open transaction on ONE backend.
 *
 * WHY THIS EXISTS. The generator's original reader called a helper that spawns
 * `psql -c` per query, so ten queries meant ten backends, ten transactions and
 * ten snapshots. For a quiescent disposable database that is harmless. For
 * Stage 1 - one authenticated principal reading a live source under a fence - it
 * is not a contract at all: nothing would stop the tenth query describing a
 * different moment than the first.
 *
 * THE CALLER OWNS THE TRANSACTION. This function never sends BEGIN, COMMIT or
 * ROLLBACK. It is handed a session that is already inside a READ ONLY
 * REPEATABLE READ transaction, proves that from inside, and reads. Ending the
 * transaction here would end the snapshot the caller is still relying on.
 */
export async function extractContractFromSession(
  executor: ContractQueryExecutor,
  expectedPid: string,
  profile: MigrationProfile = TARGET_V19_PROFILE,
): Promise<ContractArtifact> {
  if (!/^\d+$/.test(expectedPid)) {
    throw new ContractRefused(`the expected backend pid "${expectedPid}" is not a backend pid.`)
  }
  if (executor.pid !== expectedPid) {
    throw new ContractRefused(
      `the executor reports backend pid ${executor.pid}, not the expected ${expectedPid}.`)
  }

  const guard = await executor.rows(SESSION_GUARD_SQL)
  if (guard.length !== 1 || guard[0].length !== 3) {
    throw new ContractRefused('the session guard did not return one row of three values.')
  }
  const [livePid, readOnly, isolation] = guard[0]
  if (livePid !== expectedPid) {
    throw new ContractRefused(
      `the session is backend ${livePid}, not the expected ${expectedPid}.`)
  }
  if (readOnly !== 'on') {
    throw new ContractRefused(
      `transaction_read_only is "${readOnly}", not "on"; the extraction session could write.`)
  }
  if (isolation !== REQUIRED_TRANSACTION_ISOLATION) {
    throw new ContractRefused(
      `transaction_isolation is "${isolation}", not "${REQUIRED_TRANSACTION_ISOLATION}"; ` +
      'without one snapshot the ten queries can describe ten different moments.')
  }

  const tables = pgTextArray(COPY_TABLES)
  const seqs = pgTextArray(COPY_SEQUENCES)
  // ONE captured executor. There is no per-query executor argument, so nothing
  // can be swapped in partway through.
  const q = async (sql: string, arg?: string): Promise<string[][]> => {
    try {
      return await executor.rows(arg ? sql.replace('$1', arg) : sql)
    } catch (e) {
      // Bounded and redaction-safe: the failing query is named by its first
      // line, never by the rows it would have returned.
      throw new ContractRefused(
        `contract query failed: ${sql.trim().split('\n')[0].slice(0, 120)}`)
    }
  }

  await q(CONTRACT_PRELUDE)

  const raw: RawCatalog = {
    platform: await q(PLATFORM_SQL),
    extensions: await q(EXTENSIONS_SQL),
    migrations: await q(MIGRATIONS_SQL),
    relations: await q(RELATIONS_SQL, tables),
    columns: await q(COLUMNS_SQL, tables),
    droppedColumns: await q(DROPPED_COLUMNS_SQL, tables),
    constraints: await q(CONSTRAINTS_SQL, tables),
    indexes: await q(INDEXES_SQL, tables),
    triggers: await q(TRIGGERS_SQL, tables),
    sequences: await q(SEQUENCES_SQL, seqs),
  }

  const after = await executor.rows(SESSION_PID_SQL)
  if (after[0]?.[0] !== expectedPid) {
    throw new ContractRefused(
      `the session became backend ${String(after[0]?.[0])} during extraction; the contract ` +
      'would describe more than one session.')
  }

  return buildContract(raw, profile)
}

// ---------------------------------------------------------------------------
// The copy specification
// ---------------------------------------------------------------------------

/**
 * What a table copy is allowed to move: one reviewed table and its live columns,
 * in the order the VERIFIED contract recorded them.
 */
export interface TableCopySpec {
  readonly qname: string
  readonly schema: string
  readonly table: string
  readonly columns: readonly string[]
}

const SPEC_IDENT = /^[a-z_][a-z0-9_]*$/

/**
 * The ONE reviewed contract a copy may be bound to.
 *
 * WHY SELF-CONSISTENCY IS NOT ENOUGH. An artifact's digest proves only that its
 * digest matches its own payload - which anyone can arrange by editing the
 * payload and recomputing. A re-digested artifact with a column removed, a
 * column added, or a table duplicated is perfectly self-consistent and describes
 * a schema nobody reviewed; binding a binary COPY to it would move values into
 * the wrong columns while every internal check passed. So the digest is also
 * compared to this anchor: the digest of the committed expected-target contract.
 *
 * The constant is written out rather than read from the artifact file, because
 * reading it from the file would make the file its own authority again. A test
 * asserts the two agree, so they cannot drift apart silently.
 */
export const REVIEWED_CONTRACT_DIGEST =
  '59d4289f72a1027772fcfb2f907d311fe587d99cf8db09a911f53cec080bdc82'

/**
 * Derive a copy specification from a verified artifact.
 *
 * WHY THE CALLER MAY NOT SUPPLY COLUMNS. Binary COPY carries no column names -
 * only a tuple of values in the order the COPY statement named them. A
 * caller-supplied list is therefore a second, unverified authority on what the
 * table looks like, and if it drifts from the contract by one column, one
 * position, or one omission, the copy still "succeeds" and writes the wrong
 * values into the wrong columns. So the list comes from the artifact, and the
 * artifact's digest is recomputed here before a single name is read from it:
 * accepting a tampered artifact would reintroduce exactly the second authority
 * this removes.
 *
 * There is no live-catalogue query here. The contract has already been extracted
 * from the fenced source and verified; asking the catalogue again would be a
 * third authority and a second moment.
 */
export function tableCopySpec(artifact: ContractArtifact, qname: string): TableCopySpec {
  if (artifact.pgcopy_schema_contract_version !== SCHEMA_CONTRACT_VERSION) {
    throw new ContractRefused(
      `artifact version ${String(artifact.pgcopy_schema_contract_version)} is not ` +
      `${SCHEMA_CONTRACT_VERSION}.`)
  }
  const recomputed = contractDigest(artifact.payload)
  if (recomputed !== artifact.digest) {
    throw new ContractRefused(
      `artifact digest ${artifact.digest} does not match its payload (recomputed ${recomputed}).`)
  }
  // AND it must be the REVIEWED contract, not merely a self-consistent one.
  //
  // THIS PATH IS FOR THE TARGET ARTIFACT AND HAS NO ESCAPE HATCH. An earlier
  // revision took a nullable anchor so the SOURCE could be passed through
  // here, which made `null` a standing claim that C1 had run - a review
  // convention nothing could check. The source path now lives in
  // `sourceTableCopySpec`, which requires a proof only `assertCopyCompatible`
  // can mint.
  if (artifact.digest !== REVIEWED_CONTRACT_DIGEST) {
    throw new ContractRefused(
      `artifact digest ${artifact.digest} is not the reviewed expected-target digest ` +
      `${REVIEWED_CONTRACT_DIGEST}; a self-consistent artifact still describes a schema ` +
      'nobody reviewed.')
  }
  if (!COPY_TABLES.includes(qname)) {
    throw new ContractRefused(`${qname} is not in the reviewed copy set.`)
  }
  const columns = deriveCopyColumns(artifact.payload, qname)
  const [schema, table] = qname.split('.')
  return Object.freeze({ qname, schema, table, columns: Object.freeze(columns) })
}

/**
 * The structural half, separated so it stays REACHABLE.
 *
 * Once the anchor above is in place, nothing that reaches this code can be
 * structurally wrong - which would make every check below unreachable and its
 * tests impossible to write honestly. Exporting the derivation keeps the shape
 * rules testable on their own terms, and keeps them meaningful the day the
 * anchor moves to a new reviewed digest: a fresh contract still has to be a
 * well-formed one.
 */
export function deriveCopyColumns(payload: Canonical, qname: string): string[] {
  const p = payload as unknown as { table_order?: unknown; tables?: unknown }
  const order = Array.isArray(p.table_order) ? p.table_order : null
  const tables = Array.isArray(p.tables) ? p.tables : null
  if (order === null || tables === null) {
    throw new ContractRefused('the artifact carries no table_order or tables.')
  }

  const inOrder = order.filter(t => t === qname).length
  if (inOrder !== 1) {
    throw new ContractRefused(`${qname} occurs ${inOrder} times in table_order, not once.`)
  }
  const matches = (tables as Array<{ qname?: unknown; columns?: unknown }>)
    .filter(t => t.qname === qname)
  if (matches.length !== 1) {
    throw new ContractRefused(`${qname} occurs ${matches.length} times in the contract, not once.`)
  }

  const raw = Array.isArray(matches[0].columns) ? matches[0].columns : null
  if (raw === null || raw.length === 0) {
    throw new ContractRefused(`${qname} has no live columns in the contract.`)
  }

  // Recorded physical order. The contract writes columns in `attnum` order and
  // carries `position`; both are checked, so a reordered artifact is refused
  // rather than silently copied in the wrong order.
  const columns: string[] = []
  const seen = new Set<string>()
  raw.forEach((c: unknown, i: number) => {
    const col = c as { name?: unknown; position?: unknown }
    const name = col.name
    if (typeof name !== 'string' || !SPEC_IDENT.test(name)) {
      throw new ContractRefused(`${qname} has a column name that is not a bare identifier.`)
    }
    if (col.position !== i + 1) {
      throw new ContractRefused(
        `${qname} column "${name}" is recorded at position ${String(col.position)}, ` +
        `not ${i + 1}; the contract's column order cannot be trusted.`)
    }
    if (seen.has(name)) {
      throw new ContractRefused(`${qname} column "${name}" appears more than once in the contract.`)
    }
    seen.add(name)
    columns.push(name)
  })
  return columns
}
