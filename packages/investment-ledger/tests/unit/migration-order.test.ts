import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// STATIC MIGRATION CONTRACT — no database connection anywhere in this file.
//
// The defect these guard against is real and was caught in review: an earlier
// draft had the tenant-aware ledger migrations referencing identity.workspaces
// while `identity` was created by a HIGHER-numbered file. That cannot be applied
// to a fresh database at all, and no amount of care in review reliably catches
// it — a lexical check does.

const HERE = dirname(fileURLToPath(import.meta.url))
// Reaches packages/db/migrations from the ledger's DATABASE-FREE unit suite.
// It lives here rather than in packages/db because that package's vitest
// config carries a database globalSetup, so a purely static check placed
// there could never run without a PostgreSQL connection.
const DIR = resolve(HERE, '..', '..', '..', 'db', 'migrations')
const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const text = (f: string) => readFileSync(join(DIR, f), 'utf-8')
const indexOf = (f: string) => files.indexOf(f)

describe('migration filenames', () => {
  it('are zero-padded, so lexical order IS execution order', () => {
    for (const f of files) expect(f).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/)
    const numbers = files.map(f => Number(f.slice(0, 3)))
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
    expect(new Set(numbers).size, 'no duplicate migration number').toBe(numbers.length)
  })

  it('cover 001-017 with no gaps', () => {
    expect(files.map(f => Number(f.slice(0, 3))))
      .toEqual(Array.from({ length: 17 }, (_, i) => i + 1))
  })
})

describe('dependency order', () => {
  it('identity exists before anything references it', () => {
    const creator = files.find(f => text(f).includes('CREATE SCHEMA identity'))!
    expect(creator).toBe('011_identity_foundation.sql')
    for (const f of files) {
      if (!text(f).includes('REFERENCES identity.')) continue
      expect(indexOf(f), `${f} references identity before it exists`)
        .toBeGreaterThanOrEqual(indexOf(creator))
    }
  })

  it('the ledger schema exists before its tables are altered', () => {
    const creator = files.find(f => text(f).includes('CREATE SCHEMA IF NOT EXISTS investment_ledger'))!
    expect(creator).toBe('013_investment_ledger.sql')
    for (const f of files) {
      if (!text(f).includes('ALTER TABLE investment_ledger.')) continue
      expect(indexOf(f)).toBeGreaterThanOrEqual(indexOf(creator))
    }
  })

  it('all nine views are defined once, in the final migration', () => {
    const per = files.map(f => [f, (text(f).match(/CREATE (?:OR REPLACE )?VIEW investment_ledger\./g) ?? []).length] as const)
    for (const [f, n] of per) {
      if (f === '017_ledger_views_rls_grants.sql') expect(n, f).toBe(9)
      else expect(n, `${f} should define no ledger view`).toBe(0)
    }
    // No CREATE OR REPLACE anywhere: each view is written once, in final form.
    expect(text('017_ledger_views_rls_grants.sql')).not.toContain('CREATE OR REPLACE VIEW')
  })

  it('row-level security is enabled AND forced, and only where intended', () => {
    // Match STATEMENTS, not the phrase: several files discuss FORCE RLS in
    // prose, and an earlier version of this test failed on its own commentary.
    const enabling = files.filter(f => /ALTER TABLE [^;]*ENABLE ROW LEVEL SECURITY/.test(text(f)))
    expect(enabling.sort())
      .toEqual(['012_identity_security.sql', '017_ledger_views_rls_grants.sql'])
    for (const f of enabling) {
      const enable = (text(f).match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length
      const force  = (text(f).match(/FORCE\s+ROW LEVEL SECURITY/g) ?? []).length
      expect(force, `${f}: every ENABLE needs a matching FORCE`).toBe(enable)
    }
  })
})

describe('constraint names track the declarations that generate them', () => {
  // DEFECT V3-1. 013 declares `UNIQUE (workspace_id, source_kind, source_sha256)`
  // and PostgreSQL names an unnamed table constraint
  // <table>_<column>_<column>..._key. Adding `workspace_id` during the tenancy
  // rewrite therefore RENAMED it — and 015's DROP CONSTRAINT still spelled the
  // pre-tenancy name, so the chain failed on every fresh database with
  // `constraint "..." of relation "import_batches" does not exist`.
  //
  // Nothing static could see it, because nothing tied the DROP to the
  // declaration. This does: the expected name is DERIVED from 013's own
  // column list, so changing that list without changing 015 fails here.

  /** PostgreSQL's own rule for an unnamed UNIQUE table constraint. */
  function generatedUniqueName(table: string, columns: string[]): string {
    return `${table}_${columns.join('_')}_key`
  }

  it('015 drops the name 013 actually generates', () => {
    const decl = /CREATE TABLE investment_ledger\.import_batches \(([\s\S]*?)\n\);/
      .exec(text('013_investment_ledger.sql'))?.[1]
    expect(decl, 'import_batches declaration not found in 013').toBeTruthy()

    // The UNIQUE that carries the idempotency key — the one 015 replaces.
    const unique = /UNIQUE \(([^)]*source_sha256[^)]*)\)/.exec(decl!)?.[1]
    expect(unique, 'the (…, source_kind, source_sha256) UNIQUE is gone from 013').toBeTruthy()
    const columns = unique!.split(',').map(c => c.trim())
    expect(columns).toEqual(['workspace_id', 'source_kind', 'source_sha256'])

    const expected = generatedUniqueName('import_batches', columns)
    expect(expected).toBe('import_batches_workspace_id_source_kind_source_sha256_key')

    const dropped = /DROP CONSTRAINT (\w+);/.exec(text('015_investment_ledger_series_and_corrections.sql'))?.[1]
    expect(dropped, '015 no longer drops a constraint').toBeTruthy()
    expect(dropped, 'the dropped name does not match the one 013 generates').toBe(expected)
  })

  it('the pre-tenancy spelling appears nowhere in any migration', () => {
    for (const f of files) {
      expect(text(f), `${f} still names the pre-tenancy constraint`)
        .not.toMatch(/DROP CONSTRAINT import_batches_source_kind_source_sha256_key/)
    }
  })

  it('is not vacuous: the deriving rule rejects the old column list', () => {
    // The control. With the pre-tenancy columns the rule produces exactly the
    // name that used to be dropped — so the check discriminates.
    expect(generatedUniqueName('import_batches', ['source_kind', 'source_sha256']))
      .toBe('import_batches_source_kind_source_sha256_key')
  })

  it('every DROP CONSTRAINT in 011-017 names a constraint some migration creates', () => {
    // The general form of the same defect. A DROP naming something nothing
    // declares cannot apply, whatever the reason.
    const all = files.map(text).join('\n')
    for (const f of files) {
      for (const m of text(f).matchAll(/DROP CONSTRAINT (?:IF EXISTS )?(\w+)/g)) {
        const name = m[1]
        const declared =
          all.includes(`ADD CONSTRAINT ${name}`) ||
          all.includes(`CONSTRAINT ${name} `) ||
          // system-generated: derivable from a UNIQUE/PRIMARY KEY declaration
          /^\w+_(?:\w+_)*key$/.test(name)
        expect(declared, `${f} drops ${name}, which nothing declares`).toBe(true)
      }
    }
  })
})

