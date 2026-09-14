// MIGRATION 019 — THE DASHBOARD READ GRANTS, AS A STATIC CONTRACT.
//
// Database-free. This parses the SQL and asserts its exact shape, the same way
// migration-018-grants.test.ts does, because the properties that matter here are
// properties of the TEXT: which privileges are named, which objects, and which
// forms are absent. A privilege the file never mentions cannot be granted by it,
// and that is checkable without a cluster.
//
// The runtime consequences — that the role can read those five tables and
// nothing else, and that `SELECT 1::vector` fails with 42704 — belong to the
// S4B isolated gate.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const HERE      = dirname(fileURLToPath(import.meta.url))
const MIGRATION = resolve(HERE, '..', 'migrations', '019_dashboard_read_grants.sql')
const sql       = readFileSync(MIGRATION, 'utf-8')

/** Executable text: comments stripped, so prose can never satisfy an assertion. */
const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

/** Statements, whitespace-normalised. */
const statements = code.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)

const ROLE = 'ai_capital_dashboard'

/** The five tables apps/unified-platform/.../trade-graph/route.ts reads. */
const TABLES = [
  'trade.chokepoint_routes',
  'trade.chokepoints',
  'trade.countries',
  'trade.flows',
  'trade.ticker_dependencies',
]

interface Grant { privileges: string[]; kind: string; object: string; grantees: string[] }

function parseGrant(statement: string): Grant | null {
  const m = /^GRANT (.+?) ON (SCHEMA |SEQUENCE |FUNCTION |TABLE )?(.+?) TO (.+)$/.exec(statement)
  if (!m) return null
  return {
    privileges: m[1].split(',').map(p => p.trim().toUpperCase()).sort(),
    kind:       (m[2] ?? '').trim() || 'RELATION',
    object:     m[3].trim(),
    grantees:   m[4].split(',').map(g => g.trim()),
  }
}

const grants = statements.map(parseGrant).filter((g): g is Grant => g !== null)

describe('019 is exactly six grants and nothing else', () => {
  it('the parser found statements at all', () => {
    // NON-VACUITY. Every assertion below quantifies over `grants`; an empty list
    // would satisfy all of them while proving nothing.
    expect(statements.length, 'no executable statements parsed').toBe(6)
    expect(grants.length, 'no GRANT statements parsed').toBe(6)
  })

  it('every statement is a GRANT — nothing is created, altered, revoked or set', () => {
    for (const s of statements) {
      expect(s, `not a GRANT: ${s}`).toMatch(/^GRANT /)
    }
    expect(code).not.toMatch(/\b(CREATE|ALTER|DROP|REVOKE|SET|INSERT|UPDATE|DELETE|TRUNCATE)\b/i)
  })

  it('every grantee is ai_capital_dashboard and no other role', () => {
    for (const g of grants) {
      expect(g.grantees, `unexpected grantee in: ON ${g.object}`).toEqual([ROLE])
    }
  })
})

