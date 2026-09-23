/**
 * Fact-shaping and query-vocabulary contract.
 *
 * These tests run against hand-built catalogue fixtures and never open a
 * connection — `src/inventory-facts.ts` imports no driver and performs no I/O,
 * which is what makes that possible and is itself part of the contract. The
 * query definitions are asserted as TEXT, because a parameterless SQL literal
 * is the one thing about a database tool that can be checked without a
 * database, and the properties being checked (which relkinds carry an ACL,
 * whether a probe is tautological) are visible in the text.
 *
 * The recurring theme is FIDELITY. Almost every assertion exists to stop the
 * collector from being tidier than the database: a NULL ACL that really means
 * "EXECUTE TO PUBLIC", two grants that differ only by grantor, a TEMP privilege
 * nobody was looking for, an index that is live and ready and not valid, a
 * membership that carries SET and not INHERIT. Each is a shape a reasonable
 * simplification would erase, and each erasure makes the inventory understate
 * the database's real reach.
 */

import { describe, it, expect } from 'vitest'

import {
  buildBindingFacts,
  buildFactDocument,
  buildIndexFacts,
  canonicalJson,
  classifyExtensionEvidence,
  markComplete,
  recognizeManifest,
  REQUIRED_BINDING_FIELDS,
  sortRowsCanonically,
} from '../src/inventory-facts.js'
import {
  CURRENT_V19_MANIFEST,
  INVENTORY_QUERIES,
  PROBE_QUERIES,
  SERVER_BINDING_QUERY,
  SESSION_IDENTITY_QUERY,
} from '../src/inventory-queries.js'
import type {
  PublicObjectRow,
  DependencyEdgeRow,
  ExtensionMemberRow,
  IndexRow,
  SchemaMigrationRow,
  ServerBindingRow,
  SessionIdentityRow,
} from '../src/inventory-queries.js'

const SESSION: SessionIdentityRow = {
  current_database: 'ai_capital',
  current_user: 'ai_capital_migrator',
  session_user: 'ai_capital_migrator',
  transaction_read_only: 'on',
  server_version: '16.4',
  server_version_num: '160004',
}

const SERVER: ServerBindingRow = {
  database_name: 'ai_capital',
  database_oid: '16401',
  database_owner: 'thanapold',
  server_version: '16.4',
  server_version_num: '160004',
  postmaster_start_time: '2026-09-01 03:14:15+00',
  server_port: '5432',
  cluster_name: '',
  server_address: null,
  socket_directories: '/tmp',
}

function ledgerRows(): SchemaMigrationRow[] {
  return CURRENT_V19_MANIFEST.map(m => ({
    filename: m.filename,
    sha256: m.sha256,
    applied_at: '2026-09-09 12:00:00+00',
  }))
}

// ── Canonical serialization ─────────────────────────────────────────────────

describe('canonical serialization', () => {
  it('sorts keys at every level and ends with exactly one LF', () => {
    const text = canonicalJson({ b: 1, a: { d: true, c: [3, 1, 2] } })
    expect(text).toBe('{\n  "a": {\n    "c": [\n      3,\n      1,\n      2\n    ],\n    "d": true\n  },\n  "b": 1\n}\n')
    expect(text).not.toContain('\r')
  })

  it('is byte-identical for the same facts gathered in a different order', () => {
    const one = canonicalJson({ alpha: 1, beta: { x: 'a', y: 'b' } })
    const two = canonicalJson({ beta: { y: 'b', x: 'a' }, alpha: 1 })
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(true)
  })

  it('refuses a float, because it has no single decimal spelling', () => {
    expect(() => canonicalJson({ ratio: 0.1 })).toThrow(/float/)
  })

  it('refuses undefined rather than letting a dropped field become a smaller valid document', () => {
    expect(() => canonicalJson({ owner: undefined })).toThrow(/undefined/)
  })

  it('refuses NaN and Infinity', () => {
    expect(() => canonicalJson({ n: NaN })).toThrow(/non-finite/)
    expect(() => canonicalJson({ n: Infinity })).toThrow(/non-finite/)
  })

  it('sorts rows without deduplicating them — two identical ACL tuples are two grants', () => {
    const tuple = { grantee: 'ai_capital_agent', privilege_type: 'SELECT' }
    expect(sortRowsCanonically([tuple, { ...tuple }])).toHaveLength(2)
  })
})

// ── Query vocabulary, asserted as text ──────────────────────────────────────

