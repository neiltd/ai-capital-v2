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
// WHY psql AND NOT A DRIVER. The repository routes every Postgres connection
// through one canonical module, and the architecture check exists to keep it
// that way. Opening a second client here would be the first exception. psql is
// already the transport the disposable harness uses, so this adds a session
// shape, not a connection path.
//
// HOW COMMANDS ARE FRAMED. psql writes results to stdout and errors to stderr,
// and nothing in either stream says where one statement ends. So each command is
// followed by a sentinel on BOTH streams (`\echo` and `\warn`), and a read
// completes only when both have arrived. Without the stderr half, an error
// belonging to command N could be attributed to command N+1 - which, in a test
// whose entire purpose is to distinguish "refused" from "succeeded", is the one
// mistake that would invert a result.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { PSQL, type DisposableCluster } from './disposable-cluster.js'

/** One statement's outcome. `error` is psql's message, verbatim, or null. */
export interface SqlResult {
  readonly rows: string[][]
  readonly error: string | null
}

export interface PsqlSession {
  /** The backend PID. Read once at open; a psql session never reconnects here. */
  readonly pid: string
  /** Send one command. Never throws on a SQL error - the error is returned. */
  send(sql: string): Promise<SqlResult>
  /** Send one command and refuse a SQL error. */
  must(sql: string): Promise<string[][]>
  /** Close stdin and wait for the backend to go away. Idempotent. */
  close(): Promise<void>
  /** True until `close()` resolves or the child exits. */
  alive(): boolean
}

/** Every session this process opened and has not yet positively closed. */
const OPEN = new Set<PsqlSession>()

/** Close every session, whatever a test managed to keep hold of. */
export async function closeAllPsqlSessions(): Promise<void> {
  const errs: unknown[] = []
  for (const s of [...OPEN]) {
    try { await s.close() } catch (e) { errs.push(e) }
  }
  if (errs.length) throw errs[0]
}

export function openPsqlSessionCount(): number {
  return OPEN.size
}

export async function openPsqlSession(
  c: DisposableCluster, database: string,
): Promise<PsqlSession> {
  const child: ChildProcessWithoutNullStreams = spawn(PSQL, [
    '--no-psqlrc', '-X', '-q', '-A', '-t', '--pset', 'footer=off',
    '-v', 'ON_ERROR_STOP=0',
    '-h', c.socketDir, '-p', String(c.port), '-U', c.user, '-d', database, '-f', '-',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

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

  let seq = 0
  let queue: Promise<unknown> = Promise.resolve()

  const raw = async (sql: string): Promise<SqlResult> => {
    if (exited) throw new Error('psql session has already exited')
    const tag = `__PSQL_SENTINEL_${++seq}__`
    const startOut = out.length
    const startErr = err.length
    // TERMINATED EXPLICITLY. psql executes a backslash command immediately even
    // when a statement is still buffered, so an unterminated statement would let
    // the sentinel arrive BEFORE the result it is supposed to close.
    const stmt = `${sql.trim().replace(/;+$/, '')};`
    child.stdin.write(`${stmt}\n\\echo ${tag}\n\\warn ${tag}\n`)
    const deadline = Date.now() + 120_000
    for (;;) {
      if (out.slice(startOut).includes(tag) && err.slice(startErr).includes(tag)) break
      if (exited) break
      if (Date.now() > deadline) throw new Error(`psql session timed out on: ${sql.slice(0, 120)}`)
      await new Promise(r => setTimeout(r, 15))
    }
    const bodyOut = out.slice(startOut).split(`${tag}\n`)[0]
    const bodyErr = err.slice(startErr).split(`${tag}\n`)[0]
    const rows = bodyOut.split('\n').filter(l => l !== '').map(l => l.split('|'))
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
    if (r.error !== null) throw new Error(`psql refused "${sql.slice(0, 160)}": ${r.error}`)
    return r.rows
  }

  const pidRows = await (async () => {
    const r = await send('SELECT pg_catalog.pg_backend_pid()')
    if (r.error !== null) throw new Error(`could not read the session pid: ${r.error}`)
    return r.rows
  })()
  const pid = pidRows[0]?.[0]
  if (pid === undefined || !/^\d+$/.test(pid)) {
    throw new Error(`could not read the session pid, got ${JSON.stringify(pidRows)}`)
  }

  const session: PsqlSession = {
    pid,
    send,
    must,
    alive: () => !exited,
    close: async () => {
      if (!exited) {
        try { child.stdin.end() } catch { /* already gone */ }
        const deadline = Date.now() + 15_000
        while (!exited && Date.now() < deadline) await new Promise(r => setTimeout(r, 15))
        if (!exited) {
          // The session is wedged behind a lock it will never get. SIGKILL the
          // CLIENT: the backend then dies on its own, which is exactly the
          // "backend death releases the fence" path the tests exercise.
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
