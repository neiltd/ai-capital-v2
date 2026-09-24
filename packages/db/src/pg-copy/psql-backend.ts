// A LONG-LIVED psql BACKEND — the transport Stage 1 needs and nothing more.
//
// WHY A SESSION AT ALL. Everything Stage 1 proves is a property of ONE backend
// holding ONE transaction: a fence released the instant its transaction ends, a
// snapshot that must cover thirty-one queries, a pid that must still be the
// same pid at the end. A helper that spawns a process per statement cannot
// express any of that - each statement would arrive on a new backend and every
// transaction would end when the process exited.
//
// WHY psql AND NOT A DRIVER. This repository routes every PostgreSQL DRIVER
// connection through one canonical module, and the architecture check exists to
// keep it that way. Opening a `pg` client here would be the first exception.
// psql is already the transport the credential lifecycle uses, so this adds a
// session SHAPE, not a connection path.
//
// HOW THE SECRET TRAVELS, AND WHERE IT DOES NOT. Connection IDENTITY - host,
// port, user, database - goes in argv, where it is inert and where a process
// list showing it tells an observer nothing they could not read from a config
// file. The SECRET never does: it reaches psql through `PGPASSFILE`, which is a
// PATH, and the environment is built from an allow-list rather than inherited,
// so a `PGPASSWORD` or a `*_DATABASE_URL` that happens to be exported in the
// operator's shell simply is not there. There is no URL argument, no password
// argument, and no fallback environment variable anywhere in this module.
//
// HOW COMMANDS ARE FRAMED. psql writes results to stdout and errors to stderr,
// and nothing in either stream says where one statement ends. So each command
// is followed by a sentinel on BOTH streams (`\echo` and `\warn`), and a read
// completes only when both have arrived. Without the stderr half, an error
// belonging to command N could be attributed to command N+1 - which, in code
// whose entire purpose is to distinguish "refused" from "succeeded", is the one
// mistake that would invert a result.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'

import { assertBatchArgs, sterileBatchEnv } from './export-role.js'

/**
 * The field separator, shared by every psql reader in this repository.
 *
 * psql's default is `|`, which appears INSIDE real catalogue values -
 * `pg_get_constraintdef()` emits it for a `||` concatenation in a CHECK, and
 * `pg_get_indexdef()` for an expression index. Splitting on `|` would shift
 * every later column of such a row and silently change the result. US (0x1f)
 * cannot occur in these strings.
 */
export const FIELD_SEP = '\x1f'

/** How long one statement may take before the session is declared wedged. */
export const STATEMENT_TIMEOUT_MS = 120_000
/** How long a close waits for a graceful exit before killing the client. */
export const CLOSE_GRACE_MS = 15_000

/**
 * WHY a session refusal happened. A CLOSED union of reviewed sentences.
 *
 * NOTHING ELSE IS EVER CARRIED. psql echoes the failing statement into stderr,
 * and a batch this transport carries may contain a SCRAM verifier; a statement
 * may name a table, a row or a credential URL. An error raised here is going to
 * be logged by whoever catches it, so the raw text stops at this boundary. The
 * `send` path still INSPECTS stderr internally to decide whether a statement
 * succeeded - it just never republishes it.
 */
export type PsqlBackendReason =
  | 'the psql path must be absolute'
  | 'the passfile must be an absolute path'
  | 'the port is not a port number'
  | 'the psql session has already exited'
  | 'the psql session timed out on a statement'
  | 'the psql session could not report its backend pid'
  | 'the psql session did not report a backend pid'
  | 'the psql session refused a statement'
  | 'the psql session could not be started'

export class PsqlBackendRefused extends Error {
  constructor(readonly reason: PsqlBackendReason) {
    super(reason)
    this.name = 'PsqlBackendRefused'
  }
}

/**
 * The ONLY outcome a refused statement is reported as.
 *
 * A fixed token, not psql's prose. psql echoes the failing statement into
 * stderr and names the relation, the value and sometimes the credential that
 * upset it; a caller that receives that string will eventually log it, put it
 * in an error, or assert against its wording. All three are things this
 * boundary exists to prevent.
 */
export type SqlOutcome = 'statement-refused'

/**
 * One statement's outcome. `rows` is the result; `error` is a fixed token.
 *
 * The null-versus-token shape is deliberately the same shape the raw string
 * had, so every existing `r.error !== null` reads the same - what changed is
 * that there is no longer anything to read OUT of it.
 */
export interface SqlResult {
  readonly rows: string[][]
  readonly error: SqlOutcome | null
}

export interface PsqlBackend {
  /** The backend PID, read once at open. A psql session never reconnects. */
  readonly pid: string
  /** Send one command. Never throws on a SQL error - the error is returned. */
  send(sql: string): Promise<SqlResult>
  /** Send one command and throw on a SQL error. */
  must(sql: string): Promise<string[][]>
  /** `must`, under the name `ContractQueryExecutor` asks for. */
  rows(sql: string): Promise<string[][]>
  /** Close stdin and wait for the backend to go away. Idempotent. */
  close(): Promise<void>
  /** True until `close()` resolves or the child exits. */
  alive(): boolean
}

