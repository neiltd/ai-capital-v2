// C1 — is it SAFE to move this source's rows into this target?
//
// WHY THIS IS NOT DIGEST EQUALITY. The first version of Stage 2 asked whether
// the source contract's digest equalled the reviewed target's. That is a
// stricter question than the one that matters and a different one: the source
// is a CURRENT_V10 database and the target is CURRENT_V19, so their contracts
// differ in the migration ledger alone and the digests can never match. Worse,
// digest equality would also refuse differences that are harmless (a reporting
// index the target has and the source does not) while telling a reader nothing
// about WHICH property diverged when it refused.
//
// SO THE QUESTION IS ASKED PROPERTY BY PROPERTY, and the answer names the
// property. Three kinds of thing are compared:
//
//   EQUALITY-REQUIRED. Everything a binary COPY of an explicit column list
//   depends on: the ordered live-column names, the resolved type with its
//   typmod, nullability, defaults, identity and generation policy, the full
//   collation identity, the key and check constraints, the sequence linkage and
//   every sequence option, and the platform facts that change how a value is
//   read or written. If any of these differ the copy is not a copy.
//
//   ALLOWED TARGET SUPERSETS, and ONLY these two. The target may carry extra
//   NON-identity indexes - they cannot change a value, only the cost of finding
//   one - and extra foreign keys, but only if they are VALIDATED,
//   NON-DEFERRABLE and NON-DEFERRED, because a NOT VALID or deferred constraint
//   is one that has not actually been enforced against the rows about to
//   arrive.
//
//   DELIBERATELY NOT COMPARED. Owners differ by design: the legacy source is
//   owned by a person and the reviewed target by `ai_capital_owner`. ACLs,
//   grants, default ACLs and role memberships are the target authority's
//   business, not the copy's. Objects outside the 21-table domain are none of
//   this function's concern. Extension SETS are not compared beyond the one
//   thing that changes bytes on the wire - the `vector` version. And the
//   migration ledgers are checked INDEPENDENTLY on each side: requiring a V10
//   ledger to equal a V19 ledger would refuse every legitimate copy there is.
//
// FAIL-CLOSED ON BOTH SIDES. A non-internal INSERT trigger, row-level security,
// a stored generated column, an identity column or a nondeterministic or
// version-drifted collation is refused wherever it appears - source or target -
// because each of them can change what ends up in a row without the copy ever
// seeing it happen.

import {
  COPY_SEQUENCES, COPY_TABLES, type Canonical, type ContractArtifact,
} from './schema-contract.js'

/** WHICH property diverged. A closed set, so a refusal is always specific. */
export type CompatibilityCategory =
  | 'copy-set'
  | 'relation-kind'
  | 'column-sequence'
  | 'column-type'
  | 'column-nullability'
  | 'column-default'
  | 'column-identity'
  | 'column-generated'
  | 'column-collation'
  | 'key-constraints'
  | 'check-constraints'
  | 'foreign-keys'
  | 'identity-indexes'
  | 'sequence-linkage'
  | 'sequence-options'
  | 'platform'
  | 'vector-extension'
  | 'row-security'
  | 'insert-triggers'

/** WHY it was refused. A CLOSED union of reviewed sentences. */
export type CompatibilityReason =
  | 'the source and target do not describe the same reviewed copy set'
  | 'a reviewed relation is not an ordinary permanent table on both sides'
  | 'the ordered live-column sequence differs'
  | 'a column type differs'
  | 'a column nullability differs'
  | 'a column default differs'
  | 'a column identity policy differs'
  | 'a column generation policy differs'
  | 'a column collation differs'
  | 'a column uses a nondeterministic collation'
  | 'a column collation has drifted from the version it was built with'
  | 'a primary key or unique constraint differs'
  | 'a check constraint differs'
  | 'a source foreign key is missing from the target'
  | 'a target-only foreign key is not validated, non-deferrable and non-deferred'
  | 'a primary or unique index differs'
  | 'a primary or unique index is not valid and ready'
  | 'a target-only index is a primary or unique index'
  | 'the sequence linkage of a column differs'
  | 'a reviewed sequence option differs'
  | 'a platform property differs'
  | 'the vector extension version differs'
  | 'row level security is enabled on a reviewed table'
  | 'a reviewed table carries a non-internal INSERT trigger'
  | 'a reviewed table carries a stored generated column'
  | 'a reviewed table carries an identity column'