describe('query definitions', () => {
  const byId = new Map(INVENTORY_QUERIES.map(q => [q.id, q.sql]))

  it('every statement the collector may send begins with SELECT', () => {
    for (const query of [...INVENTORY_QUERIES, ...PROBE_QUERIES,
                         SESSION_IDENTITY_QUERY, SERVER_BINDING_QUERY]) {
      expect(query.sql.startsWith('SELECT'), `${query.id} does not begin with SELECT`).toBe(true)
    }
  })

  it('no query is parameterised — there is nothing to interpolate', () => {
    for (const query of INVENTORY_QUERIES) {
      expect(query.sql, `${query.id} carries a bind placeholder`).not.toMatch(/\$\d/)
    }
  })

  it('restricts relation ACL collection to grantable relkinds', () => {
    // acldefault('r', owner) returns the full table privilege set for ANY input.
    // Applied to an index or a composite type's row relation it fabricates eight
    // grants that cannot exist. The relkind filter is what stops that.
    const relations = byId.get('relations') as string
    expect(relations).toContain("c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')")
    expect(relations).not.toMatch(/relkind\s+IN\s+\([^)]*'i'/)
    expect(relations).not.toMatch(/relkind\s+IN\s+\([^)]*'c'/)
    expect(relations).not.toMatch(/relkind\s+IN\s+\([^)]*'t'/)
  })

  it('restricts column ACL collection to the same grantable relkinds', () => {
    expect(byId.get('columns')).toContain("c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')")
  })

  it('uses the sequence ACL default for sequences and the relation default otherwise', () => {
    expect(byId.get('relations')).toContain("CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END")
  })

  it('keeps indexes, which carry no ACL, in their own dedicated section', () => {
    const indexes = byId.get('indexes') as string
    expect(indexes).toContain('pg_index')
    expect(indexes).not.toContain('acldefault')
    expect(indexes).not.toContain('aclexplode')
  })

  it('collects inherit_option and set_option alongside admin_option', () => {
    const memberships = byId.get('role_memberships') as string
    expect(memberships).toContain('admin_option')
    expect(memberships).toContain("'inherit_option'")
    expect(memberships).toContain("'set_option'")
  })

  it('records the database OID, not only the reusable name', () => {
    expect(byId.get('database_acl')).toContain('d.oid::text AS datoid')
    expect(SERVER_BINDING_QUERY.sql).toContain('d.oid::text  AS database_oid')
  })

  it('asks the SERVER for the endpoint and never parses the credential', () => {
    const sql = SERVER_BINDING_QUERY.sql
    expect(sql).toContain('inet_server_addr()')
    expect(sql).toContain('unix_socket_directories')
    expect(sql).toContain("current_setting('port')")
    expect(sql).toContain("current_setting('cluster_name')")
    expect(sql).toContain('pg_postmaster_start_time()')
    // The endpoint comes from the LISTENER, never from the credential: no
    // password, and no client identity of any kind.
    expect(sql).not.toMatch(/password/i)
    expect(sql).not.toMatch(/session_user|current_user|inet_client/)
  })

  it('probes capability against a non-self role, and none of them is tautological', () => {
    const ids = PROBE_QUERIES.map(p => p.id)
    expect(ids).toEqual(['probe_has_table_privilege', 'probe_has_schema_privilege', 'probe_pg_has_role'])
    for (const probe of PROBE_QUERIES) {
      // A tautology — count(*) >= 1, or worse count(*) + 1 — asserts nothing.
      expect(probe.sql, `${probe.id} counts rows instead of asking a question`).not.toContain('count(*)')
      // Upper case only because the queries spell the special form that way;
      // PostgreSQL key words are case-insensitive, so the casing carries no
      // meaning. What matters is that the form is UNQUALIFIED — see the
      // 'SQL special forms' block below.
      expect(probe.sql, `${probe.id} does not exclude the current user`).toContain('CURRENT_USER')
      expect(probe.sql, `${probe.id} does not exclude the current principal with CURRENT_USER::text`)
        .toContain('CURRENT_USER::text')
      expect(probe.sql, `${probe.id} schema-qualifies CURRENT_USER`).not.toContain('pg_catalog.current_user')
    }
    expect(PROBE_QUERIES[0].sql).toContain('has_table_privilege')
    expect(PROBE_QUERIES[1].sql).toContain('has_schema_privilege')
    expect(PROBE_QUERIES[2].sql).toContain('pg_has_role')
  })

  it('describes catalogue objects with pg_describe_object so unusual classes survive', () => {
    expect(byId.get('extension_members')).toContain('pg_describe_object')
    expect(byId.get('dependency_edges')).toContain('pg_describe_object')
    expect(byId.get('normal_dependency_edges')).toContain('pg_describe_object')
    expect(byId.get('public_objects')).toContain('pg_describe_object')
  })

  it('discovers public objects by OBJECT ADDRESS, not by a list of three catalogues', () => {
    const publicObjects = byId.get('public_objects') as string
    expect(publicObjects, 'the fourth class must be scoped to schema public')
      .toContain("n.nspname = 'public'")
    // Namespace membership via pg_depend reaches every catalogue class the
    // server has, including pg_operator and pg_opclass.
    expect(publicObjects).toContain("d.refclassid = 'pg_namespace'::regclass")
    expect(publicObjects).toContain('pg_catalog.pg_depend')
    // The three-catalogue UNION is what limited the previous version.
    expect(publicObjects).not.toContain('UNION ALL')
    expect(publicObjects).not.toContain('pg_catalog.pg_proc')
    expect(publicObjects).not.toContain('pg_catalog.pg_type')
    expect(byId.has('application_objects'),
           'the old all-application-schema query must be gone').toBe(false)
  })

  it('collects the normal (n) dependency relation, not only the i/a closure', () => {
    expect(byId.get('dependency_edges')).toContain("d.deptype IN ('i', 'a')")
    expect(byId.get('normal_dependency_edges')).toContain("d.deptype = 'n'")
  })

  it('preserves the extension version at the point of membership', () => {
    expect(byId.get('extension_members')).toContain('e.extversion AS extension_version')
  })
})

