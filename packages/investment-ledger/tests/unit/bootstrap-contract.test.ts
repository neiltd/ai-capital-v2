import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// THE ops/ BOOTSTRAP CONTRACT — no database connection anywhere in this file.
//
// WHY THIS EXISTS. The 2026-09-06 disposable-cluster gate could not get past
// setup. Three of its seven blockers were in `ops/bootstrap/`, and all three had
// the same shape: a privilege the migration chain needs at a moment nobody had
// executed. Static tests over the migrations could not see them, because the
// missing pieces were not IN the migrations.
//
// These assertions are about ORDER and SCOPE — the two things a reader of a
// bootstrap script cannot check by reading it, and the two things a fresh
// database is merciless about.

const HERE = dirname(fileURLToPath(import.meta.url))
const OPS = resolve(HERE, '..', '..', '..', '..', 'ops')
const bootstrap = readFileSync(join(OPS, 'bootstrap', '010_database_bootstrap.sql'), 'utf-8')
const lockdown  = readFileSync(join(OPS, 'bootstrap', '090_post_migration_lockdown.sql'), 'utf-8')

/** Statements only: prose about a privilege is not a grant of it. */
const code = (sql: string) =>
  sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/**
 * Statements with SQL STRING LITERALS blanked out.
 *
 * The postcondition's RAISE HINT quotes the very statements it forbids —
 * "CREATE EXTENSION ... WITH SCHEMA public is a no-op ...", "relocate it with
 * ALTER EXTENSION <name> SET SCHEMA public". A checker that reads those as code
 * both miscounts the CREATE EXTENSION statements and accuses the file of
 * mutating an extension it only mentions. Advice about a statement is not that
 * statement, exactly as a comment about a grant is not a grant.
 */
function withoutStringLiterals(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    if (sql[i] !== "'") { out += sql[i]; i++; continue }
    i++
    while (i < sql.length) {
      if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
      if (sql[i] === "'") { i++; break }
      i++
    }
    out += "''"
  }
  return out
}

const bootstrapCode = code(bootstrap)
const lockdownCode  = code(lockdown)
/** Bootstrap statements with message text removed — see withoutStringLiterals. */
const bootstrapStatements = withoutStringLiterals(bootstrapCode)

describe('the migrator can actually run migrate.ts (defect B1)', () => {
  it('010 grants CREATE on the DATABASE — for CREATE SCHEMA IF NOT EXISTS db', () => {
    expect(bootstrapCode).toMatch(/GRANT CREATE ON DATABASE :"dbname" TO ai_capital_migrator;/)
  })

  it('010 grants CREATE on SCHEMA db — for CREATE TABLE IF NOT EXISTS', () => {
    // THE DEFECT, stated as a test. `CREATE TABLE IF NOT EXISTS
    // db.schema_migrations` resolves its creation namespace and checks
    // ACL_CREATE there BEFORE the IF-NOT-EXISTS short-circuit, so the statement
    // is refused even though the table already exists. Every fresh database
    // failed on the runner's first statement with "permission denied for
    // schema db"; the file had reasoned only about the database-level grant.
    expect(bootstrapCode).toMatch(/GRANT CREATE ON SCHEMA db TO ai_capital_migrator;/)
  })

  it('010 grants PERMANENT read on the ledger, and window-only append', () => {
    // THE SPLIT, and why it is not cosmetic. An earlier version granted
    // `SELECT, INSERT` in one statement and 090 retained both, so a CLOSED
    // window still admitted a row into db.schema_migrations. That table is what
    // every downstream check trusts to say which migrations are applied and
    // with what hashes; a deployment login able to append to it after lockdown
    // can record that a migration ran when it could not have run.
    expect(bootstrapCode).toMatch(/GRANT USAGE ON SCHEMA db TO ai_capital_migrator;/)
    expect(bootstrapCode).toMatch(/GRANT SELECT ON db\.schema_migrations TO ai_capital_migrator;/)
    expect(bootstrapCode).toMatch(/GRANT INSERT ON db\.schema_migrations TO ai_capital_migrator;/)
    // The combined grant must not come back: it is the defect itself.
    expect(bootstrapCode, 'the permanent SELECT, INSERT grant is back')
      .not.toMatch(/GRANT SELECT, ?INSERT ON db\.schema_migrations/)
  })

  it('090 revokes the ledger INSERT and keeps the ledger SELECT', () => {
    // INSERT is a window privilege and is revoked with the rest of them.
    expect(lockdownCode, 'lockdown does not close ledger write authority')
      .toMatch(/REVOKE INSERT ON db\.schema_migrations FROM ai_capital_migrator;/)
    // Reading a closed ledger is NOT a window privilege — "which migrations are
    // applied" must be answerable at any time.
    expect(lockdownCode, 'lockdown must not revoke ledger SELECT')
      .not.toMatch(/REVOKE[^;]*SELECT[^;]*ON db\.schema_migrations/)
    expect(lockdownCode, 'lockdown must not revoke USAGE ON SCHEMA db')
      .not.toMatch(/REVOKE[^;]*USAGE ON SCHEMA db/)
  })

  it('reopening the window restores INSERT without a separate repair', () => {
    // The property the old permanent grant was protecting, preserved without
    // the permanent grant: re-running 010 is the single deliberate act, and it
    // re-issues the INSERT itself.
    const insertGrant = bootstrapCode.indexOf('GRANT INSERT ON db.schema_migrations TO ai_capital_migrator')
    expect(insertGrant, '010 does not re-grant ledger INSERT').toBeGreaterThan(-1)
    // ... and it is in 010, not in some separate repair script.
    expect(lockdownCode, 'lockdown must not re-grant what it revokes')
      .not.toMatch(/GRANT[^;]*INSERT[^;]*ON db\.schema_migrations/)
  })

  it('the schema-CREATE grant comes AFTER db.schema_migrations exists', () => {
    // Ordering, not just presence: the grant names a schema, so the schema has
    // to be there. It is also where a reader looks for the explanation.
    const created = bootstrapCode.indexOf('CREATE TABLE IF NOT EXISTS db.schema_migrations')
    const granted = bootstrapCode.indexOf('GRANT CREATE ON SCHEMA db TO ai_capital_migrator')
    expect(created).toBeGreaterThan(-1)
    expect(granted).toBeGreaterThan(created)
  })

  it('the explanation no longer claims both statements are no-ops', () => {
    // The comment was the reason the defect survived review: it asserted the
    // conclusion the code got wrong.
    expect(bootstrap).not.toMatch(/Both statements are no-ops once the objects below exist/)
    expect(bootstrap).toMatch(/checks CREATE on the\s*\n--\s*SCHEMA/)
  })
})

