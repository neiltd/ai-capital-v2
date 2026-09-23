// A PostgreSQL 17 cluster that exists for the duration of one test file.
//
// WHY A DISPOSABLE CLUSTER AND NOT A TEST DATABASE. Everything slice 1 asserts
// is a LIVE property of PostgreSQL: which send function `typsend` names, what
// `numeric_send` does to scale, whether `date_send` survives infinity. An
// offline test can only assert the shape of a string. But the two clusters this
// repository owns are the production book on 5432 and the migration target on
// 5433, and a test suite must be able to run at any moment without a thought
// about either. So each run builds its own.
//
// THE THREE CONTAINMENT RULES:
//
//   1. NO TCP LISTENER. `listen_addresses = ''` means the postmaster opens no
//      TCP socket at all. The port number still names the socket FILE, and it
//      is drawn from a registry so two live harness clusters can never collide,
//      and never 5432 or 5433.
//
//   2. NOTHING OUTSIDE THE TEMPORARY ROOT, AND NOTHING LEFT BEHIND. PGDATA, the
//      socket directory and every byte written live under one `mkdtemp` root.
//      `/tmp` is chosen for its SHORT path: a Unix socket path has a ~103-byte
//      limit and macOS's per-user temp directory can exhaust it.
//
//   3. NO DRIVER. Every statement goes through the pinned `psql` binary by
//      absolute path, which keeps the harness clear of the connection factory
//      that `packages/db/src/pool.ts` owns.
//
// THE LIFECYCLE RULE THAT COST TWO ORPHANED POSTMASTERS. `pg_ctl -w start` can
// FAIL while a postmaster is nonetheless running - a slow start, a timeout, a
// readiness probe that gave up. A cleanup that only runs when start "succeeded"
// leaves that postmaster alive. So: the handle is registered BEFORE the start
// is attempted, liveness is decided by `pg_ctl status` rather than by the exit
// code of `start`, and PGDATA is never removed while a postmaster still answers
// for it. If shutdown cannot be proved, the root is PRESERVED and the handle
// stays registered so an outer guard can retry.

import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const PG_BIN = '/opt/homebrew/opt/postgresql@17/bin'
export const INITDB = `${PG_BIN}/initdb`
export const PG_CTL = `${PG_BIN}/pg_ctl`
export const PSQL = `${PG_BIN}/psql`

/** Ports that must never appear, even as a socket file name. */
export const FORBIDDEN_PORTS: readonly number[] = Object.freeze([5432, 5433])

/**
 * ASCII unit separator as a field delimiter. Chosen because no value this
 * suite stores contains it, so a split on it cannot cut a value in half.
 */
export const FIELD_SEP = '\x1f'

export interface DisposableCluster {
  readonly root: string
  readonly pgdata: string
  readonly socketDir: string
  readonly port: number
  readonly user: string
  sql(text: string, database?: string): Promise<string>
  rows(text: string, database?: string): Promise<string[][]>
  queryCount(): number
  /** Every SQL string sent, in order. Lets a test prove what was NOT sent. */
  issued(): readonly string[]
  /**
   * Stop and remove. Idempotent and concurrency-safe: concurrent callers await
   * the same attempt. REJECTS, and preserves the root, if shutdown cannot be
   * proved - so a caller can retry rather than delete a live PGDATA.
   */
  stop(): Promise<void>
}

/** Test-only seams. Never used by the suite's ordinary path. */
export interface DisposableOptions {
  readonly user?: string
  /** Simulate `pg_ctl -w start` failing AFTER a postmaster came up. */
  readonly __failStartWait?: boolean
  /** Simulate the shutdown command failing, so the root must be preserved. */
  readonly __failStop?: boolean
}

/** Every cluster this process started and has not yet positively shut down. */
const LIVE = new Set<DisposableCluster>()
/** Ports held by a live cluster, so two harness clusters cannot collide. */
const PORTS_IN_USE = new Set<number>()

/**
 * Stop every cluster this process started, whatever the test managed to keep.
 * Collects failures rather than stopping at the first, so one stubborn cluster
 * cannot strand the rest.
 */