/** Every session this process opened and has not yet positively closed. */
const OPEN = new Set<PsqlBackend>()

/** Close every session, whatever a caller managed to keep hold of. */
export async function closeAllPsqlBackends(): Promise<void> {
  const errs: unknown[] = []
  for (const s of [...OPEN]) {
    try { await s.close() } catch (e) { errs.push(e) }
  }
  if (errs.length) throw errs[0]
}

export function openPsqlBackendCount(): number {
  return OPEN.size
}

export interface PsqlBackendOptions {
  /** Absolute path to the psql binary. Never resolved through PATH. */
  readonly psqlPath: string
  /**
   * TEST-ONLY. How long one statement may take. Production uses the reviewed
   * constant; a test needs a short one to reach the timeout path in seconds
   * rather than in two minutes. Double-underscored, following the disposable
   * cluster's convention for seams nothing in production sets.
   */
  readonly __statementTimeoutMs?: number
  /** TEST-ONLY. How long teardown waits before SIGKILL. See above. */
  readonly __closeGraceMs?: number
  /** A socket DIRECTORY or a host. Goes in argv; it is not a secret. */
  readonly host: string
  readonly port: number
  readonly database: string
  readonly user: string
  /**
   * An absolute path to a 0600 pgpass file, or nothing.
   *
   * A PATH in the environment, never the password itself: `PGPASSWORD` would
   * put the secret in the child's environment, where `ps -E` can read it.
   */
  readonly passfile?: string
}

/**
 * The argv this module is willing to build.
 *
 * Built here rather than accepted from a caller, and then run through the
 * reviewed `assertBatchArgs`, which refuses `-c`, `-f`, `-v` and friends: SQL
 * travels on stdin, where a process list cannot read it. Note the ABSENCE of
 * `-f -` - psql reads stdin by default, so the session needs no file argument
 * at all and the ban stays total.
 */
export function psqlBackendArgs(o: PsqlBackendOptions): readonly string[] {
  if (!isAbsolute(o.psqlPath)) {
    throw new PsqlBackendRefused('the psql path must be absolute')
  }
  if (o.passfile !== undefined && !isAbsolute(o.passfile)) {
    throw new PsqlBackendRefused('the passfile must be an absolute path')
  }
  if (!Number.isSafeInteger(o.port) || o.port < 1 || o.port > 65_535) {
    throw new PsqlBackendRefused('the port is not a port number')
  }
  return assertBatchArgs([
    '--no-psqlrc', '-q', '-A', '-t', '-F', FIELD_SEP, '--pset', 'footer=off',
    '-h', o.host, '-p', String(o.port), '-U', o.user, '-d', o.database,
  ])
}

