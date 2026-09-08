import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// MIGRATION ROLE STATE — no database connection anywhere in this file.
//
// THE DEFECT THIS EXISTS FOR, stated exactly.
//
// `migrate.ts` opens each migration with `SET LOCAL ROLE ai_capital_owner`, so
// a file begins as the owner. 012 and 017 then switch to
// `ai_capital_identity_authority` to create SECURITY DEFINER functions that
// must be OWNED by the authority, and both files afterwards issued
// `RESET ROLE;` on the belief that it returned them to the owner.
//
// It does not. SET ROLE is not a stack: RESET ROLE returns to `session_user`,
// which during a migration is the LOGIN role `ai_capital_migrator`. And the
// migrator's memberships are granted WITH INHERIT FALSE precisely so it holds
// no ambient authority — so every statement after that RESET ran as a role that
// owns nothing:
//
//   * `REVOKE ALL ON FUNCTION identity.<fn> FROM PUBLIC` — only a function's
//     owner may revoke on it. 42501, and the migration rolls back. Had it not
//     rolled back, those SECURITY DEFINER functions would have kept PostgreSQL's
//     default PUBLIC EXECUTE.
//   * `GRANT EXECUTE ... TO ai_capital_importer` — same.
//   * `ALTER DEFAULT PRIVILEGES FOR ROLE ai_capital_owner` — must be issued as
//     that role.
//
// So this file walks each migration as a state machine over role changes and
// asserts no privileged statement is reachable while the effective role is the
// migrator.

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = resolve(HERE, '..', '..', '..', 'db', 'migrations')
const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const text = (f: string) => readFileSync(join(DIR, f), 'utf-8')

/** What migrate.ts leaves current_user set to when a file starts. */
const ENTRY_ROLE = 'ai_capital_owner'
/** What RESET ROLE actually restores: session_user. */
const SESSION_ROLE = 'ai_capital_migrator'

interface Step { line: number; role: string; sql: string }

/**
 * Walk a migration line by line, tracking the effective role.
 *
 * Dollar-quoted bodies are skipped: a `SET LOCAL ROLE` written inside a
 * function body is that function's business at CALL time, not this file's role
 * state at APPLY time, and a DO block's statements execute under whatever role
 * is current when the block runs — which the tracker already knows.
 */
function walk(sql: string): Step[] {
  const steps: Step[] = []
  let role = ENTRY_ROLE
  let dollarTag: string | null = null

  sql.split('\n').forEach((raw, i) => {
    const line = raw.replace(/--.*$/, '')
    if (dollarTag) {
      if (line.includes(dollarTag)) dollarTag = null
      return
    }
    const set = /^\s*SET\s+(?:LOCAL\s+)?ROLE\s+([A-Za-z_]\w*)\s*;/i.exec(line)
    if (set) { role = set[1].toLowerCase(); return }
    if (/^\s*RESET\s+ROLE\s*;/i.test(line)) { role = SESSION_ROLE; return }

    // Record the line FIRST, then enter the body. `DO $$` and
    // `CREATE FUNCTION ... AS $$` are themselves privileged statements and must
    // be judged; an earlier draft of this walker consumed them as body openers
    // and so never saw either.
    if (line.trim()) steps.push({ line: i + 1, role, sql: line.trim() })

    const open = /\$([A-Za-z_]\w*)?\$/.exec(line)
    if (open && line.split(open[0]).length === 2) dollarTag = open[0]
  })
  return steps
}

/** Statements that require ownership or role membership to succeed. */
const PRIVILEGED = /^\s*(GRANT|REVOKE|ALTER\s+DEFAULT\s+PRIVILEGES|CREATE\s+POLICY|CREATE\s+FUNCTION|CREATE\s+TRIGGER|CREATE\s+TABLE|CREATE\s+INDEX|CREATE\s+VIEW|CREATE\s+TYPE|CREATE\s+SCHEMA|ALTER\s+TABLE|COMMENT\s+ON)\b/i