describe('view references respect the migration that creates the view', () => {
  // DEFECT V3-2. `migration-order.test.ts` used to check only that the nine
  // views are CREATEd once, in 017. But 015 also carried a
  // `COMMENT ON VIEW investment_ledger.current_document_verification`, left
  // behind when the views were relocated — and COMMENT ON resolves its target
  // IMMEDIATELY, unlike a PL/pgSQL body. Counting CREATE VIEW statements could
  // never have caught it.
  //
  // So this looks at every OTHER statement that names a view: COMMENT ON VIEW,
  // ALTER VIEW, GRANT/REVOKE ... ON <view>, and DROP VIEW.

  const VIEW_CREATOR = '017_ledger_views_rls_grants.sql'

  /** Every ledger view name, taken from the file that creates them. */
  const viewNames = [...text(VIEW_CREATOR).matchAll(
    /CREATE VIEW investment_ledger\.(\w+)/g)].map(m => m[1])

  it('found the views (a parse failure must not read as a pass)', () => {
    expect(viewNames).toHaveLength(9)
    expect(new Set(viewNames).size).toBe(9)
  })

  it('no migration BEFORE 017 references a ledger view in a resolving statement', () => {
    const offenders: string[] = []
    for (const f of files) {
      if (indexOf(f) >= indexOf(VIEW_CREATOR)) continue
      const body = text(f)
      for (const view of viewNames) {
        const resolving = new RegExp(
          `(COMMENT ON VIEW|ALTER VIEW|DROP VIEW|GRANT[^;]*\\bON\\b|REVOKE[^;]*\\bON\\b)` +
          `\\s+investment_ledger\\.${view}\\b`)
        if (resolving.test(body)) offenders.push(`${f} -> ${view}`)
      }
    }
    expect(offenders, 'these statements resolve a view that does not exist yet').toEqual([])
  })

  it('the relocated comment now sits AFTER its CREATE VIEW, in 017', () => {
    const t = text(VIEW_CREATOR)
    const created = t.indexOf('CREATE VIEW investment_ledger.current_document_verification')
    const commented = t.indexOf('COMMENT ON VIEW investment_ledger.current_document_verification')
    expect(created).toBeGreaterThan(-1)
    expect(commented).toBeGreaterThan(created)
  })

  it('015 keeps its COMMENT ON COLUMN, which resolves a TABLE that exists', () => {
    // Deliberately NOT moved: document_file_variants is created in 013, so this
    // is the earliest valid home. It merely NAMES the view in its text.
    const t = text('015_investment_ledger_series_and_corrections.sql')
    expect(t).toMatch(
      /COMMENT ON COLUMN investment_ledger\.document_file_variants\.verification_status IS/)
    // STATEMENTS, not prose: 015 now explains at length where the COMMENT ON
    // VIEW went and why, and an earlier version of this assertion matched its
    // own explanation.
    const statements = t.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
    expect(statements).not.toMatch(/COMMENT ON VIEW/)
  })

  it('is not vacuous: the detector fires on the exact statement that was moved', () => {
    const injected = `COMMENT ON VIEW investment_ledger.current_document_verification IS 'x';`
    const resolving = new RegExp(
      `(COMMENT ON VIEW|ALTER VIEW|DROP VIEW)\\s+investment_ledger\\.current_document_verification\\b`)
    expect(resolving.test(injected)).toBe(true)
    // …and does not fire on the COMMENT ON COLUMN that legitimately stays.
    expect(resolving.test(
      "COMMENT ON COLUMN investment_ledger.document_file_variants.verification_status IS 'see current_document_verification';"))
      .toBe(false)
  })
})

