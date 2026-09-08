// Transaction-local workspace context for service callers.
//
// THE ONE HELPER TENANT CODE MAY USE. There is deliberately no exported
// function that lets a caller assert a principal identity, and no way to obtain
// a raw client with context already set. If you find yourself wanting one, the
// thing you actually want is a new capability.
//
// THE TRUST BOUNDARY, STATED PLAINLY. `app.workspace_id` is a SELECTOR, not a
// credential. It says which workspace the caller would like to act in; whether
// it may is decided by `identity.authorize_service_workspace_any`, which
// resolves the caller from `session_user` — the role that authenticated at
// connect time — and checks it against the live grant table. This is only sound
// because three things hold together:
//
//   1. Runtime callers cannot supply raw SQL. Every query here is parameterised
//      and the architecture check forbids ad-hoc clients in tenant code. With a
//      SQL-injection hole, `set_config('app.workspace_id', ...)` would be
//      forgeable and every policy would collapse.
//   2. The workspace comes from an explicit argument that the caller must
//      already be entitled to — never from a header, cookie or request body.
//   3. The runtime role is NOBYPASSRLS and owns nothing, so a correct-looking
//      GUC still cannot sidestep a policy.
//
// Composite (workspace_id, id) foreign keys are the backstop for a failure of
// (1) or (2).

import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { getPool } from './pool.js'

export type ServiceCapability =
  | 'archive-import'
  | 'manual-entry'
  | 'reconciliation'
  | 'document-verification'
  | 'ledger-read'

/**
 * A client that is already inside an authorized, context-bearing transaction.
 *
 * It is a wrapper rather than the `pg.Client` itself so the scope cannot be
 * escaped by capturing the client and using it after the transaction ends.
 */
export class WorkspaceClient {
  constructor(
    private readonly client: PoolClient,
    readonly workspaceId: string,
    readonly principalId: string,
  ) {}

  query<R extends QueryResultRow = QueryResultRow>(
    text: string, values?: unknown[],
  ): Promise<QueryResult<R>> {
    return this.client.query<R>(text, values)
  }

  async queryOne<R extends QueryResultRow = QueryResultRow>(
    text: string, values?: unknown[],
  ): Promise<R | null> {
    const { rows } = await this.client.query<R>(text, values)
    return rows[0] ?? null
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Run `fn` inside a transaction that is authorized first and contextualised
 * second.
 *
 * ORDER MATTERS, AND AN EARLIER DESIGN GOT IT WRONG. Authorization takes the
 * workspace as an ARGUMENT rather than reading the GUC, so it can run before
 * the GUC is set. A version that authorized by reading `app.workspace_id` could
 * never succeed on a clean pooled connection, because the value it needed had
 * not been published yet.
 *
 * `set_config(..., true)` is transaction-LOCAL: the setting reverts on COMMIT
 * *and* on ROLLBACK. That is what stops context outliving the transaction and
 * being inherited by the next borrower of a pooled connection — `pool.ts`
 * hands out a process-wide singleton, so a session-level SET would leak.
 */
export async function withAuthorizedServiceWorkspaceTransaction<T>(
  workspaceId: string,
  capabilities: ServiceCapability | ServiceCapability[],
  fn: (tx: WorkspaceClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(workspaceId)) {
    throw new Error(
      `workspace must be an exact UUID, got ${JSON.stringify(workspaceId)}. ` +
      'Slugs are resolved by identity.resolve_workspace_for_capability, which ' +
      'authorizes before it resolves.',
    )
  }
  const caps = Array.isArray(capabilities) ? capabilities : [capabilities]
  if (caps.length === 0) throw new Error('at least one capability is required')

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')

    // 1. AUTHORIZE. Raises SQLSTATE 42501 for an unbound login, a disabled
    //    principal, or a principal holding none of these capabilities here.
    const authorized = await client.query<{ principal_id: string }>(
      'SELECT identity.authorize_service_workspace_any($1, $2::identity.service_capability[])'
      + ' AS principal_id',
      [workspaceId, caps],
    )
    const principalId = authorized.rows[0]?.principal_id
    if (!principalId) throw new Error('authorization returned no principal')

    // 2. Only now publish context. The principal is DERIVED from the database,
    //    never accepted from the caller.
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId])
    await client.query("SELECT set_config('app.principal_id', $1, true)", [principalId])

    const out = await fn(new WorkspaceClient(client, workspaceId, principalId))
    await client.query('COMMIT')
    return out
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* the connection is going back anyway */ }
    throw err
  } finally {
    client.release()
  }
}