describe('no migration reaches a privileged statement as the migrator', () => {
  it.each(files)('%s', file => {
    const offending = walk(text(file))
      .filter(s => s.role === SESSION_ROLE && PRIVILEGED.test(s.sql))
      .map(s => `line ${s.line}: ${s.sql.slice(0, 70)}`)
    expect(offending, `${file} runs privileged SQL as ${SESSION_ROLE}`).toEqual([])
  })

  it('is not vacuous: a RESET ROLE before a GRANT is detected', () => {
    const bad = `
      CREATE FUNCTION identity.f() RETURNS void LANGUAGE sql AS 'select 1';
      RESET ROLE;
      REVOKE ALL ON FUNCTION identity.f() FROM PUBLIC;
    `
    const offending = walk(bad).filter(s => s.role === SESSION_ROLE && PRIVILEGED.test(s.sql))
    expect(offending.length).toBe(1)
    expect(offending[0].sql).toContain('REVOKE ALL ON FUNCTION')
  })
})

describe('the two role-switching migrations say their role out loud', () => {
  it.each(['012_identity_security.sql', '017_ledger_views_rls_grants.sql'])(
    '%s never uses RESET ROLE at all', file => {
      // RESET ROLE is banned in these files rather than merely unused: its
      // meaning ("go back to session_user") is not what any reader expects
      // after a SET LOCAL ROLE, and that misreading is the defect.
      const code = text(file).split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
      expect(code).not.toMatch(/^\s*RESET\s+ROLE\s*;/m)
    })

  it.each(['012_identity_security.sql', '017_ledger_views_rls_grants.sql'])(
    '%s opens by naming ai_capital_owner explicitly', file => {
      const firstRole = /^\s*SET\s+(?:LOCAL\s+)?ROLE\s+([A-Za-z_]\w*)\s*;/m.exec(text(file))
      expect(firstRole?.[1]).toBe('ai_capital_owner')
    })
})

describe('authority-owned functions get their ACLs from the authority', () => {
  const AUTHORITY = 'ai_capital_identity_authority'

  it('012 revokes and grants on identity functions while still the authority', () => {
    const steps = walk(text('012_identity_security.sql'))
    const acl = steps.filter(s => /^(GRANT|REVOKE)\b/i.test(s.sql) && /\bON\s+FUNCTION\s+identity\./i.test(s.sql))
    expect(acl.length, 'the function ACL block should exist').toBeGreaterThanOrEqual(7)
    for (const s of acl) {
      expect(s.role, `line ${s.line} must run as the function owner`).toBe(AUTHORITY)
    }
  })

  it('017 revokes and grants on the resolver while still the authority', () => {
    const steps = walk(text('017_ledger_views_rls_grants.sql'))
    const acl = steps.filter(s =>
      /^(GRANT|REVOKE)\b/i.test(s.sql) && /resolve_or_create_instrument/i.test(s.sql))
    expect(acl.length).toBeGreaterThanOrEqual(2)
    for (const s of acl) expect(s.role, `line ${s.line}`).toBe(AUTHORITY)
  })

  it('every SECURITY DEFINER function in identity is created by the authority', () => {
    // Ownership is decided by whoever runs CREATE. An identity definer function
    // owned by ai_capital_owner would hit FORCE ROW LEVEL SECURITY on its own
    // tables and return zero rows — silently.
    const steps = walk(text('012_identity_security.sql'))
    const created = steps.filter(s => /^CREATE\s+FUNCTION\s+identity\./i.test(s.sql))
    expect(created.length).toBe(7)
    for (const s of created) expect(s.role, `line ${s.line}`).toBe(AUTHORITY)
  })
})

