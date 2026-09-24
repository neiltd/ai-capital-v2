// The schema contract, proved OFFLINE: refusals, canonicalisation, the digest
// domain, and the shape of the two commands. What a live catalogue actually
// returns is tests/pgcopy/schema-contract.int.test.ts.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { CURRENT_V19_MANIFEST } from '../src/inventory-queries.js'
import { TARGET_TABLES, TARGET_SEQUENCES } from '../src/legacy-copy.js'
import {
  COPY_SEQUENCES, COPY_TABLES, CONTRACT_PRELUDE, CONTRACT_QUERIES,
  ContractRefused, EXPECTED_MIGRATION_COUNT, EXPECTED_MIGRATION_RECOGNITION,
  REVIEWED_EXTENSIONS, REVIEWED_TARGET_SETTINGS, SCHEMA_CONTRACT_VERSION, TRIGGER_INSERT_BIT,
  assertNoRawOids, buildContract, canonicalJson, contractDigest, parseArtifact,
  serializeArtifact, type RawCatalog,
} from '../src/pg-copy/schema-contract.js'
import { ARTIFACT_PATH, pgTextArray } from '../bin/pg-copy-contract.js'
import {
  CANONICAL_CONF_PATH, CONF_KEY_FOR_SETTING, ReviewedSettingsRefused,
  parseConfAssignments, requireSingleAssignment, reviewedTargetSettings,
} from '../testing/reviewed-settings.js'

const SRC = readFileSync(
  fileURLToPath(new URL('../src/pg-copy/schema-contract.ts', import.meta.url)), 'utf-8')
const CLI = readFileSync(
  fileURLToPath(new URL('../bin/pg-copy-contract.ts', import.meta.url)), 'utf-8')

/**
 * The ledger the contract must recognise: the PUBLISHED manifest, not a second
 * copy of nineteen hashes maintained here. A fixture that carried its own hashes
 * could agree with a broken extractor.
 */
const LEDGER: string[][] = [...CURRENT_V19_MANIFEST]
  .map(m => [m.filename, m.sha256])
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

/** The smallest catalogue that builds: 21 tables, one text PK column each. */
function raw(over: Partial<RawCatalog> = {}): RawCatalog {
  const cols = COPY_TABLES.map(q => [
    q, '1', 'id', 'text', 'pg_catalog', 'text', 'b', 'S', '-1', '', '',
    't', 'f', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    '', '', '', '', '', '', '', '', '', '',
  ])
  const rels = COPY_TABLES.map(q => {
    const [s, t] = q.split('.')
    return [s, t, 'r', 'p', 'ai_capital_owner', 'f', 'f']
  })
  const seqs = COPY_SEQUENCES.map(q => [
    q, 'integer', '1', '1', '1', '2147483647', '1', 'f', `${q.replace(/_id_seq$/, '')}.id`,
  ])
  return {
    platform: [['170010', 'UTF8', 'en_US.UTF-8', 'en_US.UTF-8', 'UTC', 'pg_catalog.english']],
    extensions: REVIEWED_EXTENSIONS.map(n => [n, '1.0', 'public']),
    migrations: LEDGER,
    relations: rels, columns: cols, droppedColumns: [],
    constraints: [], indexes: [], triggers: [], sequences: seqs,
    ...over,
  }
}

const colOf = (q: string, over: Record<number, string>): string[] => {
  const base = [q, '1', 'id', 'text', 'pg_catalog', 'text', 'b', 'S', '-1', '', '',
                't', 'f', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
                '', '', '', '', '', '', '', '', '', '']
  for (const [i, v] of Object.entries(over)) base[Number(i)] = v
  return base
}
const withCol = (q: string, over: Record<number, string>): RawCatalog =>
  raw({ columns: COPY_TABLES.map(t => (t === q ? colOf(t, over) : colOf(t, {}))) })

