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

export class PsqlBackendRefused extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'PsqlBackendRefused'
  }
}

/** One statement's outcome. `error` is psql's message, verbatim, or null. */
export interface SqlResult {
  readonly rows: string[][]
  readonly error: string | null
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
    throw new PsqlBackendRefused('the psql path must be absolute.')
  }
  if (o.passfile !== undefined && !isAbsolute(o.passfile)) {
    throw new PsqlBackendRefused('the passfile must be an absolute path.')
  }
  if (!Number.isSafeInteger(o.port) || o.port < 1 || o.port > 65_535) {
    throw new PsqlBackendRefused('the port is not a port number.')
  }
  return assertBatchArgs([
    '--no-psqlrc', '-q', '-A', '-t', '-F', FIELD_SEP, '--pset', 'footer=off',
    '-h', o.host, '-p', String(o.port), '-U', o.user, '-d', o.database,
  ])
}

export async function openPsqlBackend(o: PsqlBackendOptions): Promise<PsqlBackend> {
  const args = psqlBackendArgs(o)
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
  const done = new Promise<void>(resolve => {
    child.on('close', () => { exited = true; resolve() })
  })
  child.on('error', () => { exited = true })

  let seq = 0
  let queue: Promise<unknown> = Promise.resolve()

  const raw = async (sql: string): Promise<SqlResult> => {
    if (exited) throw new PsqlBackendRefused('the psql session has already exited.')
    const tag = `__PSQL_SENTINEL_${++seq}__`
    const startOut = out.length
    const startErr = err.length
    // TERMINATED EXPLICITLY. psql executes a backslash command immediately even
    // when a statement is still buffered, so an unterminated statement would
    // let the sentinel arrive BEFORE the result it is supposed to close.
    const stmt = `${sql.trim().replace(/;+$/, '')};`
    child.stdin.write(`${stmt}\n\\echo ${tag}\n\\warn ${tag}\n`)
    const deadline = Date.now() + STATEMENT_TIMEOUT_MS
    for (;;) {
      if (out.slice(startOut).includes(tag) && err.slice(startErr).includes(tag)) break
      if (exited) break
      if (Date.now() > deadline) {
        // The STATEMENT is not named: it may be a batch carrying a verifier.
        throw new PsqlBackendRefused('the psql session timed out on a statement.')
      }
      await new Promise(r => setTimeout(r, 15))
    }
    const bodyOut = out.slice(startOut).split(`${tag}\n`)[0]
    const bodyErr = err.slice(startErr).split(`${tag}\n`)[0]
    const rows = bodyOut.split('\n').filter(l => l !== '').map(l => l.split(FIELD_SEP))
    const message = bodyErr.trim()
    return { rows, error: message === '' ? null : message }
  }

  /** Serialised: one psql stdin, so two concurrent sends would interleave. */
  const send = (sql: string): Promise<SqlResult> => {
    const next = queue.then(() => raw(sql))
    queue = next.catch(() => undefined)
    return next
  }

  const must = async (sql: string): Promise<string[][]> => {
    const r = await send(sql)
    if (r.error !== null) {
      throw new PsqlBackendRefused(`psql refused "${sql.slice(0, 160)}": ${r.error}`)
    }
    return r.rows
  }

  const pidRows = await (async () => {
    const r = await send('SELECT pg_catalog.pg_backend_pid()')
    if (r.error !== null) {
      throw new PsqlBackendRefused('the session could not report its backend pid.')
    }
    return r.rows
  })()
  const pid = pidRows[0]?.[0]
  if (pid === undefined || !/^\d+$/.test(pid)) {
    throw new PsqlBackendRefused('the session did not report a backend pid.')
  }

  const session: PsqlBackend = {
    pid,
    send,
    must,
    rows: must,
    alive: () => !exited,
    close: async () => {
      if (!exited) {
        try { child.stdin.end() } catch { /* already gone */ }
        const deadline = Date.now() + CLOSE_GRACE_MS
        while (!exited && Date.now() < deadline) await new Promise(r => setTimeout(r, 15))
        if (!exited) {
          // The session is wedged behind a lock it will never get. SIGKILL the
          // CLIENT: the backend then dies on its own, which is exactly the
          // "backend death releases the fence" path.
          child.kill('SIGKILL')
          await done
        }
      }
      OPEN.delete(session)
    },
  }
  OPEN.add(session)
  return session
}