// ── Manifest recognition ────────────────────────────────────────────────────

describe('manifest recognition', () => {
  it('recognises CURRENT_V19 only from all nineteen filenames with exact hashes', () => {
    const facts = recognizeManifest(ledgerRows())
    expect(facts.recognition).toBe('CURRENT_V19')
    expect(facts.recorded_count).toBe(19)
    expect(facts.missing).toEqual([])
    expect(facts.additional).toEqual([])
    expect(facts.hash_mismatched).toEqual([])
  })

  it('a single changed hash is UNRECOGNIZED, and the mismatch is recorded', () => {
    const rows = ledgerRows()
    rows[6] = { ...rows[6], sha256: '0'.repeat(64) }
    const facts = recognizeManifest(rows)
    expect(facts.recognition).toBe('UNRECOGNIZED')
    expect(facts.hash_mismatched).toEqual([{
      filename: '007_trade.sql',
      recorded_sha256: '0'.repeat(64),
      manifest_sha256: CURRENT_V19_MANIFEST[6].sha256,
    }])
  })

  it('a missing migration is UNRECOGNIZED and named', () => {
    const facts = recognizeManifest(ledgerRows().filter(r => r.filename !== '012_identity_security.sql'))
    expect(facts.recognition).toBe('UNRECOGNIZED')
    expect(facts.missing).toEqual(['012_identity_security.sql'])
  })

  it('an additional migration is UNRECOGNIZED — there is no V20 in this build', () => {
    // The fictional file moved 019 -> 020 when 019 became real. A fixture naming
    // a migration the manifest DOES know would stop testing "additional" and
    // start testing a hash mismatch.
    const facts = recognizeManifest([...ledgerRows(), {
      filename: '020_future.sql', sha256: 'f'.repeat(64), applied_at: '2026-09-10 00:00:00+00',
    }])
    expect(facts.recognition).toBe('UNRECOGNIZED')
    expect(facts.additional).toEqual(['020_future.sql'])
  })

  it('a DUPLICATED migration row is UNRECOGNIZED', () => {
    // The shape the length comparison exists for. With a row recorded twice
    // nothing is missing and nothing is additional — every filename is one the
    // manifest knows — so only the count separates this from an exact match.
    const rows = ledgerRows()
    const facts = recognizeManifest([...rows, rows[3]])
    expect(facts.recognition).toBe('UNRECOGNIZED')
    // 19 manifest rows PLUS the repeat. recorded_count and expected_count
    // differing by exactly one is the whole signal: nothing is missing and
    // nothing is additional, so the length comparison is the only thing that
    // separates a duplicated row from an exact match.
    expect(facts.recorded_count).toBe(20)
    expect(facts.expected_count).toBe(19)
    expect(facts.missing).toEqual([])
    expect(facts.additional).toEqual([])
  })

  it('a ledger row naming a file the manifest has never heard of is UNRECOGNIZED', () => {
    const rows = ledgerRows()
    rows[0] = { ...rows[0], filename: '001_portfolio_renamed.sql' }
    const facts = recognizeManifest(rows)
    expect(facts.recognition).toBe('UNRECOGNIZED')
    expect(facts.missing).toContain('001_portfolio.sql')
    expect(facts.additional).toContain('001_portfolio_renamed.sql')
  })

  it('preserves the lower-case migration filenames verbatim, `trade` included', () => {
    const facts = recognizeManifest(ledgerRows())
    expect(facts.recorded.map(r => r.filename)).toContain('007_trade.sql')
    expect(facts.recorded.every(r => r.filename === r.filename.toLowerCase())).toBe(true)
  })
})

// ── Extension evidence: the four-way model ──────────────────────────────────

const member = (objid: string, over: Partial<ExtensionMemberRow> = {}): ExtensionMemberRow => ({
  extension_name: 'vector', extension_version: '0.7.4',
  classid: '1259', objid, objsubid: '0', catalogue: 'pg_class',
  object_description: `type public.thing${objid}`, ...over,
})

const edge = (from: string, to: string, deptype = 'i'): DependencyEdgeRow => ({
  classid: '1259', objid: from, objsubid: '0',
  refclassid: '1259', refobjid: to, refobjsubid: '0',
  deptype, catalogue: 'pg_class', ref_catalogue: 'pg_class',
  object_description: `object ${from}`, ref_object_description: `object ${to}`,
})

/** An object discovered in schema `public`, by object address. */
const publicObject = (objid: string, over: Partial<PublicObjectRow> = {}): PublicObjectRow => ({
  classid: '1259', objid, objsubid: '0', catalogue: 'pg_class',
  object_description: `table public.t${objid}`, ...over,
})