describe('the published migrations are untouched', () => {
  // 001-010 are immutable. migrate.ts refuses to re-run a file whose hash
  // changed, so editing one is not a style question — it breaks every database
  // that has already applied it.
  it('001-010 contain no tenancy or identity reference', () => {
    for (const f of files.filter(f => Number(f.slice(0, 3)) <= 10)) {
      expect(text(f), `${f} was edited`).not.toContain('workspace_id')
      expect(text(f), `${f} was edited`).not.toContain('identity.')
    }
  })

  it('portfolio remains single-owner and un-tenanted', () => {
    const t = text('001_portfolio.sql')
    expect(t).toContain('ticker          TEXT        PRIMARY KEY')
    expect(t).not.toContain('workspace_id')
    expect(t).not.toContain('ROW LEVEL SECURITY')
  })
})

describe('no policy trusts a caller-set GUC on its own', () => {
  it('every tenant policy pairs the GUC with an authorization call', () => {
    // PER POLICY, not by looking backwards from each GUC.
    //
    // The original form required an `authorize_service_workspace*(` call within
    // the preceding 220 characters, which encoded the OLD predicate's shape —
    // `workspace_id = authorize_...(guc, caps)`, where the call came first. The
    // corrected predicate compares the row to the GUC first and then requires
    // the authorization result to be non-null, so the lookback failed on a file
    // that is strictly safer than the one it was written for.
    //
    // Checking each policy body as a whole is both order-independent and
    // stronger: it demands that BOTH halves are present in the SAME policy.
    const t = text('017_ledger_views_rls_grants.sql')
    const policies = [...t.matchAll(/CREATE POLICY (\w+)[\s\S]*?\$f\$, t, \w+\)/g)]
    expect(policies.length, 'no policy templates found').toBe(3)
    for (const [body, name] of policies.map(m => [m[0], m[1]] as const)) {
      expect(body, `${name}: no GUC selector`).toMatch(/current_setting\('app\.workspace_id'/)
      expect(body, `${name}: a bare GUC comparison would be no protection at all`)
        .toMatch(/identity\.authorize_service_workspace(_any)?\(/)
      expect(body, `${name}: the row's own workspace is not compared`)
        .toMatch(/workspace_id = nullif\(current_setting/)
    }
  })

  it('ai_capital_app receives no ledger grant or policy in this foundation', () => {
    // Again: statements, not prose. 017 names the role in a comment explaining
    // precisely why it is absent from every GRANT and every policy.
    const t = text('017_ledger_views_rls_grants.sql')
    const code = t.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
    expect(code, 'app must hold no ledger grant').not.toMatch(/GRANT[^;]*ai_capital_app/)
    expect(code, 'app must have no ledger policy').not.toMatch(/CREATE POLICY[^;]*ai_capital_app/)
    // ANCHORED to a role clause. The previous `/TO[^;]*ai_capital_app/` matched
    // `SELECT count(*) INTO n ... VALUES ('ai_capital_app')` inside 017's own
    // closing assertion — the statement that PROVES the app holds nothing. A
    // check that fires on its own guard is worse than no check.
    expect(code, 'app must not be named as a grantee or policy role')
      .not.toMatch(/\bTO\s+(?:\w+\s*,\s*)*ai_capital_app\b/)
  })
})
