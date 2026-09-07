import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  SERVICE_PRINCIPALS, GRANTOR, ALL_CAPABILITIES,
  begin, commit, rollback, isTransactionOpen, probe, probeDetached,
  beginAuthorized, beginWithForgedContext, NO_ACTIVE_TRANSACTION,
} from '../integration/tenancy/fixture.js'
import type { Client } from 'pg'

// THE FIXTURE'S OWN CONTRACT — no database connection anywhere in this file.
//
// WHY A TEST FOR TEST CODE. The tenancy integration suite cannot run until the
// database gate opens, so its fixture is unexercised source. An unexercised
// fixture that violates the schema does not fail loudly when it finally runs:
// it fails during SETUP, and every assertion afterwards reports something other
// than what it claims to test. The first version did exactly that in four
// separate ways — DEFAULT VALUES into a table with two NOT NULL columns, service
// keys that fail their CHECK, several principals bound to one UNIQUE db_role,
// and a missing NOT NULL `granted_by`.
//
// So the fixture's compliance with the identity schema is checked HERE, now,
// against the migrations themselves — which is possible because both are text.

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = resolve(HERE, '..', '..', '..', 'db', 'migrations')
const TENANCY = resolve(HERE, '..', 'integration', 'tenancy')

const identitySql = readFileSync(join(MIGRATIONS, '011_identity_foundation.sql'), 'utf-8')
const fixtureSrc = readFileSync(join(TENANCY, 'fixture.ts'), 'utf-8')
const graphSrc = readFileSync(join(TENANCY, 'graph.ts'), 'utf-8')
const suiteFiles = readdirSync(TENANCY).filter(f => f.endsWith('.test.ts'))
const suiteSrc = suiteFiles.map(f => readFileSync(join(TENANCY, f), 'utf-8')).join('\n')

/** Columns of an identity table that are NOT NULL and have no DEFAULT — the
 *  ones an INSERT must therefore name. Generated columns are excluded: they
 *  cannot be supplied. */