describe('extension evidence', () => {
  it('terminates on a cyclic dependency fixture', () => {
    // A ↔ B, plus B → C → A. Every naive recursive walk over this loops forever.
    const facts = classifyExtensionEvidence(
      [member('100')],
      [edge('200', '100'), edge('100', '200'), edge('300', '200'), edge('100', '300')],
    )
    expect(facts.classifications.map(f => f.objid).sort()).toEqual(['100', '200', '300'])
  })

  it('visits an object reached by two different paths exactly once per extension', () => {
    const facts = classifyExtensionEvidence(
      [member('1')],
      [edge('2', '1'), edge('3', '1'), edge('4', '2'), edge('4', '3')],
    )
    expect(facts.classifications.filter(f => f.objid === '4')).toHaveLength(1)
  })

  it('keeps direct membership and internal support distinct', () => {
    const facts = classifyExtensionEvidence([member('10')], [edge('11', '10')])
    const classes = Object.fromEntries(facts.classifications.map(f => [f.objid, f.evidence_class]))
    expect(classes['10']).toBe('direct_member')
    expect(classes['11']).toBe('internal_support')
    expect(facts.totals.direct_member).toBe(1)
    expect(facts.totals.internal_support).toBe(1)
  })

  it('records an application object with a normal dependency on the closure', () => {
    const facts = classifyExtensionEvidence(
      [member('10')],
      [edge('11', '10')],
      [edge('900', '11', 'n')],
      [publicObject('900')],
    )
    const found = facts.classifications.find(f => f.objid === '900')
    expect(found?.evidence_class).toBe('application_dependency')
    expect(found?.extension_name).toBe('vector')
    expect(facts.application_dependency_edges).toHaveLength(1)
    expect(facts.application_dependency_edges[0].referenced_objid).toBe('11')
    expect(facts.application_dependency_edges[0].extension_version).toBe('0.7.4')
  })

  it('records an unrelated PUBLIC table — in no closure and depending on none', () => {
    const facts = classifyExtensionEvidence(
      [member('10')], [], [], [publicObject('555')],
    )
    const found = facts.classifications.find(f => f.objid === '555')
    expect(found?.evidence_class).toBe('unrelated_public_object')
    expect(found?.extension_name).toBeNull()
    expect(found?.catalogue).toBe('pg_class')
    expect(facts.totals.unrelated_public_object).toBe(1)
  })

  it('records an unrelated public OPERATOR — the category is not three catalogues', () => {
    // pg_operator, pg_opclass, pg_opfamily, pg_conversion, pg_collation and the
    // text-search catalogues are precisely what gets left behind in `public`
    // after extension work, and precisely what the old query could not see.
    const facts = classifyExtensionEvidence([member('10')], [], [], [
      publicObject('700', { classid: '2617', catalogue: 'pg_operator',
                            object_description: 'operator public.<->(vector,vector)' }),
      publicObject('701', { classid: '2616', catalogue: 'pg_opclass',
                            object_description: 'operator class public.vector_ops for access method hnsw' }),
      publicObject('702', { classid: '99999', catalogue: null, object_description: null }),
    ])
    const byObj = Object.fromEntries(facts.classifications.map(f => [f.objid, f]))
    expect(byObj['700'].evidence_class).toBe('unrelated_public_object')
    expect(byObj['700'].classid).toBe('2617')
    expect(byObj['700'].object_description).toBe('operator public.<->(vector,vector)')
    expect(byObj['700'].described).toBe(true)
    expect(byObj['701'].evidence_class).toBe('unrelated_public_object')
    // Still recorded, and marked, when the server could not describe it.
    expect(byObj['702'].evidence_class).toBe('unrelated_public_object')
    expect(byObj['702'].described).toBe(false)
    expect(facts.totals.unrelated_public_object).toBe(3)
  })

  it('does not call an ordinary application-schema object unrelated', () => {
    // `portfolio.positions` and `investment_ledger.transactions` do not depend
    // on an extension, and that is true of nearly every table in the database.
    // Labelling them "unrelated" drowned the one signal the category carries.
    // They are not in the `public` universe at all, so they cannot appear.
    const facts = classifyExtensionEvidence(
      [member('10')], [], [], [publicObject('555')],
    )
    const descriptions = facts.classifications.map(f => f.object_description ?? '')
    expect(descriptions.some(d => d.includes('portfolio.'))).toBe(false)
    expect(descriptions.some(d => d.includes('investment_ledger.'))).toBe(false)
    expect(facts.totals.unrelated_public_object).toBe(1)
  })

  it('a public object that IS an extension member is not also unrelated', () => {
    const facts = classifyExtensionEvidence(
      [member('10')], [], [], [publicObject('10')],
    )
    const found = facts.classifications.filter(f => f.objid === '10')
    expect(found).toHaveLength(1)
    expect(found[0].evidence_class).toBe('direct_member')
  })

  it('a public object reached through the i/a closure is not also unrelated', () => {
    const facts = classifyExtensionEvidence(
      [member('10')], [edge('11', '10')], [], [publicObject('11')],
    )
    const found = facts.classifications.filter(f => f.objid === '11')
    expect(found).toHaveLength(1)
    expect(found[0].evidence_class).toBe('internal_support')
  })

  it('a public object that is a normal dependency is not also unrelated', () => {
    const facts = classifyExtensionEvidence(
      [member('10')], [], [edge('900', '10', 'n')], [publicObject('900')],
    )
    const found = facts.classifications.filter(f => f.objid === '900')
    expect(found).toHaveLength(1)
    expect(found[0].evidence_class).toBe('application_dependency')
    expect(facts.totals.unrelated_public_object).toBe(0)
  })

  it('keeps an object shared by two overlapping closures under BOTH extensions', () => {
    // The visited key is extension+object. With an object-only key the second
    // extension loses the shared object entirely, and "what breaks if this is
    // dropped?" gets a confidently wrong answer.
    const facts = classifyExtensionEvidence(
      [member('10'), member('20', { extension_name: 'btree_gist', extension_version: '1.7' })],
      [edge('99', '10'), edge('99', '20')],
    )
    const shared = facts.classifications.filter(f => f.objid === '99')
    expect(shared.map(f => f.extension_name).sort()).toEqual(['btree_gist', 'vector'])
    expect(shared.every(f => f.evidence_class === 'internal_support')).toBe(true)
  })

  it('reports per-extension totals and preserves each extension version', () => {
    const facts = classifyExtensionEvidence(
      [member('10'), member('20', { extension_name: 'btree_gist', extension_version: '1.7' })],
      [edge('11', '10')],
    )
    const totals = Object.fromEntries(facts.per_extension.map(t => [t.extension_name, t]))
    expect(totals['vector'].direct_member).toBe(1)
    expect(totals['vector'].internal_support).toBe(1)
    expect(totals['vector'].extension_version).toBe('0.7.4')
    expect(totals['btree_gist'].extension_version).toBe('1.7')
    expect(totals['btree_gist'].internal_support).toBe(0)
  })

  it('preserves classid, objid and objsubid, and describes unusual catalogue classes', () => {
    const facts = classifyExtensionEvidence(
      [
        member('900', { classid: '2617', catalogue: 'pg_operator',
                        object_description: 'operator public.<->(vector,vector)' }),
        member('901', { classid: '99999', catalogue: null, object_description: null }),
        member('902', { objsubid: '3' }),
      ],
      [],
    )
    const byObj = Object.fromEntries(facts.classifications.map(f => [f.objid, f]))
    expect(byObj['900'].classid).toBe('2617')
    expect(byObj['900'].object_description).toBe('operator public.<->(vector,vector)')
    expect(byObj['900'].described).toBe(true)
    // An object the server could not describe is still an object the extension
    // owns. Marked, never dropped.
    expect(byObj['901'].described).toBe(false)
    expect(byObj['901'].classid).toBe('99999')
    expect(byObj['902'].objsubid).toBe('3')
    expect(facts.classifications).toHaveLength(3)
  })

  it('does not classify an object as unrelated once it is a dependency of any extension', () => {
    const facts = classifyExtensionEvidence(
      [member('10')], [], [edge('900', '10', 'n')], [publicObject('900'), publicObject('901')],
    )
    const classes = Object.fromEntries(facts.classifications.map(f => [f.objid, f.evidence_class]))
    expect(classes['900']).toBe('application_dependency')
    expect(classes['901']).toBe('unrelated_public_object')
  })

  it('derives no verdict from any of the four classes', () => {
    const facts = classifyExtensionEvidence(
      [member('10')], [edge('11', '10')], [edge('900', '11', 'n')], [publicObject('901')],
    )
    expect(canonicalJson(facts)).not.toMatch(/\bPASS\b|\bFAIL\b|\bunexpected\b|\bviolation\b/i)
  })
})