describe('the reviewed copy set', () => {
  it('is exactly legacy-copy’s 21 target tables, in the same order', () => {
    expect([...COPY_TABLES]).toEqual([...TARGET_TABLES])
    expect(COPY_TABLES.length).toBe(21)
  })

  it('is exactly legacy-copy’s three target sequences', () => {
    expect([...COPY_SEQUENCES]).toEqual(TARGET_SEQUENCES.map(s => s.sequence))
  })

  it('pins the migration recognition exactly', () => {
    expect(EXPECTED_MIGRATION_COUNT).toBe(19)
    expect(EXPECTED_MIGRATION_RECOGNITION).toBe('CURRENT_V19')
  })
})

describe('extraction SQL is resolved and qualified', () => {
  it('pins search_path for the extraction session', () => {
    expect(CONTRACT_PRELUDE).toBe('SET search_path = pg_catalog;')
  })

  it('qualifies every catalog relation, function and cast', () => {
    for (const sql of CONTRACT_QUERIES) {
      expect(sql).not.toMatch(/(^|[^.\w])FROM\s+pg_(?!catalog)/i)
      expect(sql).not.toMatch(/(^|[^.\w])JOIN\s+pg_(?!catalog)/i)
      for (const bare of ['format_type(', 'pg_get_expr(', 'pg_get_constraintdef(',
                          'pg_get_indexdef(', 'pg_get_userbyid(', 'count(', 'string_agg(',
                          'unnest(', 'quote_ident(', 'current_setting(']) {
        const re = new RegExp(`(^|[^.\\w])${bare.replace('(', '\\s*\\(')}`, 'm')
        expect(sql, `${bare} is unqualified`).not.toMatch(re)
      }
      expect(sql).not.toMatch(/::text\b|::int4\b(?!\b)/)
    }
  })

  it('never selects a raw OID column', () => {
    for (const sql of CONTRACT_QUERIES) {
      expect(sql).not.toMatch(/SELECT[^;]*\b\w+\.oid\s+AS/i)
    }
  })

  it('builds a text[] literal with no interpolation hazard', () => {
    expect(pgTextArray(['a.b', 'c.d'])).toBe(`'{"a.b","c.d"}'::pg_catalog.text[]`)
  })
})

