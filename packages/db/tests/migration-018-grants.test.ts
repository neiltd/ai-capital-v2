/**
 * Migration 018 — the legacy runtime grant contract.
 *
 * No database connection anywhere in this file. Every assertion is about the
 * EXECUTABLE SQL of `packages/db/migrations/018_legacy_runtime_grants.sql`:
 * comments are stripped first, because that file is dense with prose naming
 * privileges it deliberately does NOT confer — the manual paths it excludes,
 * the CONNECT it cannot grant, the compensating EXECUTE it must not add. A
 * checker that read the prose could be satisfied by a file that grants nothing
 * at all, or that grants the opposite of what it says.
 *
 * The assertions are SET EQUALITIES, not substring searches. "Does 018 contain
 * a GRANT SELECT on portfolio.positions?" is a much weaker question than "is
 * the privilege set of portfolio.positions exactly {SELECT, UPDATE}?", and only
 * the second catches a widening.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

import { CURRENT_V18_MANIFEST } from '../src/inventory-queries.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATION = resolve(HERE, '..', 'migrations', '018_legacy_runtime_grants.sql')
const raw = readFileSync(MIGRATION, 'utf-8')

/** Statements only: prose about a privilege is not a grant of it. */
const code = raw.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/** Executable statements, whitespace-normalised, semicolon-delimited. */
const statements = code.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)

interface Grant { privileges: string[]; objectType: string; object: string; grantee: string }

/** Parse `GRANT <privs> ON [SCHEMA|SEQUENCE|FUNCTION] <object> TO <role>`. */
function parseGrant(statement: string): Grant | null {
  const m = /^GRANT (.+?) ON (SCHEMA |SEQUENCE |FUNCTION |TABLE )?(.+?) TO (.+)$/.exec(statement)
  if (!m) return null
  return {
    privileges: m[1].split(',').map(p => p.trim().toUpperCase()).sort(),
    objectType: (m[2] ?? 'RELATION ').trim() || 'RELATION',
    object: m[3].trim(),
    grantee: m[4].trim(),
  }
}

const grants = statements
  .filter(s => s.startsWith('GRANT '))
  .map(parseGrant)
  .filter((g): g is Grant => g !== null)

const revokes = statements.filter(s => s.startsWith('REVOKE '))

const PIPELINE = 'ai_capital_pipeline'
const WRITER   = 'ai_capital_claim_writer'

const forGrantee = (role: string) => grants.filter(g => g.grantee === role)
const byObject = (role: string, type: string) =>
  Object.fromEntries(forGrantee(role).filter(g => g.objectType === type)
    .map(g => [g.object, g.privileges]))

// ── The manifest is pinned to the files on disk ─────────────────────────────
//
// WHY THIS EXISTS. A mutation control caught the gap: every other test builds
// its ledger fixture FROM `CURRENT_V18_MANIFEST`, so a manifest whose hash does
// not match the migration it names is perfectly self-consistent and no
// assertion notices. The collector would then report `CURRENT_V18` for a
// database built from different bytes, or `UNRECOGNIZED` for one built from the
// right ones. The manifest has to be checked against the filesystem, once.

describe('CURRENT_V18_MANIFEST matches the migrations on disk', () => {
  const DIR = resolve(HERE, '..', 'migrations')
  const onDisk = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

  it('names exactly the migration files that exist, in order', () => {
    expect(CURRENT_V18_MANIFEST.map(m => m.filename)).toEqual(onDisk)
    expect(CURRENT_V18_MANIFEST).toHaveLength(18)
  })

  it('records the exact SHA-256 of every one of them', () => {
    for (const entry of CURRENT_V18_MANIFEST) {
      const actual = createHash('sha256')
        .update(readFileSync(join(DIR, entry.filename)))
        .digest('hex')
      expect(actual, `${entry.filename} hash drifted from the manifest`).toBe(entry.sha256)
    }
  })

  it("018's own entry is present and correct", () => {
    const entry = CURRENT_V18_MANIFEST.find(m => m.filename === '018_legacy_runtime_grants.sql')
    expect(entry, 'migration 018 is absent from the manifest').toBeDefined()
    const actual = createHash('sha256').update(readFileSync(MIGRATION)).digest('hex')
    expect((entry as { sha256: string }).sha256).toBe(actual)
  })
})