// ── Index facts ─────────────────────────────────────────────────────────────

const indexRow = (over: Partial<IndexRow> = {}): IndexRow => ({
  schema_name: 'investment_ledger', table_name: 'transactions', index_name: 'transactions_pkey',
  table_owner: 'ai_capital_owner', index_owner: 'ai_capital_owner',
  is_unique: true, is_primary: true, is_exclusion: false,
  is_valid: true, is_ready: true, is_live: true,
  index_definition: 'CREATE UNIQUE INDEX transactions_pkey ON investment_ledger.transactions USING btree (id)',
  ...over,
})

describe('index facts', () => {
  it('records the parent relation, both owners, and their agreement', () => {
    const [fact] = buildIndexFacts([indexRow()])
    expect(fact.schema_name).toBe('investment_ledger')
    expect(fact.table_name).toBe('transactions')
    expect(fact.table_owner).toBe('ai_capital_owner')
    expect(fact.owner_matches_table).toBe(true)
  })

  it('records an owner divergence as a fact and not as a failure', () => {
    const [fact] = buildIndexFacts([indexRow({ index_owner: 'thanapold' })])
    expect(fact.owner_matches_table).toBe(false)
    expect(canonicalJson(fact)).not.toMatch(/FAIL|PASS|violation/i)
  })

  it('keeps valid, ready and live apart — a failed CONCURRENTLY build is all three differently', () => {
    const [fact] = buildIndexFacts([indexRow({ is_valid: false, is_ready: true, is_live: true })])
    expect(fact.is_valid).toBe(false)
    expect(fact.is_ready).toBe(true)
    expect(fact.is_live).toBe(true)
  })
})

// ── The document and its binding ────────────────────────────────────────────