describe('the trigger-creation privilege (defect V3-3)', () => {
  const AUTHORITY = 'ai_capital_identity_authority'

  it('012 grants EXECUTE on assert_actor_authorized to ai_capital_owner', () => {
    // THE DEFECT. 012 revoked the function from PUBLIC and granted it to
    // nobody, reasoning that a trigger function needs no callers. True of
    // FIRING — which checks no privilege at all — and false of CREATE TRIGGER,
    // which checks EXECUTE against the role issuing it. 017 attaches seventeen
    // `actor_is_authorized` triggers as ai_capital_owner, so every one failed:
    //     permission denied for function identity.assert_actor_authorized
    expect(text('012_identity_security.sql')).toMatch(
      /GRANT EXECUTE ON FUNCTION identity\.assert_actor_authorized\(\)\s*\n\s*TO ai_capital_owner;/)
  })

  it('the grant is issued BY THE FUNCTION OWNER, not by the migrator', () => {
    // Only a function's owner may grant on it, and the owner here is the
    // authority — so the statement has to sit inside the authority's role
    // window. The walker is what proves it, rather than proximity in the file.
    const step = walk(text('012_identity_security.sql'))
      .find(s => /^GRANT EXECUTE ON FUNCTION identity\.assert_actor_authorized/.test(s.sql))
    expect(step, 'the grant statement was not found').toBeTruthy()
    expect(step!.role, `line ${step!.line} must run as the function owner`).toBe(AUTHORITY)
  })

  it('it is granted to ai_capital_owner ALONE — not PUBLIC, not a runtime login', () => {
    const grants = [...text('012_identity_security.sql').matchAll(
      /GRANT EXECUTE ON FUNCTION identity\.assert_actor_authorized\(\)\s*\n\s*TO ([^;]+);/g)]
    expect(grants).toHaveLength(1)
    expect(grants[0][1].split(',').map(r => r.trim())).toEqual(['ai_capital_owner'])
    // And the revoke that makes the grant meaningful is still there.
    expect(text('012_identity_security.sql')).toMatch(
      /REVOKE ALL ON FUNCTION identity\.assert_actor_authorized\(\)\s+FROM PUBLIC;/)
  })

  it('the revoke precedes the grant', () => {
    const t = text('012_identity_security.sql')
    expect(t.indexOf('REVOKE ALL ON FUNCTION identity.assert_actor_authorized'))
      .toBeLessThan(t.indexOf('GRANT EXECUTE ON FUNCTION identity.assert_actor_authorized'))
  })

  it('the inaccurate "granted to nobody" explanation is gone', () => {
    expect(text('012_identity_security.sql'))
      .not.toContain('It is granted to nobody')
  })

  it('ownership and SECURITY DEFINER are unchanged', () => {
    // The fix must not have been "make it an invoker" or "let the owner own it".
    const body = /CREATE FUNCTION identity\.assert_actor_authorized\(\)[\s\S]*?AS \$\$/
      .exec(text('012_identity_security.sql'))?.[0]
    expect(body).toContain('SECURITY DEFINER')
    const created = walk(text('012_identity_security.sql'))
      .find(s => /^CREATE FUNCTION identity\.assert_actor_authorized/.test(s.sql))
    expect(created!.role).toBe(AUTHORITY)
  })

  it('017 can therefore create the triggers as the owner', () => {
    // The consumer side: every attribution trigger is created while the role is
    // ai_capital_owner, which is exactly the role the grant above names.
    const steps = walk(text('017_ledger_views_rls_grants.sql'))
      .filter(s => /^CREATE TRIGGER actor_is_authorized/.test(s.sql))
    expect(steps).toHaveLength(17)
    for (const s of steps) expect(s.role, `line ${s.line}`).toBe('ai_capital_owner')
  })

  it('is not vacuous: the same walk shows the grant OUTSIDE the authority window would fail', () => {
    const bad = `
      SET LOCAL ROLE ai_capital_identity_authority;
      CREATE FUNCTION identity.f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      SET LOCAL ROLE ai_capital_owner;
      GRANT EXECUTE ON FUNCTION identity.f() TO ai_capital_owner;
    `
    const step = walk(bad).find(s => /^GRANT EXECUTE ON FUNCTION identity\.f/.test(s.sql))
    expect(step!.role).toBe('ai_capital_owner')   // i.e. NOT the function's owner
  })
})