// ── Parser non-vacuity ──────────────────────────────────────────────────────

describe('the parser sees migration 018 as executable SQL', () => {
  it('found every statement category the contract depends on', () => {
    // Without this, every "not" assertion below would pass over an empty list.
    expect(statements.length).toBeGreaterThan(20)
    expect(grants.length).toBeGreaterThan(20)
    expect(revokes).toHaveLength(1)
    expect(forGrantee(PIPELINE).length).toBeGreaterThan(15)
    expect(forGrantee(WRITER).length).toBeGreaterThan(3)
    expect(grants.every(g => g.privileges.length > 0)).toBe(true)
  })

  it('discards prose: the file discusses privileges it does not grant', () => {
    // The header explains why CONNECT is NOT granted here, and names the manual
    // paths that are excluded. Those words are in the file; none is a statement.
    expect(raw).toContain('GRANT CONNECT issued from a migration is refused')
    expect(raw).toContain('removePosition')
    expect(statements.some(s => /CONNECT/.test(s))).toBe(false)
    expect(statements.some(s => /DELETE/.test(s))).toBe(false)
  })

  it('grants to exactly two roles, and no others', () => {
    expect([...new Set(grants.map(g => g.grantee))].sort()).toEqual([WRITER, PIPELINE].sort())
  })
})

// ── ai_capital_pipeline ─────────────────────────────────────────────────────

describe('ai_capital_pipeline schema privileges', () => {
  it('holds USAGE on exactly five schemas', () => {
    expect(byObject(PIPELINE, 'SCHEMA')).toEqual({
      capital:   ['USAGE'],
      thesis:    ['USAGE'],
      portfolio: ['USAGE'],
      briefing:  ['USAGE'],
      trade:     ['USAGE'],
    })
  })

  it('grants nothing whatsoever on schema public', () => {
    // The pipeline does need USAGE on public — vector-store/pg.ts resolves the
    // `vector` type and the `<=>` operator there — but this migration cannot
    // confer it and must not pretend to. Migrations run as ai_capital_owner;
    // public is owned by pg_database_owner, so the GRANT is silently discarded
    // with SQLSTATE 01007 (`no privileges were granted`), which ON_ERROR_STOP
    // and node-postgres both ignore. The grant lives in
    // ops/bootstrap/010_database_bootstrap.sql, where the database owner can
    // actually make it stick, and bootstrap-contract.test.ts pins it there.
    expect(byObject(PIPELINE, 'SCHEMA')).not.toHaveProperty('public')
    for (const g of forGrantee(PIPELINE)) {
      expect(g.object, 'references schema public').not.toMatch(/^public$|^public\./)
    }
  })

  it('no statement in this migration touches schema public at all', () => {
    // Guards the whole file, not just pipeline grants: no role may be granted
    // anything on public from here, for the reason above.
    for (const stmt of statements) {
      expect(stmt, 'statement references schema public')
        .not.toMatch(/\bON\s+SCHEMA\s+public\b/i)
    }
  })

  it('grants CREATE on nothing', () => {
    for (const g of forGrantee(PIPELINE)) {
      expect(g.privileges, `${g.object} grants CREATE`).not.toContain('CREATE')
    }
  })

  it('receives no privilege in identity, investment_ledger, cash_ledger, desk, db or graph', () => {
    for (const forbidden of ['identity', 'investment_ledger', 'cash_ledger', 'desk', 'db', 'graph']) {
      const hits = forGrantee(PIPELINE).filter(
        g => g.object === forbidden || g.object.startsWith(`${forbidden}.`),
      )
      expect(hits, `pipeline is granted something in ${forbidden}`).toEqual([])
    }
  })
})