describe('the privilege matrix is exact', () => {
  it('grants USAGE on schema trade, and on no other schema', () => {
    const schemas = grants.filter(g => g.kind === 'SCHEMA')
    expect(schemas).toHaveLength(1)
    expect(schemas[0].object).toBe('trade')
    expect(schemas[0].privileges).toEqual(['USAGE'])
  })

  it('grants SELECT on exactly the five tables the dashboard route reads', () => {
    const relations = grants.filter(g => g.kind === 'RELATION')
    // Set equality in BOTH directions: a missing table breaks the dashboard, an
    // extra one widens a network-facing role.
    expect(relations.map(g => g.object).sort()).toEqual([...TABLES].sort())
    for (const g of relations) {
      expect(g.privileges, `${g.object} is not SELECT-only`).toEqual(['SELECT'])
    }
  })

  it('grants no write privilege anywhere', () => {
    for (const g of grants) {
      for (const forbidden of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        expect(g.privileges, `${g.object} grants ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('grants no CREATE, no TEMPORARY, no CONNECT and no EXECUTE', () => {
    for (const g of grants) {
      for (const forbidden of ['CREATE', 'TEMP', 'TEMPORARY', 'CONNECT', 'EXECUTE', 'ALL']) {
        expect(g.privileges, `${g.object} grants ${forbidden}`).not.toContain(forbidden)
      }
    }
    // CONNECT in particular is not 019's to give: the database is not an
    // owner-owned object, so a GRANT ... ON DATABASE from a migration running as
    // ai_capital_owner is refused with 42501. It lives in 010.
    expect(code).not.toMatch(/ON DATABASE/i)
  })
})

describe('the forms that silently widen a role are absent', () => {
  it('no ON ALL and no ALTER DEFAULT PRIVILEGES', () => {
    // Both would extend this role to tables that do not exist yet. The 2026-09-06
    // B3 remediation rejected exactly this shape when a broad diagnostic grant
    // was mistaken for a design.
    expect(code).not.toMatch(/ON ALL/i)
    expect(code).not.toMatch(/DEFAULT PRIVILEGES/i)
  })

  it('no WITH GRANT OPTION', () => {
    expect(code).not.toMatch(/WITH GRANT OPTION/i)
  })

  it('no role membership is conferred', () => {
    // `GRANT <role> TO <member>` is a membership, not an object privilege.
    for (const s of statements) {
      expect(s).not.toMatch(/^GRANT ai_capital_\w+ TO /)
    }
  })

  it('no sequence and no function is named', () => {
    // The comparison values used to carry the trailing space from the regex
    // group ('SEQUENCE ', 'FUNCTION '), but parseGrant() trims before storing —
    // so neither assertion could ever fire, whatever 019 contained. Compare
    // against the values the parser actually produces.
    for (const g of grants) {
      expect(g.kind, `019 names a ${g.kind}`).not.toBe('SEQUENCE')
      expect(g.kind, `019 names a ${g.kind}`).not.toBe('FUNCTION')
    }
  })

  it('every parsed kind is one the parser can actually produce', () => {
    // NON-VACUITY for the assertion above: it is only meaningful if `kind` is
    // drawn from this set, which is what makes 'SEQUENCE ' (with the space) an
    // unreachable comparison rather than a strict one.
    const PRODUCIBLE = ['SCHEMA', 'SEQUENCE', 'FUNCTION', 'TABLE', 'RELATION']
    for (const g of grants) expect(PRODUCIBLE).toContain(g.kind)
    // And 019 in particular produces only these two.
    expect([...new Set(grants.map(g => g.kind))].sort()).toEqual(['RELATION', 'SCHEMA'])
  })
})

describe('no schema outside trade is touched', () => {
  const FORBIDDEN = [
    'public', 'identity', 'investment_ledger', 'cash_ledger', 'desk', 'db',
    'capital', 'portfolio', 'thesis', 'briefing', 'graph',
    'information_schema', 'pg_catalog',
  ]

  for (const schema of FORBIDDEN) {
    it(`names no object in ${schema}`, () => {
      for (const g of grants) {
        expect(g.object, `019 grants on ${g.object}`).not.toMatch(new RegExp(`^${schema}$|^${schema}\\.`))
      }
    })
  }

  it('public is absent entirely — the dashboard runs no pgvector query', () => {
    // Withholding public USAGE is the cheapest proof the route resolves no type
    // or operator there. The S4B gate asserts the positive consequence:
    // `SELECT 1::vector` as this role fails with SQLSTATE 42704.
    expect(code).not.toMatch(/\bpublic\b/i)
  })
})

describe('the manifest records 019', () => {
  it('019 is present in CURRENT_V19_MANIFEST with its exact hash', async () => {
    const { CURRENT_V19_MANIFEST } = await import('../src/inventory-queries.js')
    const { createHash } = await import('node:crypto')
    const entry = CURRENT_V19_MANIFEST.find(m => m.filename === '019_dashboard_read_grants.sql')
    expect(entry, '019 is absent from the manifest').toBeDefined()
    const actual = createHash('sha256').update(readFileSync(MIGRATION)).digest('hex')
    expect((entry as { sha256: string }).sha256).toBe(actual)
  })

  it('the manifest is nineteen entries', async () => {
    const { CURRENT_V19_MANIFEST } = await import('../src/inventory-queries.js')
    expect(CURRENT_V19_MANIFEST).toHaveLength(19)
  })
})

describe('019 is a grants-only migration', () => {
  it('defines no object of any kind', () => {
    // Same property 018 has, and the reason migration-order.test.ts can still
    // call 017 "the final LEDGER migration".
    const dir = resolve(HERE, '..', 'migrations')
    const body = readFileSync(join(dir, '019_dashboard_read_grants.sql'), 'utf-8')
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    expect(body).not.toMatch(/CREATE (TABLE|VIEW|INDEX|FUNCTION|TRIGGER|SCHEMA|TYPE|POLICY)/i)
  })
})