describe('lockdown closes BOTH halves of the window (defect B1)', () => {
  it('090 revokes CREATE on the database and on schema db', () => {
    expect(lockdownCode).toMatch(/REVOKE CREATE ON DATABASE :"dbname" FROM ai_capital_migrator;/)
    expect(lockdownCode).toMatch(/REVOKE CREATE ON SCHEMA db\s+FROM ai_capital_migrator;/)
  })

  it('every CREATE the bootstrap grants the migrator is revoked by lockdown', () => {
    // Derived, not listed. A future grant added to 010 and forgotten in 090
    // fails here rather than silently leaving the window ajar.
    const granted = [...bootstrapCode.matchAll(
      /GRANT [^;]*\bCREATE\b[^;]*?ON (DATABASE :"dbname"|SCHEMA \w+)[^;]*TO ([^;]*ai_capital_migrator[^;]*);/g)]
      .map(m => m[1])
    expect(granted.sort()).toEqual(['DATABASE :"dbname"', 'SCHEMA db'])
    for (const target of granted) {
      const revoked = new RegExp(`REVOKE CREATE ON ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+FROM ai_capital_migrator`)
      expect(lockdownCode, `${target} is granted by 010 and never revoked by 090`).toMatch(revoked)
    }
  })

  it('090 does NOT revoke the ledger READ access the runner keeps', () => {
    // Narrowed from "does not revoke anything on db.schema_migrations": that
    // blanket form asserted the very defect this round removes, because it also
    // forbade revoking INSERT. Only the READ path is retained now.
    expect(lockdownCode).not.toMatch(/REVOKE[^;]*USAGE ON SCHEMA db/)
    expect(lockdownCode).not.toMatch(/REVOKE[^;]*SELECT[^;]*ON db\.schema_migrations/)
  })

  it('re-running 010 is what reopens the window', () => {
    expect(bootstrapCode).toMatch(/GRANT ai_capital_owner\s+TO ai_capital_migrator WITH INHERIT FALSE, SET TRUE;/)
    expect(lockdownCode).toMatch(/REVOKE ai_capital_owner\s+FROM ai_capital_migrator;/)
  })
})