export class CopyIncompatible extends Error {
  constructor(
    readonly category: CompatibilityCategory,
    readonly reason: CompatibilityReason,
    readonly qname: string | null = null,
    readonly column: string | null = null,
  ) {
    super(
      `${reason} (${category}` +
      `${qname === null ? '' : ` for ${qname}`}` +
      `${column === null ? '' : `.${column}`})`)
    this.name = 'CopyIncompatible'
  }
}

// ---------------------------------------------------------------------------
// The payload shapes this comparator reads. Narrow, and named once.
// ---------------------------------------------------------------------------

interface Collation {
  readonly schema: string | null
  readonly name: string | null
  readonly provider: string | null
  readonly deterministic: boolean | null
  readonly encoding: number | null
  readonly collate: string | null
  readonly ctype: string | null
  readonly locale: string | null
  readonly icu_rules: string | null
  readonly version: string | null
  readonly actual_version: string | null
}

interface Column {
  readonly position: number
  readonly name: string
  readonly format_type: string
  readonly not_null: boolean
  readonly has_default: boolean
  readonly default_expression: string | null
  readonly identity: string | null
  readonly generated: string | null
  readonly serial_sequence: string | null
  readonly identity_sequence: string | null
  readonly collation: Collation | null
}

interface Constraint {
  readonly name: string
  readonly type: string
  readonly definition: string
  readonly columns: string
  readonly validated: boolean
  readonly deferrable: boolean
  readonly deferred: boolean
}

interface Index {
  readonly name: string
  readonly definition: string
  readonly is_primary: boolean
  readonly is_unique: boolean
  readonly is_valid: boolean
  readonly is_ready: boolean
  readonly predicate: string
  readonly expressions: string
}

interface Table {
  readonly qname: string
  readonly relkind: string
  readonly relpersistence: string
  readonly row_security: boolean
  readonly force_row_security: boolean
  readonly columns: readonly Column[]
  readonly constraints: readonly Constraint[]
  readonly indexes: readonly Index[]
}

interface Sequence {
  readonly qname: string
  readonly data_type: string
  readonly start_value: string
  readonly increment_by: string
  readonly min_value: string
  readonly max_value: string
  readonly cache_size: string
  readonly cycle: boolean
  readonly owned_by: string
}

interface Platform {
  readonly server_version_major: number
  readonly encoding: string
  readonly lc_collate: string
  readonly lc_ctype: string
  readonly timezone: string
  readonly default_text_search_config: string
  readonly extensions: ReadonlyArray<{ name: string; version: string; schema: string }>
}

interface Payload {
  readonly table_order: readonly string[]
  readonly tables: readonly Table[]
  readonly sequences: readonly Sequence[]
  readonly platform: Platform
}

const payloadOf = (a: ContractArtifact): Payload => a.payload as unknown as Payload

/**
 * What the comparator ALLOWED, recorded rather than merely permitted.
 *
 * A superset that is tolerated silently is a superset nobody ever reviews. The
 * full definition of every target-only index and foreign key is returned, so
 * the caller can put it in the manifest and a person can read later what this
 * copy was willing to accept.
 */
export interface CompatibilityReport {
  readonly sourceRecognition: string
  readonly targetRecognition: string
  readonly targetOnlyIndexes: ReadonlyArray<{
    qname: string; name: string; definition: string
    is_valid: boolean; is_ready: boolean; predicate: string; expressions: string
  }>
  readonly targetOnlyForeignKeys: ReadonlyArray<{
    qname: string; name: string; definition: string
  }>
}

/** The reviewed identity of one constraint, independent of its NAME. */
const constraintKey = (c: Constraint): string => `${c.type}|${c.definition}`

/** The reviewed identity of one index, independent of its NAME. */
const indexKey = (i: Index): string =>
  `${i.is_primary ? 'p' : ''}${i.is_unique ? 'u' : ''}|` +
  `${i.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, '')}|` +
  `${i.predicate}|${i.expressions}`