function documentFixture(overrides: Record<string, unknown[]> = {}, server: ServerBindingRow = SERVER) {
  return buildFactDocument({
    run_id: 'fixture-run',
    collected_at: '2026-09-10T00:00:00.000Z',
    repository_head: '2b6658a370dc4e65916cbbd2ca1f0ce978181d1c',
    session: SESSION,
    server,
    probes: { probe_has_table_privilege: 'true (object: table desk.agent_runs, subject: ai_capital_owner)' },
    raw: {
      schema_migrations: ledgerRows(),
      schemas: [
        { schema_name: 'trade', owner: 'ai_capital_owner', acl_is_default: true,
          grantor: 'ai_capital_owner', grantee: 'ai_capital_owner', privilege_type: 'USAGE', is_grantable: false },
      ],
      database_acl: [], relations: [], indexes: [indexRow()],
      extension_members: [], dependency_edges: [], normal_dependency_edges: [], public_objects: [],
      ...overrides,
    },
  })
}

describe('the fact document', () => {
  it('is byte-stable across two builds from the same facts', () => {
    expect(canonicalJson(documentFixture())).toBe(canonicalJson(documentFixture()))
  })

  it('is byte-stable when the server returns the same rows in a different order', () => {
    const rows = ledgerRows()
    expect(canonicalJson(documentFixture({ schema_migrations: rows })))
      .toBe(canonicalJson(documentFixture({ schema_migrations: [...rows].reverse() })))
  })

  it('preserves the lower-case schema name `trade`', () => {
    const doc = documentFixture() as { objects: { schemas: { schema_name: string }[] } }
    expect(doc.objects.schemas[0].schema_name).toBe('trade')
  })

  it('carries ownership and ACL facts separately rather than collapsing them', () => {
    const doc = documentFixture({
      relations: [
        { schema_name: 'desk', object_name: 'agent_runs', relkind: 'r', owner: 'ai_capital_owner',
          rowsecurity: true, forcerowsecurity: true, persistence: 'p', acl_is_default: false,
          grantor: 'ai_capital_owner', grantee: 'ai_capital_agent', privilege_type: 'SELECT', is_grantable: false },
        { schema_name: 'desk', object_name: 'agent_runs', relkind: 'r', owner: 'ai_capital_owner',
          rowsecurity: true, forcerowsecurity: true, persistence: 'p', acl_is_default: false,
          grantor: 'ai_capital_owner', grantee: 'ai_capital_agent', privilege_type: 'INSERT', is_grantable: true },
      ],
    }) as { objects: { relations: Record<string, unknown>[] } }
    const relations = doc.objects.relations
    expect(relations).toHaveLength(2)
    expect(relations.map(r => r.privilege_type).sort()).toEqual(['INSERT', 'SELECT'])
    expect(relations.map(r => r.is_grantable).sort()).toEqual([false, true])
  })

  it('preserves grantor, grantee, privilege and grant option as four separate fields', () => {
    const doc = documentFixture({
      schemas: [
        { schema_name: 'identity', owner: 'ai_capital_owner', acl_is_default: false,
          grantor: 'ai_capital_owner', grantee: 'ai_capital_app', privilege_type: 'USAGE', is_grantable: false },
        { schema_name: 'identity', owner: 'ai_capital_owner', acl_is_default: false,
          grantor: 'thanapold', grantee: 'ai_capital_app', privilege_type: 'USAGE', is_grantable: false },
      ],
    }) as { objects: { schemas: Record<string, unknown>[] } }
    expect(doc.objects.schemas).toHaveLength(2)
    expect(doc.objects.schemas.map(s => s.grantor).sort()).toEqual(['ai_capital_owner', 'thanapold'])
  })

  it('records the built-in-default provenance of a NULL ACL rather than reporting no grants', () => {
    const doc = documentFixture() as { objects: { schemas: Record<string, unknown>[] } }
    expect(doc.objects.schemas[0].acl_is_default).toBe(true)
  })

  it('keeps the database TEMP privilege for every principal and for PUBLIC', () => {
    const principals = ['PUBLIC', 'ai_capital_app', 'ai_capital_agent', 'ai_capital_importer',
                        'ai_capital_migrator', 'ai_capital_operator']
    const doc = documentFixture({
      database_acl: principals.map(grantee => ({
        datname: 'ai_capital', datoid: '16401', owner: 'thanapold', datallowconn: true,
        datconnlimit: '-1', acl_is_default: false, grantor: 'thanapold', grantee,
        privilege_type: 'TEMPORARY', is_grantable: false,
      })),
    }) as { objects: { database_acl: { grantee: string; privilege_type: string; datoid: string }[] } }
    const temp = doc.objects.database_acl.filter(r => r.privilege_type === 'TEMPORARY')
    expect(temp.map(r => r.grantee).sort()).toEqual([...principals].sort())
    expect(temp.some(r => r.grantee === 'PUBLIC')).toBe(true)
    expect(temp[0].datoid).toBe('16401')
  })

  it('keeps admin, inherit and set membership options apart', () => {
    const doc = documentFixture({
      role_memberships: [{
        member: 'ai_capital_migrator', granted_role: 'ai_capital_owner',
        admin_option: false, inherit_option: 'false', set_option: 'true', grantor: 'thanapold',
      }],
    }) as { objects: { role_memberships: Record<string, unknown>[] } }
    const membership = doc.objects.role_memberships[0]
    // SET without INHERIT is the whole tenancy design: the migrator may ASSUME
    // the owner inside a window and does not silently carry its privileges.
    expect(membership.admin_option).toBe(false)
    expect(membership.inherit_option).toBe('false')
    expect(membership.set_option).toBe('true')
  })

  it('starts incomplete, and only markComplete stamps completion and the exit status', () => {
    const doc = documentFixture()
    expect((doc as { complete: boolean }).complete).toBe(false)
    expect((doc as { binding: Record<string, unknown> }).binding.exit_status).toBeUndefined()
    const done = markComplete(doc) as { complete: boolean; binding: { exit_status: number } }
    expect(done.complete).toBe(true)
    expect(done.binding.exit_status).toBe(0)
  })

  it('derives no verdict from a missing object, a drifted version, a LOGIN owner or an unexpected grant', () => {
    const doc = documentFixture({
      schema_migrations: ledgerRows().slice(0, 10),
      extensions: [{ extension_name: 'vector', owner: 'thanapold', schema_name: 'public',
                     version: '0.0.1-unexpected', relocatable: true }],
      relations: [
        { schema_name: 'portfolio', object_name: 'positions', relkind: 'r', owner: 'thanapold',
          rowsecurity: false, forcerowsecurity: false, persistence: 'p', acl_is_default: false,
          grantor: 'thanapold', grantee: 'PUBLIC', privilege_type: 'DELETE', is_grantable: true },
      ],
      roles: [{ rolname: 'ai_capital_owner', rolsuper: false, rolinherit: true, rolcreaterole: false,
                rolcreatedb: false, rolcanlogin: true, rolreplication: false, rolbypassrls: false,
                rolconnlimit: '-1', rolvaliduntil: null, rolconfig: null }],
    })
    expect(canonicalJson(doc)).not.toMatch(/\bPASS\b|\bFAIL\b|\bVIOLATION\b|\bCOMPLIANT\b|\bexpected_owner\b/i)
    expect((doc as { migrations: { recognition: string } }).migrations.recognition).toBe('UNRECOGNIZED')
  })
})

