/**
 * Fact shaping — PURE. Catalogue rows in, one canonical fact document out.
 *
 * No I/O, no clock, no `pg`, no `process`. Everything the document contains is
 * either a row the collector read or a restatement of one; the run id and the
 * timestamp are passed IN so this module has no source of nondeterminism at all
 * and its output is byte-reproducible from its input.
 *
 * ── THE ONE RULE: RECORD, DO NOT JUDGE ──────────────────────────────────────
 *
 * This module contains no policy. It does not decide that a missing object is
 * wrong, that a LOGIN role owning something is wrong, that an unexpected grant
 * is wrong, that a drifted extension version is wrong, or that an invalid index
 * is wrong. Each of those is a FACT here and a DECISION somewhere else, later.
 *
 * The one label it does emit — `CURRENT_V18` or `UNRECOGNIZED` — names which
 * published manifest the recorded migration ledger matches. It is a
 * recognition, not a verdict: `UNRECOGNIZED` says "this is not the eighteen
 * migrations I know", and says nothing about whether that is acceptable. The
 * evidence behind it (what was missing, what was extra, what hashed
 * differently) is recorded alongside so a later slice can decide without
 * re-reading the database.
 */

import type {
  PublicObjectRow,
  DependencyEdgeRow,
  ExtensionMemberRow,
  IndexRow,
  ManifestEntry,
  SchemaMigrationRow,
  ServerBindingRow,
  SessionIdentityRow,
} from './inventory-queries.js'
import { CURRENT_V18_MANIFEST } from './inventory-queries.js'

// ── Canonical serialization ─────────────────────────────────────────────────

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [k: string]: CanonicalValue }

/**
 * Serialize to bytes that are identical for identical facts, on any machine.
 *
 * WHY EACH RESTRICTION EARNS ITS PLACE.
 *
 *   Sorted keys, every level — JavaScript object key order follows insertion,
 *   so two runs that gathered the same facts in a different order would produce
 *   different bytes and a hash comparison between them would be meaningless.
 *
 *   No floats — IEEE-754 has no single decimal spelling, and a privilege
 *   inventory has nothing to say that needs one. Counts and OIDs are integers;
 *   OIDs in particular arrive as TEXT from the queries precisely so a value
 *   above 2^53 cannot be silently rounded into a different object.
 *
 *   No `undefined` — it disappears from a JSON object rather than serializing,
 *   so a shaping bug that dropped a field would produce a *valid smaller*
 *   document instead of an error. Absence must be spelled `null`.
 *
 *   LF only, one trailing newline — so the artifact is a well-formed text file,
 *   diffable, and hashes the same whether or not a tool touched its ending.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, '$'), null, 2) + '\n'
}

function canonicalize(value: unknown, path: string): CanonicalValue {
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value as string | boolean
  if (t === 'number') {
    const n = value as number
    if (!Number.isFinite(n)) {
      throw new Error(`@common/db inventory: ${path} is ${String(n)}; the fact document admits no non-finite number.`)
    }
    if (!Number.isInteger(n)) {
      throw new Error(
        `@common/db inventory: ${path} is the float ${n}. Floats have no single decimal ` +
        'spelling, so the artifact would not be byte-stable. Record it as an integer or a string.',
      )
    }
    return n === 0 ? 0 : n
  }
  if (t === 'undefined') {
    throw new Error(
      `@common/db inventory: ${path} is undefined. It would vanish from the document rather ` +
      'than serialize, turning a shaping bug into a valid smaller artifact. Use null.',
    )
  }
  if (t === 'bigint' || t === 'function' || t === 'symbol') {
    throw new Error(`@common/db inventory: ${path} is a ${t} and has no canonical JSON form.`)
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => canonicalize(v, `${path}[${i}]`))
  }
  const src = value as Record<string, unknown>
  const out: Record<string, CanonicalValue> = {}
  for (const key of Object.keys(src).sort()) {
    out[key] = canonicalize(src[key], `${path}.${key}`)
  }
  return out
}

/**
 * Order rows by their own canonical serialization.
 *
 * The server's row order is not a fact about the database — `ORDER BY` fixes
 * most of it, but collation, parallel plans and ties are all free to vary. A
 * total order derived from the row's own content is the only one that cannot
 * drift. This SORTS; it never deduplicates, because two ACL tuples that
 * serialize identically are two real grants and collapsing them would
 * understate the database.
 */