function collationKey(c: Collation | null): string {
  if (c === null) return 'none'
  // EVERY field, because two collations that agree on a name and disagree on a
  // provider or a locale sort differently - and a PK built on one of them does
  // not mean the same thing on the other.
  return [c.schema, c.name, c.provider, String(c.deterministic), String(c.encoding),
          c.collate, c.ctype, c.locale, c.icu_rules].map(v => String(v)).join('|')
}

/**
 * Refuse what neither side may carry, whichever side it is on.
 *
 * Run over BOTH contracts before anything is compared, because a target that
 * quietly rewrites a row on INSERT makes every later equality meaningless.
 */
export function assertCopyDomainSafe(artifact: ContractArtifact): void {
  const p = payloadOf(artifact)
  for (const t of p.tables) {
    if (t.row_security || t.force_row_security) {
      throw new CopyIncompatible(
        'row-security', 'row level security is enabled on a reviewed table', t.qname)
    }
    for (const c of t.columns) {
      if (c.generated !== null && c.generated !== '') {
        throw new CopyIncompatible(
          'column-generated', 'a reviewed table carries a stored generated column',
          t.qname, c.name)
      }
      if (c.identity !== null && c.identity !== '') {
        throw new CopyIncompatible(
          'column-identity', 'a reviewed table carries an identity column', t.qname, c.name)
      }
      const col = c.collation
      if (col !== null) {
        if (col.deterministic === false) {
          throw new CopyIncompatible(
            'column-collation', 'a column uses a nondeterministic collation', t.qname, c.name)
        }
        if (col.version !== null && col.actual_version !== null &&
            col.version !== col.actual_version) {
          throw new CopyIncompatible(
            'column-collation',
            'a column collation has drifted from the version it was built with',
            t.qname, c.name)
        }
      }
    }
  }
}

/**
 * C1. Refuse unless every row the source holds can land in the target unchanged.
 *
 * The order of the checks is deliberate: the copy SET first, then what each
 * relation IS, then the columns a binary COPY names, then the constraints those
 * columns must satisfy, then the sequences, then the platform. A refusal
 * therefore names the earliest thing that is wrong rather than a downstream
 * symptom of it.
 */
