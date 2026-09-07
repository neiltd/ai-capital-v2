import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// THE TENANT TABLE / INSERT MATRIX — no database connection anywhere in this file.
//
// THE INVARIANT: every tenant-owned ledger row records BOTH the workspace it
// belongs to and the principal that wrote it, and neither is optional.
//
// THE DEFECT THIS EXISTS FOR. `actor_principal_id` was carried by the tables
// that felt important — transactions, batches, documents, reconciliation — and
// silently omitted from `accounts`, `instrument_aliases`, `raw_import_rows`,
// `document_file_variants`, `document_extractions` and `transaction_groups`.
// Those six are exactly where an unattributable change hides: renaming an
// account, re-aliasing a security, or rewriting the raw payload a transaction
// was derived from changes what the ledger MEANS while every transaction row
// stays byte-identical.
//
// Three things have to line up, and a test that checked only one would pass
// while the guarantee was absent:
//   1. the COLUMN exists and is NOT NULL           (nothing can omit it)
//   2. a FOREIGN KEY to identity.principals        (it names a real principal)
//   3. an `actor_is_authorized` trigger            (it names the ACTING one)
// Plus the producer side: every INSERT in production source supplies both.
//
// What this file CANNOT check, stated so it is not mistaken for covered: that
// the actor supplied is the right one. A wrong-but-valid principal id is
// rejected by the trigger at runtime, and that is an integration test —
// tests/integration/attribution.test.ts, authored and not yet run.

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = resolve(HERE, '..', '..', '..', 'db', 'migrations')
const SRC = resolve(HERE, '..', '..', 'src')
const BIN = resolve(HERE, '..', '..', 'bin')

const migrationText = readdirSync(MIGRATIONS)
  .filter(f => f.endsWith('.sql')).sort()
  .map(f => readFileSync(join(MIGRATIONS, f), 'utf-8'))
  .join('\n')

/** The one deliberately global table: a canonical security is global. */
const GLOBAL_TABLES = new Set(['instruments'])

interface Table { name: string; body: string }

const tables: Table[] = [...migrationText.matchAll(
  /CREATE TABLE investment_ledger\.(\w+)\s*\(([\s\S]*?)\n\);/g)]
  .map(m => ({ name: m[1], body: m[2] }))

const tenantTables = tables.filter(t => !GLOBAL_TABLES.has(t.name))

describe('the table half of the matrix', () => {
  it('found every ledger table (a parse failure must not read as a pass)', () => {
    expect(tables.map(t => t.name).sort()).toEqual([
      'account_resolutions', 'accounts', 'document_blobs', 'document_extractions',
      'document_file_variants', 'document_verification_events', 'import_batches',
      'instrument_aliases', 'instruments', 'logical_documents', 'raw_import_rows',
      'reconciliation_case_events', 'reconciliation_cases', 'transaction_amount_components',
      'transaction_document_links', 'transaction_groups', 'transactions',
      'validation_findings',
    ])
    expect(tenantTables.length).toBe(17)
  })

  it.each(tenantTables.map(t => t.name))('%s has a NOT NULL workspace_id with no default', name => {
    const body = tenantTables.find(t => t.name === name)!.body
    const col = new RegExp(`^\\s*workspace_id\\s+UUID\\s+NOT NULL\\s+REFERENCES identity\\.workspaces\\(id\\)`, 'm')
    expect(body, `${name}.workspace_id`).toMatch(col)
    // A DEFAULT is how the first cross-tenant row gets written by omission.
    expect(body).not.toMatch(/workspace_id[^,\n]*DEFAULT/i)
  })

  it.each(tenantTables.map(t => t.name))('%s has a NOT NULL actor_principal_id keyed to a principal', name => {
    const body = tenantTables.find(t => t.name === name)!.body
    expect(body, `${name}.actor_principal_id`).toMatch(
      /^\s*actor_principal_id\s+UUID\s+NOT NULL\s+REFERENCES identity\.principals\(id\)/m)
    expect(body).not.toMatch(/actor_principal_id[^,\n]*DEFAULT/i)
  })

  it('instruments stays global — no tenancy, no attribution', () => {
    const body = tables.find(t => t.name === 'instruments')!.body
    expect(body).not.toContain('workspace_id')
    expect(body).not.toContain('actor_principal_id')
  })
})