describe('pgvector is provisioned by the bootstrap (defect B2)', () => {
  it('010 pre-creates BOTH extensions the chain needs', () => {
    expect(bootstrapCode).toMatch(/CREATE EXTENSION IF NOT EXISTS btree_gist\b/)
    expect(bootstrapCode).toMatch(/CREATE EXTENSION IF NOT EXISTS vector\b/)
  })

  it('EVERY CREATE EXTENSION names its target schema explicitly', () => {
    // Both extensions are RELOCATABLE, so an unqualified CREATE EXTENSION
    // installs into the first schema of the creating session's effective
    // `search_path`. `--no-psqlrc` does NOT settle that: a search_path set with
    // ALTER DATABASE ... SET or ALTER ROLE ... SET is applied by the server at
    // connect time, before psql runs anything.
    //
    // Everything downstream assumes `public` — the single USAGE grant, the
    // lockdown that preserves it, and the runtime assertion that both
    // extensions live there — so placement must be a property of this file and
    // not of whoever runs it.
    const statements = [...bootstrapStatements.matchAll(/CREATE EXTENSION[^;]*;/g)].map(m => m[0])
    expect(statements, 'no CREATE EXTENSION found — the check would be vacuous')
      .toHaveLength(2)
    for (const statement of statements) {
      expect(statement, 'CREATE EXTENSION without an explicit schema')
        .toMatch(/WITH SCHEMA public\s*;/)
    }
  })

  it('...and that schema is the one the grant and the runtime check assume', () => {
    // The three statements have to agree, and they are in three different
    // places: this file's CREATE, this file's GRANT, and the post-lockdown
    // suite's `pg_extension → pg_namespace` assertion.
    expect(bootstrapCode).toMatch(
      /CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;/)
    expect(bootstrapCode).toMatch(
      /CREATE EXTENSION IF NOT EXISTS vector\s+WITH SCHEMA public;/)
    expect(bootstrapCode).toMatch(/GRANT USAGE ON SCHEMA public TO ai_capital_owner;/)
  })

  it('an UNQUALIFIED CREATE EXTENSION is not accepted', () => {
    // The negative form of the rule, stated separately so the intent survives a
    // future edit: no statement may leave placement to the session.
    const unqualified = [...bootstrapStatements.matchAll(/CREATE EXTENSION[^;]*;/g)]
      .map(m => m[0])
      .filter(st => !/WITH SCHEMA/.test(st))
    expect(unqualified, 'these install into whatever search_path offers first').toEqual([])
  })

  // ── THE FAIL-CLOSED POSTCONDITION ────────────────────────────────────────
  //
  // `CREATE EXTENSION IF NOT EXISTS ... WITH SCHEMA public` is a no-op when the
  // extension already exists IN ANY SCHEMA. It emits a notice and succeeds — so
  // on a database where a previous run put `vector` in, say, `extensions`, the
  // whole bootstrap reports a clean run while everything downstream assumes
  // something untrue. The clause is necessary and not sufficient; the check is
  // what makes the file's promise true.

  /** The DO block that enforces extension placement, if there is one. */
  const postcondition = (() => {
    for (const m of bootstrapCode.matchAll(/DO \$\$[\s\S]*?END \$\$;/g)) {
      if (/pg_extension/.test(m[0])) return m[0]
    }
    return null
  })()

  /** The postcondition's executable half, with its message text removed. */
  const postconditionStatements = postcondition ? withoutStringLiterals(postcondition) : ''

  it('a namespace postcondition exists at all', () => {
    expect(postcondition, 'no DO block inspects pg_extension').toBeTruthy()
  })

  it('it fails closed — RAISE EXCEPTION, not a notice', () => {
    // A NOTICE would let the bootstrap "succeed" on exactly the database the
    // check exists to catch.
    expect(postcondition).toMatch(/RAISE EXCEPTION/)
  })

  it('it checks BOTH extensions', () => {
    for (const extension of ['btree_gist', 'vector']) {
      expect(postcondition, `${extension} is not covered by the postcondition`)
        .toContain(`'${extension}'`)
    }
  })

  it('it resolves the namespace and requires it to be public', () => {
    // Reading pg_extension alone would prove existence, not placement.
    expect(postcondition).toMatch(/pg_namespace/)
    expect(postcondition).toMatch(/extnamespace/)
    expect(postcondition).toMatch(/nspname = 'public'/)
  })

  it('it names WHICH extension is wrong, and where it actually is', () => {
    // A bare "postcondition failed" would send an operator to read this file
    // instead of to the extension that is in the wrong place.
    expect(postcondition).toMatch(/not installed/)
    expect(postcondition).toMatch(/installed in schema/)
  })

  it('it does not MUTATE a misplaced extension', () => {
    // Relocating one silently is exactly the unrequested change of existing
    // state this design refuses. The message names the remedy; an operator
    // decides.
    // Read with message text stripped: the HINT deliberately NAMES
    // `ALTER EXTENSION ... SET SCHEMA public` as the remedy an operator should
    // apply, and advice about a statement is not that statement.
    expect(postconditionStatements).not.toMatch(/ALTER EXTENSION/)
    expect(postconditionStatements).not.toMatch(/DROP EXTENSION/)
    expect(postconditionStatements).not.toMatch(/CREATE EXTENSION/)
    // …and the HINT really does still name the remedy.
    expect(postcondition).toMatch(/ALTER EXTENSION <name> SET SCHEMA public/)
  })

  it('it runs AFTER both CREATE EXTENSION statements', () => {
    const lastCreate = bootstrapCode.lastIndexOf('CREATE EXTENSION IF NOT EXISTS')
    expect(bootstrapCode.indexOf(postcondition!)).toBeGreaterThan(lastCreate)
  })

  it('...and BEFORE the PUBLIC revoke', () => {
    // After the revoke it would still be correct, but the two statements it
    // protects — the revoke and the single USAGE grant — would already have
    // been issued against an assumption nobody had checked.
    const revoke = bootstrapCode.indexOf('REVOKE ALL ON SCHEMA public FROM PUBLIC')
    expect(revoke).toBeGreaterThan(-1)
    expect(bootstrapCode.indexOf(postcondition!)).toBeLessThan(revoke)
  })

  it('it introduces no transaction control', () => {
    // psql --single-transaction supplies exactly one; a BEGIN/COMMIT inside
    // would break the SET LOCAL ROLE scoping the rest of the file depends on.
    for (const kw of ['BEGIN;', 'COMMIT;', 'ROLLBACK;', 'SAVEPOINT']) {
      expect(postconditionStatements, `postcondition contains ${kw}`).not.toContain(kw)
    }
  })

  it('it needs no privilege the bootstrap does not already have', () => {
    // Catalogue reads only. A GRANT here would be a new privilege introduced by
    // a check, which is worse than the thing it checks.
    expect(postconditionStatements).not.toMatch(/\bGRANT\b/)
    expect(postconditionStatements).not.toMatch(/SET (LOCAL )?ROLE/)
  })

  it('both are created BEFORE the PUBLIC revoke', () => {
    // They land in `public`. Created after the revoke, the administrator could
    // still make them — but the ordering is what a reader must be able to trust,
    // and reversing it is a plausible tidy-up.
    const gist   = bootstrapCode.indexOf('CREATE EXTENSION IF NOT EXISTS btree_gist')
    const vector = bootstrapCode.indexOf('CREATE EXTENSION IF NOT EXISTS vector')
    const revoke = bootstrapCode.indexOf('REVOKE ALL ON SCHEMA public FROM PUBLIC')
    expect(gist).toBeGreaterThan(-1)
    expect(vector).toBeGreaterThan(-1)
    expect(revoke).toBeGreaterThan(vector)
    expect(revoke).toBeGreaterThan(gist)
  })

  it('migration 006 is untouched and still expects the extension', () => {
    // 006 is PUBLISHED AND IMMUTABLE — migrate.ts refuses a changed hash — so
    // the fix had to be in the bootstrap. This asserts we did not "fix" 006.
    const m006 = readFileSync(
      resolve(HERE, '..', '..', '..', 'db', 'migrations', '006_vectors.sql'), 'utf-8')
    expect(m006).toContain('CREATE EXTENSION IF NOT EXISTS vector;')
    expect(m006).not.toContain('workspace_id')
    expect(m006).not.toContain('WITH SCHEMA')
  })

  it('migration 006 is BYTE-unchanged from the published revision', () => {
    // The strongest available statement, and it needs no git: 006 is pinned in
    // db.schema_migrations by this exact sha256, so any edit at all — including
    // one that "only" adds a comment — would make migrate.ts refuse to run on
    // every database that has already applied it.
    const bytes = readFileSync(
      resolve(HERE, '..', '..', '..', 'db', 'migrations', '006_vectors.sql'))
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('948c04ee131362647b07bfe6313ca59a8f15c3d24b29cdd7f8013ffe9c6916cb')
  })

  it('the bootstrap describes 006 ACCURATELY', () => {
    // A comment is the only place a reader learns WHY the owner needs USAGE on
    // public, so a comment that invents the evidence is worse than none. An
    // earlier version cited `chunk_embedding vector(1536)`; 006 declares
    // `embedding vector(384)` and neither the name nor the dimension was real.
    // Whitespace-normalised on BOTH sides: 006 aligns its column list
    // (`embedding        vector(384)`), and a citation is expected to quote the
    // tokens, not reproduce the padding.
    const squash = (t: string) => t.replace(/\s+/g, ' ')
    const m006 = squash(readFileSync(
      resolve(HERE, '..', '..', '..', 'db', 'migrations', '006_vectors.sql'), 'utf-8'))
    const cites = [...bootstrap.matchAll(/006\s+`([^`]+)`/g)].map(m => squash(m[1]))
    expect(cites.length, 'the bootstrap cites nothing from 006').toBeGreaterThan(0)
    for (const cited of cites) {
      expect(m006, `010 cites \`${cited}\`, which 006 does not contain`).toContain(cited)
    }
    expect(bootstrap).toContain('embedding vector(384)')
    expect(bootstrap).not.toContain('vector(1536)')
    expect(bootstrap).not.toContain('chunk_embedding')
  })
})