describe('the evidence binding', () => {
  const binding = () => (documentFixture() as { binding: Record<string, unknown> }).binding

  it('carries every required field', () => {
    const b = binding()
    for (const field of REQUIRED_BINDING_FIELDS) {
      expect(b, `binding is missing ${field}`).toHaveProperty(field)
    }
  })

  it('records the operator run id, the UTC timestamp and the repository head', () => {
    const b = binding()
    expect(b.run_id).toBe('fixture-run')
    expect(b.collected_at_utc).toBe('2026-09-10T00:00:00.000Z')
    expect(b.repository_head).toBe('2b6658a370dc4e65916cbbd2ca1f0ce978181d1c')
  })

  it('records the database name AND its OID — a name is reusable, an OID is not', () => {
    const b = binding()
    expect(b.database_name).toBe('ai_capital')
    expect(b.database_oid).toBe('16401')
  })

  it('records the instance: version, postmaster start time, port and cluster name', () => {
    const b = binding()
    expect(b.server_version).toBe('16.4')
    expect(b.postmaster_start_time).toBe('2026-09-01 03:14:15+00')
    expect(b.server_port).toBe('5432')
    // '' is cluster_name's real default. Recorded as empty, not folded to null.
    expect(b.cluster_name).toBe('')
  })

  it('records a sanitized endpoint: host or socket directory, port and database only', () => {
    const endpoint = binding().endpoint as Record<string, unknown>
    expect(Object.keys(endpoint).sort()).toEqual(['database', 'host', 'port', 'socket_directories'])
    expect(endpoint.host).toBeNull()
    expect(endpoint.socket_directories).toBe('/tmp')
    expect(endpoint.database).toBe('ai_capital')
  })

  it('records a TCP host when the connection was not over a socket', () => {
    const doc = documentFixture({}, { ...SERVER, server_address: '10.0.0.7' })
    const endpoint = (doc as { binding: { endpoint: Record<string, unknown> } }).binding.endpoint
    expect(endpoint.host).toBe('10.0.0.7')
  })

  it('carries the manifest recognition and version', () => {
    expect(binding().manifest_recognition).toBe('CURRENT_V19')
    expect(binding().manifest_version).toBe('V19')
    const drifted = buildFactDocument({
      run_id: 'r', collected_at: '2026-09-10T00:00:00.000Z', repository_head: 'abc',
      session: SESSION, server: SERVER, probes: {},
      raw: { schema_migrations: ledgerRows().slice(0, 3) },
    }) as { binding: { manifest_version: string | null; manifest_recognition: string } }
    expect(drifted.binding.manifest_recognition).toBe('UNRECOGNIZED')
    expect(drifted.binding.manifest_version).toBeNull()
  })

  it('refuses to build a binding without an operator run id', () => {
    expect(() => buildFactDocument({
      run_id: '', collected_at: '2026-09-10T00:00:00.000Z', repository_head: 'abc',
      session: SESSION, server: SERVER, probes: {}, raw: {},
    })).toThrow(/operator-supplied run id/)
  })

  it('refuses a non-UTC collection timestamp', () => {
    expect(() => buildBindingFacts({
      run_id: 'r', collected_at: '2026-09-10T00:00:00+07:00', repository_head: 'abc',
      session: SESSION, server: SERVER, probes: {}, raw: {},
    }, recognizeManifest([]))).toThrow(/not UTC/)
  })

  it('refuses to complete a document whose binding lost a field', () => {
    const doc = documentFixture() as Record<string, unknown>
    const binding = { ...(doc.binding as Record<string, unknown>) }
    delete binding.database_oid
    expect(() => markComplete({ ...doc, binding })).toThrow(/missing "database_oid"/)
  })

  it('never contains a user name, a password or a raw URL', () => {
    expect(canonicalJson(binding())).not.toMatch(/password|postgres:\/\/|@localhost/i)
  })
})