describe('ai_capital_pipeline relation privileges', () => {
  it('are exactly the approved matrix', () => {
    expect(byObject(PIPELINE, 'RELATION')).toEqual({
      'capital.watchlist':            ['INSERT', 'SELECT', 'UPDATE'],
      'capital.documents':            ['INSERT', 'SELECT'],
      'capital.fetch_log':            ['INSERT', 'SELECT'],
      'capital.pending_manual_input': ['INSERT', 'SELECT'],
      'capital.short_interest':       ['INSERT', 'SELECT', 'UPDATE'],
      'capital.chunks':               ['INSERT', 'SELECT'],
      'thesis.theses':                ['SELECT'],
      'thesis.assumptions':           ['SELECT'],
      'thesis.narratives':            ['SELECT'],
      'thesis.proposals':             ['INSERT', 'SELECT'],
      'thesis.proposal_changes':      ['INSERT'],
      'portfolio.positions':          ['SELECT', 'UPDATE'],
      'portfolio.trade_log':          ['SELECT', 'UPDATE'],
      'briefing.predictions':         ['INSERT', 'SELECT', 'UPDATE'],
      'trade.ticker_dependencies':    ['SELECT'],
    })
  })

  it('briefing.predictions has SELECT — the ON CONFLICT upsert needs it', () => {
    // prediction-archiver.ts issues INSERT ... ON CONFLICT (date) DO UPDATE.
    // PostgreSQL requires SELECT on the conflict target in addition to INSERT
    // and UPDATE; without it the statement fails outright with 42501. This is
    // an upsert requirement, not general read access.
    expect(byObject(PIPELINE, 'RELATION')['briefing.predictions']).toContain('SELECT')
  })

  it('capital.pending_manual_input has no UPDATE — resolvePendingManualInput is manual', () => {
    expect(byObject(PIPELINE, 'RELATION')['capital.pending_manual_input']).not.toContain('UPDATE')
  })

  it('capital.api_budget and thesis.theme_memberships appear in no statement', () => {
    // Both have zero callers in production source.
    for (const statement of statements) {
      expect(statement).not.toContain('api_budget')
      expect(statement).not.toContain('theme_memberships')
    }
  })

  it('portfolio.positions has no INSERT and no DELETE — both are manual', () => {
    expect(byObject(PIPELINE, 'RELATION')['portfolio.positions']).toEqual(['SELECT', 'UPDATE'])
  })
})

describe('ai_capital_pipeline sequence privileges', () => {
  it('is exactly one sequence, USAGE only', () => {
    expect(byObject(PIPELINE, 'SEQUENCE')).toEqual({
      'capital.fetch_log_id_seq': ['USAGE'],
    })
  })
})

// ── ai_capital_claim_writer ─────────────────────────────────────────────────

describe('ai_capital_claim_writer', () => {
  it('holds USAGE on desk and no other schema', () => {
    expect(byObject(WRITER, 'SCHEMA')).toEqual({ desk: ['USAGE'] })
  })

  it('relation privileges are exactly the approved matrix', () => {
    expect(byObject(WRITER, 'RELATION')).toEqual({
      'desk.agent_claims': ['INSERT', 'SELECT', 'UPDATE'],
      'desk.agent_runs':   ['INSERT'],
    })
  })

  it('has no SELECT on desk.agent_runs — nothing reads it', () => {
    expect(byObject(WRITER, 'RELATION')['desk.agent_runs']).toEqual(['INSERT'])
  })

  it('sequence privileges are exactly two, USAGE only', () => {
    expect(byObject(WRITER, 'SEQUENCE')).toEqual({
      'desk.agent_claims_id_seq': ['USAGE'],
      'desk.agent_runs_id_seq':   ['USAGE'],
    })
  })

  it('holds nothing outside schema desk', () => {
    for (const g of forGrantee(WRITER)) {
      const inDesk = g.object === 'desk' || g.object.startsWith('desk.')
      expect(inDesk, `claim writer is granted ${g.object}, outside desk`).toBe(true)
    }
  })
})

