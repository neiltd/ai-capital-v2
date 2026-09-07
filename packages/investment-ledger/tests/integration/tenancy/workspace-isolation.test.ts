import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import {
  connectAs, ensurePrincipals, seedWorkspace, grantCapability, beginAuthorized,
  beginWithForgedContext, begin, commit, rollback, probe, probeDetached, terminateGrant,
  INSUFFICIENT_PRIVILEGE, FK_VIOLATION, RAISE_EXCEPTION,
  type Principals, type Workspace,
} from './fixture.js'
import { hex64, seedGraphAndRestrict } from './graph.js'
import { describeInPhase } from './phase.js'

// TWO-WORKSPACE READ, INSERT AND COMPOSITE-FK ISOLATION.
//
// INTEGRATION TEST — RUN ONLY BY THE ISOLATED POSTGRESQL TENANCY GATE.
//
// THE DESIGN HAS TWO INDEPENDENT BOUNDARIES and this file tests both, because
// the whole point of having two is that a mistake in one must not silently
// disable the other:
//
//   1. ROW-LEVEL SECURITY. A policy that resolves the caller from session_user
//      and checks it against the grant table. This fails if a policy is dropped
//      or a GUC is trusted on its own.
//   2. COMPOSITE FOREIGN KEYS on (workspace_id, id). Enforced by the planner.
//      This catches a row whose own workspace_id is legitimate but whose parent
//      belongs to somebody else — the exact shape of a record-fusion bug, and
//      one RLS cannot see.
//
// ONE PRINCIPAL throughout, granted in alpha and not in beta. Using one rather
// than two proves the boundary is the GRANT, not the identity.