export async function stopAllDisposableClusters(): Promise<void> {
  const failures: unknown[] = []
  for (const c of [...LIVE]) {
    try { await c.stop() } catch (err) { failures.push(err) }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} disposable cluster(s) would not stop`)
  }
}

/** Roots that still exist because a shutdown could not be proved. */
export function unstoppedRoots(): string[] {
  return [...LIVE].map(c => c.root)
}

/** A high, non-privileged value, never reused while another cluster holds it. */
function reservePort(): number {
  for (let i = 0; i < 10_000; i += 1) {
    const p = 55_000 + Math.floor(Math.random() * 4_000)
    if (FORBIDDEN_PORTS.includes(p) || PORTS_IN_USE.has(p)) continue
    PORTS_IN_USE.add(p)
    return p
  }
  throw new Error('no free harness port in 55000-58999')
}

/** Short root: a Unix socket path must fit in ~103 bytes. */
function shortTmpRoot(): string {
  const base = tmpdir().length > 24 ? '/tmp' : tmpdir()
  return mkdtempSync(join(base, 'pgcopy-'))
}

/** Liveness decided by the postmaster itself, not by a start command's status. */
export async function postmasterAlive(pgdata: string): Promise<boolean> {
  try {
    await run(PG_CTL, ['-D', pgdata, 'status'])
    return true
  } catch (err) {
    // pg_ctl status exits 3 for "not running" and 4 for "no accessible PGDATA".
    // Both mean no postmaster is answering for this directory.
    const code = (err as { code?: number }).code
    if (code === 3 || code === 4) return false
    // Anything else is an unknown state; treat it as alive so nothing is
    // deleted on the strength of a failure we cannot explain.
    return true
  }
}

export async function startDisposableCluster(
  opts: DisposableOptions = {},
): Promise<DisposableCluster> {
  const user = opts.user ?? 'pgcopy_test'
  const root = shortTmpRoot()
  const pgdata = join(root, 'd')
  const socketDir = join(root, 's')
  const port = reservePort()

  let queries = 0
  const sent: string[] = []
  let stopping: Promise<void> | null = null
  // The simulated failure fires ONCE. A permanent one would make the retry path
  // untestable: the point is that a failed stop can be retried successfully.
  let failStopOnce = opts.__failStop === true

  const doStop = async (): Promise<void> => {
    const simulateFailure = failStopOnce
    failStopOnce = false
    if (!simulateFailure && existsSync(pgdata) && await postmasterAlive(pgdata)) {
      try {
        await run(PG_CTL, ['-D', pgdata, '-m', 'immediate', '-w', '-t', '30', 'stop'])
      } catch {
        // Fall through to the liveness check: the command may have failed and
        // the postmaster may still have died, or the reverse.
      }
    }
    if (existsSync(pgdata) && await postmasterAlive(pgdata)) {
      // NEVER remove a PGDATA a postmaster still answers for, and stay
      // registered so an outer guard can retry.
      throw new Error(
        `disposable cluster at ${root} is still running after an immediate stop; ` +
        'the root has been PRESERVED and the cluster remains registered for retry.',
      )
    }
    rmSync(root, { recursive: true, force: true })
    PORTS_IN_USE.delete(port)
    LIVE.delete(handle)
  }

  const psql = async (args: string[], database: string, text: string): Promise<string> => {
    queries += 1
    sent.push(text)
    const { stdout } = await run(PSQL, [
      '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-X', '-q',
      '-h', socketDir, '-p', String(port), '-U', user, '-d', database,
      ...args,
    ], { maxBuffer: 64 * 1024 * 1024 })
    return stdout
  }

  const handle: DisposableCluster = {
    root, pgdata, socketDir, port, user,
    sql: (text, database = 'postgres') => psql(['-c', text], database, text),
    rows: async (text, database = 'postgres') => {
      const out = await psql(['-A', '-t', '-F', FIELD_SEP, '-c', text], database, text)
      return out.split('\n').filter(l => l !== '').map(l => l.split(FIELD_SEP))
    },
    queryCount: () => queries,
    issued: () => sent,
    stop: () => {
      // Idempotent and concurrency-safe: concurrent callers await one attempt,
      // and a FAILED attempt is not memoised, so a retry really retries.
      if (!stopping) {
        stopping = doStop().catch(err => { stopping = null; throw err })
      }
      return stopping
    },
  }

  // REGISTERED BEFORE ANYTHING CAN FAIL. initdb creates no postmaster, but
  // `pg_ctl start` can leave one behind while reporting failure, and a handle
  // that is only registered on success is a handle that cannot clean that up.
  LIVE.add(handle)

  try {
    await run(INITDB, [
      '-D', pgdata, '--username', user, '--auth=trust', '--no-sync',
      '--encoding=UTF8', '--locale=en_US.UTF-8',
    ])
    mkdirSync(socketDir, { mode: 0o700, recursive: true })
    appendFileSync(join(pgdata, 'postgresql.conf'), [
      '',
      '# disposable-cluster.ts - containment',
      "listen_addresses = ''",
      `unix_socket_directories = '${socketDir}'`,
      `port = ${port}`,
      'fsync = off',
      'full_page_writes = off',
      'logging_collector = off',
      'max_connections = 20',
      '',
    ].join('\n'), 'utf-8')
    await run(PG_CTL, ['-D', pgdata, '-w', '-t', '60', '-l', join(root, 'pg.log'), 'start'])
    if (opts.__failStartWait) {
      throw new Error('simulated: pg_ctl -w start reported failure after the postmaster came up')
    }
  } catch (err) {
    // The postmaster may be running regardless of what start reported. Try to
    // stop it; if that also fails, leave the handle registered and the root in
    // place, and surface the original error.
    try { await handle.stop() } catch { /* handled by the outer guard */ }
    throw err
  }
  return handle
}

/** Teardown proof: nothing of this cluster survives on disk. */
export function clusterResidue(c: { root: string; port: number }): {
  rootExists: boolean
  socketExists: boolean
} {
  return {
    rootExists: existsSync(c.root),
    socketExists: existsSync(join(c.root, 's', `.s.PGSQL.${c.port}`)),
  }
}