// ── Trigger-function hardening ──────────────────────────────────────────────

describe('trigger-function hardening', () => {
  it('revokes PUBLIC EXECUTE from the immutability trigger function', () => {
    expect(revokes).toEqual([
      'REVOKE EXECUTE ON FUNCTION desk.agent_claims_assertion_is_immutable() FROM PUBLIC',
    ])
  })

  it('adds no compensating EXECUTE grant', () => {
    // PostgreSQL checks EXECUTE on a trigger function when the trigger is
    // CREATED, not when it fires; a compensating grant would hand a runtime role
    // the ability to invoke the function directly, for no benefit.
    expect(grants.filter(g => g.objectType === 'FUNCTION')).toEqual([])
    expect(grants.some(g => g.privileges.includes('EXECUTE'))).toBe(false)
  })
})

// ── Global prohibitions ─────────────────────────────────────────────────────

describe('migration 018 stays within its authority', () => {
  it('grants no DELETE, TRUNCATE, REFERENCES or TRIGGER, anywhere', () => {
    for (const g of grants) {
      for (const forbidden of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL', 'ALL PRIVILEGES']) {
        expect(g.privileges, `${g.object} grants ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('uses no GRANT ALL, no ON ALL, and no ALTER DEFAULT PRIVILEGES', () => {
    for (const statement of statements) {
      expect(statement).not.toMatch(/\bGRANT\s+ALL\b/i)
      expect(statement).not.toMatch(/\bALL PRIVILEGES\b/i)
      expect(statement).not.toMatch(/\bON ALL (TABLES|SEQUENCES|FUNCTIONS|ROUTINES)\b/i)
      expect(statement).not.toMatch(/\bALTER DEFAULT PRIVILEGES\b/i)
    }
  })

  it('grants nothing to PUBLIC — the only PUBLIC statement is the revoke', () => {
    expect(grants.some(g => g.grantee.toUpperCase() === 'PUBLIC')).toBe(false)
    const publicStatements = statements.filter(s => /\bPUBLIC\b/.test(s))
    expect(publicStatements).toHaveLength(1)
    expect(publicStatements[0]).toMatch(/^REVOKE EXECUTE/)
  })

  it('grants no role membership and changes no ownership', () => {
    for (const statement of statements) {
      // `GRANT <role> TO <member>` — no ON clause.
      expect(statement).not.toMatch(/^GRANT ai_capital_\w+ TO /)
      expect(statement).not.toMatch(/\bOWNER TO\b/i)
      expect(statement).not.toMatch(/^ALTER (TABLE|SCHEMA|SEQUENCE|FUNCTION|DATABASE)\b/i)
      expect(statement).not.toMatch(/^REASSIGN OWNED\b/i)
    }
  })

  it('creates, drops and alters nothing, and manages no extension or role', () => {
    for (const statement of statements) {
      expect(statement).not.toMatch(/^CREATE\b/i)
      expect(statement).not.toMatch(/^DROP\b/i)
      expect(statement).not.toMatch(/\bCREATE (ROLE|EXTENSION|DATABASE)\b/i)
      expect(statement).not.toMatch(/\bPASSWORD\b/i)
    }
  })

  it('contains no transaction control and no role switch', () => {
    // The runner supplies exactly one transaction, and enters the file with
    // SET LOCAL ROLE ai_capital_owner already in force.
    for (const keyword of ['BEGIN', 'COMMIT', 'ROLLBACK', 'SET ROLE', 'SET LOCAL ROLE', 'RESET ROLE']) {
      expect(code.toUpperCase(), `018 contains ${keyword}`).not.toContain(keyword)
    }
  })

  it('grants no database-level privilege — CONNECT comes from bootstrap 010', () => {
    for (const statement of statements) {
      expect(statement).not.toMatch(/\bON DATABASE\b/i)
    }
  })

  it('names every object with its schema', () => {
    for (const g of grants) {
      if (g.objectType === 'SCHEMA') continue
      expect(g.object, `${g.object} is not schema-qualified`).toContain('.')
    }
  })
})