describe('fail-closed refusals', () => {
  const refuses = (over: Partial<RawCatalog>, re: RegExp): void => {
    expect(() => buildContract(raw(over))).toThrow(re)
  }

  it('refuses a non-17 major version', () => {
    refuses({ platform: [['160004', 'UTF8', 'c', 'c', 'UTC', 'x']] }, /major 16 is not the reviewed 17/)
  })

  it('refuses any ledger that is not exactly CURRENT_V19', () => {
    refuses({ migrations: LEDGER.slice(1) }, /missing \[/)
    refuses({ migrations: [...LEDGER, ['999_rogue.sql', 'f'.repeat(64)]] }, /unexpected \[999_rogue\.sql\]/)
    // 19 rows, one duplicated and one missing - a map-based comparison alone
    // would collapse the duplicate, so the duplicate check runs first.
    refuses({ migrations: [...LEDGER.slice(1), LEDGER[1]] }, /appears more than once/)
    // The defect this correction exists for: nineteen rows, every filename
    // right, every hash wrong. A count-only check passes this.
    refuses({ migrations: LEDGER.map(([f]) => [f, '0'.repeat(64)]) }, /hash-mismatched \[/)
    // ... and nineteen rows whose filenames are all wrong.
    refuses({ migrations: LEDGER.map(([f, h], i) => [`z${i}_${f}`, h]) }, /missing \[/)
  })

  it('never derives recognition from the row count alone', () => {
    const nineteenWrong = LEDGER.map(([f]) => [f, '0'.repeat(64)])
    expect(nineteenWrong.length).toBe(EXPECTED_MIGRATION_COUNT)
    expect(() => buildContract(raw({ migrations: nineteenWrong }))).toThrow(ContractRefused)
  })

  it('refuses an unreviewed, missing or duplicated extension', () => {
    refuses({ extensions: [...REVIEWED_EXTENSIONS.map(n => [n, '1.0', 'public']), ['hstore', '1.0', 'public']] },
      /extension "hstore" is not in the reviewed set/)
    refuses({ extensions: [['plpgsql', '1.0', 'pg_catalog'], ['vector', '1.0', 'public']] },
      /reviewed extension "btree_gist" is not installed/)
    refuses({ extensions: [...REVIEWED_EXTENSIONS.map(n => [n, '1.0', 'public']), ['vector', '1.0', 'public']] },
      /appears more than once/)
  })

  it('refuses a missing, unexpected, duplicated or non-ordinary relation', () => {
    refuses({ relations: raw().relations.slice(1) }, /required table portfolio.positions is missing/)
    refuses({ relations: [...raw().relations, ['other', 't', 'r', 'p', 'o', 'f', 'f']] },
      /unexpected table other.t/)
    refuses({ relations: [...raw().relations, raw().relations[0]] }, /appears more than once/)
    const v = raw().relations.map((r, i) => (i === 0 ? [...r.slice(0, 2), 'v', ...r.slice(3)] : r))
    refuses({ relations: v }, /relkind "v", not an ordinary table/)
    const u = raw().relations.map((r, i) => (i === 0 ? [...r.slice(0, 3), 'u', ...r.slice(4)] : r))
    refuses({ relations: u }, /relpersistence "u", not permanent/)
  })

  it('refuses BOTH row-security flags unconditionally', () => {
    const rls = raw().relations.map((r, i) => (i === 0 ? [...r.slice(0, 5), 't', 'f'] : r))
    refuses({ relations: rls }, /relrowsecurity enabled; refused unconditionally/)
    const force = raw().relations.map((r, i) => (i === 0 ? [...r.slice(0, 5), 'f', 't'] : r))
    refuses({ relations: force }, /relforcerowsecurity enabled; refused unconditionally/)
  })

  it('refuses EVERY class of non-internal INSERT trigger, enabled or not', () => {
    // tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 64 INSTEAD.
    for (const [label, tgtype] of [['before row', '7'], ['after row', '5'],
                                   ['before statement', '6'], ['after statement', '4'],
                                   ['instead of', '69']] as const) {
      for (const enabled of ['O', 'D']) {
        expect(() => buildContract(raw({
          triggers: [['portfolio.positions', 't_' + label.replace(/ /g, '_'), tgtype, 'f', enabled]],
        })), `${label}/${enabled}`).toThrow(/fires for INSERT/)
      }
    }
  })

  it('does NOT refuse an internal trigger, or a non-INSERT trigger', () => {
    expect(() => buildContract(raw({
      triggers: [['portfolio.positions', 'RI_ConstraintTrigger_a', '5', 't', 'O']],
    }))).not.toThrow()
    // UPDATE-only (bit 16) and DELETE-only (bit 8) do not carry the INSERT bit.
    for (const tgtype of ['17', '9', '33']) {
      expect(Number(tgtype) & TRIGGER_INSERT_BIT).toBe(0)
      expect(() => buildContract(raw({
        triggers: [['portfolio.positions', 'g', tgtype, 'f', 'O']],
      }))).not.toThrow()
    }
  })

  it('refuses identity columns as POLICY, naming the reason', () => {
    expect(() => buildContract(withCol('portfolio.trade_log', { 14: 'd' })))
      .toThrow(/COMPATIBILITY POLICY, not a claim that COPY cannot accept identity values/)
    expect(() => buildContract(withCol('portfolio.trade_log', { 14: 'a' }))).toThrow(ContractRefused)
  })

  it('extracts the identity sequence options and linkage BEFORE refusing', () => {
    // The refusal names what extraction found. If the options and the pg_depend
    // linkage were not read, the message cannot carry them - so this asserts the
    // extraction happened, not merely that the policy fired.
    const withSeq = withCol('portfolio.trade_log', {
      14: 'a',
      28: 'portfolio.trade_log_id_seq', 29: 'bigint', 30: '1', 31: '1',
      32: '1', 33: '9223372036854775807', 34: '1', 35: 'f',
      36: 'pg_depend(deptype=i,refobjsubid=1)',
    })
    let message = ''
    try { buildContract(withSeq) } catch (e) { message = (e as Error).message }
    expect(message).toMatch(/portfolio\.trade_log_id_seq/)
    expect(message).toMatch(/data_type=bigint/)
    expect(message).toMatch(/start=1 increment=1/)
    expect(message).toMatch(/min=1 max=9223372036854775807/)
    expect(message).toMatch(/cache=1 cycle=false/)
    expect(message).toMatch(/linkage=pg_depend\(deptype=i,refobjsubid=1\)/)
  })

  it('says ABSENT when an identity column has no linked sequence', () => {
    let message = ''
    try { buildContract(withCol('portfolio.trade_log', { 14: 'a' })) } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/identity sequence is ABSENT/)
  })

  it('refuses a stored generated column', () => {
    expect(() => buildContract(withCol('capital.chunks', { 15: 's' })))
      .toThrow(/stored generated column/)
  })

  it('refuses an unsupported or ambiguously identified type', () => {
    expect(() => buildContract(withCol('capital.chunks', { 3: 'double precision', 5: 'float8' })))
      .toThrow(/not in the reviewed set/)
    // A type NAMED text but living elsewhere is refused on identity.
    expect(() => buildContract(withCol('capital.chunks', { 4: 'public' })))
      .toThrow(/identified as public\.text/)
    // vector is accepted only as an extension member.
    expect(() => buildContract(withCol('capital.chunks', { 5: 'vector', 9: '' })))
      .toThrow(/not in the reviewed set/)
    expect(() => buildContract(withCol('capital.chunks',
      { 4: 'public', 5: 'vector', 9: 'vector', 10: '0.8.2' }))).not.toThrow()
  })

  it('refuses a nondeterministic collation', () => {
    expect(() => buildContract(withCol('capital.chunks',
      { 17: 'public', 18: 'ci', 19: 'i', 20: 'f', 21: '6' }))).toThrow(/nondeterministic collation/)
  })

  it('refuses when the catalogue collation version and the provider disagree', () => {
    const coll = (version: string, actual: string): RawCatalog => withCol('capital.chunks',
      { 17: 'pg_catalog', 18: 'en_US.UTF-8', 19: 'c', 20: 't', 21: '6', 26: version, 27: actual })
    expect(() => buildContract(coll('2.44', '2.44'))).not.toThrow()
    expect(() => buildContract(coll('', ''))).not.toThrow()          // unversioned provider
    expect(() => buildContract(coll('2.44', '2.48')))
      .toThrow(/records version "2\.44" but the provider now reports "2\.48"/)
    expect(() => buildContract(coll('', '2.48')))
      .toThrow(/records NO version while the provider reports "2\.48"/)
    expect(() => buildContract(coll('2.44', '')))
      .toThrow(/while the provider reports none/)
  })

  it('carries both collation versions into the payload', () => {
    const c = buildContract(withCol('capital.chunks',
      { 17: 'pg_catalog', 18: 'en_US.UTF-8', 19: 'c', 20: 't', 21: '6', 26: '2.44', 27: '2.44' }))
    const col = JSON.parse(canonicalJson(c.payload)).tables
      .find((t: { qname: string }) => t.qname === 'capital.chunks').columns[0]
    expect(col.collation.version).toBe('2.44')
    expect(col.collation.actual_version).toBe('2.44')
  })

  it('refuses a NOT VALID or DEFERRABLE foreign key', () => {
    const fk = (validated: string, deferrable: string): RawCatalog => raw({
      constraints: [['thesis.assumptions', 'fk', 'f', 'FOREIGN KEY (a) REFERENCES b(c)',
                     validated, deferrable, 'f', 'a']],
    })
    expect(() => buildContract(fk('f', 'f'))).toThrow(/NOT VALID/)
    expect(() => buildContract(fk('t', 't'))).toThrow(/DEFERRABLE/)
    expect(() => buildContract(fk('t', 'f'))).not.toThrow()
  })

  it('refuses an invalid or not-ready identity index', () => {
    const idx = (valid: string, ready: string, unique: string): RawCatalog => raw({
      indexes: [['portfolio.positions', 'pk', 'CREATE UNIQUE INDEX pk ON ...', 't', unique, valid, ready, '', '']],
    })
    expect(() => buildContract(idx('f', 't', 't'))).toThrow(/identity index "pk" is not valid\/ready/)
    expect(() => buildContract(idx('t', 'f', 't'))).toThrow(/not valid\/ready/)
    // A non-identity index may be invalid: it constrains nothing.
    expect(() => buildContract(raw({
      indexes: [['portfolio.positions', 'i', 'CREATE INDEX i ON ...', 'f', 'f', 'f', 'f', '', '']],
    }))).not.toThrow()
  })

  it('refuses a missing, unexpected or unowned sequence', () => {
    refuses({ sequences: raw().sequences.slice(1) }, /required sequence portfolio.trade_log_id_seq is missing/)
    refuses({ sequences: [...raw().sequences, ['x.y', 'integer', '1', '1', '1', '9', '1', 'f', 'a.b.c']] },
      /unexpected sequence x.y/)
    const un = raw().sequences.map((r, i) => (i === 0 ? [...r.slice(0, 8), ''] : r))
    refuses({ sequences: un }, /has no owning table column/)
  })

  it('refuses a duplicated column identity', () => {
    const dup = raw()
    expect(() => buildContract({ ...dup, columns: [...dup.columns, dup.columns[0]] }))
      .toThrow(/appears more than once/)
  })
})

describe('the expected target is host-independent', () => {
  const HARNESS = readFileSync(
    fileURLToPath(new URL('../testing/v19-database.ts', import.meta.url)), 'utf-8')

  it('names every setting whose default would otherwise come from the host', () => {
    expect(REVIEWED_TARGET_SETTINGS).toEqual({
      TimeZone: 'America/Los_Angeles',
      default_text_search_config: 'pg_catalog.english',
    })
  })

  it('applies them to the expected-target DATABASE, from the PARSED canonical file', () => {
    // Written as a REGEX, not a string literal. The repository's dead-test-file
    // invariant scans test sources for relative import specifiers as raw text,
    // so a quoted example of another file's import would be resolved relative to
    // tests/ rather than to testing/, and reported as a broken import.
    expect(HARNESS).toMatch(/import \{ reviewedTargetSettings \} from '\.\/reviewed-settings\.js'/)
    expect(HARNESS).toMatch(/for \(const \[k, v\] of Object\.entries\(reviewedTargetSettings\(\)\)\)/)
    expect(HARNESS).toMatch(/ALTER DATABASE \$\{database\} SET \$\{k\} = '\$\{v\}'/)
    // Not a second literal copy of the values in the harness.
    expect(HARNESS).not.toContain('America/Los_Angeles')
  })

  it('does not let extraction set what it is supposed to observe', () => {
    for (const sql of CONTRACT_QUERIES) {
      expect(sql).not.toMatch(/\bSET\s+TimeZone\b/i)
      expect(sql).not.toMatch(/\bSET\s+default_text_search_config\b/i)
      expect(sql).not.toContain('America/Los_Angeles')
    }
    expect(CONTRACT_PRELUDE).not.toMatch(/TimeZone|text_search/i)
  })
})

describe('the canonical configuration is the authority for those settings', () => {
  const CONF = readFileSync(CANONICAL_CONF_PATH, 'utf-8')

  it('reads the file provision.sh installs, not a copy', () => {
    const provision = readFileSync(
      fileURLToPath(new URL('../../../ops/clusters/ai-capital-v3/provision.sh', import.meta.url)), 'utf-8')
    expect(CANONICAL_CONF_PATH)
      .toMatch(/ops\/clusters\/ai-capital-v3\/postgresql\.conf\.d\/ai-capital-v3\.conf$/)
    expect(provision).toContain('postgresql.conf.d')
    expect(provision).toContain('ai-capital-v3.conf')
  })

  it('agrees, value for value, with REVIEWED_TARGET_SETTINGS', () => {
    expect(reviewedTargetSettings()).toEqual({ ...REVIEWED_TARGET_SETTINGS })
    // NON-VACUITY: prove the values actually came out of the file.
    expect(requireSingleAssignment(parseConfAssignments(CONF), 'timezone'))
      .toBe(REVIEWED_TARGET_SETTINGS.TimeZone)
    expect(requireSingleAssignment(parseConfAssignments(CONF), 'default_text_search_config'))
      .toBe(REVIEWED_TARGET_SETTINGS.default_text_search_config)
  })

  it('maps every reviewed setting to exactly one configuration key', () => {
    expect(Object.keys(CONF_KEY_FOR_SETTING).sort())
      .toEqual(Object.keys(REVIEWED_TARGET_SETTINGS).sort())
  })

  it('refuses a missing assignment', () => {
    const stripped = CONF.split('\n').filter(l => !/^\s*timezone\s*=/.test(l)).join('\n')
    expect(() => reviewedTargetSettings(stripped))
      .toThrow(/no active assignment for "timezone"/)
  })

  it('refuses a duplicate active assignment', () => {
    expect(() => reviewedTargetSettings(`${CONF}\ntimezone = 'America/Los_Angeles'\n`))
      .toThrow(/2 active assignments for "timezone"/)
    // A COMMENTED duplicate is not an assignment and must not trip it.
    expect(() => reviewedTargetSettings(`${CONF}\n# timezone = 'UTC'\n`)).not.toThrow()
  })

  it('refuses malformed quoting rather than guessing', () => {
    expect(() => reviewedTargetSettings(`${CONF}\nlc_time = 'en_US.UTF-8\n`))
      .toThrow(/unterminated quoted value/)
    expect(() => reviewedTargetSettings(`${CONF}\nlc_time = en_US'\n`))
      .toThrow(/unterminated quoted value|mixes a bare and a quoted value/)
    expect(() => reviewedTargetSettings(`${CONF}\nlc_time =\n`))
      .toThrow(/has an empty value/)
    expect(() => reviewedTargetSettings(`${CONF}\nnot a setting line\n`))
      .toThrow(/not a setting assignment/)
  })

  it('refuses an unexpected value, in EITHER direction', () => {
    // The canonical file moved and the constant did not.
    const drifted = CONF.replace(/^timezone = .*$/m, "timezone = 'UTC'")
    expect(drifted).not.toBe(CONF)
    expect(() => reviewedTargetSettings(drifted))
      .toThrow(/sets timezone = "UTC" but REVIEWED_TARGET_SETTINGS\.TimeZone is "America\/Los_Angeles"/)
    // The constant moved and the canonical file did not.
    expect(() => reviewedTargetSettings(CONF, { ...REVIEWED_TARGET_SETTINGS, TimeZone: 'UTC' }))
      .toThrow(/REVIEWED_TARGET_SETTINGS\.TimeZone is "UTC"/)
    const bothMoved = { ...REVIEWED_TARGET_SETTINGS, default_text_search_config: 'pg_catalog.simple' }
    expect(() => reviewedTargetSettings(CONF, bothMoved)).toThrow(ReviewedSettingsRefused)
  })

  it('refuses a reviewed setting that no canonical key covers', () => {
    expect(() => reviewedTargetSettings(CONF, { ...REVIEWED_TARGET_SETTINGS, DateStyle: 'ISO, MDY' }))
      .toThrow(/has no canonical configuration key/)
  })

  it('does not treat a commented or quoted-hash line as an assignment', () => {
    const a = parseConfAssignments("# timezone = 'UTC'\nlog_line_prefix = '%m [%p] %q%u@%d '\n")
    expect(a.map(x => x.key)).toEqual(['log_line_prefix'])
    expect(a[0].value).toBe('%m [%p] %q%u@%d ')
  })
})

describe('canonical serialisation and the digest domain', () => {
  const a = buildContract(raw())

  it('sorts keys and is stable', () => {
    expect(canonicalJson({ b: 1, a: 2 } as never)).toBe('{"a":2,"b":1}')
    expect(canonicalJson(a.payload)).toBe(canonicalJson(a.payload))
  })

  it('takes the digest over version + payload, never over itself', () => {
    expect(a.digest).toBe(contractDigest(a.payload))
    expect(canonicalJson(a.payload)).not.toContain('"digest"')
    expect(SRC).toContain('canonicalJson({ version: SCHEMA_CONTRACT_VERSION, payload }')
  })

  it('changes when the version changes', () => {
    expect(SCHEMA_CONTRACT_VERSION).toBe(2)
    expect(SRC).toContain('version: SCHEMA_CONTRACT_VERSION')
  })

  it('carries no timestamp, host path, random id or catalogue OID', () => {
    const text = canonicalJson(a.payload)
    expect(text).not.toMatch(/\/Users\/|\/tmp\/|pgcopy-/)
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(() => assertNoRawOids(a)).not.toThrow()
    expect(() => assertNoRawOids({ ...a, payload: { oid: 1 } as never }))
      .toThrow(/raw catalogue key "oid"/)
  })

  it('round-trips through the committed serialisation', () => {
    const bytes = serializeArtifact(a)
    expect(bytes.endsWith('}\n')).toBe(true)
    expect(parseArtifact(bytes).digest).toBe(a.digest)
  })

  it('REJECTS an artifact whose digest does not match its payload', () => {
    const bytes = serializeArtifact({ ...a, digest: 'f'.repeat(64) })
    expect(() => parseArtifact(bytes)).toThrow(/does not match its payload/)
  })

  it('rejects an artifact of another version', () => {
    const bytes = serializeArtifact({ ...a, pgcopy_schema_contract_version: 99 })
    expect(() => parseArtifact(bytes)).toThrow(/artifact version 99 is not 2/)
  })

  it('binds column order and table order', () => {
    const swapped = raw()
    const cols = [...swapped.columns]
    const t = COPY_TABLES[0]
    const two = [colOf(t, { 1: '1', 2: 'a' }), colOf(t, { 1: '2', 2: 'b' })]
    const withTwo = { ...swapped, columns: [...two, ...cols.slice(1)] }
    const reversed = { ...swapped, columns: [two[1], two[0], ...cols.slice(1)] }
    expect(buildContract(withTwo).digest).not.toBe(buildContract(reversed).digest)
    expect(buildContract(raw()).payload).toHaveProperty('table_order')
  })

  it('carries EVERY reviewed field, on every record, in the committed artifact', () => {
    // WHY A SHAPE ASSERTION AND NOT ONLY DIGEST DRIFT. Dropping a field that is
    // constant across the 21 tables - has_default on a table with no defaults,
    // is_ready on indexes that are all ready - changes no digest here and no
    // digest on a drifted target either. Nothing would notice until the day the
    // field mattered. So the presence of each field is asserted directly.
    const p = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8')).payload as {
      platform: Record<string, unknown>
      migrations: Record<string, unknown>
      table_order: string[]
      tables: Record<string, unknown>[]
      sequences: Record<string, unknown>[]
    }
    const has = (o: Record<string, unknown>, keys: string[], what: string): void => {
      for (const k of keys) expect(Object.keys(o), `${what} is missing ${k}`).toContain(k)
    }
    has(p.platform, ['server_version_major', 'encoding', 'lc_collate', 'lc_ctype',
                     'timezone', 'default_text_search_config', 'extensions'], 'platform')
    has(p.migrations, ['recognition', 'count', 'ledger', 'ledger_digest'], 'migrations')
    expect(p.table_order).toEqual([...COPY_TABLES])
    expect(p.tables.length).toBe(COPY_TABLES.length)
    let columns = 0; let constraints = 0; let indexes = 0
    for (const t of p.tables) {
      has(t, ['qname', 'schema', 'name', 'relkind', 'relpersistence', 'owner',
              'row_security', 'force_row_security', 'dropped_column_count',
              'columns', 'constraints', 'indexes'], `table ${String(t.qname)}`)
      for (const c of t.columns as Record<string, unknown>[]) {
        has(c, ['position', 'attnum', 'name', 'format_type', 'type_schema', 'type_name',
                'typtype', 'typcategory', 'typmod', 'type_extension', 'type_extension_version',
                'not_null', 'has_default', 'default_expression', 'identity', 'generated',
                'serial_sequence', 'identity_sequence', 'collation'], `column ${String(c.name)}`)
        columns++
      }
      for (const c of t.constraints as Record<string, unknown>[]) {
        has(c, ['name', 'type', 'definition', 'columns',
                'validated', 'deferrable', 'deferred'], `constraint ${String(c.name)}`)
        constraints++
      }
      for (const i of t.indexes as Record<string, unknown>[]) {
        has(i, ['name', 'definition', 'is_primary', 'is_unique',
                'is_valid', 'is_ready', 'predicate', 'expressions'], `index ${String(i.name)}`)
        indexes++
      }
    }
    for (const q of p.sequences) {
      has(q, ['qname', 'data_type', 'start_value', 'increment_by', 'min_value',
              'max_value', 'cache_size', 'cycle', 'owned_by'], `sequence ${String(q.qname)}`)
    }
    // NON-VACUITY: an empty artifact would satisfy every loop above.
    expect(columns).toBe(152)
    expect(constraints).toBe(34)
    expect(indexes).toBe(41)
    expect(p.sequences.length).toBe(3)
  })

  it('distinguishes default ABSENT from default PRESENT', () => {
    const none = buildContract(withCol('portfolio.trade_log', { 12: 'f', 13: '' }))
    const some = buildContract(withCol('portfolio.trade_log', { 12: 't', 13: 'nextval(\'s\'::regclass)' }))
    const other = buildContract(withCol('portfolio.trade_log', { 12: 't', 13: '0' }))
    expect(none.digest).not.toBe(some.digest)
    expect(some.digest).not.toBe(other.digest)
  })
})

describe('the committed artifact and the two commands', () => {
  it('the committed artifact parses and verifies its own digest', () => {
    const a = parseArtifact(readFileSync(ARTIFACT_PATH, 'utf-8'))
    expect(a.pgcopy_schema_contract_version).toBe(2)
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(() => assertNoRawOids(a)).not.toThrow()
  })

  it('the artifact path is inside the package, under contracts/', () => {
    expect(ARTIFACT_PATH.endsWith('/packages/db/contracts/expected-target-v19.json')).toBe(true)
  })

  it('--check has NO write path at all', () => {
    const checkBranch = CLI.slice(CLI.indexOf('let committedText'), CLI.indexOf('export function isDirectEntrypoint'))
    expect(checkBranch).not.toContain('writeFileSync')
    // Exactly one write in the whole file, and it is inside --generate.
    expect((CLI.match(/writeFileSync\(/g) ?? []).length).toBe(1)
    expect(CLI.slice(CLI.indexOf('if (generate) {'), CLI.indexOf('let committedText')))
      .toContain('writeFileSync(ARTIFACT_PATH')
  })

  it('requires exactly one mode and rejects anything else', () => {
    expect(CLI).toContain('if (generate === check)')
    expect(CLI).toContain('unknown argument(s)')
  })
})