describe('schema public stays shut (defect B3)', () => {
  it('PUBLIC is fully revoked and nothing gives it back', () => {
    expect(bootstrapCode).toMatch(/REVOKE ALL ON SCHEMA public FROM PUBLIC;/)
    const grantsToPublic = [...bootstrapCode.matchAll(/GRANT[^;]*ON SCHEMA public[^;]*;/g)]
      .filter(m => /\bTO\b[^;]*\bPUBLIC\b/.test(m[0]))
    expect(grantsToPublic.map(m => m[0])).toEqual([])
  })

  it('exactly ONE role receives anything on schema public: ai_capital_owner', () => {
    const grants = [...bootstrapCode.matchAll(/GRANT\s+(\w+)\s+ON SCHEMA public\s+TO ([^;]+);/g)]
      .map(m => ({ privilege: m[1], grantees: m[2].split(',').map(x => x.trim()) }))
    expect(grants).toHaveLength(1)
    expect(grants[0].privilege).toBe('USAGE')
    expect(grants[0].grantees).toEqual(['ai_capital_owner'])
  })

  it('the owner gets USAGE and never CREATE', () => {
    // CREATE on public is what the revoke exists to prevent; every application
    // object belongs in a named schema this design owns.
    expect(bootstrapCode).toMatch(/GRANT USAGE ON SCHEMA public TO ai_capital_owner;/)
    expect(bootstrapCode).not.toMatch(/GRANT[^;]*CREATE[^;]*ON SCHEMA public/)
    expect(lockdownCode).not.toMatch(/GRANT[^;]*ON SCHEMA public/)
  })

  it('no runtime or operations role receives a public-schema privilege', () => {
    // The gate used a deliberately broad diagnostic grant to all seven roles.
    // That was a probe, not a design: source tracing over 011-017 finds exactly
    // ONE reference from the tenancy schemas into `public` — 011's
    // `EXCLUDE USING gist` opclass lookup, performed at DDL time by the owner.
    for (const role of ['ai_capital_migrator', 'ai_capital_importer', 'ai_capital_agent',
                        'ai_capital_app', 'ai_capital_operator',
                        'ai_capital_identity_authority']) {
      const re = new RegExp(`GRANT[^;]*ON SCHEMA public[^;]*${role}`)
      expect(bootstrapCode, `${role} must not receive a public-schema privilege`).not.toMatch(re)
    }
  })

  it('nothing in 011-017 asks for schema public either', () => {
    const dir = resolve(HERE, '..', '..', '..', 'db', 'migrations')
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql') && Number(f.slice(0, 3)) >= 11)) {
      const body = code(readFileSync(join(dir, f), 'utf-8'))
      expect(body, `${f} references schema public`).not.toMatch(/ON SCHEMA public/)
    }
  })
})

describe('the ops files remain single-transaction safe', () => {
  it('neither file contains its own transaction control', () => {
    // Both are run with psql --single-transaction, which supplies exactly one.
    // Internal BEGIN/COMMIT would break the SET LOCAL ROLE scoping they rely on.
    for (const [name, body] of [['010', bootstrapCode], ['090', lockdownCode]] as const) {
      for (const kw of ['BEGIN;', 'COMMIT;', 'ROLLBACK;']) {
        expect(body, `${name} contains ${kw}`).not.toContain(kw)
      }
    }
  })
})