export function sortRowsCanonically<T>(rows: readonly T[]): T[] {
  return rows
    .map(row => ({ row, key: canonicalJson(row) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(entry => entry.row)
}

// ── Migration manifest recognition ──────────────────────────────────────────

export type ManifestRecognition = 'CURRENT_V18' | 'UNRECOGNIZED'

export interface ManifestFacts {
  recognition: ManifestRecognition
  expected_count: number
  recorded_count: number
  recorded: { filename: string; sha256: string; applied_at: string }[]
  /** In the manifest, absent from the ledger. */
  missing: string[]
  /** In the ledger, absent from the manifest. */
  additional: string[]
  /** Present in both under the same name, applied from different bytes. */
  hash_mismatched: { filename: string; recorded_sha256: string; manifest_sha256: string }[]
}

/**
 * Recognise the recorded ledger against a published manifest.
 *
 * `CURRENT_V18` requires ALL EIGHTEEN filenames present, each with the exact
 * recorded hash, and nothing else recorded. Every other shape is
 * `UNRECOGNIZED`: one changed hash, one missing row, one extra row, one row
 * naming a file this manifest has never heard of. There is no partial credit
 * and no "close enough" — the point of the label is that it is worthless unless
 * it means exactly one thing.
 *
 * `CURRENT_V18` is the CURRENT exact recognition, and the only one. There is no
 * `CURRENT_V19` branch: a migration nobody has written yet must not be
 * recognisable in advance, so a database carrying one lands in `UNRECOGNIZED`
 * and is looked at by a person. Additional, missing, duplicated and
 * hash-drifted rows all reach the same verdict — `UNRECOGNIZED` is not a
 * severity, it is the single answer to "this is not the eighteen migrations I
 * know".
 */
export function recognizeManifest(
  rows: readonly SchemaMigrationRow[],
  manifest: readonly ManifestEntry[] = CURRENT_V18_MANIFEST,
): ManifestFacts {
  const recorded = sortRowsCanonically(
    rows.map(r => ({ filename: r.filename, sha256: r.sha256, applied_at: r.applied_at })),
  )
  const byName = new Map(recorded.map(r => [r.filename, r]))
  const expected = new Map(manifest.map(m => [m.filename, m.sha256]))

  const missing: string[] = []
  const hash_mismatched: ManifestFacts['hash_mismatched'] = []
  for (const entry of manifest) {
    const row = byName.get(entry.filename)
    if (!row) {
      missing.push(entry.filename)
      continue
    }
    if (row.sha256 !== entry.sha256) {
      hash_mismatched.push({
        filename: entry.filename,
        recorded_sha256: row.sha256,
        manifest_sha256: entry.sha256,
      })
    }
  }
  const additional = recorded.map(r => r.filename).filter(f => !expected.has(f))

  const exact =
    missing.length === 0 &&
    additional.length === 0 &&
    hash_mismatched.length === 0 &&
    recorded.length === manifest.length

  return {
    recognition: exact ? 'CURRENT_V18' : 'UNRECOGNIZED',
    expected_count: manifest.length,
    recorded_count: recorded.length,
    recorded,
    missing: [...missing].sort(),
    additional: [...additional].sort(),
    hash_mismatched: sortRowsCanonically(hash_mismatched),
  }
}

// ── Extension evidence: a four-way model, and no verdicts ───────────────────

export type EvidenceClass =
  | 'direct_member'
  | 'internal_support'
  | 'application_dependency'
  | 'unrelated_public_object'

export interface ExtensionEvidenceFact {
  /** null only for `unrelated_public_object` — it belongs to no extension. */
  extension_name: string | null
  extension_version: string | null
  classid: string
  objid: string
  objsubid: string
  catalogue: string | null
  object_description: string | null
  /** false when the server could not describe the object. It is KEPT and
   *  marked, never dropped — an object we cannot name is still an object. */
  described: boolean
  evidence_class: EvidenceClass
}

export interface ApplicationDependencyEdge {
  extension_name: string
  extension_version: string
  dependent_classid: string
  dependent_objid: string
  dependent_objsubid: string
  dependent_description: string | null
  referenced_classid: string
  referenced_objid: string
  referenced_objsubid: string
  referenced_description: string | null
}

export interface PerExtensionTotals {
  extension_name: string
  extension_version: string
  direct_member: number
  internal_support: number
  application_dependency: number
}

export interface ExtensionEvidence {
  classifications: ExtensionEvidenceFact[]
  application_dependency_edges: ApplicationDependencyEdge[]
  per_extension: PerExtensionTotals[]
  totals: Record<EvidenceClass, number>
}

/**
 * Object identity. Deliberately excludes traversal depth — an object reached at
 * depth 2 and again at depth 5 is one object, and a key that carried depth
 * would let a cycle re-enqueue it forever under ever-new keys.
 */
function objectKey(classid: string, objid: string, objsubid: string): string {
  return `${classid}/${objid}/${objsubid}`
}

/**
 * Visited identity for the closure walk: EXTENSION plus object.
 *
 * WHY NOT THE OBJECT ALONE. Two extensions' closures can overlap — most
 * obviously through a shared type, operator or access method, and `btree_gist`
 * and `vector` both reach into `public`. With an object-only visited set the
 * first extension to reach a shared object claims it and the second is recorded
 * as not containing it at all, so "which extensions would break if this were
 * dropped?" gets a confidently wrong answer. Scoping by extension keeps the
 * object's relationship to EVERY extension, and still terminates, because
 * within one extension's walk the object is still visited once.
 */
function visitedKey(extension: string, object: string): string {
  return `${extension}\u0000${object}`
}

/**
 * Classify every object into exactly one evidence class per extension.
 *
 *   direct_member          — `pg_depend` deptype 'e': the extension owns it.
 *   internal_support       — reached from a direct member through the 'i'/'a'
 *                            closure: PostgreSQL's own scaffolding for that
 *                            member (an index behind a constraint, a sequence
 *                            behind an identity column, an array type behind a
 *                            base type). Dropping the extension drops it too.
 *   application_dependency — an ordinary object with a NORMAL ('n') dependency
 *                            on something in a closure: a `vector` column, an
 *                            `hnsw` index, an exclusion constraint using
 *                            btree_gist's operators. Dropping the extension
 *                            does NOT drop it — the drop is refused.
 *   unrelated_public_object — an object living in schema `public` that is in
 *                            neither of the above relations.
 *
 * THE FOURTH CLASS IS ABOUT `public`, NOT ABOUT THE APPLICATION. `public` is
 * the one schema the bootstrap installs extensions into and then revokes from
 * PUBLIC, so "what is in there that no extension accounts for?" is a real
 * question with a small answer. "Which application objects don't depend on an
 * extension?" is not — it is nearly every table in the database, and labelling
 * `portfolio.positions` or `investment_ledger.transactions` "unrelated" made
 * the category useless in both directions: it drowned the signal AND, being
 * built from three catalogues, it missed the operators and operator classes
 * that are the things actually likely to be left behind in `public`.
 *
 * Without this universe, "not part of any extension" would be indistinguishable
 * from "never looked at" — absence is not a fact.
 *
 * NOTHING HERE IS A VERDICT. An application object depending on an extension is
 * not an error, an unrelated object is not an intruder, and a version is not
 * drift. Each is recorded so a later slice can decide.
 */
export function classifyExtensionEvidence(
  directMembers: readonly ExtensionMemberRow[],
  closureEdges: readonly DependencyEdgeRow[],
  normalEdges: readonly DependencyEdgeRow[] = [],
  publicObjects: readonly PublicObjectRow[] = [],
): ExtensionEvidence {
  const byReferenced = new Map<string, DependencyEdgeRow[]>()
  for (const e of closureEdges) {
    const key = objectKey(e.refclassid, e.refobjid, e.refobjsubid)
    const list = byReferenced.get(key)
    if (list) list.push(e)
    else byReferenced.set(key, [e])
  }

  const versions = new Map<string, string>()
  for (const m of directMembers) versions.set(m.extension_name, m.extension_version)

  const classifications: ExtensionEvidenceFact[] = []
  /** extension -> every object key in its closure (direct + internal). */
  const closureOf = new Map<string, Set<string>>()
  const visited = new Set<string>()

  const record = (fact: ExtensionEvidenceFact): void => { classifications.push(fact) }

  // ── seeds ────────────────────────────────────────────────────────────────
  const queue: { extension: string; key: string }[] = []
  for (const m of directMembers) {
    const key = objectKey(m.classid, m.objid, m.objsubid)
    if (visited.has(visitedKey(m.extension_name, key))) continue
    visited.add(visitedKey(m.extension_name, key))
    const set = closureOf.get(m.extension_name) ?? new Set<string>()
    set.add(key)
    closureOf.set(m.extension_name, set)
    record({
      extension_name: m.extension_name,
      extension_version: m.extension_version,
      classid: m.classid, objid: m.objid, objsubid: m.objsubid,
      catalogue: m.catalogue,
      object_description: m.object_description,
      described: m.object_description !== null && m.object_description !== '',
      evidence_class: 'direct_member',
    })
    queue.push({ extension: m.extension_name, key })
  }

  // ── i/a closure, cycle-safe ──────────────────────────────────────────────
  while (queue.length > 0) {
    const current = queue.shift() as { extension: string; key: string }
    for (const edge of byReferenced.get(current.key) ?? []) {
      const key = objectKey(edge.classid, edge.objid, edge.objsubid)
      const seen = visitedKey(current.extension, key)
      if (visited.has(seen)) continue
      visited.add(seen)
      closureOf.get(current.extension)?.add(key)
      record({
        extension_name: current.extension,
        extension_version: versions.get(current.extension) ?? null,
        classid: edge.classid, objid: edge.objid, objsubid: edge.objsubid,
        catalogue: edge.catalogue,
        object_description: edge.object_description,
        described: edge.object_description !== null && edge.object_description !== '',
        evidence_class: 'internal_support',
      })
      queue.push({ extension: current.extension, key })
    }
  }

  // ── normal ('n') dependencies onto any closure ───────────────────────────
  const applicationDependencyEdges: ApplicationDependencyEdge[] = []
  const dependentKeys = new Set<string>()
  for (const edge of normalEdges) {
    const referenced = objectKey(edge.refclassid, edge.refobjid, edge.refobjsubid)
    const dependent = objectKey(edge.classid, edge.objid, edge.objsubid)
    for (const [extension, closure] of closureOf) {
      if (!closure.has(referenced)) continue
      applicationDependencyEdges.push({
        extension_name: extension,
        extension_version: versions.get(extension) ?? '',
        dependent_classid: edge.classid,
        dependent_objid: edge.objid,
        dependent_objsubid: edge.objsubid,
        dependent_description: edge.object_description,
        referenced_classid: edge.refclassid,
        referenced_objid: edge.refobjid,
        referenced_objsubid: edge.refobjsubid,
        referenced_description: edge.ref_object_description,
      })
      dependentKeys.add(dependent)
      const seen = visitedKey(extension, dependent)
      if (visited.has(seen)) continue
      visited.add(seen)
      record({
        extension_name: extension,
        extension_version: versions.get(extension) ?? null,
        classid: edge.classid, objid: edge.objid, objsubid: edge.objsubid,
        catalogue: edge.catalogue,
        object_description: edge.object_description,
        described: edge.object_description !== null && edge.object_description !== '',
        evidence_class: 'application_dependency',
      })
    }
  }

  // ── everything else IN `public` ──────────────────────────────────────────
  // An object already in any extension's closure, or already recorded as a
  // normal dependency on one, is accounted for and is not "unrelated".
  const inSomeClosure = new Set<string>()
  for (const closure of closureOf.values()) for (const key of closure) inSomeClosure.add(key)
  for (const object of publicObjects) {
    const key = objectKey(object.classid, object.objid, object.objsubid)
    if (inSomeClosure.has(key) || dependentKeys.has(key)) continue
    record({
      extension_name: null,
      extension_version: null,
      classid: object.classid, objid: object.objid, objsubid: object.objsubid,
      catalogue: object.catalogue,
      object_description: object.object_description,
      described: object.object_description !== null && object.object_description !== '',
      evidence_class: 'unrelated_public_object',
    })
  }

  const sorted = sortRowsCanonically(classifications)
  const count = (extension: string, klass: EvidenceClass): number =>
    sorted.filter(f => f.extension_name === extension && f.evidence_class === klass).length

  return {
    classifications: sorted,
    application_dependency_edges: sortRowsCanonically(applicationDependencyEdges),
    per_extension: sortRowsCanonically(
      [...closureOf.keys()].map(extension => ({
        extension_name: extension,
        extension_version: versions.get(extension) ?? '',
        direct_member: count(extension, 'direct_member'),
        internal_support: count(extension, 'internal_support'),
        application_dependency: count(extension, 'application_dependency'),
      })),
    ),
    totals: {
      direct_member: sorted.filter(f => f.evidence_class === 'direct_member').length,
      internal_support: sorted.filter(f => f.evidence_class === 'internal_support').length,
      application_dependency: sorted.filter(f => f.evidence_class === 'application_dependency').length,
      unrelated_public_object:
        sorted.filter(f => f.evidence_class === 'unrelated_public_object').length,
    },
  }
}

// ── Index facts ─────────────────────────────────────────────────────────────

export interface IndexFact {
  schema_name: string
  table_name: string
  index_name: string
  table_owner: string
  index_owner: string
  /** An index whose owner is not its table's owner. RECORDED, not judged —
   *  PostgreSQL keeps them in step, so a divergence is worth seeing rather than
   *  worth failing on, and deciding which it is belongs to enforcement. */
  owner_matches_table: boolean
  is_unique: boolean
  is_primary: boolean
  is_exclusion: boolean
  is_valid: boolean
  is_ready: boolean
  is_live: boolean
  index_definition: string
}

/**
 * `indisvalid`, `indisready` and `indislive` are three different things and are
 * kept apart. A concurrently-built index that failed is live and ready and NOT
 * valid — the planner ignores it while a UNIQUE one still enforces its
 * constraint — and collapsing the three into one "healthy" boolean would hide
 * exactly that state.
 */
export function buildIndexFacts(rows: readonly IndexRow[]): IndexFact[] {
  return sortRowsCanonically(
    rows.map(r => ({
      schema_name: r.schema_name,
      table_name: r.table_name,
      index_name: r.index_name,
      table_owner: r.table_owner,
      index_owner: r.index_owner,
      owner_matches_table: r.index_owner === r.table_owner,
      is_unique: r.is_unique,
      is_primary: r.is_primary,
      is_exclusion: r.is_exclusion,
      is_valid: r.is_valid,
      is_ready: r.is_ready,
      is_live: r.is_live,
      index_definition: r.index_definition,
    })),
  )
}

// ── The fact document ───────────────────────────────────────────────────────

export interface FactDocumentInput {
  /** OPERATOR-SUPPLIED and mandatory. See `binding` below. */
  run_id: string
  /** ISO-8601, UTC, with a `Z`. Asserted, not assumed. */
  collected_at: string
  /** The repository revision the collector's own source came from. */
  repository_head: string
  session: SessionIdentityRow
  server: ServerBindingRow
  probes: Readonly<Record<string, string>>
  raw: Readonly<Record<string, readonly unknown[]>>
}

export const ARTIFACT_VERSION = 2

/** Sections carried through verbatim (sorted, never filtered, never merged). */
const PASSTHROUGH_SECTIONS = [
  'database_acl',
  'schemas',
  'relations',
  'columns',
  'sequences',
  'routines',
  'types',
  'default_acls',
  'roles',
  'role_memberships',
  'policies',
  'triggers',
  'extensions',
] as const

/**
 * The evidence-binding tuple: what this artifact is evidence ABOUT.
 *
 * An inventory file with no binding is an assertion about "a database" — and a
 * month later nobody can say which one, when, from what code, or whether it was
 * the same cluster as last time. Each field closes one of those gaps, and each
 * is required:
 *
 *   run_id                 operator-supplied, never generated. A machine-made
 *                          id says only "some run"; an operator-made one ties
 *                          the file to the change, ticket or window it was
 *                          taken for. A generated default would silently make
 *                          two unrelated runs look equally well-attested.
 *   database_name + _oid   the NAME is reusable — drop and recreate `ai_capital`
 *                          and every name-based fact still matches while every
 *                          object is new. The OID says which database this was.
 *   endpoint               host or socket directory, port, database. NEVER the
 *                          user, the password or the raw URL. Derived from the
 *                          server, which does not know a credential to leak.
 *   server_version,        which engine, and which running instance: two
 *   postmaster_start_time  artifacts with the same start time came from the
 *   server_port,           same postmaster, and a changed start time means a
 *   cluster_name           restart happened between them. `cluster_name` is
 *                          recorded even when empty, because empty is its real
 *                          and default value.
 *   collected_at_utc       when, in UTC, so two artifacts are comparable across
 *                          machines and daylight-saving boundaries.
 *   repository_head        which source produced this. Read through an
 *                          injectable, read-only seam.
 *   manifest_recognition   which published schema the ledger matched.
 *   exit_status            added only by `markComplete`. A completed artifact
 *                          records the successful status; a failed run has no
 *                          artifact at all, so the field cannot ever say
 *                          anything but 0.
 */
export interface BindingFacts {
  run_id: string
  collected_at_utc: string
  repository_head: string
  database_name: string
  database_oid: string
  database_owner: string
  endpoint: {
    host: string | null
    socket_directories: string
    port: string
    database: string
  }
  server_version: string
  server_version_num: string
  postmaster_start_time: string
  server_port: string
  cluster_name: string
  manifest_recognition: ManifestRecognition
  manifest_version: string | null
}

/** Every binding field that must be present in a completed artifact. */
export const REQUIRED_BINDING_FIELDS: readonly string[] = Object.freeze([
  'run_id', 'collected_at_utc', 'repository_head', 'database_name', 'database_oid',
  'database_owner', 'endpoint', 'server_version', 'server_version_num',
  'postmaster_start_time', 'server_port', 'cluster_name', 'manifest_recognition',
  'manifest_version',
])

export function buildBindingFacts(
  input: FactDocumentInput,
  manifest: ManifestFacts,
): BindingFacts {
  if (!input.run_id) {
    throw new Error('@common/db inventory: the binding requires an operator-supplied run id.')
  }
  if (!/Z$/.test(input.collected_at)) {
    throw new Error(
      `@common/db inventory: collected_at "${input.collected_at}" is not UTC. Two artifacts ` +
      'taken in different zones would not be comparable.',
    )
  }
  return {
    run_id: input.run_id,
    collected_at_utc: input.collected_at,
    repository_head: input.repository_head,
    database_name: input.server.database_name,
    database_oid: input.server.database_oid,
    database_owner: input.server.database_owner,
    endpoint: {
      // NULL host means a Unix-socket connection; the socket directory is then
      // the endpoint. Neither carries a user name or a password.
      host: input.server.server_address,
      socket_directories: input.server.socket_directories,
      port: input.server.server_port,
      database: input.server.database_name,
    },
    server_version: input.server.server_version,
    server_version_num: input.server.server_version_num,
    postmaster_start_time: input.server.postmaster_start_time,
    server_port: input.server.server_port,
    cluster_name: input.server.cluster_name,
    manifest_recognition: manifest.recognition,
    manifest_version: manifest.recognition === 'CURRENT_V18' ? 'V18' : null,
  }
}

/**
 * Assemble the document.
 *
 * `complete` is FALSE here and stays false until the collector has rolled back,
 * closed its connection and published the file successfully. A document that
 * says `complete: true` therefore asserts something about the whole run, not
 * merely about the moment the rows were shaped.
 */
export function buildFactDocument(input: FactDocumentInput): Record<string, unknown> {
  const raw = input.raw
  const section = <T>(id: string): readonly T[] => (raw[id] ?? []) as readonly T[]

  const objects: Record<string, unknown> = {}
  for (const id of PASSTHROUGH_SECTIONS) {
    objects[id] = sortRowsCanonically(section<unknown>(id))
  }

  const migrations = recognizeManifest(section<SchemaMigrationRow>('schema_migrations'))

  return {
    artifact_version: ARTIFACT_VERSION,
    mode: 'inventory',
    complete: false,
    binding: buildBindingFacts(input, migrations),
    session: {
      current_database: input.session.current_database,
      current_user: input.session.current_user,
      session_user: input.session.session_user,
      transaction_read_only: input.session.transaction_read_only,
      server_version: input.session.server_version,
      server_version_num: input.session.server_version_num,
    },
    probes: Object.fromEntries(Object.entries(input.probes).map(([k, v]) => [k, String(v)])),
    migrations,
    objects,
    indexes: buildIndexFacts(section<IndexRow>('indexes')),
    extension_evidence: classifyExtensionEvidence(
      section<ExtensionMemberRow>('extension_members'),
      section<DependencyEdgeRow>('dependency_edges'),
      section<DependencyEdgeRow>('normal_dependency_edges'),
      section<PublicObjectRow>('public_objects'),
    ),
    counts: Object.fromEntries(
      Object.keys(raw).sort().map(id => [id, section<unknown>(id).length]),
    ),
  }
}

/**
 * Mark a document complete, and stamp the successful exit status.
 *
 * Called ONLY after the rollback, the disconnect and the file publication have
 * all succeeded. Because a failed run publishes nothing, `exit_status` in a
 * file on disk can only ever be 0 — which is the point: the status is part of
 * what the artifact attests, not a field that could contradict its own
 * existence.
 */
export function markComplete(document: Record<string, unknown>): Record<string, unknown> {
  const binding = document.binding as Record<string, unknown> | undefined
  if (!binding) {
    throw new Error('@common/db inventory: refusing to complete a document with no binding.')
  }
  for (const field of REQUIRED_BINDING_FIELDS) {
    if (!(field in binding)) {
      throw new Error(`@common/db inventory: the binding is missing "${field}"; refusing to publish.`)
    }
  }
  return { ...document, complete: true, binding: { ...binding, exit_status: 0 } }
}