describeInPhase('post-lockdown', 'two workspaces cannot see or touch each other', () => {
  let admin: Client
  let importer: Client
  let operator: Client
  let principals: Principals
  let alpha: Workspace
  let beta: Workspace
  let alphaGrant: string
  let betaGrant: string | null = null
  /** The alpha account row seeded below, so later tests can assert against a
   *  relation that is provably NON-EMPTY. An RLS predicate is never evaluated
   *  over an empty scan, so a denial test on an empty table proves nothing. */
  let isolationAccountId: string | null = null

  beforeAll(async () => {
    admin = await connectAs('admin')
    importer = await connectAs('importer')
    operator = await connectAs('operator')
    principals = await ensurePrincipals(admin)
    alpha = await seedWorkspace(admin, 'isolation-alpha')
    beta = await seedWorkspace(admin, 'isolation-beta')
    alphaGrant = await grantCapability(
      admin, alpha, principals.importer, 'archive-import', principals.grantor)
  })

  afterAll(async () => {
    await operator?.end()
    await importer?.end()
    await admin?.end()
  })

  it('the fixture is set up as claimed: granted in alpha, not in beta', async () => {
    const { rows } = await admin.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM identity.workspace_service_grants
        WHERE principal_id = $1 AND workspace_id = ANY($2)
          AND effective_range @> now()`,
      [principals.importer.id, [alpha.id, beta.id]])
    expect(rows.map(r => r.workspace_id)).toEqual([alpha.id])
    expect(alphaGrant).toBeTruthy()
  })

  it('authorizing into a workspace with no grant raises 42501', async () => {
    const result = await probeDetached(importer, () =>
      importer.query(
        'SELECT identity.authorize_service_workspace_any($1, $2::identity.service_capability[])',
        [beta.id, ['archive-import']]))
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
    expect(result.message).toMatch(/holds none of/)
  })

  it('a row written in alpha is visible from alpha and invisible from beta', async () => {
    const actor = await beginAuthorized(importer, alpha.id, ['archive-import'])
    const written = await importer.query<{ id: string }>(
      `INSERT INTO investment_ledger.accounts
         (workspace_id, actor_principal_id, account_key, platform, display_name,
          resolution_status, unresolved_reason)
       VALUES ($1,$2,$3,'tenancy',$3,'unresolved','isolation fixture') RETURNING id`,
      [alpha.id, actor, `isolation-${Date.now()}`])
    await commit(importer)
    const accountId = written.rows[0].id
    isolationAccountId = accountId

    // THE POSITIVE HALF, and it is not decoration. "Invisible from beta" is
    // satisfied just as well by a predicate that hides the row from EVERYONE —
    // which is precisely what the pre-Round-7 principal/workspace comparison
    // did, and it passed a cross-workspace test while breaking the product. So
    // the same row is read back under its OWN workspace first.
    await beginAuthorized(importer, alpha.id, ['archive-import'])
    try {
      const { rows } = await importer.query(
        'SELECT id FROM investment_ledger.accounts WHERE id = $1', [accountId])
      expect(rows.map((r: { id: string }) => r.id),
        "alpha's own row must be visible under alpha context").toEqual([accountId])
    } finally {
      await rollback(importer)
    }

    // Grant beta so the read is refused by ISOLATION rather than by having no
    // context at all — a distinction the next assertion depends on.
    betaGrant = await grantCapability(
      admin, beta, principals.importer, 'archive-import', principals.grantor)
    await beginAuthorized(importer, beta.id, ['archive-import'])
    try {
      const { rows } = await importer.query(
        'SELECT id FROM investment_ledger.accounts WHERE id = $1', [accountId])
      expect(rows, "alpha's row must not be visible under beta context").toEqual([])
    } finally {
      await rollback(importer)
    }
  })

  it('a SELECT with no context at all returns nothing rather than everything', async () => {
    // Default-deny. The failure this rules out is a policy whose USING clause
    // evaluates to NULL and is treated as permissive.
    const result = await probeDetached(importer, async () => {
      const { rows } = await importer.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM investment_ledger.accounts')
      if (rows[0].n !== 0) throw new Error(`no context returned ${rows[0].n} rows`)
    })
    // Either the authorizer refuses a NULL workspace, or the count is zero.
    // Anything else — including a thrown "returned N rows" — is a failure.
    expect(result.code === null || result.code === INSUFFICIENT_PRIVILEGE,
      `unexpected: ${result.code} ${result.message}`).toBe(true)
  })

  it('a FORGED GUC does not grant access to another workspace', async () => {
    // The whole trust model in one test. `app.workspace_id` is a SELECTOR that
    // the caller sets; the grant table is the authority. Beta's grant is
    // revoked first so the forgery has something real to try to bypass.
    await terminateGrant(operator, betaGrant!, 'revoke', 'isolation test: forged-GUC probe')
    betaGrant = null

    // CLEANUP IN `finally`, and the 2026-09-06 gate is why. When the two
    // expectations below failed, the trailing `await rollback(importer)` never
    // ran, the fixture's client stayed marked in-transaction, and the NEXT TWO
    // tests died in `begin(): a transaction is already open on this client` —
    // reporting a fixture error for a defect that lived here. `rollback` is
    // tolerant of an already-aborted transaction, so it is always safe here.
    await beginWithForgedContext(importer, beta.id, principals.importer.id)
    try {
      const result = await probe(importer, () =>
        importer.query('SELECT count(*) FROM investment_ledger.accounts'))
      expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(result.message).toMatch(/holds none of/)
    } finally {
      await rollback(importer)
    }
  })

  it('a child row cannot name a parent in another workspace', async () => {
    // THE COMPOSITE FOREIGN KEY on its own terms. The insert below carries a
    // legitimate workspace_id for the child and a batch_id belonging to alpha.
    // RLS cannot object: the row's own tenancy is correct. The (workspace_id,
    // id) key is what refuses it, and it is enforced by the planner rather than
    // by a policy — which is why it survives a policy mistake.
    const actor = await beginAuthorized(importer, alpha.id, ['archive-import'])
    const batch = await importer.query<{ id: string }>(
      `INSERT INTO investment_ledger.import_batches
         (workspace_id, actor_principal_id, series_key, source_kind, source_name,
          source_sha256, importer_version, row_count, status)
       VALUES ($1,$2,$3,'archive_csv','fk-probe',$4,'tenancy-suite',0,'published') RETURNING id`,
      [alpha.id, actor, `probe:fk-${Date.now()}`, hex64()])
    await commit(importer)

    const regrant = await grantCapability(
      admin, beta, principals.importer, 'archive-import', principals.grantor)
    await beginAuthorized(importer, beta.id, ['archive-import'])
    try {
      const result = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.raw_import_rows
             (workspace_id, actor_principal_id, batch_id, row_number, raw_sha256, raw_payload)
           VALUES ($1,$2,$3,2,$4,'{}'::jsonb)`,
          [beta.id, principals.importer.id, batch.rows[0].id, hex64()]))
      expect(result.code, `a cross-tenant parent must be a foreign key violation: ${result.message}`)
        .toBe(FK_VIOLATION)
    } finally {
      // Both the transaction AND the temporary grant must be released even on
      // failure: a surviving beta grant would silently weaken every later test
      // in this file, which asserts on beta being unauthorized.
      await rollback(importer)
      await terminateGrant(operator, regrant, 'revoke', 'isolation test: composite-FK probe done')
    }
  })

  it('an INSERT naming a workspace the caller is not in is refused', async () => {
    await beginAuthorized(importer, alpha.id, ['archive-import'])
    try {
      const result = await probe(importer, () =>
        importer.query(
          `INSERT INTO investment_ledger.accounts
             (workspace_id, actor_principal_id, account_key, platform, display_name,
              resolution_status, unresolved_reason)
           VALUES ($1,$2,'smuggled','tenancy','smuggled','unresolved','x')`,
          [beta.id, principals.importer.id]))
      expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(result.message).toMatch(/holds none of/)
    } finally {
      await rollback(importer)
    }
  })

  // ───────────────────────────────────────────────────────────────────────
  // ROUND 8: authorization is proven BEFORE the row is compared.
  //
  // The 2026-09-06 gate found the Round-7 predicate short-circuiting. Written
  // as `workspace_id = <guc> AND authorize(...) IS NOT NULL`, the comparison is
  // false for every row in another workspace, so PostgreSQL skipped the second
  // conjunct and the THROWING authorizer never ran: a forged workspace returned
  // 0 rows instead of raising. The predicate is now a CASE whose WHEN condition
  // is the authorizer, so the row column is unreachable until it has returned.
  //
  // WHAT THESE TESTS CAN AND CANNOT PROVE. RLS is only evaluated for rows that
  // are actually scanned, so every assertion below runs against a relation that
  // is checked to be NON-EMPTY first. An empty table evaluates no qual and
  // would pass a denial test for the wrong reason — the same non-vacuity trap
  // this suite has hit before.
  // ───────────────────────────────────────────────────────────────────────
  describe('authorization is evaluated before the workspace comparison', () => {
    it('the ledger table under test is populated, so a qual really is evaluated', async () => {
      expect(isolationAccountId, 'the alpha fixture row must have been written').toBeTruthy()
      const { rows } = await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM investment_ledger.accounts')
      if (rows[0].n < 1) {
        throw new Error('investment_ledger.accounts is empty; every denial below would be vacuous')
      }
    })

    it('a forged unauthorized workspace RAISES on SELECT rather than returning nothing', async () => {
      // The regression test for the gate's finding, stated as the difference it
      // actually observed: 42501 with the authorizer's own message, NOT a quiet
      // empty result. `beta` has no live grant at this point.
      await beginWithForgedContext(importer, beta.id, principals.importer.id)
      try {
        const result = await probe(importer, () =>
          importer.query('SELECT count(*) FROM investment_ledger.accounts'))
        expect(result.code,
          `a forged workspace must raise, not filter: got ${result.code} ${result.message}`)
          .toBe(INSUFFICIENT_PRIVILEGE)
        expect(result.message).toMatch(/holds none of/)
      } finally {
        await rollback(importer)
      }
    })

    it('a forged unauthorized workspace RAISES on SELECT ... FOR UPDATE', async () => {
      // The LOCK path is a separate policy. `SELECT ... FOR UPDATE` is charged
      // to the UPDATE privilege and evaluates `importer_lock_only`'s USING
      // clause as well as `importer_read`'s, so the CASE correction has to hold
      // in both or a lock becomes a silent no-op on a forged workspace.
      await beginWithForgedContext(importer, beta.id, principals.importer.id)
      try {
        const result = await probe(importer, () =>
          importer.query('SELECT id FROM investment_ledger.accounts LIMIT 1 FOR UPDATE'))
        expect(result.code,
          `a forged workspace must raise on locking: got ${result.code} ${result.message}`)
          .toBe(INSUFFICIENT_PRIVILEGE)
        expect(result.message).toMatch(/holds none of/)
      } finally {
        await rollback(importer)
      }
    })

    it('an INSERT into an unauthorized workspace RAISES', async () => {
      // WITH CHECK is evaluated per row proposed, so this path is never vacuous
      // — but it must still raise from the authorizer rather than merely fail
      // the comparison.
      await beginWithForgedContext(importer, beta.id, principals.importer.id)
      try {
        const result = await probe(importer, () =>
          importer.query(
            `INSERT INTO investment_ledger.accounts
               (workspace_id, actor_principal_id, account_key, platform, display_name,
                resolution_status, unresolved_reason)
             VALUES ($1,$2,$3,'tenancy',$3,'unresolved','forged-insert')`,
            [beta.id, principals.importer.id, `forged-${Date.now()}`]))
        expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
        expect(result.message).toMatch(/holds none of/)
      } finally {
        await rollback(importer)
      }
    })

    it('a legitimately authorized caller still reads its OWN workspace', async () => {
      // The correction must not have turned the policy into a blanket denial —
      // the failure mode of the defect it replaces. Same populated table, same
      // login, valid context: rows must come back.
      await beginAuthorized(importer, alpha.id, ['archive-import'])
      try {
        const { rows } = await importer.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM investment_ledger.accounts')
        expect(rows[0].n,
          'an authorized caller must still see its own workspace rows').toBeGreaterThan(0)
      } finally {
        await rollback(importer)
      }
    })

    it('missing context remains fail-closed on the populated table', async () => {
      // No `app.workspace_id` at all. The authorizer is reached with a NULL
      // workspace and raises 'no workspace selected'; if it were somehow not
      // reached, the only other acceptable outcome is zero rows. Returning data
      // is the failure this rules out.
      const result = await probeDetached(importer, async () => {
        const { rows } = await importer.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM investment_ledger.accounts')
        if (rows[0].n !== 0) throw new Error(`no context returned ${rows[0].n} rows`)
      })
      expect(result.code === null || result.code === INSUFFICIENT_PRIVILEGE,
        `unexpected: ${result.code} ${result.message}`).toBe(true)
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // COMPOSITE TENANT KEYS ON THE THREE SELF-LINKS.
  //
  // `import_batches.changed_from_batch`, `account_resolutions.supersedes_id`
  // and `document_verification_events.supersedes_id` shipped as id-only foreign
  // keys. RLS does not catch that class of mistake: the child row's OWN tenancy
  // is correct, so the policy is satisfied, and a principal authorized in BOTH
  // workspaces could name another tenant's row as its parent.
  //
  // WHAT THE CALLER ACTUALLY OBSERVES, stated honestly. Each of these tables
  // carries a BEFORE INSERT trigger that looks the parent up, and BEFORE ROW
  // triggers necessarily run before foreign-key validation — a foreign key is
  // an AFTER-trigger check. So for a runtime caller the trigger refuses first,
  // with P0001, and the composite key never gets to fire. The key is the
  // STRUCTURAL backstop: it is what still refuses the link if a trigger is
  // dropped, and it is asserted directly against pg_constraint below rather
  // than inferred from an error code the trigger pre-empts.
  // ───────────────────────────────────────────────────────────────────────
  describe('tenant self-links are workspace-scoped', () => {
    const SELF_LINKS = [
      ['import_batches', 'changed_from_batch'],
      ['account_resolutions', 'supersedes_id'],
      ['document_verification_events', 'supersedes_id'],
    ] as const

    it('each self-link is a COMPOSITE foreign key on (workspace_id, <column>)', async () => {
      for (const [table, column] of SELF_LINKS) {
        const { rows } = await admin.query<{ def: string }>(
          `SELECT pg_get_constraintdef(c.oid) AS def
             FROM pg_constraint c
            WHERE c.conrelid = ('investment_ledger.' || $1)::regclass
              AND c.contype = 'f'
              AND pg_get_constraintdef(c.oid) LIKE '%' || $2 || '%'`,
          [table, column])
        expect(rows.length, `${table}.${column}: no foreign key at all`).toBeGreaterThan(0)
        const composite = rows.filter(r =>
          r.def.includes(`FOREIGN KEY (workspace_id, ${column})`) &&
          r.def.includes(`REFERENCES investment_ledger.${table}(workspace_id, id)`))
        expect(composite.length,
          `${table}.${column} is not workspace-scoped: ${rows.map(r => r.def).join(' | ')}`)
          .toBe(1)
      }
    })

    it('single-successor uniqueness is scoped by workspace, not global', async () => {
      for (const [table, column] of SELF_LINKS) {
        const { rows } = await admin.query<{ def: string }>(
          `SELECT pg_get_constraintdef(c.oid) AS def
             FROM pg_constraint c
            WHERE c.conrelid = ('investment_ledger.' || $1)::regclass
              AND c.contype = 'u'
              AND pg_get_constraintdef(c.oid) LIKE '%' || $2 || '%'`,
          [table, column])
        expect(rows.map(r => r.def),
          `${table}.${column} has no workspace-scoped uniqueness`)
          .toEqual([`UNIQUE (workspace_id, ${column})`])
      }
    })

    // ── THE THREE RELATIONSHIPS, one place, so a new self-link cannot be
    //    covered for one table and quietly missed for the others.
    //
    //    Each needs a COMMITTED parent in each of two workspaces, and the
    //    resolution/verification parents sit at the end of a chain
    //    (account -> resolution, batch -> document -> variant -> event). So
    //    this block seeds its OWN pair of fully-populated workspaces rather
    //    than bending the alpha/beta fixtures the rest of the file depends on.
    let fkA: Workspace
    let fkB: Workspace
    /** parent row id per (relationship, workspace). */
    const parents = new Map<string, string>()

    beforeAll(async () => {
      const CAPS = ['archive-import', 'reconciliation', 'document-verification'] as const
      fkA = await seedWorkspace(admin, 'fk-alpha')
      fkB = await seedWorkspace(admin, 'fk-beta')
      for (const ws of [fkA, fkB]) {
        await seedGraphAndRestrict(
          admin, importer, operator, ws, principals.importer, principals.grantor,
          [...CAPS], { fillEveryTenantTable: true })
        for (const table of ['import_batches', 'account_resolutions',
                             'document_verification_events'] as const) {
          const { rows } = await admin.query<{ id: string }>(
            `SELECT id FROM investment_ledger.${table} WHERE workspace_id = $1 LIMIT 1`,
            [ws.id])
          if (rows.length !== 1) {
            throw new Error(`no ${table} parent seeded in ${ws.id}; the probes would be vacuous`)
          }
          parents.set(`${table}:${ws.id}`, rows[0].id)
        }
      }
    }, 180_000)

    /** A child INSERT for each relationship, naming `parentId` as its parent. */
    const childInsert = (rel: string, ws: string, parentId: string) => {
      const stamp = `${Date.now()}-${Math.random()}`
      switch (rel) {
        case 'import_batches':
          return {
            sql: `INSERT INTO investment_ledger.import_batches
                    (workspace_id, actor_principal_id, series_key, source_kind, source_name,
                     source_sha256, importer_version, row_count, status, changed_from_batch)
                  VALUES ($1,$2,$3,'archive_csv','fk-child',$4,'tenancy-suite',0,'published',$5)`,
            args: [ws, principals.importer.id, `probe:fk-${stamp}`, hex64(), parentId],
            capability: 'archive-import' as const,
          }
        case 'account_resolutions':
          return {
            sql: `INSERT INTO investment_ledger.account_resolutions
                    (workspace_id, placeholder_account_id, resolution_kind, supersedes_id,
                     actor_principal_id, reason)
                  SELECT $1, r.placeholder_account_id, 'retract', $3, $2, 'fk backstop probe'
                    FROM investment_ledger.account_resolutions r WHERE r.workspace_id = $1 LIMIT 1`,
            args: [ws, principals.importer.id, parentId],
            capability: 'reconciliation' as const,
          }
        default:
          return {
            sql: `INSERT INTO investment_ledger.document_verification_events
                    (workspace_id, variant_id, event_kind, supersedes_id,
                     actor_principal_id, reason)
                  SELECT $1, e.variant_id, 'retracted', $3, $2, 'fk backstop probe'
                    FROM investment_ledger.document_verification_events e
                   WHERE e.workspace_id = $1 LIMIT 1`,
            args: [ws, principals.importer.id, parentId],
            capability: 'document-verification' as const,
          }
      }
    }

    const RELATIONSHIPS = [
      ['import_batches', 'changed_from_batch'],
      ['account_resolutions', 'supersedes_id'],
      ['document_verification_events', 'supersedes_id'],
    ] as const

    it.each(RELATIONSHIPS)(
      'NORMAL RUNTIME: %s.%s cannot name a parent in another workspace',
      async (table) => {
        // The principal is authorized in BOTH workspaces here, so the refusal
        // cannot be attributed to missing authority — only tenancy is left to
        // explain it.
        //
        // P0001, ASSERTED SEPARATELY AND ON PURPOSE. Each of these tables
        // carries a BEFORE INSERT trigger that looks the parent up, and BEFORE
        // ROW triggers necessarily run before foreign-key validation, which is
        // an AFTER-trigger check. So at normal runtime the trigger refuses
        // first and 23503 is unreachable. The composite key is proved
        // independently, in the backstop block below.
        const parentInA = parents.get(`${table}:${fkA.id}`)!
        const child = childInsert(table, fkB.id, parentInA)
        await beginAuthorized(importer, fkB.id, [child.capability])
        try {
          const result = await probe(importer, () => importer.query(child.sql, child.args))
          expect(result.code, `${table}: a cross-workspace link was accepted`).not.toBeNull()
          expect(result.code, `${table}: ${result.message}`).toBe(RAISE_EXCEPTION)
          expect(result.code, `${table}: must not be a privilege failure`)
            .not.toBe(INSUFFICIENT_PRIVILEGE)
        } finally {
          await rollback(importer)
        }
      })

    it.each(RELATIONSHIPS)(
      'FK BACKSTOP: %s.%s is refused by the composite key with the triggers out of the way',
      async (table, column) => {
        // WHAT THIS PROVES THAT THE TEST ABOVE CANNOT. The trigger always wins
        // the race, so a passing runtime test says nothing about whether the
        // key exists. Here the USER triggers on the table under test are
        // disabled for the duration of ONE transaction, which leaves the
        // foreign key — an internal/constraint trigger — fully active, and the
        // insert is refused by the key itself.
        //
        //   * ADMIN ONLY, and only inside the disposable gate: DISABLE TRIGGER
        //     needs table ownership.
        //   * `DISABLE TRIGGER USER`, not `ALL` and not
        //     session_replication_role: `ALL` would take the FK's own internal
        //     trigger down with it and the probe would prove the opposite of
        //     what it claims.
        //   * The whole thing is rolled back, so trigger state and fixture rows
        //     are restored by the transaction rather than by a cleanup step
        //     that could itself fail.
        const parentInA = parents.get(`${table}:${fkA.id}`)!
        const parentInB = parents.get(`${table}:${fkB.id}`)!

        await begin(admin)
        try {
          await admin.query(`ALTER TABLE investment_ledger.${table} DISABLE TRIGGER USER`)

          // The triggers really are down, and the CONSTRAINT triggers are not.
          const { rows: trig } = await admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_trigger
              WHERE tgrelid = ('investment_ledger.' || $1)::regclass
                AND NOT tgisinternal AND tgenabled <> 'D'`, [table])
          expect(trig[0].n, `${table}: user triggers are still enabled`).toBe(0)
          const { rows: fk } = await admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_constraint
              WHERE conrelid = ('investment_ledger.' || $1)::regclass
                AND contype = 'f'
                AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (workspace_id, ' || $2 || ')%'`,
            [table, column])
          expect(fk[0].n, `${table}.${column}: the composite key is missing`).toBe(1)

          // CROSS-WORKSPACE: the key must refuse it, with exactly 23503.
          const across = childInsert(table, fkB.id, parentInA)
          const denied = await probe(admin, () => admin.query(across.sql, across.args))
          expect(denied.code, `${table}: expected a foreign-key violation, got ${denied.message}`)
            .toBe(FK_VIOLATION)

          // CONTROL: the same statement shape, same disabled triggers, parent in
          // the SAME workspace — must be accepted. Without this the 23503 above
          // could be produced by a malformed statement rather than by tenancy.
          const within = childInsert(table, fkB.id, parentInB)
          const allowed = await probe(admin, () => admin.query(within.sql, within.args))
          expect(allowed.code,
            `${table}: a same-workspace link must satisfy the key: ${allowed.message}`)
            .toBeNull()

          // NO CHILD ROW LANDED for the cross-workspace attempt. probe() rolls
          // back to its savepoint, so this is checked inside the transaction
          // where the write would have been visible if it had succeeded.
          const { rows: left } = await admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM investment_ledger.${table}
              WHERE workspace_id = $1 AND ${column} = $2`, [fkB.id, parentInA])
          expect(left[0].n, `${table}: a cross-workspace child row survived`).toBe(0)
        } finally {
          // Restores the trigger state AND discards every probe above.
          await rollback(admin)
        }
      })
  })

  it('every tenant table has all three importer policies', async () => {
    // A missing policy is default-deny, which LOOKS like working isolation
    // until somebody "fixes" the resulting empty result set.
    const { rows } = await admin.query<{ relname: string; polname: string }>(
      `SELECT c.relname, p.polname
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'investment_ledger'`)
    const byTable = new Map<string, string[]>()
    for (const row of rows) {
      byTable.set(row.relname, [...(byTable.get(row.relname) ?? []), row.polname])
    }
    expect(byTable.size).toBe(17)
    for (const [table, policies] of byTable) {
      for (const wanted of ['importer_read', 'importer_insert', 'importer_lock_only']) {
        expect(policies, `${table} is missing ${wanted}`).toContain(wanted)
      }
    }
  })
})