describe('the blanket function revoke precedes the authority-owned resolver (defect V3-4)', () => {
  const steps = walk(text('017_ledger_views_rls_grants.sql'))
  const at = (pattern: RegExp) => steps.findIndex(s => pattern.test(s.sql))

  const blanket  = at(/^REVOKE ALL ON ALL FUNCTIONS IN SCHEMA investment_ledger FROM PUBLIC;/)
  const created  = at(/^CREATE FUNCTION investment_ledger\.resolve_or_create_instrument/)
  const revoked  = at(/^REVOKE ALL ON FUNCTION investment_ledger\.resolve_or_create_instrument/)
  const granted  = at(/^GRANT EXECUTE ON FUNCTION investment_ledger\.resolve_or_create_instrument/)

  it('all four statements are present', () => {
    for (const [name, i] of [['blanket revoke', blanket], ['resolver CREATE', created],
                             ['resolver REVOKE', revoked], ['resolver GRANT', granted]] as const) {
      expect(i, `${name} not found`).toBeGreaterThan(-1)
    }
  })

  it('the blanket revoke runs as ai_capital_owner', () => {
    // A REVOKE on a function you do not own is refused, and `ON ALL FUNCTIONS
    // IN SCHEMA` is a loop over every function in the schema — so it has to run
    // as the role that owns all of them.
    expect(steps[blanket].role).toBe('ai_capital_owner')
  })

  it('...and BEFORE the resolver exists', () => {
    // THE DEFECT. The blanket revoke used to live in section 6, by which time
    // the schema held `resolve_or_create_instrument`, owned by the authority
    // and already carrying an EXPLICIT ACL. A function at DEFAULT (NULL) acl
    // only produces `WARNING: no privileges could be revoked`; one with an
    // explicit acl is a hard failure —
    //     ERROR: permission denied for function resolve_or_create_instrument
    // — and the whole migration rolled back.
    expect(blanket).toBeLessThan(created)
    expect(blanket).toBeLessThan(revoked)
    expect(blanket).toBeLessThan(granted)
  })

  it('the resolver keeps its own owner-issued ACL block', () => {
    // Nothing was weakened; only the order changed. Both statements still run
    // as the authority, which owns the function.
    expect(steps[revoked].role).toBe('ai_capital_identity_authority')
    expect(steps[granted].role).toBe('ai_capital_identity_authority')
    expect(steps[created].role).toBe('ai_capital_identity_authority')
    expect(steps[granted].sql + steps[granted + 1]?.sql).toContain('ai_capital_importer')
  })

  it('section 6 still revokes TABLES and SEQUENCES from PUBLIC', () => {
    // Only the FUNCTIONS line moved.
    const t = text('017_ledger_views_rls_grants.sql')
    expect(t).toMatch(/REVOKE ALL ON ALL TABLES\s+IN SCHEMA investment_ledger FROM PUBLIC;/)
    expect(t).toMatch(/REVOKE ALL ON ALL SEQUENCES IN SCHEMA investment_ledger FROM PUBLIC;/)
  })

  it('the blanket revoke appears exactly once', () => {
    const all = [...text('017_ledger_views_rls_grants.sql').matchAll(
      /^REVOKE ALL ON ALL FUNCTIONS IN SCHEMA investment_ledger FROM PUBLIC;/gm)]
    expect(all).toHaveLength(1)
  })

  it('every owner-owned ledger function is created BEFORE the sweep', () => {
    // The sweep is only complete if nothing owner-owned comes after it.
    const late = steps
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => i > blanket && s.role === 'ai_capital_owner'
                            && /^CREATE FUNCTION investment_ledger\./.test(s.sql))
    expect(late.map(({ s }) => s.sql), 'these functions would miss the PUBLIC revoke').toEqual([])
  })
})

describe('owner-only statements run as the owner', () => {
  it.each(files)('%s issues ALTER DEFAULT PRIVILEGES as ai_capital_owner', file => {
    for (const s of walk(text(file))) {
      if (!/^ALTER\s+DEFAULT\s+PRIVILEGES/i.test(s.sql)) continue
      expect(s.role, `${file}:${s.line}`).toBe('ai_capital_owner')
    }
  })

  it('017 creates every RLS policy as the table owner', () => {
    // The policies live inside a DO block, so what matters is the role in
    // effect when the block runs.
    const steps = walk(text('017_ledger_views_rls_grants.sql'))
    const doBlocks = steps.filter(s => /^DO\s*\$/i.test(s.sql))
    expect(doBlocks.length).toBeGreaterThanOrEqual(2)
    for (const s of doBlocks) expect(s.role, `line ${s.line}`).toBe('ai_capital_owner')
  })
})