describe('the trigger half of the matrix', () => {
  const triggers = new Map<string, string[]>()
  for (const m of migrationText.matchAll(
    /CREATE TRIGGER actor_is_authorized BEFORE INSERT ON investment_ledger\.(\w+)\s*\n\s*FOR EACH ROW EXECUTE FUNCTION identity\.assert_actor_authorized\(([^)]*)\);/g)) {
    triggers.set(m[1], m[2].split(',').map(s => s.trim().replace(/^'|'$/g, '')))
  }

  it.each(tenantTables.map(t => t.name))('%s has an actor_is_authorized trigger', name => {
    expect([...triggers.keys()], `${name} accepts unproven attribution`).toContain(name)
  })

  it('covers every tenant table and nothing else', () => {
    expect(triggers.size).toBe(17)
    expect(triggers.has('instruments')).toBe(false)
  })

  it('each trigger names a non-empty capability set', () => {
    const known = new Set([
      'archive-import', 'manual-entry', 'reconciliation',
      'document-verification', 'ledger-read',
    ])
    for (const [table, caps] of triggers) {
      expect(caps.length, table).toBeGreaterThan(0)
      for (const c of caps) expect(known, `${table}: ${c}`).toContain(c)
      // ledger-read must never authorize a WRITE.
      expect(caps, table).not.toContain('ledger-read')
    }
  })

  it('the trigger capability set matches the RLS policy capability set', () => {
    // Two independent enforcement layers that disagreed would be worse than
    // one: a row could pass the policy and die in the trigger, or the reverse.
    const rls = readFileSync(join(MIGRATIONS, '017_ledger_views_rls_grants.sql'), 'utf-8')
    // The CASE arms are SQL string literals holding SQL string literals, so the
    // text on the page is `'''archive-import'',''manual-entry'''` — one leading
    // and trailing triple quote and `'',''` between. Pull the capability names
    // out by name rather than trying to model that quoting.
    const CAPS = ['archive-import', 'manual-entry', 'reconciliation',
                  'document-verification', 'ledger-read']
    const explicit = new Map<string, string[]>()
    for (const m of rls.matchAll(/WHEN '(\w+)'\s*THEN\s+(.+)/g)) {
      explicit.set(m[1], CAPS.filter(c => m[2].includes(`'${c}'`)))
    }
    const fallback = ['archive-import']   // the CASE's ELSE branch
    for (const [table, caps] of triggers) {
      const policy = explicit.get(table) ?? fallback
      expect([...caps].sort(), `${table}: trigger vs policy`).toEqual([...policy].sort())
    }
  })
})

describe('the producer half of the matrix', () => {
  const sources = [
    ...readdirSync(SRC).filter(f => f.endsWith('.ts')).map(f => join(SRC, f)),
    ...readdirSync(BIN).filter(f => f.endsWith('.ts')).map(f => join(BIN, f)),
  ]

  interface Insert { file: string; table: string; columns: string[] }
  const inserts: Insert[] = []
  for (const file of sources) {
    const text = readFileSync(file, 'utf-8')
    for (const m of text.matchAll(/INSERT INTO investment_ledger\.(\w+)\s*\(([^)]*)\)/g)) {
      inserts.push({
        file: file.slice(file.lastIndexOf('/') + 1),
        table: m[1],
        columns: m[2].split(',').map(c => c.trim()).filter(Boolean),
      })
    }
  }

  it('found the production INSERTs (a parse failure must not read as a pass)', () => {
    expect(inserts.length).toBeGreaterThanOrEqual(18)
    expect(new Set(inserts.map(i => i.file))).toEqual(new Set(['publish.ts', 'manual-entry.ts']))
  })

  it.each(inserts.map((i, n) => [`${i.file} #${n} -> ${i.table}`, n] as const))(
    '%s supplies workspace_id and actor_principal_id', (_label, n) => {
      const insert = inserts[n]
      if (GLOBAL_TABLES.has(insert.table)) return
      expect(insert.columns, `${insert.file}: ${insert.table}`).toContain('workspace_id')
      expect(insert.columns, `${insert.file}: ${insert.table}`).toContain('actor_principal_id')
    })

  it('no production code INSERTs into the global instruments table', () => {
    // The only path is 017's resolve_or_create_instrument, which authorizes
    // before it writes. A direct INSERT would bypass that entirely.
    expect(inserts.filter(i => i.table === 'instruments')).toEqual([])
    for (const file of sources) {
      const text = readFileSync(file, 'utf-8')
      const code = text.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
      expect(code, file).not.toMatch(/INSERT INTO investment_ledger\.instruments/)
    }
  })

  it('is not vacuous: an INSERT missing the actor is detected', () => {
    const bad = `INSERT INTO investment_ledger.accounts
       (workspace_id, account_key) VALUES ($1,$2)`
    const m = /INSERT INTO investment_ledger\.(\w+)\s*\(([^)]*)\)/.exec(bad)!
    const columns = m[2].split(',').map(c => c.trim())
    expect(columns).toContain('workspace_id')
    expect(columns).not.toContain('actor_principal_id')
  })
})