export async function openPsqlBackend(o: PsqlBackendOptions): Promise<PsqlBackend> {
  const args = psqlBackendArgs(o)
  const statementTimeoutMs = o.__statementTimeoutMs ?? STATEMENT_TIMEOUT_MS
  const closeGraceMs = o.__closeGraceMs ?? CLOSE_GRACE_MS
  // The caller cannot hand us an environment to forward: it is constructed from
  // an allow-list, and only the PASSFILE PATH may enter it.
  const env = sterileBatchEnv(o.passfile)
  const child: ChildProcessWithoutNullStreams =
    spawn(o.psqlPath, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env })

  let out = ''
  let err = ''
  let exited = false
  child.stdout.setEncoding('utf-8')
  child.stderr.setEncoding('utf-8')
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.on('close', () => { exited = true })
  child.on('error', () => { exited = true })

  let seq = 0
  let queue: Promise<unknown> = Promise.resolve()

  const raw = async (sql: string): Promise<SqlResult> => {
    if (exited) throw new PsqlBackendRefused('the psql session has already exited')
    const tag = `__PSQL_SENTINEL_${++seq}__`
    const startOut = out.length
    const startErr = err.length
    // TERMINATED EXPLICITLY. psql executes a backslash command immediately even
    // when a statement is still buffered, so an unterminated statement would
    // let the sentinel arrive BEFORE the result it is supposed to close.
    const stmt = `${sql.trim().replace(/;+$/, '')};`
    child.stdin.write(`${stmt}\n\\echo ${tag}\n\\warn ${tag}\n`)
    const deadline = Date.now() + statementTimeoutMs
    for (;;) {
      if (out.slice(startOut).includes(tag) && err.slice(startErr).includes(tag)) break
      if (exited) break
      if (Date.now() > deadline) {
        // The STATEMENT is not named: it may be a batch carrying a verifier.
        throw new PsqlBackendRefused('the psql session timed out on a statement')
      }
      await new Promise(r => setTimeout(r, 15))
    }
    const bodyOut = out.slice(startOut).split(`${tag}\n`)[0]
    const bodyErr = err.slice(startErr).split(`${tag}\n`)[0]
    const rows = bodyOut.split('\n').filter(l => l !== '').map(l => l.split(FIELD_SEP))
    // RAW STDERR IS READ HERE AND NOWHERE ELSE. Its only job is to answer one
    // question - did this statement fail - and the answer leaves as a token.
    // The text itself is a local that goes out of scope on the next line.
    const message = bodyErr.trim()
    return { rows, error: message === '' ? null : 'statement-refused' }
  }

  /** Serialised: one psql stdin, so two concurrent sends would interleave. */
  const send = (sql: string): Promise<SqlResult> => {
    const next = queue.then(() => raw(sql))
    queue = next.catch(() => undefined)
    return next
  }

  /**
   * `send`, refusing a SQL error - and saying NOTHING about what it was.
   *
   * An earlier revision raised `psql refused "<sql>": <stderr>`. Both halves
   * are exactly what must not travel: the statement can name a relation, a
   * value or a credential URL, and psql's stderr echoes the failing statement
   * back verbatim. A caller that needs to branch on the outcome uses `send`,
   * which returns the raw result without raising it.
   */
  const must = async (sql: string): Promise<string[][]> => {
    const r = await send(sql)
    if (r.error !== null) throw new PsqlBackendRefused('the psql session refused a statement')
    return r.rows
  }

  /**
   * Reap the child before propagating an opening failure.
   *
   * Until the session is added to `OPEN` nothing else can close it, so a throw
   * between `spawn` and registration used to leave a live psql - and therefore
   * a live BACKEND - with no handle to it. For a fence supervisor that is not
   * an untidy process, it is a lock nobody can release.
   */
  /**
   * End the child, escalating to SIGKILL, and NEVER wait unboundedly.
   *
   * `close` fires only once every stdio stream has ended, and a stream ends
   * when the last writer lets go of it - which is not necessarily the child.
   * A process the child spawned inherits these pipes and can hold them open
   * after the child itself is gone, so `await done` is a wait on something
   * this module does not control. Measured while building the timeout test: a
   * fake psql whose shell forked `sleep` left `done` pending indefinitely. So
   * the post-SIGKILL wait is bounded too, and our ends of the pipes are
   * destroyed rather than waited on.
   */
  const reap = async (): Promise<void> => {
    try { child.stdin.end() } catch { /* already gone */ }
    const graceful = Date.now() + closeGraceMs
    while (!exited && Date.now() < graceful) await new Promise(r => setTimeout(r, 15))
    if (exited) return
    child.kill('SIGKILL')
    const hard = Date.now() + closeGraceMs
    while (!exited && Date.now() < hard) await new Promise(r => setTimeout(r, 15))
    try { child.stdout.destroy() } catch { /* already gone */ }
    try { child.stderr.destroy() } catch { /* already gone */ }
  }

  let abandoned = false
  const abandon = async (reason: PsqlBackendReason): Promise<never> => {
    abandoned = true
    await reap()
    throw new PsqlBackendRefused(reason)
  }

  /**
   * EVERY failure between spawn and registration goes through `abandon`.
   *
   * An earlier revision rethrew a `PsqlBackendRefused` straight out of this
   * catch, which looks like a harmless pass-through and is not: the statement
   * TIMEOUT is raised as exactly that class, and a timed-out opening is
   * precisely the case where the child is still alive. Until the session
   * reaches `OPEN` nothing else holds a handle to it, so what was left running
   * was an unreachable psql - and, for a supervisor, an unreachable backend
   * that may be holding the fence. The `abandoned` flag distinguishes
   * `abandon`'s own throw from every other one, so nothing escapes uncleaned.
   */
  let pid: string | undefined
  try {
    const r = await send('SELECT pg_catalog.pg_backend_pid()')
    if (r.error !== null) await abandon('the psql session could not report its backend pid')
    pid = r.rows[0]?.[0]
    if (pid === undefined || !/^\d+$/.test(pid)) {
      await abandon('the psql session did not report a backend pid')
    }
  } catch (e) {
    if (abandoned) throw e
    await abandon(e instanceof PsqlBackendRefused
      ? e.reason : 'the psql session could not be started')
  }

  const session: PsqlBackend = {
    pid: pid as string,
    send,
    must,
    rows: must,
    alive: () => !exited,
    close: async () => {
      // The session may be wedged behind a lock it will never get. `reap`
      // escalates to SIGKILL on the CLIENT: the backend then dies on its own,
      // which is exactly the "backend death releases the fence" path.
      if (!exited) await reap()
      OPEN.delete(session)
    },
  }
  OPEN.add(session)
  return session
}
