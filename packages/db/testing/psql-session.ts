// A LONG-LIVED psql backend, for properties that only exist inside one session.
//
// WHY THIS EXISTS. `DisposableCluster.sql()` runs psql once per statement, so
// every statement arrives on a NEW backend and every transaction ends when the
// process exits. A fence is exactly the thing that cannot be expressed that
// way: `LOCK TABLE ... IN SHARE MODE` is released the instant its transaction
// ends, so a one-shot helper can only ever prove that a lock was taken and
// immediately dropped. Holding one open session - and, separately, watching it
// from a DIFFERENT backend - is the whole subject of this slice.
//
// WHY THIS IS NOW A THIN ADAPTER. The session shape this file introduced is the
// same shape Stage 1 needs in production, so the implementation - argv
// construction, the sterile environment, the two-stream sentinel framing, the
// serialised stdin, the close-then-SIGKILL teardown - moved to
// `src/pg-copy/psql-backend.ts` and this file binds it to a DisposableCluster.
//
// ONE TRANSPORT, BOTH PATHS. Keeping a second copy of the framing here would
// mean the sessions the tests exercise and the sessions production opens could
// drift apart, and the first thing to drift would be error attribution - which,
// in code whose entire purpose is to distinguish "refused" from "succeeded", is
// the one mistake that would invert a result.

import {
  closeAllPsqlBackends, openPsqlBackend, openPsqlBackendCount,
  type PsqlBackend, type SqlResult,
} from '../src/pg-copy/psql-backend.js'
import { PSQL, type DisposableCluster } from './disposable-cluster.js'

export type { SqlResult }

/** The session shape, unchanged: one backend, one pid, framed statements. */
export type PsqlSession = PsqlBackend

/** Close every session, whatever a test managed to keep hold of. */
export async function closeAllPsqlSessions(): Promise<void> {
  await closeAllPsqlBackends()
}

export function openPsqlSessionCount(): number {
  return openPsqlBackendCount()
}

export interface PsqlSessionOptions {
  /** Authenticate as this role instead of the cluster superuser. */
  readonly user?: string
  /**
   * A 0600 pgpass file for that role.
   *
   * A PATH, never the password itself: `PGPASSWORD` would put the secret in the
   * child's environment, where `ps -E` and /proc can read it.
   */
  readonly passfile?: string
}

export async function openPsqlSession(
  c: DisposableCluster, database: string, opts: PsqlSessionOptions = {},
): Promise<PsqlSession> {
  return await openPsqlBackend({
    psqlPath: PSQL,
    host: c.socketDir,
    port: c.port,
    database,
    user: opts.user ?? c.user,
    ...(opts.passfile === undefined ? {} : { passfile: opts.passfile }),
  })
}