export function assertCopyCompatible(
  source: ContractArtifact, target: ContractArtifact,
): CompatibilityReport {
  assertCopyDomainSafe(source)
  assertCopyDomainSafe(target)

  const s = payloadOf(source)
  const t = payloadOf(target)

  // ---- the copy set -------------------------------------------------------
  const reviewed = [...COPY_TABLES]
  for (const p of [s, t]) {
    if (p.table_order.length !== reviewed.length ||
        p.table_order.some((q, i) => q !== reviewed[i])) {
      throw new CopyIncompatible(
        'copy-set', 'the source and target do not describe the same reviewed copy set')
    }
  }
  const sTables = new Map(s.tables.map(x => [x.qname, x]))
  const tTables = new Map(t.tables.map(x => [x.qname, x]))

  const targetOnlyIndexes: CompatibilityReport['targetOnlyIndexes'][number][] = []
  const targetOnlyForeignKeys: CompatibilityReport['targetOnlyForeignKeys'][number][] = []

  for (const qname of reviewed) {
    const a = sTables.get(qname)
    const b = tTables.get(qname)
    if (a === undefined || b === undefined) {
      throw new CopyIncompatible(
        'copy-set', 'the source and target do not describe the same reviewed copy set', qname)
    }

    // ---- what the relation IS --------------------------------------------
    for (const r of [a, b]) {
      if (r.relkind !== 'r' || r.relpersistence !== 'p') {
        throw new CopyIncompatible(
          'relation-kind', 'a reviewed relation is not an ordinary permanent table on both sides',
          qname)
      }
    }

    // ---- the ordered live-column sequence --------------------------------
    // THIS IS THE ONE THE COPY ACTUALLY DEPENDS ON. Binary COPY carries no
    // column names; it carries values in the order the statement named them.
    // Dropped-column attnums are deliberately NOT compared - a physical gap on
    // one side is invisible to an explicit column list.
    if (a.columns.length !== b.columns.length ||
        a.columns.some((c, i) => c.name !== b.columns[i].name)) {
      throw new CopyIncompatible('column-sequence', 'the ordered live-column sequence differs', qname)
    }

    for (let i = 0; i < a.columns.length; i += 1) {
      const ca = a.columns[i]
      const cb = b.columns[i]
      const where = (cat: CompatibilityCategory, why: CompatibilityReason): never => {
        throw new CopyIncompatible(cat, why, qname, ca.name)
      }
      // The resolved type, typmod included - `numeric(12,4)` is not `numeric`.
      if (ca.format_type !== cb.format_type) where('column-type', 'a column type differs')
      if (ca.not_null !== cb.not_null) {
        where('column-nullability', 'a column nullability differs')
      }
      if (ca.has_default !== cb.has_default ||
          (ca.default_expression ?? '') !== (cb.default_expression ?? '')) {
        where('column-default', 'a column default differs')
      }
      if ((ca.identity ?? '') !== (cb.identity ?? '')) {
        where('column-identity', 'a column identity policy differs')
      }
      if ((ca.generated ?? '') !== (cb.generated ?? '')) {
        where('column-generated', 'a column generation policy differs')
      }
      if (collationKey(ca.collation) !== collationKey(cb.collation)) {
        where('column-collation', 'a column collation differs')
      }
      // Sequence LINKAGE: which sequence, if any, feeds this column.
      if ((ca.serial_sequence ?? '') !== (cb.serial_sequence ?? '') ||
          (ca.identity_sequence ?? '') !== (cb.identity_sequence ?? '')) {
        where('sequence-linkage', 'the sequence linkage of a column differs')
      }
    }

    // ---- keys and checks --------------------------------------------------
    const keyKeys = (r: Table): string[] => r.constraints
      .filter(c => c.type === 'p' || c.type === 'u').map(constraintKey).sort()
    const sk = keyKeys(a)
    const tk = keyKeys(b)
    if (sk.length !== tk.length || sk.some((k, i) => k !== tk[i])) {
      throw new CopyIncompatible(
        'key-constraints', 'a primary key or unique constraint differs', qname)
    }
    const checkKeys = (r: Table): string[] => r.constraints
      .filter(c => c.type === 'c').map(constraintKey).sort()
    const sc = checkKeys(a)
    const tc = checkKeys(b)
    if (sc.length !== tc.length || sc.some((k, i) => k !== tc[i])) {
      throw new CopyIncompatible('check-constraints', 'a check constraint differs', qname)
    }

    // ---- foreign keys: every source FK on the target, extras only if real --
    const sFk = a.constraints.filter(c => c.type === 'f')
    const tFk = b.constraints.filter(c => c.type === 'f')
    const tFkKeys = new Set(tFk.map(constraintKey))
    for (const f of sFk) {
      if (!tFkKeys.has(constraintKey(f))) {
        throw new CopyIncompatible(
          'foreign-keys', 'a source foreign key is missing from the target', qname)
      }
    }
    const sFkKeys = new Set(sFk.map(constraintKey))
    for (const f of tFk) {
      if (sFkKeys.has(constraintKey(f))) continue
      // A TARGET-ONLY FK. Allowed, but only if it has actually been enforced:
      // NOT VALID means existing rows were never checked, and deferrable or
      // deferred means the check can be postponed past the point where this
      // copy would have seen it fail.
      if (!f.validated || f.deferrable || f.deferred) {
        throw new CopyIncompatible(
          'foreign-keys',
          'a target-only foreign key is not validated, non-deferrable and non-deferred', qname)
      }
      targetOnlyForeignKeys.push({ qname, name: f.name, definition: f.definition })
    }

    // ---- indexes: identity ones must match; extras must not be identity ---
    const identity = (r: Table): Index[] => r.indexes.filter(x => x.is_primary || x.is_unique)
    for (const r of [a, b]) {
      for (const x of identity(r)) {
        if (!x.is_valid || !x.is_ready) {
          throw new CopyIncompatible(
            'identity-indexes', 'a primary or unique index is not valid and ready', qname)
        }
      }
    }
    const si = identity(a).map(indexKey).sort()
    const ti = identity(b).map(indexKey).sort()
    if (si.length !== ti.length || si.some((k, i) => k !== ti[i])) {
      throw new CopyIncompatible('identity-indexes', 'a primary or unique index differs', qname)
    }
    const sAll = new Set(a.indexes.map(indexKey))
    for (const x of b.indexes) {
      if (sAll.has(indexKey(x))) continue
      // A TARGET-ONLY INDEX. Allowed ONLY if it is not an identity index: a
      // unique index the source does not have can refuse rows the source holds.
      if (x.is_primary || x.is_unique) {
        throw new CopyIncompatible(
          'identity-indexes', 'a target-only index is a primary or unique index', qname)
      }
      targetOnlyIndexes.push({
        qname, name: x.name, definition: x.definition,
        is_valid: x.is_valid, is_ready: x.is_ready,
        predicate: x.predicate, expressions: x.expressions,
      })
    }
  }

  // ---- sequences ---------------------------------------------------------
  const sSeq = new Map(s.sequences.map(x => [x.qname, x]))
  const tSeq = new Map(t.sequences.map(x => [x.qname, x]))
  for (const qname of COPY_SEQUENCES) {
    const a = sSeq.get(qname)
    const b = tSeq.get(qname)
    if (a === undefined || b === undefined) {
      throw new CopyIncompatible('sequence-options', 'a reviewed sequence option differs', qname)
    }
    const key = (x: Sequence): string => [
      x.data_type, x.start_value, x.increment_by, x.min_value, x.max_value,
      x.cache_size, String(x.cycle), x.owned_by,
    ].join('|')
    if (key(a) !== key(b)) {
      throw new CopyIncompatible('sequence-options', 'a reviewed sequence option differs', qname)
    }
  }

  // ---- platform ----------------------------------------------------------
  const pKey = (p: Platform): string => [
    String(p.server_version_major), p.encoding, p.lc_collate, p.lc_ctype,
    p.timezone, p.default_text_search_config,
  ].join('|')
  if (s.platform.server_version_major !== 17 || t.platform.server_version_major !== 17) {
    throw new CopyIncompatible('platform', 'a platform property differs')
  }
  if (pKey(s.platform) !== pKey(t.platform)) {
    throw new CopyIncompatible('platform', 'a platform property differs')
  }

  // THE VECTOR VERSION AND NOTHING ELSE ABOUT EXTENSIONS. `vector_send` is the
  // function the content digest hashes through, so a version change can change
  // the bytes; the rest of the extension set is the target's own business, and
  // requiring the source to carry a target-only extension such as `btree_gist`
  // would refuse a perfectly copyable source.
  const vec = (p: Platform): string | null =>
    p.extensions.find(e => e.name === 'vector')?.version ?? null
  if (vec(s.platform) === null || vec(s.platform) !== vec(t.platform)) {
    throw new CopyIncompatible('vector-extension', 'the vector extension version differs')
  }

  const recognitionOf = (a: ContractArtifact): string =>
    String((a.payload as unknown as { migrations: { recognition: string } }).migrations.recognition)

  return Object.freeze({
    // THE LEDGERS ARE REPORTED, NEVER COMPARED. Each side was recognised
    // exactly, independently, when its contract was extracted.
    sourceRecognition: recognitionOf(source),
    targetRecognition: recognitionOf(target),
    targetOnlyIndexes: Object.freeze(targetOnlyIndexes),
    targetOnlyForeignKeys: Object.freeze(targetOnlyForeignKeys),
  })
}

/** The report as a canonical document, for the manifest and the evidence. */
export function compatibilityDocument(r: CompatibilityReport): Canonical {
  return {
    source_recognition: r.sourceRecognition,
    target_recognition: r.targetRecognition,
    target_only_indexes: r.targetOnlyIndexes.map(i => ({
      qname: i.qname, name: i.name, definition: i.definition,
      is_valid: i.is_valid, is_ready: i.is_ready,
      predicate: i.predicate, expressions: i.expressions,
    })),
    target_only_foreign_keys: r.targetOnlyForeignKeys.map(f => ({
      qname: f.qname, name: f.name, definition: f.definition,
    })),
  }
}
