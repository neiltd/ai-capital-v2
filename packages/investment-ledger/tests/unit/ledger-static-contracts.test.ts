import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// STATIC LEDGER CONTRACTS — no database connection anywhere in this file.
//
// Three separately-reported defects, each of which was a disagreement between
// what a comment claimed and what the executable text did:
//
//   C  The CLI authorizes `archive-import` alone, but publishArchive inserts an
//      OPEN reconciliation event that required `reconciliation`. A changed
//      archive could therefore never be published. Widening the CLI's request
//      would have handed every importer authority over the whole review
//      history, so the database now allows exactly one narrow event instead.
//   E  016's prose said `legacy:unclassified` was exempt from the one-root
//      index; the predicate said only `changed_from_batch IS NULL`.
//   F  The publication advisory lock keyed on the series alone, so two
//      unrelated workspaces importing a series with the same name serialized
//      against each other across the whole cluster.

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = resolve(HERE, '..', '..', '..', 'db', 'migrations')
const PKG = resolve(HERE, '..', '..')
const OPS = resolve(HERE, '..', '..', '..', '..', 'ops')
const sql = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf-8')
const ops = (f: string) => readFileSync(join(OPS, f), 'utf-8')
const ts  = (p: string) => readFileSync(join(PKG, p), 'utf-8')
const allSql = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
  .map(sql).join('\n')