// ── SQL special forms must never be schema-qualified ────────────────────────
//
// `CURRENT_USER` and `SESSION_USER` are SQL special forms — reserved key words
// the grammar resolves. Writing `pg_catalog.current_user` does not name a
// function: the parser reads it as a FIELD reference whose relation or alias is
// `pg_catalog`, and with no FROM clause defining that relation the statement
// dies with `missing FROM-clause entry for table "pg_catalog"`. The form takes
// no argument list either, so `CURRENT_USER()` is equally invalid.
//
// The other `pg_catalog.` prefixes in inventory-queries.ts are deliberate and
// stay: qualified function calls, and qualified catalog relations. Only these
// two forms are exempt.

describe('SQL special forms are never schema-qualified', () => {
  /**
   * The declared SELECT queries: identity, server binding, capability probes
   * and the inventory reads.
   *
   * NOT every statement the collector sends — `BEGIN TRANSACTION READ ONLY` and
   * `ROLLBACK` are issued by the runner and are not declared here.
   */
  const DECLARED_QUERIES = [
    SESSION_IDENTITY_QUERY,
    SERVER_BINDING_QUERY,
    ...PROBE_QUERIES,
    ...INVENTORY_QUERIES,
  ]

  it('covers every declared query', () => {
    // NON-VACUITY for the whole block: an empty or truncated collection would
    // make every absence assertion below trivially true.
    expect(DECLARED_QUERIES.length).toBe(2 + PROBE_QUERIES.length + INVENTORY_QUERIES.length)
    expect(PROBE_QUERIES.length).toBeGreaterThan(0)
    expect(INVENTORY_QUERIES.length).toBeGreaterThan(0)
    for (const q of DECLARED_QUERIES) expect(q.sql.length, `${q.id} is empty`).toBeGreaterThan(0)
  })

  it('no query schema-qualifies CURRENT_USER or SESSION_USER', () => {
    const offenders = DECLARED_QUERIES
      .filter(q => /pg_catalog\.(current_user|session_user)\b/.test(q.sql))
      .map(q => q.id)
    expect(offenders, `these queries would fail to parse: ${offenders.join(', ')}`).toEqual([])
  })

  it('no query turns a special form into a call with parentheses', () => {
    // `CURRENT_USER()` is equally invalid — the form takes no argument list.
    const offenders = DECLARED_QUERIES
      .filter(q => /\b(CURRENT_USER|SESSION_USER)\s*\(/.test(q.sql))
      .map(q => q.id)
    expect(offenders).toEqual([])
  })

  it('the session identity query uses the exact unqualified expressions', () => {
    expect(SESSION_IDENTITY_QUERY.sql).toContain('CURRENT_USER::text                        AS current_user')
    expect(SESSION_IDENTITY_QUERY.sql).toContain('SESSION_USER::text                        AS session_user')
  })

  it('every capability probe excludes the current principal with unqualified CURRENT_USER::text', () => {
    expect(PROBE_QUERIES.length).toBe(3)
    for (const probe of PROBE_QUERIES) {
      expect(probe.sql, `${probe.id} does not use CURRENT_USER::text`).toContain('CURRENT_USER::text')
      expect(probe.sql, `${probe.id} qualifies the special form`).not.toMatch(/pg_catalog\.current_user/)
    }
  })

  it('leaves genuinely qualified catalog FUNCTIONS alone', () => {
    // A blanket de-qualification would break these. They are real functions,
    // and qualifying them pins the call to the system catalog regardless of
    // search_path — which is wanted.
    expect(SESSION_IDENTITY_QUERY.sql).toContain('pg_catalog.current_database()')
    expect(SESSION_IDENTITY_QUERY.sql).toContain("pg_catalog.current_setting('transaction_read_only')")
    expect(PROBE_QUERIES[0].sql).toContain('pg_catalog.has_table_privilege(')
    expect(PROBE_QUERIES[1].sql).toContain('pg_catalog.has_schema_privilege(')
    expect(PROBE_QUERIES[2].sql).toContain('pg_catalog.pg_has_role(')
    // ...and the catalog relations they read are still qualified too.
    expect(PROBE_QUERIES[2].sql).toContain('FROM pg_catalog.pg_roles')
  })
})