function requiredColumns(table: string): string[] {
  const body = new RegExp(`CREATE TABLE identity\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(identitySql)?.[1]
  if (!body) throw new Error(`identity.${table} not found in 011`)
  const required: string[] = []
  for (const line of body.split('\n')) {
    const m = /^\s{2}([a-z_]+)\s+[A-Za-z]/.exec(line)
    if (!m) continue
    if (!/NOT NULL/.test(line)) continue
    if (/DEFAULT/.test(line)) continue
    if (/GENERATED ALWAYS AS/.test(line)) continue
    required.push(m[1])
  }
  return required
}

/** Every `INSERT INTO identity.<table> (cols)` in the fixture. */
function fixtureInserts(): { table: string; columns: string[] }[] {
  const out: { table: string; columns: string[] }[] = []
  for (const m of fixtureSrc.matchAll(/INSERT INTO identity\.(\w+)\s*\(([^)]*)\)/g)) {
    out.push({ table: m[1], columns: m[2].split(',').map(c => c.trim()).filter(Boolean) })
  }
  return out
}

describe('the fixture supplies every required identity column', () => {
  const inserts = fixtureInserts()

  it('found the inserts (a parse failure must not read as a pass)', () => {
    expect(inserts.map(i => i.table).sort()).toEqual([
      'principals', 'service_principal_roles', 'service_principals',
      'workspace_service_grants', 'workspaces',
    ])
  })

  it.each(['principals', 'service_principals', 'service_principal_roles',
           'workspaces', 'workspace_service_grants'])(
    '%s: every NOT NULL column with no default is named', table => {
      const required = requiredColumns(table)
      expect(required.length, `parsed no required columns for ${table}`).toBeGreaterThan(0)
      for (const insert of inserts.filter(i => i.table === table)) {
        for (const column of required) {
          expect(insert.columns, `identity.${table} INSERT omits ${column}`).toContain(column)
        }
      }
    })

  it('principals is never inserted with DEFAULT VALUES', () => {
    // The original defect, stated literally. `kind` and `display_name` are both
    // NOT NULL with no default, so this form cannot work — and it is the form a
    // fixture reaches for when it only wants an id.
    expect(fixtureSrc).not.toMatch(/INSERT INTO identity\.principals\s+DEFAULT VALUES/)
    expect(requiredColumns('principals').sort()).toEqual(['display_name', 'kind'])
  })

  it('every grant supplies granted_by', () => {
    const grants = inserts.filter(i => i.table === 'workspace_service_grants')
    expect(grants.length).toBeGreaterThan(0)
    for (const grant of grants) {
      expect(grant.columns, 'granted_by is NOT NULL in 011').toContain('granted_by')
    }
    // And the value comes from a seeded principal, not a literal or a null.
    expect(fixtureSrc).toMatch(/grantor: ServicePrincipal/)
    expect(fixtureSrc).toMatch(/grantor\.id\]/)
  })

  it('the production schema was not weakened to accommodate the fixture', () => {
    // The alternative fix — dropping NOT NULL — would have made every test
    // pass and every grant unattributable.
    expect(identitySql).toMatch(/granted_by\s+UUID NOT NULL REFERENCES identity\.principals\(id\)/)
    expect(identitySql).toMatch(/kind\s+TEXT NOT NULL CHECK \(kind IN \('human','service'\)\)/)
    expect(identitySql).toMatch(/display_name\s+TEXT NOT NULL CHECK \(length\(btrim\(display_name\)\) > 0\)/)
  })
})

describe('service keys match the schema constraint', () => {
  const CHECK = /service_key\s+TEXT NOT NULL UNIQUE\s*\n\s*CHECK \(service_key ~ '(\^[^']+\$)'\)/
    .exec(identitySql)?.[1]

  it('the constraint was found in 011', () => {
    expect(CHECK).toBe('^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$')
  })

  it.each([...Object.values(SERVICE_PRINCIPALS).map(s => s.serviceKey), GRANTOR.serviceKey])(
    '%s is a valid namespace:name', key => {
      expect(new RegExp(CHECK!).test(key), `${key} would violate the CHECK`).toBe(true)
    })

  it('the keys are distinct — service_key is UNIQUE', () => {
    const keys = [...Object.values(SERVICE_PRINCIPALS).map(s => s.serviceKey), GRANTOR.serviceKey]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every display name is non-empty', () => {
    for (const spec of [...Object.values(SERVICE_PRINCIPALS), GRANTOR]) {
      expect(spec.displayName.trim().length).toBeGreaterThan(0)
    }
  })

  it('the fixture would REJECT a key like the ones the first version generated', () => {
    // 'matrix-archive-import-1a2b3c4d' — no colon, so no namespace.
    expect(new RegExp(CHECK!).test('matrix-archive-import-1a2b3c4d')).toBe(false)
    expect(new RegExp(CHECK!).test('isolation-importer-9f8e7d6c')).toBe(false)
  })
})

describe('one db_role maps to exactly one principal', () => {
  it('the schema makes db_role UNIQUE and the binding append-only', () => {
    expect(identitySql).toMatch(/db_role\s+NAME NOT NULL UNIQUE/)
    expect(identitySql).toMatch(
      /CREATE TRIGGER reject_mutation\nBEFORE UPDATE OR DELETE ON identity\.service_principal_roles/)
  })

  it('the fixture declares one principal per login role, and four in total', () => {
    expect(Object.keys(SERVICE_PRINCIPALS).sort()).toEqual([
      'ai_capital_agent', 'ai_capital_app', 'ai_capital_importer', 'ai_capital_operator',
    ])
    expect(new Set(Object.keys(SERVICE_PRINCIPALS)).size).toBe(4)
  })

  it('the grantor is bound to NO login role', () => {
    // It exists to be named by `granted_by`, not to act. Binding it would take
    // a db_role away from a role that needs one.
    expect(Object.values(SERVICE_PRINCIPALS).map(s => s.serviceKey))
      .not.toContain(GRANTOR.serviceKey)
    expect(fixtureSrc).toMatch(/dbRole: null/)
  })

  it('the binding is resolved by db_role before anything is created', () => {
    // Idempotency. Creating first and hoping for ON CONFLICT would fail against
    // a database that already has the binding, which is every re-run.
    const fn = /export async function ensureRolePrincipal[\s\S]*?\n}/.exec(fixtureSrc)![0]
    const lookup = fn.indexOf('FROM identity.service_principal_roles')
    const insert = fn.indexOf('INSERT INTO identity.service_principal_roles')
    expect(lookup).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(-1)
    expect(lookup, 'the lookup must precede the insert').toBeLessThan(insert)
  })

  it('no suite file creates its own principals', () => {
    // The original defect was distributed: several files each seeded a
    // principal for the same login. Every one now goes through ensurePrincipals.
    expect(suiteSrc).not.toMatch(/seedServicePrincipal/)
    expect(suiteSrc).not.toMatch(/INSERT INTO identity\.principals/)
    expect(suiteSrc).not.toMatch(/INSERT INTO identity\.service_principal_roles/)
  })
})

describe('the expected role bindings exist before any capability test', () => {
  it('every suite that grants a capability resolves principals first', () => {
    for (const file of suiteFiles) {
      const src = readFileSync(join(TENANCY, file), 'utf-8')
      if (!src.includes('grantCapability(')) continue
      const resolve_ = src.indexOf('ensurePrincipals(')
      const grant = src.indexOf('grantCapability(')
      expect(resolve_, `${file} grants without resolving principals`).toBeGreaterThan(-1)
      expect(resolve_, `${file} grants before resolving`).toBeLessThan(grant)
    }
  })

  it('the capability matrix asserts its own preconditions', () => {
    const src = readFileSync(join(TENANCY, 'capability-matrix.test.ts'), 'utf-8')
    expect(src).toMatch(/exactly one principal is bound to ai_capital_importer/)
    expect(src).toMatch(/the importer login resolves to that principal/)
    expect(src).toMatch(/each matrix workspace holds exactly one live capability/)
  })

  it('the matrix executes real INSERTs rather than calling the authorizer', () => {
    // The whole point of the redesign. A file that only called
    // authorize_service_workspace would pass against a table with NO policy.
    const src = readFileSync(join(TENANCY, 'capability-matrix.test.ts'), 'utf-8')
    expect(src).toMatch(/insert\.sql, insert\.values\(graph\)/)
    expect(graphSrc).toMatch(/export function tableInserts\(\)/)
    const tables = [...graphSrc.matchAll(/table: '(\w+)'/g)].map(m => m[1])
    expect(tables).toHaveLength(17)
    expect(new Set(tables).size).toBe(17)
    for (const t of tables) {
      expect(graphSrc, `${t} has no INSERT`).toContain(`INSERT INTO investment_ledger.${t}`)
    }
  })

  it('the matrix uses one workspace per capability, not one principal per capability', () => {
    const src = readFileSync(join(TENANCY, 'capability-matrix.test.ts'), 'utf-8')
    expect(src).toMatch(/workspaces = new Map<Capability, Workspace>/)
    expect(ALL_CAPABILITIES).toHaveLength(5)
  })

  it('every probe is rolled back', () => {
    // Successes included: a cell that stayed would satisfy the next cell's
    // unique constraint and change the next transition's starting state.
    expect(fixtureSrc).toMatch(/await client\.query\(`ROLLBACK TO SAVEPOINT \$\{savepoint\}`\)/)
    expect(fixtureSrc).not.toMatch(/RELEASE SAVEPOINT/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The transaction-state guard, exercised with a stub client and NO database.
// ─────────────────────────────────────────────────────────────────────────────

const WORKSPACE = '00000000-0000-0000-0000-0000000000aa'
const PRINCIPAL = '00000000-0000-0000-0000-0000000000bb'

/**
 * A stub whose failures can be aimed at one post-BEGIN statement, or at every
 * statement including the ROLLBACK, and then switched off so recovery can be
 * observed. Statement 0 is always BEGIN.
 */
interface FailingClient { statements: string[]; failAt: number; failAll: boolean }

function makeFailing(failAt: number, failAll = false): Client & FailingClient {
  const c: FailingClient & { query: (t: string) => Promise<unknown> } = {
    statements: [],
    failAt,
    failAll,
    async query(text: string) {
      c.statements.push(text)
      const index = c.statements.length - 1          // 0 = BEGIN
      if (index > 0 && (c.failAll || index === c.failAt)) throw new Error('boom')
      return { rows: [{ principal_id: PRINCIPAL }], rowCount: 1 }
    },
  }
  return c as unknown as Client & FailingClient
}

/** Fails at exactly the Nth statement after BEGIN. */
const failingAfter = (n: number) => makeFailing(n)
/** Fails at every statement after BEGIN — including the ROLLBACK. */
const failingFrom  = (n: number) => makeFailing(n, true)

/** Let a stub recover, so a subsequent transaction can be attempted. */
function repair(client: Client & FailingClient): void {
  client.failAll = false
  client.failAt = Number.POSITIVE_INFINITY
}

/** Records the SQL it is given and answers every query with no rows. */
function stubClient(): Client & { statements: string[] } {
  const statements: string[] = []
  const client = {
    statements,
    async query(text: string) { statements.push(text); return { rows: [], rowCount: 0 } },
  }
  return client as unknown as Client & { statements: string[] }
}

describe('helpers refuse the wrong transaction state instead of returning a plausible error', () => {
  it('probe() on a client with no transaction THROWS', async () => {
    const client = stubClient()
    await expect(probe(client, async () => {})).rejects.toThrow(/requires an open transaction/)
  })

  it('...and issues no SQL at all when it refuses', async () => {
    // The point: it must not emit a SAVEPOINT and hand back 25P01, which a test
    // asserting "some failure" would accept as a database refusal.
    const client = stubClient()
    await probe(client, async () => {}).catch(() => {})
    expect(client.statements).toEqual([])
  })

  it('the refusal is an Error, never a SQLSTATE-shaped value', async () => {
    // What matters is the SHAPE. A caller distinguishes "the database refused"
    // from "the helper was misused" by looking for `.code`, and the guard must
    // therefore carry none. Its message names 25P01 on purpose — it is
    // explaining the failure it exists to prevent, not reporting one.
    const client = stubClient()
    const error = await probe(client, async () => {}).catch(e => e as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as unknown as { code?: string }).code).toBeUndefined()
    expect(error.message).toContain('requires an open transaction')
    expect(NO_ACTIVE_TRANSACTION).toBe('25P01')
  })

  it('probe() works once begin() has been called, and rolls back', async () => {
    const client = stubClient()
    await begin(client)
    const result = await probe(client, async () => {})
    expect(result).toEqual({ code: null, message: null })
    expect(client.statements[0]).toBe('BEGIN')
    expect(client.statements.some(s => s.startsWith('SAVEPOINT'))).toBe(true)
    expect(client.statements.some(s => s.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true)
  })

  it('probe() reports a thrown error as code + message and still rolls back', async () => {
    const client = stubClient()
    await begin(client)
    const failure = Object.assign(new Error('permission denied'), { code: '42501' })
    const result = await probe(client, async () => { throw failure })
    expect(result).toEqual({ code: '42501', message: 'permission denied' })
    expect(client.statements.some(s => s.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true)
  })

  it('probeDetached() opens and closes its own transaction', async () => {
    const client = stubClient()
    expect(isTransactionOpen(client)).toBe(false)
    await probeDetached(client, async () => {})
    expect(client.statements[0]).toBe('BEGIN')
    expect(client.statements.at(-1)).toBe('ROLLBACK')
    expect(isTransactionOpen(client)).toBe(false)
  })

  it('begin() twice is refused rather than silently nesting', async () => {
    // A second BEGIN is a no-op with a warning in PostgreSQL, so the second
    // "transaction" would share the first's fate — and a test that thought it
    // had isolation would not.
    const client = stubClient()
    await begin(client)
    await expect(begin(client)).rejects.toThrow(/already open/)
  })

  it('commit() with no transaction is refused', async () => {
    const client = stubClient()
    await expect(commit(client)).rejects.toThrow(/no transaction is open/)
  })

  it('rollback() is tolerant, because it is the cleanup path', async () => {
    const client = stubClient()
    await begin(client)
    await rollback(client)
    expect(isTransactionOpen(client)).toBe(false)
    await rollback(client)          // must not throw
    expect(isTransactionOpen(client)).toBe(false)
  })

  it('beginAuthorized() rolls back and clears state when AUTHORIZATION fails', async () => {
    // The first of four post-BEGIN failure points. Before this fix the tracker
    // stayed marked-open and the NEXT test died with "a transaction is already
    // open" — twelve such cascades in the first database gate, each masking the
    // real failure.
    const client = failingAfter(1)          // BEGIN ok, authorize throws
    await expect(beginAuthorized(client, WORKSPACE, ['archive-import'])).rejects.toThrow('boom')
    expect(isTransactionOpen(client)).toBe(false)
    expect(client.statements.at(-1)).toBe('ROLLBACK')
  })

  it('...when the FIRST set_config fails', async () => {
    const client = failingAfter(2)          // BEGIN, authorize ok; set_config throws
    await expect(beginAuthorized(client, WORKSPACE, ['archive-import'])).rejects.toThrow('boom')
    expect(isTransactionOpen(client)).toBe(false)
    expect(client.statements.at(-1)).toBe('ROLLBACK')
  })

  it('...when the SECOND set_config fails', async () => {
    const client = failingAfter(3)
    await expect(beginAuthorized(client, WORKSPACE, ['archive-import'])).rejects.toThrow('boom')
    expect(isTransactionOpen(client)).toBe(false)
    expect(client.statements.at(-1)).toBe('ROLLBACK')
  })

  it('...and even when the ROLLBACK ITSELF fails', async () => {
    // rollback() clears the tracker BEFORE issuing ROLLBACK and swallows the
    // query error, so a connection that is already gone cannot strand the
    // fixture. The original error must still surface.
    const client = failingFrom(1)           // everything after BEGIN throws
    await expect(beginAuthorized(client, WORKSPACE, ['archive-import'])).rejects.toThrow('boom')
    expect(isTransactionOpen(client)).toBe(false)
  })

  it('beginWithForgedContext() is failure-atomic too', async () => {
    for (const n of [1, 2]) {
      const client = failingAfter(n)
      await expect(beginWithForgedContext(client, WORKSPACE, PRINCIPAL)).rejects.toThrow('boom')
      expect(isTransactionOpen(client), `failure at statement ${n}`).toBe(false)
    }
  })

  it('A SUBSEQUENT TRANSACTION CAN BEGIN after every failure path', async () => {
    // The property that actually matters: recovery, not just a cleared flag.
    for (const make of [() => failingAfter(1), () => failingAfter(2),
                        () => failingAfter(3), () => failingFrom(1)]) {
      const client = make()
      await beginAuthorized(client, WORKSPACE, ['archive-import']).catch(() => {})
      repair(client)                                   // the connection recovers
      await begin(client)                              // must NOT throw
      expect(isTransactionOpen(client)).toBe(true)
      await rollback(client)
    }
  })

  it('commit() and rollback() both clear the state, so a client can be reused', async () => {
    const client = stubClient()
    await begin(client)
    await commit(client)
    expect(isTransactionOpen(client)).toBe(false)
    await begin(client)
    expect(isTransactionOpen(client)).toBe(true)
    await rollback(client)
  })
})