// ─────────────────────────────────────────────────────────────────────────────
// C. The narrow changed-archive path.
// ─────────────────────────────────────────────────────────────────────────────
describe('archive-import may open a changed_archive case and nothing more', () => {
  const scope = /CREATE FUNCTION investment_ledger\.assert_reconciliation_event_scope\(\)[\s\S]*?\nEND \$\$;/
    .exec(sql('017_ledger_views_rls_grants.sql'))?.[0]

  it('the scope function exists and is attached to the events table', () => {
    expect(scope, 'assert_reconciliation_event_scope is missing').toBeTruthy()
    expect(sql('017_ledger_views_rls_grants.sql')).toMatch(
      /CREATE TRIGGER reconciliation_event_scope BEFORE INSERT ON investment_ledger\.reconciliation_case_events\s*\n\s*FOR EACH ROW EXECUTE FUNCTION investment_ledger\.assert_reconciliation_event_scope\(\);/)
  })

  it('full reconciliation authority short-circuits every check', () => {
    expect(scope).toMatch(/service_has_workspace_capability\(\s*\n?\s*NEW\.workspace_id, 'reconciliation'/)
    // The reconciliation branch must RETURN, not fall through into the
    // archive-import restrictions.
    const head = scope!.slice(0, scope!.indexOf('archive-import'))
    expect(head).toContain('RETURN NEW;')
  })

  it('the carve-out is exactly OPEN + changed_archive + same workspace + first event', () => {
    expect(scope).toMatch(/NEW\.event_type <> 'OPEN'/)
    expect(scope).toMatch(/v_case_type IS DISTINCT FROM 'changed_archive'/)
    // Both lookups are workspace-qualified: a case in another tenant must not
    // even be a candidate.
    const lookups = [...scope!.matchAll(/WHERE case_id = NEW\.case_id AND workspace_id = NEW\.workspace_id|WHERE id = NEW\.case_id AND workspace_id = NEW\.workspace_id/g)]
    expect(lookups.length, 'both lookups must filter on workspace').toBe(2)
    expect(scope).toMatch(/already has reconciliation events/)
  })

  it('every rejection is an authorization error, not a generic one', () => {
    // Split rather than match a terminator: the message text itself contains
    // semicolons ("changed_archive cases; case % is %"), so a non-greedy
    // `[\s\S]*?;` stopped inside the string and read as a missing ERRCODE.
    // Each chunk here runs from one RAISE to the next, so it holds exactly one
    // raise's tail.
    const raises = scope!.split('RAISE EXCEPTION').slice(1)
    expect(raises.length).toBe(4)
    for (const r of raises) expect(r).toContain("ERRCODE = '42501'")
  })

  it('SECURITY DEFINER is NOT used, so the lookups stay inside the caller’s RLS', () => {
    // A definer function owned by the authority would read these tables with no
    // policy naming it — under FORCE RLS that is zero rows, and the trigger
    // would reject every legitimate insert.
    expect(scope).not.toMatch(/SECURITY DEFINER/)
  })

  it('a second OPEN cannot win a race: the unique index is the real guarantee', () => {
    expect(sql('013_investment_ledger.sql')).toMatch(
      /CREATE UNIQUE INDEX uq_reconciliation_case_events_open\s*\n\s*ON investment_ledger\.reconciliation_case_events\(workspace_id, case_id\)\s*\n\s*WHERE event_type = 'OPEN';/)
  })

  it('the events table still requires reconciliation for every transition', () => {
    // The carve-out is expressed by ALLOWING archive-import at the coarse layer
    // and narrowing in the trigger. What must not happen is the coarse layer
    // being the only layer.
    const t = sql('017_ledger_views_rls_grants.sql')
    expect(t).toMatch(/actor_is_authorized BEFORE INSERT ON investment_ledger\.reconciliation_case_events\s*\n\s*FOR EACH ROW EXECUTE FUNCTION identity\.assert_actor_authorized\('archive-import','reconciliation'\);/)
    expect(t).toMatch(/CREATE TRIGGER reconciliation_event_scope/)
  })

  it('the CLI still asks for archive-import ALONE', () => {
    // The whole point: the fix must not have been "give the importer
    // reconciliation too".
    const cli = ts('bin/import-archive.ts')
    expect(cli).toMatch(/withAuthorizedServiceWorkspaceTransaction\(\s*\n?\s*options\.workspace!, 'archive-import',/)
    expect(cli).not.toContain("'reconciliation'")
    expect(cli).not.toContain('manual-entry')
  })

  it('publishArchive writes exactly one case and one event for a changed archive', () => {
    const publish = ts('src/publish.ts')
    const guarded = /if \(prior\.rows\[0\]\) \{([\s\S]*?)\n    \}/.exec(publish)?.[1]
    expect(guarded, 'the changed-archive branch is missing').toBeTruthy()
    expect([...guarded!.matchAll(/INSERT INTO investment_ledger\.reconciliation_cases/g)].length).toBe(1)
    expect([...guarded!.matchAll(/INSERT INTO investment_ledger\.reconciliation_case_events/g)].length).toBe(1)
    expect(guarded).toContain("'changed_archive'")
    expect(guarded).toContain("'OPEN'")
  })

  it('no production code writes any other reconciliation event', () => {
    const publish = ts('src/publish.ts')
    const events = [...publish.matchAll(
      /INSERT INTO investment_ledger\.reconciliation_case_events[\s\S]{0,400}?VALUES[^`]*`/g)]
    expect(events.length).toBe(1)
    for (const e of events) {
      for (const forbidden of ['MATCH', 'FLAG_MISMATCH', 'REQUEST_REVIEW', 'RESOLVE', 'DISMISS', 'REOPEN']) {
        expect(e[0], `publish.ts must not author ${forbidden}`).not.toContain(`'${forbidden}'`)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The resolver's schema access, across its whole lifecycle.
//
// THE DEFECT: 017 granted the identity authority CREATE on investment_ledger
// and never USAGE. That is exactly enough to DEFINE
// `resolve_or_create_instrument` and not enough to ever CALL it — a SECURITY
// DEFINER function executes as its owner, and resolving
// `investment_ledger.instruments` inside the body needs USAGE for that owner.
// Worse, the failure is invisible during migration (CREATE FUNCTION does not
// resolve the body) and arrives at the first import, on a database whose
// migration window lockdown has already closed.
//
// The lifecycle has three parts and all three are checked here, because getting
// any one wrong reintroduces the bug in a different place.
// ─────────────────────────────────────────────────────────────────────────────
describe('the identity authority keeps USAGE and loses CREATE', () => {
  const m017 = sql('017_ledger_views_rls_grants.sql')
  const lockdown = readFileSync(
    join(HERE, '..', '..', '..', '..', 'ops', 'bootstrap', '090_post_migration_lockdown.sql'), 'utf-8')

  it('017 grants the authority USAGE on investment_ledger', () => {
    expect(m017).toMatch(
      /GRANT USAGE\s+ON SCHEMA investment_ledger TO ai_capital_identity_authority;/)
  })

  it('017 also grants CREATE, and does so BEFORE it assumes the authority', () => {
    const usage  = m017.indexOf('GRANT USAGE  ON SCHEMA investment_ledger TO ai_capital_identity_authority')
    const create = m017.indexOf('GRANT CREATE ON SCHEMA investment_ledger TO ai_capital_identity_authority')
    const assume = m017.indexOf('SET LOCAL ROLE ai_capital_identity_authority')
    expect(usage).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(-1)
    // A grant issued AFTER the role switch would be the authority granting
    // itself schema rights it does not hold — 42501.
    expect(create, 'CREATE must be granted by the owner, before the switch').toBeLessThan(assume)
    expect(usage).toBeLessThan(assume)
  })

  it('017 asserts the USAGE grant at migration time', () => {
    // Belt and braces: the static check catches an edit to this file, the
    // migration-time assertion catches a database where the grant did not land.
    expect(m017).toMatch(
      /has_schema_privilege\('ai_capital_identity_authority',[\s\S]{0,40}?'investment_ledger', 'USAGE'\)/)
  })

  it('lockdown revokes CREATE from the authority on BOTH schemas', () => {
    expect(lockdown).toMatch(/REVOKE CREATE ON SCHEMA identity\s+FROM ai_capital_identity_authority;/)
    expect(lockdown).toMatch(/REVOKE CREATE ON SCHEMA investment_ledger FROM ai_capital_identity_authority;/)
  })

  it('lockdown revokes USAGE from NOBODY', () => {
    // The whole point. A tidy-up that turned the two REVOKE CREATE lines into
    // REVOKE ALL would break every import after the next deployment, and would
    // do it on a database that can no longer be migrated to fix it.
    const code = lockdown.split('\n')
      .filter(l => !l.trimStart().startsWith('--')).join('\n')
    expect(code).not.toMatch(/REVOKE\s+USAGE\s+ON SCHEMA/)
    expect(code).not.toMatch(/REVOKE\s+ALL\s+ON SCHEMA/)
  })

  it('011 does the same for the identity schema', () => {
    const m011 = sql('011_identity_foundation.sql')
    expect(m011).toMatch(/GRANT USAGE ON SCHEMA identity[\s\S]{0,20}?TO ai_capital_identity_authority,/)
    expect(m011).toMatch(/GRANT CREATE ON SCHEMA identity TO ai_capital_identity_authority;/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The RLS predicate, the operation split, and the role/view boundary.
//
// THE DEFECT THE DATABASE GATE FOUND: every policy read
//     workspace_id = identity.authorize_service_workspace_any(guc, caps)
// but that function returns the PRINCIPAL id, so the comparison was always
// false and every tenant write was refused. Type-correct, plausible, and
// catastrophic — which is precisely why it needs a static guard as well as a
// runtime one.
// ─────────────────────────────────────────────────────────────────────────────
describe('the RLS predicate compares a workspace to a workspace', () => {
  const m017 = sql('017_ledger_views_rls_grants.sql')

  /**
   * Statements with `--` comments and SQL string literals removed.
   *
   * 017's own closing assertion block searches pg_policy for the defective
   * pattern, so the pattern appears inside a SQL literal there. A checker that
   * read message text as code would accuse the file of containing the very bug
   * it guards against — the same trap the bootstrap contract test hit.
   */
  const statements = (() => {
    const noComments = m017.split('\n')
      .filter(l => !l.trimStart().startsWith('--')).join('\n')
    let out = ''
    for (let i = 0; i < noComments.length; i++) {
      if (noComments[i] !== "'") { out += noComments[i]; continue }
      i++
      while (i < noComments.length) {
        if (noComments[i] === "'" && noComments[i + 1] === "'") { i += 2; continue }
        if (noComments[i] === "'") break
        i++
      }
      out += "''"
    }
    return out
  })()

  it('no policy compares workspace_id to the authorizer’s return value', () => {
    expect(statements, 'the principal-return comparison is back')
      .not.toMatch(/workspace_id = identity\.authorize_service_workspace/)
  })

  it('...and 017 still guards against it at migration time', () => {
    // The literal the stripper removes above must really be present.
    expect(m017).toMatch(/workspace_id = identity\\.authorize_service_workspace/)
  })

  it('every policy compares the row to the GUC and separately requires authorization', () => {
    const policies = [...m017.matchAll(/CREATE POLICY (\w+)[\s\S]*?\$f\$, t, (\w+)\)/g)]
    expect(policies.map(p => p[1]).sort())
      .toEqual(['importer_insert', 'importer_lock_only', 'importer_read'])
    for (const [body, name] of policies.map(p => [p[0], p[1]] as const)) {
      expect(body, `${name}: missing the GUC comparison`)
        .toMatch(/workspace_id = nullif\(current_setting\('app\.workspace_id', true\), ''\)::uuid/)
      expect(body, `${name}: missing the authorization conjunct`)
        .toMatch(/IS NOT NULL/)
    }
  })

  // ───────────────────────────────────────────────────────────────────────
  // ROUND 8 — EVALUATION ORDER.
  //
  // The 2026-09-06 gate proved that the two conjuncts being PRESENT is not
  // enough. Written as `workspace_id = <guc> AND authorize(...) IS NOT NULL`,
  // PostgreSQL evaluated the cheap false comparison and skipped the throwing
  // authorizer entirely, so a forged workspace returned 0 rows instead of
  // raising 42501. The test above passes on that defective form — which is
  // exactly why these exist alongside it.
  // ───────────────────────────────────────────────────────────────────────
  describe('and authorization is ordered before the comparison, structurally', () => {
    const policies = () =>
      [...m017.matchAll(/CREATE POLICY (\w+)[\s\S]*?\$f\$, t, (\w+)\)/g)]
        .map(m => [m[1], m[0]] as const)

    it('all three policies are covered by the checks below', () => {
      expect(policies().map(([name]) => name).sort())
        .toEqual(['importer_insert', 'importer_lock_only', 'importer_read'])
    })

    it('each policy expresses the order with CASE, not a top-level AND', () => {
      for (const [name, body] of policies()) {
        expect(body, `${name}: the predicate is not a CASE`).toMatch(/CASE\s*\n?\s*WHEN/)
      }
    })

    it('the authorizer sits in the WHEN condition, ahead of any row column', () => {
      // Positional rather than a whole-expression regex, so reformatting the
      // migration cannot quietly defeat it.
      for (const [name, body] of policies()) {
        const caseAt = body.indexOf('CASE')
        const authAt = body.indexOf('authorize_service_workspace_any')
        const thenAt = body.indexOf('THEN')
        const wsAt = body.indexOf('workspace_id =')
        expect(caseAt, `${name}: no CASE`).toBeGreaterThan(-1)
        expect(authAt, `${name}: no authorizer call`).toBeGreaterThan(-1)
        expect(thenAt, `${name}: no THEN`).toBeGreaterThan(-1)
        expect(wsAt, `${name}: no workspace comparison`).toBeGreaterThan(-1)
        expect(caseAt, `${name}: the authorizer is outside the CASE`).toBeLessThan(authAt)
        expect(authAt, `${name}: the row is compared before authorization`).toBeLessThan(wsAt)
        expect(thenAt, `${name}: workspace_id is in the WHEN condition, not a branch`)
          .toBeLessThan(wsAt)
      }
    })

    it('MUTATION CONTROL: the short-circuitable top-level conjunction is rejected', () => {
      // NON-VACUITY FOR THE ORDER CHECK ITSELF. The three assertions above must
      // FAIL against the exact expression the gate disproved. Reconstructing it
      // here — rather than trusting that they would — is the only way to know
      // the guard discriminates instead of merely passing.
      const shortCircuitable = `
        CREATE POLICY importer_read ON investment_ledger.%I
          FOR SELECT TO ai_capital_importer
          USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                 AND identity.authorize_service_workspace_any(
                       nullif(current_setting('app.workspace_id', true), '')::uuid,
                       ARRAY[%s]::identity.service_capability[]) IS NOT NULL)
      $f$, t, select_caps)`

      // It satisfies the ORIGINAL "both conjuncts present" contract ...
      expect(shortCircuitable).toMatch(
        /workspace_id = nullif\(current_setting\('app\.workspace_id', true\), ''\)::uuid/)
      expect(shortCircuitable).toMatch(/IS NOT NULL/)

      // ... and is still rejected here, on both counts.
      expect(shortCircuitable, 'a top-level AND must not read as a CASE')
        .not.toMatch(/CASE\s*\n?\s*WHEN/)
      const authAt = shortCircuitable.indexOf('authorize_service_workspace_any')
      const wsAt = shortCircuitable.indexOf('workspace_id =')
      expect(wsAt, 'the defective form compares the row first').toBeLessThan(authAt)
    })

    it('MUTATION CONTROL: merely reversing the AND is also rejected', () => {
      // Operand order is not a documented contract, so a "fix" that only swaps
      // the sides must not be accepted as one. It passes the positional
      // authorizer-before-workspace_id test and fails on the absent CASE — which
      // is why the CASE check carries its own weight.
      const reversed = `
          USING (identity.authorize_service_workspace_any(
                       nullif(current_setting('app.workspace_id', true), '')::uuid,
                       ARRAY[%s]::identity.service_capability[]) IS NOT NULL
                 AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)`
      expect(reversed.indexOf('authorize_service_workspace_any'))
        .toBeLessThan(reversed.indexOf('workspace_id ='))
      expect(reversed, 'a reversed AND is not a structural ordering')
        .not.toMatch(/CASE\s*\n?\s*WHEN/)
    })

    it('017 asserts the same shape against pg_policy at migration time', () => {
      // Source review cannot see what format() produced, so the catalogue is
      // checked too. This binds the two guards together.
      expect(m017).toMatch(/can short-circuit past authorization/)
      expect(m017).toMatch(
        /strpos\(x\.e, 'authorize_service_workspace_any'\) < strpos\(k\.masked, 'workspace_id'\)/)
      expect(m017).toMatch(/strpos\(x\.e, 'THEN'\) < strpos\(k\.masked, 'workspace_id'\)/)
    })

    it('the migration-time guard locates the ROW COLUMN, not the GUC literal', () => {
      // ROUND 6 DEFECT. The guard used a bare `strpos(e, 'workspace_id')`, but
      // that is not where the column is: pg_get_expr names the GUC first, in
      // the literal 'app.workspace_id' passed to the authorizer — and that
      // literal lives in the WHEN condition. `THEN < workspace_id` was
      // therefore FALSE for the correct policy, so the assertion would have
      // failed the migration on a good tree.
      //
      // The fix masks both non-column occurrences by exact name before locating
      // the column, using replacements of identical length so offsets in the
      // masked string still line up with the original.
      expect(m017, 'the authorizer name is not masked')
        .toMatch(/'authorize_service_workspace_any',\s*\n\s*'z{31}'/)
      expect(m017, 'the GUC literal is not masked')
        .toMatch(/'app\.workspace_id',\s*\n\s*'z{16}'/)
      // The masks must be exactly as long as what they replace, or the position
      // arithmetic is meaningless — 017 checks this at runtime too.
      expect('authorize_service_workspace_any').toHaveLength(31)
      expect('app.workspace_id').toHaveLength(16)
      expect(m017, 'the length-preservation invariant is not asserted')
        .toMatch(/length\(k\.masked\) = length\(x\.e\)/)
      // And the surviving occurrence must be a real comparison at a token
      // boundary, not any substring.
      expect(m017, 'no boundary-aware comparison check')
        .toMatch(/\[\^\._\[:alnum:\]\]\)workspace_id\[\[:space:\]\]\*=/)
      // It must not have raised the chain's PostgreSQL floor to get there.
      // Executable text only: the migration's own comment EXPLAINS why
      // regexp_instr was avoided, and prose read as code would indict it.
      const sqlCode = m017.split('\n')
        .filter(l => !l.trimStart().startsWith('--')).join('\n')
      expect(sqlCode, 'regexp_instr would require PostgreSQL 15+')
        .not.toMatch(/regexp_instr/)
    })

    it('NON-VACUITY: the guard accepts the intended CASE and rejects every defective shape', () => {
      // The guard runs inside a migration, so it cannot be exercised here
      // directly. What CAN be checked database-free is its LOGIC, applied to
      // representative deparsed text — and the text deliberately contains both
      // hazards: the authorizer's name and the literal 'app.workspace_id'.
      // Without them the Round-6 bug would not reproduce and this test would
      // prove nothing.
      const AUTH = 'authorize_service_workspace_any'
      const GUC = 'app.workspace_id'
      const ARG = `(NULLIF(current_setting('${GUC}'::text, true), ''::text))::uuid`
      const CAPS = "ARRAY['archive-import'::identity.service_capability]"

      /** The migration's predicate, transcribed. */
      const accepts = (e: string): boolean => {
        const masked = e.split(AUTH).join('z'.repeat(31)).split(GUC).join('z'.repeat(16))
        if (masked.length !== e.length) return false
        const caseAt = e.indexOf('CASE') + 1
        const authAt = e.indexOf(AUTH) + 1
        const thenAt = e.indexOf('THEN') + 1
        const wsAt = masked.indexOf('workspace_id') + 1
        return caseAt > 0 && thenAt > 0 && authAt > 0 && wsAt > 0
          && /(^|[^._a-zA-Z0-9])workspace_id[ \t\n]*=/.test(masked)
          && caseAt < authAt && authAt < wsAt && thenAt < wsAt
      }

      const intended =
        `CASE WHEN (identity.${AUTH}(${ARG}, ${CAPS}) IS NOT NULL) ` +
        `THEN (workspace_id = ${ARG}) ELSE false END`

      // THE POSITIVE CASE — and the one Round 6 would have rejected.
      expect(accepts(intended), 'the intended CASE policy must be accepted').toBe(true)

      // The hazard really is present in that text, so the acceptance above is
      // not an artefact of a sanitised fixture.
      expect(intended.indexOf(GUC)).toBeLessThan(intended.indexOf('THEN'))
      expect(intended).toContain(AUTH)

      // THE ROUND-6 REGRESSION, stated as an executable fact: locating the
      // column with a bare search finds the GUC literal, ahead of THEN.
      const naiveWsAt = intended.indexOf('workspace_id')
      expect(naiveWsAt,
        'the bare search must land in the GUC literal, which is why it was wrong')
        .toBeLessThan(intended.indexOf('THEN'))

      // EVERY DEFECTIVE SHAPE, each rejected for its own reason.
      const defective: Array<readonly [string, string]> = [
        ['comparison-first AND',
         `((workspace_id = ${ARG}) AND (identity.${AUTH}(${ARG}, ${CAPS}) IS NOT NULL))`],
        ['reversed AND',
         `((identity.${AUTH}(${ARG}, ${CAPS}) IS NOT NULL) AND (workspace_id = ${ARG}))`],
        ['workspace comparison inside WHEN',
         `CASE WHEN (workspace_id = ${ARG}) ` +
         `THEN (identity.${AUTH}(${ARG}, ${CAPS}) IS NOT NULL) ELSE false END`],
        ['missing CASE',
         `(identity.${AUTH}(${ARG}, ${CAPS}) IS NOT NULL)`],
        ['missing authorizer',
         `CASE WHEN true THEN (workspace_id = ${ARG}) ELSE false END`],
        ['authorizes but never compares the row',
         `CASE WHEN (identity.${AUTH}(${ARG}, ${CAPS}) IS NOT NULL) THEN true ELSE false END`],
      ]
      for (const [name, e] of defective) {
        expect(accepts(e), `${name} must be rejected`).toBe(false)
      }
    })

    it('the ACL tests classify roles by rolcanlogin, not by name', () => {
      // R2. Both files used to select their subjects with `LIKE 'ai_capital_%'`,
      // which swept in `ai_capital_owner` — a NOLOGIN object owner whose
      // DELETE/TRUNCATE/SELECT come from OWNERSHIP, not from a grant, and which
      // an owner can restore at will. The boundary is "nobody can authenticate
      // as it", so the subject must be `rolcanlogin`.
      const appendOnly = ts('tests/integration/tenancy/append-only.test.ts')
      const ownership  = ts('tests/integration/tenancy/ownership-and-acl.test.ts')

      // The privilege sweeps must be scoped to LOGIN, non-superuser roles.
      expect(appendOnly, 'append-only: DELETE/TRUNCATE sweep is not LOGIN-scoped')
        .toMatch(/r\.rolcanlogin AND NOT r\.rolsuper/)
      expect(ownership, 'ownership: withheld-view sweep is not LOGIN-scoped')
        .toMatch(/r\.rolcanlogin AND NOT r\.rolsuper/)

      // NEGATIVE ASSERTIONS RUN OVER CODE ONLY. Those files now EXPLAIN the
      // discredited filter in a comment, so a checker that read prose as code
      // would accuse them of still containing it — the same self-match trap
      // this file already handles for 017's SQL literals.
      const code = (src: string) => src.split('\n')
        .filter(l => !l.trimStart().startsWith('//')).join('\n')

      expect(code(appendOnly), 'the name-based grantee filter is back')
        .not.toMatch(/grantee LIKE 'ai_capital_%'/)
      // ... and neither must the information_schema view it read, which is
      // filtered by the querying role and cannot prove absence.
      expect(code(appendOnly), 'information_schema cannot prove absence of a privilege')
        .not.toMatch(/role_table_grants/)

      // Non-vacuity: both files must pin the LOGIN role set positively, or an
      // empty sweep would read as a pass.
      for (const [name, body] of [['append-only', appendOnly], ['ownership', ownership]] as const) {
        expect(body, `${name}: no positive LOGIN-role roster`)
          .toMatch(/rolcanlogin AND NOT rolsuper AND rolname LIKE 'ai_capital_%'/)
        expect(body, `${name}: does not re-assert the owner is NOLOGIN`)
          .toMatch(/ai_capital_owner must remain NOLOGIN/)
      }
    })

    it('the owner is not described as a runtime role', () => {
      // The prose the gate disproved: DELETE/TRUNCATE ARE held by the owner.
      const appendOnly = ts('tests/integration/tenancy/append-only.test.ts')
      // This one is ABOUT prose, so it deliberately reads the file whole.
      expect(appendOnly)
        .not.toMatch(/DELETE and TRUNCATE are not granted to any runtime role\./)
      expect(appendOnly).toMatch(/No role anyone can LOG IN AS holds DELETE or TRUNCATE/)
    })

    it('the tests that stranded a transaction in the gate now clean up in finally', () => {
      // The 2026-09-06 gate turned two assertion failures into eleven, because
      // a trailing `await rollback(...)` never ran and the fixture's client
      // stayed marked in-transaction. Both now roll back in a `finally`.
      const isolation = ts('tests/integration/tenancy/workspace-isolation.test.ts')
      const changed   = ts('tests/integration/tenancy/changed-archive-import.test.ts')

      // EVERY transaction, not "the file contains a finally somewhere". The
      // gate's cascade came from ONE unprotected test in a file that had
      // others, so a file-wide check would have passed on the defect.
      //
      // ALL THREE OPENERS. An earlier version recognised only
      // `beginAuthorized` and `beginWithForgedContext`, so the FK-backstop
      // block's `begin(admin)` regions — which disable USER triggers and MUST
      // roll back to restore them — were scanned past entirely. A mutation that
      // deleted their `finally` did not fail the suite.
      //
      // COMMENTS ARE STRIPPED FIRST. These files DISCUSS `await begin(...)` in
      // prose; counting a mention as an open would invent regions that have no
      // cleanup and fail on correct code. Stripping also means a commented-out
      // opener is not policed. The `(` is required, so `beginAuthorized` is
      // never read as `begin`, and an unrelated word like `beginning` cannot
      // match. Helper DEFINITIONS live in fixture.ts and carry no `await`.
      const OPENER = /await begin(?:Authorized|WithForgedContext)?\(/g
      const stripComments = (src: string) => src.split('\n')
        .filter(l => !l.trimStart().startsWith('//')).join('\n')

      for (const [name, raw] of [['workspace-isolation', isolation],
                                 ['changed-archive-import', changed]] as const) {
        const body = stripComments(raw)
        const opens = [...body.matchAll(OPENER)]
        expect(opens.length, `${name}: no transactions opened at all`).toBeGreaterThan(0)

        // Each region runs to the NEXT recognised open, located with the same
        // regex rather than a bare indexOf, so a region cannot be truncated
        // early by the word appearing somewhere it is not an opener.
        for (let i = 0; i < opens.length; i++) {
          const start = opens[i].index!
          const end = i + 1 < opens.length ? opens[i + 1].index! : body.length
          const region = body.slice(start, end)
          const opener = opens[i][0]

          expect(/await (rollback|commit)\(/.test(region),
            `${name}: ${opener} opens a transaction that is never released`).toBe(true)
          // A commit is the deliberate hand-off case: there is nothing left to
          // roll back, so a finally is not required.
          if (/await commit\(/.test(region)) continue

          // POSITIONAL, not adjacency: a `finally` whose first lines are
          // comments is still a `finally`, and requiring `await rollback(` to
          // follow the brace immediately would reject correct code.
          const finallyAt  = region.indexOf('} finally {')
          const rollbackAt = region.indexOf('await rollback(')
          expect(finallyAt,
            `${name}: ${opener} has a rollback-only transaction with no finally:\n${region.slice(0, 300)}`)
            .toBeGreaterThan(-1)
          expect(rollbackAt,
            `${name}: ${opener} does not roll back inside its finally:\n${region.slice(0, 300)}`)
            .toBeGreaterThan(finallyAt)
        }
      }

      // NON-VACUITY FOR THE EXTENSION ITSELF. The bare `begin(` opener must
      // actually occur in the scanned corpus, or this guard would have been
      // widened for nothing and would silently stop covering the FK-backstop
      // block if it were ever renamed.
      const bare = [...stripComments(isolation).matchAll(/await begin\(/g)]
      expect(bare.length,
        'no bare `await begin(` region found — the FK-backstop block is not being scanned')
        .toBeGreaterThan(0)
      // ... and those regions really are the admin/backstop ones.
      expect(stripComments(isolation)).toMatch(/await begin\(admin\)/)
      expect(stripComments(isolation)).toMatch(/DISABLE TRIGGER USER/)
    })

    it('FINAL: current-state wording names the current constraints', () => {
      // Three files carried claims about the RESULTING schema that the schema
      // no longer matched. Historical explanations are legitimate and are
      // allowed here — but only when they are marked as history.
      const pub = ts('src/publish.ts')
      const m016 = sql('016_investment_ledger_enforcement.sql')
      const enf = ts('tests/integration/enforcement.test.ts')

      // 1. publish.ts names the index it actually catches a violation from.
      expect(pub, 'publish.ts still names the pre-tenancy unique index')
        .toMatch(/\(workspace_id, series_key, source_kind, source_sha256\) index/)
      expect(pub, 'the stale three-column form is back')
        .not.toMatch(/\(series_key, source_kind, source_sha256\) index/)
      // The constant it documents must still be the one it describes.
      expect(pub).toMatch(/SERIES_SOURCE_UNIQUE = 'import_batches_series_source_unique'/)

      // 2. 016 and its enforcement test name the CURRENT successor constraint.
      for (const [name, body] of [['016', m016], ['enforcement.test.ts', enf]] as const) {
        expect(body, `${name}: the current successor constraint is not named`)
          .toMatch(/UNIQUE \(workspace_id, changed_from_batch\)/)
        // Any bare `UNIQUE (changed_from_batch)` left in either file must be
        // inside an explicit historical phrase, not stated as current fact.
        const lines = body.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].includes('UNIQUE (changed_from_batch)')) continue
          const window = lines.slice(Math.max(0, i - 2), i + 3).join(' ')
          expect(window,
            `${name}:${i + 1} states the obsolete constraint without marking it as history`)
            .toMatch(/spelled .* when this defect was found/)
        }
      }
      // 016 must also record that 013 declares no such uniqueness at all.
      expect(m016, '016 does not say where the successor constraint comes from')
        .toMatch(/015's `import_batches_single_successor`/)
    })

    it('the changed-archive fixture isolates capabilities by WORKSPACE, not by connection', () => {
      // ROUND 7 DEFECT. The file opened two clients with `connectAs('importer')`
      // and treated them as two authorities, then granted the ONE underlying
      // principal both `archive-import` and `reconciliation` in ONE workspace
      // and asserted it lacked `reconciliation`. Capability is resolved from
      // `session_user`, so two connections on one login are one principal; the
      // assertion could never pass, and the 2026-09-06 gate failed it.
      //
      // The separation is now per (principal, workspace), which is how a grant
      // is actually keyed. These guards pin that arrangement.
      const f = ts('tests/integration/tenancy/changed-archive-import.test.ts')
      const code = f.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

      // TWO capability-isolated workspaces, seeded distinctly.
      expect(code).toMatch(/archiveWs = await seedWorkspace\(admin, 'changed-archive'\)/)
      expect(code).toMatch(/reconWs = await seedWorkspace\(admin, 'changed-archive-recon'\)/)

      // EXACTLY the two intended grants, and no others anywhere in the file.
      const grants = [...code.matchAll(
        /grantCapability\(\s*admin,\s*(\w+),\s*principals\.(\w+),\s*'([a-z-]+)'/g)]
        .map(m => `${m[1]}:${m[2]}:${m[3]}`).sort()
      expect(grants).toEqual([
        'archiveWs:importer:archive-import',
        'reconWs:importer:reconciliation',
      ])
      // Stated again as explicit negatives, because the list above would also
      // be satisfied by a rename: neither workspace may receive the other's
      // capability, which is what makes each block's refusals non-vacuous.
      expect(grants, 'archiveWs must not receive reconciliation')
        .not.toContain('archiveWs:importer:reconciliation')
      expect(grants, 'reconWs must not receive archive-import')
        .not.toContain('reconWs:importer:archive-import')

      // ONE LOGIN, ONE PRINCIPAL. Both clients are the importer login, no other
      // login is used, and no second principal is created or bound.
      expect([...code.matchAll(/connectAs\('importer'\)/g)],
        'exactly two importer connections').toHaveLength(2)
      expect(code, "the agent login must not reappear here")
        .not.toMatch(/connectAs\('(agent|app|operator|migrator)'\)/)
      expect(code, 'a second principal must not be created or bound')
        .not.toMatch(/ensureRolePrincipal|ensureGrantorPrincipal|SERVICE_PRINCIPALS/)
      // Every actor written is the one shared importer principal.
      const actors = new Set([...code.matchAll(/principals\.(\w+)/g)].map(m => m[1]))
      expect([...actors].sort()).toEqual(['grantor', 'importer'])

      // The file must prove the shared identity at runtime too, not just here.
      expect(code, 'no runtime proof that both clients are one principal')
        .toMatch(/session_user AS who/)
      expect(code).toMatch(/toBe\('ai_capital_importer'\)/)
    })

    it('both capability assertions are positive and two-sided', () => {
      // A single-sided check ("has archive-import") would pass with a stray
      // reconciliation grant present, turning every carve-out refusal in the
      // file into a vacuous pass. Each workspace asserts what it HAS and what
      // it LACKS.
      const f = ts('tests/integration/tenancy/changed-archive-import.test.ts')
      const code = f.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

      const archiveBlock = /in archiveWs the principal holds[\s\S]*?\n  \}\)/.exec(code)?.[0] ?? ''
      expect(archiveBlock, 'the archiveWs capability test is missing').not.toBe('')
      expect(archiveBlock).toMatch(/\[archiveWs\.id\]/)
      expect(archiveBlock).toMatch(/rows\[0\]\.imp[\s\S]*?\.toBe\(true\)/)
      expect(archiveBlock).toMatch(/rows\[0\]\.rec[\s\S]*?\.toBe\(false\)/)

      const reconBlock = /in reconWs the SAME principal holds[\s\S]*?\n  \}\)/.exec(code)?.[0] ?? ''
      expect(reconBlock, 'the reconWs capability test is missing').not.toBe('')
      expect(reconBlock).toMatch(/\[reconWs\.id\]/)
      expect(reconBlock).toMatch(/rows\[0\]\.rec[\s\S]*?\.toBe\(true\)/)
      expect(reconBlock).toMatch(/rows\[0\]\.imp[\s\S]*?\.toBe\(false\)/)

      // The impossible assertion the gate caught must not return in any form:
      // no test may claim a lack of reconciliation while reading reconWs. The
      // check is per STATEMENT — a span-based regex leaks into the neighbouring
      // `imp ... toBe(false)` and reports a failure that is not there.
      const statementAfter = (block: string, needle: string): string => {
        const at = block.indexOf(needle)
        if (at < 0) return ''
        const next = block.indexOf('expect(', at)
        return block.slice(at, next < 0 ? block.length : next)
      }
      const recAssertion = statementAfter(reconBlock, 'rows[0].rec')
      expect(recAssertion, 'no reconciliation assertion found in the reconWs block').not.toBe('')
      expect(recAssertion, 'reconWs must assert it HOLDS reconciliation').toContain('.toBe(true)')
      expect(recAssertion, 'reconWs must not claim it lacks reconciliation')
        .not.toContain('.toBe(false)')
    })

    it('the positive reconciliation fixture is a case of its own, in reconWs', () => {
      // Reusing the changed-archive case would test two things at once: nobody
      // holds `reconciliation` in archiveWs, so a probe there would be refused
      // for tenancy reasons while claiming to prove transition authority.
      const f = ts('tests/integration/tenancy/changed-archive-import.test.ts')
      const code = f.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

      expect(code, 'no independent reconciliation case is seeded')
        .toMatch(/reconCaseId = seeded\.rows\[0\]\.id/)
      // The transition probes use it, in reconWs, and never the archive case.
      const transitions =
        /may author %s from the open state[\s\S]*?\n    \}\)/.exec(code)?.[0] ?? ''
      expect(transitions, 'the transition block is missing').not.toBe('')
      expect(transitions).toMatch(/reconWs\.id, principals\.importer\.id, reconCaseId/)
      expect(transitions, 'the archive case must not be the reconciliation fixture')
        .not.toMatch(/openedCaseId/)
      // ... and the archive-import carve-out probes still use the archive case.
      const carveOut = /archive-import cannot author a %s event[\s\S]*?\n  \}\)/.exec(code)?.[0] ?? ''
      expect(carveOut, 'the carve-out block is missing').not.toBe('')
      expect(carveOut).toMatch(/archiveWs\.id, principals\.importer\.id, openedCaseId/)
    })

    it('no file changed this round still claims it has never run', () => {
      // The tenancy suite ran on 2026-09-06; this file's header said otherwise.
      expect(ts('tests/integration/tenancy/changed-archive-import.test.ts'))
        .not.toMatch(/AUTHORED, NOT YET RUN/)
    })

    it('ROUND 8: post-lockdown tests assert the order PostgreSQL actually uses', () => {
      // Four tests demanded outcomes the server cannot produce. Each is pinned
      // here so the wrong expectation cannot come back.
      const ao = ts('tests/integration/tenancy/append-only.test.ts')
      const at = ts('tests/integration/tenancy/attribution.test.ts')
      const oc = ts('tests/integration/tenancy/operation-capabilities.test.ts')
      const code = (src: string) => src.split('\n')
        .filter(l => !l.trimStart().startsWith('//')).join('\n')

      // (1) A BEFORE UPDATE trigger precedes WITH CHECK, so an ordinary UPDATE
      //     yields the trigger's P0001, never the policy's 42501.
      expect(ao, 'the append-only UPDATE test still claims the policy denies first')
        .not.toMatch(/an UPDATE is denied at the POLICY layer, before the trigger/)
      const upd = /an ordinary UPDATE is refused by the append-only TRIGGER[\s\S]*?\n  \}\)/
        .exec(ao)?.[0] ?? ''
      expect(upd, 'the ordinary-UPDATE test is missing').not.toBe('')
      expect(upd).toMatch(/\.toBe\(RAISE_EXCEPTION\)/)
      expect(upd).toMatch(/toMatch\(\/append-only\//)
      // Lookbehind so the test's own `.not.toBe(INSUFFICIENT_PRIVILEGE)` — which
      // is a correct assertion — is not read as the defect it rules out.
      expect(upd, 'must not demand the policy error')
        .not.toMatch(/(?<!\.not)\.toBe\(INSUFFICIENT_PRIVILEGE\)/)

      // (2) SET ROLE does not change session_user, so it cannot stand in for an
      //     importer login in any authorization-sensitive probe.
      expect(code(ao), 'the invalid SET ROLE identity control is back')
        .not.toMatch(/SET LOCAL ROLE|SET ROLE/)
      expect(ao, 'the reason must be recorded, not just the removal')
        .toMatch(/does not\s*\n?\/\/ change `session_user`|does not\s+change `session_user`/)
      // Its guarantee survives as catalogue assertions.
      expect(ao).toMatch(/WITH CHECK \(false\) is the second denial, asserted in the catalogue/)
      expect(ao).toMatch(/no PERMISSIVE update policy exists/)

      // (3) A BEFORE INSERT trigger precedes constraint evaluation, so a missing
      //     actor raises 42501 and 23502 is never observable from that path.
      expect(code(at), 'the missing-actor test still demands NOT_NULL_VIOLATION')
        .not.toMatch(/NOT_NULL_VIOLATION/)
      expect(at).toMatch(/refused by the attribution TRIGGER, with 42501/)
      // ... and the constraint itself is still proven, in the catalogue.
      expect(at).toMatch(/every tenant table declares actor_principal_id NOT NULL/)
      expect(at).toMatch(/attnotnull, 'accounts\.actor_principal_id must be NOT NULL'\)\.toBe\(true\)/)

      // (4) probe() rolls back its SAVEPOINT even on success, which discards a
      //     DEFERRED constraint trigger's pending event. The INSERT that queues
      //     it must therefore run directly; probe() may wrap only the verdict.
      const deferred = /DEFERRED correction triggers fire[\s\S]*?\n  \}\)/.exec(oc)?.[0] ?? ''
      expect(deferred, 'the deferred-trigger test is missing').not.toBe('')
      const insertAt = deferred.indexOf('INSERT INTO investment_ledger.transactions')
      const probesBefore = [...deferred.slice(0, insertAt).matchAll(/await probe\(/g)]
      expect(probesBefore.length,
        'the correction-group INSERT must not run inside rollback-always probe()').toBe(0)
      // probe() is still used, and only around the verdict.
      expect(deferred).toMatch(/await probe\(importer, \(\) =>\s*\n\s*importer\.query\('SET CONSTRAINTS ALL IMMEDIATE'\)\)/)
      expect(deferred).toMatch(/\.toBe\(RAISE_EXCEPTION\)/)
    })

    it('ROUND 8: shared probe() semantics were NOT changed to suit a test', () => {
      // The alternative fix would have been to make probe() keep successful
      // work. That would silently change every other probe in the suite from
      // "observe and leave no trace" to "observe and commit", so it was
      // rejected: probe() still rolls back unconditionally.
      const fx = ts('tests/integration/tenancy/fixture.ts')
      const probeBody = /export async function probe\(client: Client[\s\S]*?\n\}/.exec(fx)?.[0] ?? ''
      expect(probeBody, 'probe() is missing').not.toBe('')
      expect(probeBody, 'probe() must still roll back to its savepoint unconditionally')
        .toMatch(/await client\.query\(`ROLLBACK TO SAVEPOINT \$\{savepoint\}`\)\s*\n\s*return result/)
      // The rollback must not have been made conditional on failure.
      expect(probeBody).not.toMatch(/if \([\s\S]{0,80}ROLLBACK TO SAVEPOINT/)
    })

    it('ROUND 8A: 017 no longer claims the policy denies before the trigger', () => {
      // Two comments in 017 said `WITH CHECK (false)` refuses an UPDATE "before
      // the append-only trigger is reached". The server does the opposite: a
      // BEFORE ROW trigger runs after the policy's USING clause and before its
      // WITH CHECK, so the trigger's P0001 is what a caller actually observes.
      // The executable SQL was always right; only the prose was wrong, and
      // prose is what the next reader trusts.
      expect(m017, 'the section-5 ordering claim is back')
        .not.toMatch(/Two\s*\n?--\s*independent denials, the append-only trigger being the second/)
      expect(m017, 'the lock-only ordering claim is back')
        .not.toMatch(/denies every real UPDATE at the policy\s*\n\s*--\s*layer, before the append-only trigger is reached/)
      // Blanket: no phrasing anywhere may put WITH CHECK ahead of the trigger.
      expect(m017, 'some comment still orders WITH CHECK before the trigger')
        .not.toMatch(/before the append-only trigger/)

      // And the correct order is stated positively, in both places.
      expect(m017).toMatch(/fires BEFORE ROW triggers, and only then applies/)
      expect(m017).toMatch(/BEFORE ROW triggers run\s*\n\s*--\s*after this policy's USING clause and before its WITH CHECK/)
      // The two facts that must survive the correction.
      expect(m017, 'the row-locking rationale for the UPDATE privilege was lost')
        .toMatch(/charges `SELECT \.\.\. FOR UPDATE` row locking against it/)
      // Anchored per LOCATION, not a bare word search: 017 now says "backstop"
      // in both corrected comments, so a single /backstop/ match is satisfied
      // by either one and would miss the loss of the other.
      expect(m017, 'section 5 no longer calls WITH CHECK (false) the backstop')
        .toMatch(/WITH CHECK \(false\) is the backstop that would\s*\n\s*--\s*refuse the write if the trigger were ever dropped/)
      expect(m017, 'the lock-only comment no longer calls it the independent backstop')
        .toMatch(/WITH CHECK \(false\) is the\s*\n\s*--\s*independent backstop, not the front line/)
    })

    it('ROUND 8A: the tenancy integration files claim no run state', () => {
      // "AUTHORED, NOT YET RUN" was true when written and false afterwards — a
      // comment that decays. The replacement states the PRECONDITION instead,
      // which stays true regardless of how many gates have run, and does not
      // claim the current assertions have passed against PostgreSQL.
      const files = [
        'tests/integration/tenancy/append-only.test.ts',
        'tests/integration/tenancy/attribution.test.ts',
        'tests/integration/tenancy/operation-capabilities.test.ts',
      ] as const
      for (const f of files) {
        const src = ts(f)
        expect(src, `${f}: the decaying run-state banner is back`)
          .not.toMatch(/AUTHORED, NOT YET RUN/)
        expect(src, `${f}: missing the timeless precondition banner`)
          .toMatch(/INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE\./)
        // It must not have swapped one dated claim for another.
        expect(src, `${f}: the banner must not assert a past passing run`)
          .not.toMatch(/(?:PASSED|VERIFIED|GREEN) (?:ON|AGAINST)|last run on|as of 20\d\d-/)
      }
    })

    it('ROUND 8B: NO tenancy file claims a run state — directory-wide', () => {
      // DIRECTORY-WIDE ON PURPOSE. Round 8A fixed three files by name and I
      // reported "12 other files"; the real number was 13, and a by-name guard
      // would have kept passing while ten stale banners sat next to it. This
      // one enumerates the directory instead, so a file added later is covered
      // without anybody remembering to add it here.
      const DIR = 'tests/integration/tenancy'
      const TEST_BANNER = 'INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.'
      const SUPPORT_BANNER = 'INTEGRATION SUPPORT — USED ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.'
      const SUPPORT_FILES = ['fixture.ts', 'graph.ts', 'phase.ts']

      const names = readdirSync(join(PKG, DIR)).filter(f => f.endsWith('.ts')).sort()
      // Non-vacuity: an empty or mis-pointed listing would pass every loop below.
      expect(names.length, 'the tenancy directory listing is implausibly small')
        .toBeGreaterThanOrEqual(17)
      for (const f of SUPPORT_FILES) {
        expect(names, `${f} is missing from the tenancy directory`).toContain(f)
      }

      let testBanners = 0
      let supportBanners = 0
      for (const name of names) {
        const src = ts(join(DIR, name))
        const isSupport = SUPPORT_FILES.includes(name)

        // 1. The decaying claim is gone everywhere.
        expect(src, `${name}: "AUTHORED, NOT YET RUN" is back`)
          .not.toMatch(/AUTHORED, NOT YET RUN/)

        // 2. No dated or past-result status replaced it.
        expect(src, `${name}: a banner must not assert a past passing run`)
          .not.toMatch(/(?:PASSED|VERIFIED|GREEN) (?:ON|AGAINST)|last run on|as of 20\d\d-/)

        // 3. Support files carry the support banner; test files carry the test
        //    banner. Where a file has no banner at all this says nothing — the
        //    directory holds at least one test file whose header never had one.
        if (isSupport) {
          expect(src, `${name}: missing the integration-support banner`)
            .toContain(SUPPORT_BANNER)
          expect(src, `${name}: a support file must not claim to be a test`)
            .not.toContain(TEST_BANNER)
          supportBanners++
        } else if (src.includes('ISOLATED POSTGRESQL TENANCY GATE')) {
          expect(src, `${name}: banner present but not the integration-test form`)
            .toContain(TEST_BANNER)
          expect(src, `${name}: a test file must not use the support banner`)
            .not.toContain(SUPPORT_BANNER)
          testBanners++
        }
      }

      // Non-vacuity for the loop body: the branches must actually have run.
      expect(supportBanners, 'no support banner was checked').toBe(3)
      expect(testBanners, 'implausibly few test banners were checked')
        .toBeGreaterThanOrEqual(13)
    })

    it('ROUND 9: the correction validator is granted to the importer ALONE', () => {
      // The 2026-09-07 fresh gate: enforce_correction_integrity() fires without
      // an EXECUTE check (triggers never check one), but its body calls
      // validate_correction_group(gid) ORDINARILY, which does. After 017's
      // blanket revoke the validator was owner-only, so every importer
      // correction died at SET CONSTRAINTS with 42501 before the integrity rule
      // could run. The repair is one grant, to one role, with no change of
      // security context.
      // 014 defines both correction functions; 015 replaces the validator.
      const m014 = sql('014_investment_ledger_remediation.sql')
      const m015 = sql('015_investment_ledger_series_and_corrections.sql')
      const GRANT = /GRANT EXECUTE ON FUNCTION investment_ledger\.validate_correction_group\(UUID\)\s*\n\s*TO ai_capital_importer;/

      // 1. The exact grant exists, once.
      expect(m017, 'the importer-only validator grant is missing').toMatch(GRANT)
      expect([...m017.matchAll(/validate_correction_group\(UUID\)/g)],
        'the validator grant must appear exactly once').toHaveLength(1)

      // 2. It comes AFTER the blanket PUBLIC revoke — before it, the sweep
      //    would simply erase it.
      const revokeAt = m017.indexOf('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA investment_ledger FROM PUBLIC;')
      const grantAt = m017.search(GRANT)
      expect(revokeAt, 'the blanket function revoke is gone').toBeGreaterThan(-1)
      expect(grantAt, 'the validator grant is gone').toBeGreaterThan(-1)
      expect(grantAt, 'the validator grant precedes the blanket revoke that would erase it')
        .toBeGreaterThan(revokeAt)

      // 3. It is issued while the EFFECTIVE ROLE is ai_capital_owner. Only a
      //    function's owner may grant EXECUTE on it, and this file switches
      //    roles explicitly — an owner-owned grant issued under the authority
      //    would raise 42501 and roll the migration back.
      const roleSwitches = [...m017.matchAll(/SET LOCAL ROLE (\w+);/g)]
        .map(m => [m.index!, m[1]] as const)
      const effective = roleSwitches.filter(([at]) => at < grantAt).pop()
      expect(effective, 'no SET LOCAL ROLE precedes the validator grant').toBeTruthy()
      expect(effective![1], 'the validator grant is issued under the wrong migration role')
        .toBe('ai_capital_owner')

      // 4. Neither correction function becomes SECURITY DEFINER. This is the
      //    property the grant exists to PRESERVE: a definer validator would
      //    read `transactions` as the owner and escape the caller's RLS.
      for (const fn of ['validate_correction_group', 'enforce_correction_integrity']) {
        const decl = new RegExp(
          `(CREATE|CREATE OR REPLACE) FUNCTION investment_ledger\\.${fn}\\b[\\s\\S]{0,400}?AS \\$\\$`)
        for (const src of [m014, m015, m017]) {
          const m = decl.exec(src)
          if (!m) continue
          expect(m[0], `${fn} must remain SECURITY INVOKER`).not.toMatch(/SECURITY DEFINER/)
        }
      }

      // 5. The trigger function is granted to nobody, ever. Matched as a real
      //    `GRANT ... ON FUNCTION ...` on comment-stripped text: a loose window
      //    match spans unrelated statements and prose and reports a grant that
      //    is not there.
      const code = (src: string) => src.split('\n')
        .filter(l => !l.trimStart().startsWith('--')).join('\n')
      for (const src of [m014, m015, m017]) {
        expect(code(src), 'enforce_correction_integrity must not be granted to any role')
          .not.toMatch(/GRANT\s+[\w ,()]*ON\s+FUNCTION\s+investment_ledger\.enforce_correction_integrity/i)
      }

      // 6. No broader grant on the validator: not PUBLIC, not the other logins.
      const stmts = code(m017)
      for (const role of ['PUBLIC', 'ai_capital_agent', 'ai_capital_app',
                          'ai_capital_operator', 'ai_capital_migrator']) {
        expect(stmts, `the validator must not be granted to ${role}`)
          .not.toMatch(new RegExp(`validate_correction_group\\(UUID\\)\\s*\\n?\\s*TO ${role}`))
      }
      // ... and the blanket revoke is not softened into a grant to PUBLIC.
      expect(stmts, 'EXECUTE must not be granted to PUBLIC on this schema')
        .not.toMatch(/GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA investment_ledger TO PUBLIC/)
    })

    it('FINAL-B: every tenant-to-tenant reference is workspace-scoped', () => {
      // THE ENUMERATION GUARD. Three self-links shipped as id-only foreign keys
      // (`import_batches.changed_from_batch`, `account_resolutions.supersedes_id`,
      // `document_verification_events.supersedes_id`). RLS does not catch those:
      // the child row's OWN tenancy is correct, so the policy is satisfied and a
      // principal authorized in both workspaces could name another tenant's row
      // as its parent. Only the key can refuse it.
      //
      // Enumerated rather than spot-checked, so a FOURTH id-only reference
      // cannot appear quietly. Any column-level `REFERENCES investment_ledger.x(id)`
      // anywhere in the tenant schema is rejected outright.
      const m013 = sql('013_investment_ledger.sql')
      const m014 = sql('014_investment_ledger_remediation.sql')
      const m015 = sql('015_investment_ledger_series_and_corrections.sql')
      const code = (src: string) => src.split('\n')
        .filter(l => !l.trimStart().startsWith('--')).join('\n')
      const tenantSql = [m013, m014, m015, m017].map(code).join('\n')

      // 1. NO id-only reference into a TENANT table survives anywhere.
      //    `instruments` is the one legitimate exception: it is global
      //    reference data, carries no workspace_id and no RLS, and is excluded
      //    from the tenant table list by 017 for exactly that reason. A
      //    composite key to it is not expressible, so it is named here rather
      //    than pattern-matched away.
      const GLOBAL_TABLES = ['instruments']
      const idOnly = [...tenantSql.matchAll(
        /REFERENCES\s+investment_ledger\.(\w+)\s*\(\s*id\s*\)/g)]
        .map(m => m[1])
        .filter(t => !GLOBAL_TABLES.includes(t))
      expect(idOnly, 'an id-only reference into a tenant table is back').toEqual([])
      // Non-vacuity: the scan must actually have found references to classify,
      // or a broken regex would read as "no id-only references".
      expect([...tenantSql.matchAll(/REFERENCES\s+investment_ledger\./g)].length,
        'the reference scan found nothing at all').toBeGreaterThan(3)

      // 2. The three corrected self-links are composite, naming (workspace_id, id).
      const required: Array<readonly [string, string, string]> = [
        ['changed_from_batch', 'import_batches', m013],
        ['supersedes_id', 'account_resolutions', m014],
        ['supersedes_id', 'document_verification_events', m015],
      ]
      for (const [column, parent, src] of required) {
        const fk = new RegExp(
          `FOREIGN KEY \\(workspace_id, ${column}\\)\\s*\\n\\s*` +
          `REFERENCES investment_ledger\\.${parent} \\(workspace_id, id\\)`)
        expect(code(src), `${parent}.${column} is not a composite foreign key`).toMatch(fk)
      }

      // 3. Nullable parents are preserved — a first batch supersedes nothing,
      //    and a plain 'resolve'/'verified' event has no predecessor.
      for (const [column, , src] of required) {
        const decl = new RegExp(`\\b${column}\\s+UUID\\s*,`)
        expect(code(src), `${column} must stay nullable`).toMatch(decl)
        expect(code(src), `${column} must not have become NOT NULL`)
          .not.toMatch(new RegExp(`\\b${column}\\s+UUID\\s+NOT NULL`))
      }

      // 4. Single-successor uniqueness is scoped by workspace, not global.
      expect(code(m013) + code(m015), 'import_batches single-successor lost its scope')
        .toMatch(/UNIQUE \(workspace_id, changed_from_batch\)/)
      for (const src of [m014, m015]) {
        expect(code(src), 'supersedes_id uniqueness lost its workspace scope')
          .toMatch(/UNIQUE \(workspace_id, supersedes_id\)/)
      }
      // The bare global UNIQUE on the column must not return.
      expect(tenantSql, 'a global UNIQUE on supersedes_id is back')
        .not.toMatch(/supersedes_id\s+UUID\s+UNIQUE/)

      // 5. Same-series validation survives, and its lookup is workspace-scoped
      //    rather than relying on RLS to hide the other tenant's batch.
      expect(code(m015), 'same-series validation was lost')
        .toMatch(/supersession is only defined within one series/)
      expect(code(m015), 'the series lookup is not workspace-scoped')
        .toMatch(/WHERE id = NEW\.changed_from_batch AND workspace_id = NEW\.workspace_id/)
      for (const src of [m014, m015]) {
        expect(code(src), 'a supersession lookup is not workspace-scoped')
          .toMatch(/WHERE id = NEW\.supersedes_id AND workspace_id = NEW\.workspace_id/)
      }
    })

    it('FINAL-C: object_key rejects the two traversal names and keeps ordinary dots', () => {
      // The comment claimed "'..' is unrepresentable" while the pattern's third
      // component accepted a filename of exactly `.` or `..`.
      expect(m017, 'the disproven unrepresentable claim is back')
        .not.toMatch(/'\.\.' is unrepresentable/)
      expect(m017, 'the traversal CHECK is missing')
        .toMatch(/CONSTRAINT document_blobs_object_key_no_traversal\s*\n\s*CHECK \(split_part\(object_key, '\/', 3\) NOT IN \('\.', '\.\.'\)\)/)
      // The shape rule must survive: three components, dots still legal in a
      // filename, so real extensions keep working.
      expect(m017, 'the object_key shape rule was lost')
        .toMatch(/\^\[0-9a-f-\]\{36\}\/\[a-z0-9_\]\+\/\[A-Za-z0-9\._-\]\{1,200\}\$/)
      // And the workspace-prefix trigger is untouched.
      expect(m017).toMatch(/object_key must begin with its own workspace id/)
      expect(m017).toMatch(/CREATE TRIGGER object_key_is_workspace_scoped/)

      // NON-VACUITY: the rule, applied here to representative keys.
      const ws = '00000000-0000-4000-8000-000000000001'
      const shape = /^[0-9a-f-]{36}\/[a-z0-9_]+\/[A-Za-z0-9._-]{1,200}$/
      const accepted = (k: string) => shape.test(k) && !['.', '..'].includes(k.split('/')[2])
      expect(accepted(`${ws}/statements/.`), '"." must be rejected').toBe(false)
      expect(accepted(`${ws}/statements/..`), '".." must be rejected').toBe(false)
      expect(accepted(`${ws}/statements/2026-01_report.v2.pdf`),
        'an ordinary dotted filename must be accepted').toBe(true)
      // ... and the old pattern alone would have let both traversals through,
      // which is why the separate CHECK is required.
      expect(shape.test(`${ws}/statements/..`),
        'the shape rule alone accepts "..", hence the second CHECK').toBe(true)
    })

    it('FINAL-A: ledger INSERT is a migration-window privilege', () => {
      // 010 granted `SELECT, INSERT` permanently and 090 retained both, so a
      // CLOSED window still admitted a row into db.schema_migrations — the one
      // table every downstream check trusts to say what the schema is.
      const b = ops('bootstrap/010_database_bootstrap.sql')
      const l = ops('bootstrap/090_post_migration_lockdown.sql')
      expect(b, 'the permanent SELECT, INSERT grant is back')
        .not.toMatch(/GRANT SELECT, ?INSERT ON db\.schema_migrations/)
      expect(b).toMatch(/GRANT SELECT ON db\.schema_migrations TO ai_capital_migrator;/)
      expect(b).toMatch(/GRANT INSERT ON db\.schema_migrations TO ai_capital_migrator;/)
      expect(l, 'lockdown does not revoke ledger INSERT')
        .toMatch(/REVOKE INSERT ON db\.schema_migrations FROM ai_capital_migrator;/)
      expect(l, 'lockdown must keep ledger SELECT')
        .not.toMatch(/REVOKE[^;]*SELECT[^;]*ON db\.schema_migrations/)
      expect(l, 'lockdown must not re-grant what it revokes')
        .not.toMatch(/GRANT[^;]*INSERT[^;]*ON db\.schema_migrations/)
    })

    it('the honest guarantee is recorded, not an overclaim about empty scans', () => {
      // The one thing this correction must NOT be described as. RLS is not
      // evaluated for rows that are never scanned, so the migration has to say
      // so rather than promise a raise on an empty relation.
      expect(m017).toMatch(/per SCANNED ROW/)
      expect(m017).toMatch(/NOT a claim that/)
    })
  })

  it('each policy uses its OWN capability set', () => {
    // The operation split: SELECT/INSERT/lock must not share one variable again.
    const pairs = [...m017.matchAll(/CREATE POLICY (\w+)[\s\S]*?\$f\$, t, (\w+)\)/g)]
      .map(m => [m[1], m[2]] as const)
    expect(new Map(pairs).get('importer_read')).toBe('select_caps')
    expect(new Map(pairs).get('importer_insert')).toBe('insert_caps')
    expect(new Map(pairs).get('importer_lock_only')).toBe('lock_caps')
  })

  it('the lock-only policy still denies every real update', () => {
    const lock = /CREATE POLICY importer_lock_only[\s\S]*?\$f\$, t, lock_caps\)/.exec(m017)?.[0]
    expect(lock).toMatch(/WITH CHECK \(false\)/)
  })

  it('only accounts and document_file_variants have a wider SELECT than INSERT', () => {
    // Derived from the file, then checked against the written-out expectation.
    const setOf = (variable: string) => {
      const block = new RegExp(`${variable} := CASE t([\\s\\S]*?)END;`).exec(m017)![1]
      const out = new Map<string, string>()
      for (const m of block.matchAll(/WHEN '(\w+)'\s*THEN\s+(.+)/g)) out.set(m[1], m[2].trim())
      return out
    }
    const sel = setOf('select_caps')
    const ins = setOf('insert_caps')
    expect(sel.get('accounts')).toContain("''reconciliation''")
    expect(ins.get('accounts')).not.toContain("''reconciliation''")
    expect(sel.get('document_file_variants')).toContain("''document-verification''")
    expect(ins.get('document_file_variants')).not.toContain("''document-verification''")
    expect(m017).toMatch(/lock_caps := select_caps;/)

    const diverging = [...sel.keys()].filter(t => sel.get(t) !== ins.get(t))
    expect(diverging.sort()).toEqual(['accounts', 'document_file_variants'])
  })
})

describe('ai_capital_agent holds nothing in the ledger', () => {
  const m017 = sql('017_ledger_views_rls_grants.sql')
  const code = m017.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

  it('017 creates no agent policy', () => {
    expect(code).not.toMatch(/CREATE POLICY agent_read/)
    expect(code).not.toMatch(/TO ai_capital_agent/)
  })

  it('017 issues no grant to the agent at all', () => {
    expect(code, 'the agent must receive no ledger grant').not.toMatch(/GRANT[^;]*ai_capital_agent/)
  })

  it('the migration asserts the absence itself', () => {
    expect(m017).toMatch(/ai_capital_agent still holds USAGE on investment_ledger/)
    expect(m017).toMatch(/ai_capital_agent holds privileges on % ledger relation\(s\)/)
  })
})

describe('017 proves every policy names ONLY the importer', () => {
  const m017 = sql('017_ledger_views_rls_grants.sql')

  // Naming the agent was only the case that happened to be wrong. A policy with
  // two roles, or one naming the app/operator/migrator — or none at all, which
  // makes polroles contain OID 0 for PUBLIC — would be just as wrong.

  it('asserts each policy has exactly one role', () => {
    expect(m017).toMatch(/cardinality\(p\.polroles\) <> 1/)
  })

  it('asserts that role is ai_capital_importer', () => {
    expect(m017).toMatch(/p\.polroles\[1\] <> 'ai_capital_importer'::regrole/)
  })

  it('says why PUBLIC is the sharp case', () => {
    // The comment is the only place a reader learns that oid 0 means everyone.
    expect(m017).toMatch(/PUBLIC is oid 0|contains OID 0, which means EVERY role/)
  })

  it('asserts name and command agree, for all three policies', () => {
    const block = /p\.polcmd <> CASE p\.polname[\s\S]*?END;/.exec(m017)?.[0]
    expect(block, 'the name/command postcondition is gone').toBeTruthy()
    expect(block).toMatch(/'importer_read'\s+THEN 'r'/)
    expect(block).toMatch(/'importer_insert'\s+THEN 'a'/)
    expect(block).toMatch(/'importer_lock_only' THEN 'w'/)
    expect(block, 'an unknown policy name must not default to a valid command')
      .toMatch(/ELSE '\?'/)
  })

  it('asserts every tenant table carries all THREE named policies', () => {
    // The count-of-three check alone would accept three policies of one kind.
    for (const name of ['importer_read', 'importer_insert', 'importer_lock_only']) {
      expect(m017, `${name} is not required per table`)
        .toMatch(new RegExp(`p\\.polname = '${name}'`))
    }
    expect(m017).toMatch(/are missing one of the three named policies/)
  })

  it('the four postconditions all raise, so none can pass silently', () => {
    for (const message of [
      'do not name exactly ai_capital_importer',
      'unexpected name/command pairing',
      'missing one of the three named policies',
      'name ai_capital_agent; it must have none',
    ]) {
      expect(m017, `no RAISE for: ${message}`).toContain(message)
    }
  })
})

describe('the SELECT/LOCK matrix cannot pass against an empty table', () => {
  // A STATIC CONTRACT OVER A RUNTIME TEST.
  //
  // The matrix's allowed cells used to assert only that the query did not
  // throw. RLS HIDES rows rather than raising, so a SELECT over an empty table
  // and a SELECT the policy silently filtered to nothing are indistinguishable
  // from "no error" — and a `FOR UPDATE` that locks nothing raises nothing
  // either. Every allowed cell could have passed while proving neither
  // visibility nor locking.
  //
  // The fix is behavioural, so the guard against regressing it has to be too:
  // these assertions fail if the positive-row checks are removed, which is what
  // makes the runtime matrix trustworthy without running it.
  const matrix = readFileSync(
    join(HERE, '..', 'integration', 'tenancy', 'capability-matrix.test.ts'), 'utf-8')
  const graph = readFileSync(
    join(HERE, '..', 'integration', 'tenancy', 'graph.ts'), 'utf-8')

  /** The seventeen, written out here so the check does not read its expectation
   *  from the file it is checking. */
  const TENANT_TABLES_EXPECTED = [
    'accounts', 'instrument_aliases', 'import_batches', 'raw_import_rows',
    'logical_documents', 'document_file_variants', 'document_extractions',
    'document_blobs', 'document_verification_events', 'transaction_groups',
    'transactions', 'transaction_amount_components', 'transaction_document_links',
    'validation_findings', 'reconciliation_cases', 'reconciliation_case_events',
    'account_resolutions',
  ]

  it('the allowed SELECT asserts a POSITIVE visible-row count', () => {
    expect(matrix, 'an error-only SELECT assertion is back')
      .toMatch(/if \(rows\[0\]\.n < 1\) throw new Error\(`visible-row count was/)
  })

  it('the allowed FOR UPDATE asserts a row was ACTUALLY LOCKED', () => {
    expect(matrix, 'an error-only lock assertion is back')
      .toMatch(/if \(\(res\.rowCount \?\? 0\) < 1\) throw new Error\('locked no row'\)/)
  })

  it('each cell first proves the row exists PHYSICALLY, as the admin', () => {
    // As the admin, which bypasses RLS — so it measures what is there, not what
    // the role under test can see.
    expect(matrix).toMatch(/const physical = await admin\.query/)
    expect(matrix).toMatch(/nothing to see, cell is vacuous/)
  })

  it('denied cells run against the same non-empty workspace', () => {
    // Both branches read `vis`, so a denial cannot pass merely because
    // PostgreSQL skipped an RLS predicate over an empty scan.
    const cell = /it\(`\$\{allowed \? 'may SELECT and LOCK'[\s\S]*?^        \}\)/m.exec(matrix)?.[0]
    expect(cell, 'the SELECT/LOCK cell was not found').toBeTruthy()
    expect(cell).toMatch(/const vis = visWorkspaces\.get\(capability\)!/)
    expect((cell!.match(/vis\.id/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('visibility uses SEPARATE workspaces, so INSERT starting state is untouched', () => {
    expect(matrix).toMatch(/visWorkspaces = new Map<Capability, Workspace>/)
    expect(matrix).toMatch(/fillEveryTenantTable: true/)
    // …and those workspaces still hold exactly one capability afterwards.
    expect(matrix).toMatch(/still holds exactly one live capability after the setup window closed/)
  })

  it('the fixture fills ALL SEVENTEEN tenant tables', () => {
    expect(graph).toMatch(/export const TENANT_TABLES/)
    const list = /export const TENANT_TABLES = \[([\s\S]*?)\] as const/.exec(graph)![1]
    const declared = [...list.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    expect(declared.sort()).toEqual([...TENANT_TABLES_EXPECTED].sort())
    // SCOPED TO THE FILL FUNCTION'S BODY, not the whole file. An earlier
    // version searched all of graph.ts, where `tableInserts()` also names every
    // table — so deleting a table from the visibility fill left the guard
    // passing against the INSERT-probe definitions instead. A check that reads
    // the wrong region is worse than none: it reports coverage it never had.
    const fill = /async function fillRemainingTenantTables\([\s\S]*?\n}/.exec(graph)?.[0]
    expect(fill, 'fillRemainingTenantTables is gone').toBeTruthy()

    const seededByGraph = ['accounts', 'import_batches', 'raw_import_rows',
                           'logical_documents', 'document_file_variants',
                           'transaction_groups', 'transactions', 'reconciliation_cases']
    const seededByFill = TENANT_TABLES_EXPECTED.filter(t => !seededByGraph.includes(t))
    expect(seededByFill).toHaveLength(9)
    for (const table of seededByFill) {
      expect(fill!, `${table} is not filled by the visibility fixture`)
        .toContain(`INSERT INTO investment_ledger.${table}`)
    }
    // …and the parent graph really does cover the other eight.
    const seed = /export async function seedGraphAndRestrict\([\s\S]*?\n}/.exec(graph)?.[0]
    for (const table of seededByGraph) {
      expect(seed!, `${table} is not seeded by the parent graph`)
        .toContain(`INSERT INTO investment_ledger.${table}`)
    }
  })

  it('the fixture explains why filling is opt-in', () => {
    // Three of those rows change what a later INSERT may legally do; a reader
    // who does not know that will "simplify" the two workspaces into one.
    expect(graph).toMatch(/CHANGE WHAT A LATER INSERT MAY DO/)
  })
})

describe('the deferred correction trigger is declared DEFERRABLE', () => {
  // The runtime test proves the trigger fires at SET CONSTRAINTS ALL IMMEDIATE.
  // This proves the declaration that makes that possible, so "made
  // non-deferrable" is caught without a database.
  const m014 = sql('014_investment_ledger_remediation.sql')

  it.each(['enforce_correction_integrity_tx', 'enforce_correction_integrity_amounts'])(
    '%s is an AFTER INSERT CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED', name => {
      const block = new RegExp(
        `CREATE CONSTRAINT TRIGGER ${name}\\s*\\nAFTER INSERT ON investment_ledger\\.\\w+` +
        `\\s*\\nDEFERRABLE INITIALLY DEFERRED`)
      expect(m014, `${name} is not a deferred constraint trigger`).toMatch(block)
    })

  it('the correction-integrity error the runtime test asserts really exists', () => {
    // If this message is reworded, the runtime assertion must be updated with
    // it — otherwise that test would silently start accepting a different
    // failure.
    expect(m014).toContain('must contain exactly one original transaction, found %')
  })
})

describe('four view grants, five withheld', () => {
  const m017 = sql('017_ledger_views_rls_grants.sql')
  const code = m017.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

  const GRANTED = [
    'current_import_batches', 'reconciliation_case_current_state',
    'active_account_resolutions', 'active_document_verification_events',
  ]
  const WITHHELD = [
    'current_transactions', 'economic_amount_components', 'effective_accounts',
    'transaction_effective_accounts', 'current_document_verification',
  ]

  it('exactly the four traced views are granted, to the importer alone', () => {
    const grants = [...code.matchAll(
      /GRANT SELECT ON investment_ledger\.(\w+) TO (\w+);/g)]
      .filter(m => GRANTED.includes(m[1]) || WITHHELD.includes(m[1]))
    expect(grants.map(m => m[1]).sort()).toEqual([...GRANTED].sort())
    for (const m of grants) expect(m[2]).toBe('ai_capital_importer')
  })

  it('no blanket grant is used', () => {
    expect(code).not.toMatch(/GRANT[^;]*ON ALL TABLES[^;]*TO ai_capital/)
    expect(code).not.toMatch(/GRANT[^;]*ON ALL VIEWS/)
  })

  it.each(WITHHELD)('%s is withheld and the reason is written down', view => {
    expect(code, `${view} is granted`).not.toMatch(
      new RegExp(`GRANT SELECT ON investment_ledger\\.${view}\\b`))
    const rationale = new RegExp(`${view}\\n--\\s+(NO CONSUMER|CAPABILITY-INCOHERENT)`)
    expect(m017, `${view} has no recorded justification`).toMatch(rationale)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E. The legacy series predicate.
// ─────────────────────────────────────────────────────────────────────────────
describe('the one-root index exempts the reserved legacy series in SQL, not prose', () => {
  it('the predicate names both halves of the rule', () => {
    expect(sql('016_investment_ledger_enforcement.sql')).toMatch(
      /CREATE UNIQUE INDEX import_batches_one_root_per_series\s*\n\s*ON investment_ledger\.import_batches \(workspace_id, series_key\)\s*\n\s*WHERE changed_from_batch IS NULL\s*\n\s*AND series_key <> 'legacy:unclassified';/)
  })

  it('the constraint that closes the key to NEW inserts is preserved, and NOT VALID', () => {
    // The residue is append-only history: exempting it must not become
    // permission to create more of it.
    expect(sql('016_investment_ledger_enforcement.sql')).toMatch(
      /ADD CONSTRAINT import_batches_no_new_legacy_series\s*\n\s*CHECK \(series_key <> 'legacy:unclassified'\) NOT VALID;/)
  })

  it('the reserved key is still the column default from 015', () => {
    expect(sql('015_investment_ledger_series_and_corrections.sql'))
      .toContain("ADD COLUMN series_key TEXT NOT NULL DEFAULT 'legacy:unclassified'")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F. The publication advisory lock.
// ─────────────────────────────────────────────────────────────────────────────
describe('publication is serialized per workspace AND series', () => {
  const publish = ts('src/publish.ts')

  it('uses the two-key advisory lock with the workspace first', () => {
    expect(publish).toMatch(
      /pg_advisory_xact_lock\(hashtext\(\$1\), hashtext\(\$2\)\)'\s*,\s*\n?\s*\[`investment-ledger-workspace:\$\{ws\.workspaceId\}`, `investment-ledger-series:\$\{series\}`\]/)
  })

  it('no single-key lock survives anywhere', () => {
    expect(publish).not.toMatch(/pg_advisory_xact_lock\(hashtext\(\$1\)\)/)
    expect(publish).not.toMatch(/pg_advisory_lock\(/)   // session-scoped: would outlive the transaction
  })

  it('the lock is transaction-scoped, so it is released by COMMIT and ROLLBACK alike', () => {
    expect(publish).toContain('pg_advisory_xact_lock')
    expect(publish).not.toContain('pg_advisory_unlock')
  })

  it('the workspace is also in every uniqueness key the lock protects', () => {
    // The lock only has to be right because the constraints beneath it are
    // per-workspace too; a global unique key would make cross-tenant contention
    // a correctness problem rather than a throughput one.
    expect(allSql).toContain('UNIQUE (workspace_id, source_kind, source_sha256)')
    expect(sql('016_investment_ledger_enforcement.sql'))
      .toContain('ON investment_ledger.import_batches (workspace_id, series_key)')
  })
})
