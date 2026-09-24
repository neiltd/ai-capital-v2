// The temporary read-only principal Stage 1 authenticates as, and its whole
// lifecycle: secret, verifier, role, grants, credential file, teardown.
//
// WHY A TEMPORARY ROLE AT ALL. The copy needs to read the source, and the roles
// that already exist can either write it or own it. A principal that exists only
// for the duration of one copy, holding exactly the reads that copy performs, is
// the smallest thing that can do the job - and, because it is torn down, the
// smallest thing that has to be proved gone afterwards.
//
// WHY THE READ SURFACE IS NOT "THE 21 TABLES". Stage 1 runs the schema contract,
// and `MIGRATIONS_SQL` reads `db.schema_migrations`. Claiming the role reads only
// the copied tables while handing it that query would be a claim contradicted by
// the first thing it does. So the surface is stated exactly: the 21 tables, two
// COLUMNS of the migration ledger, and nothing else. A column-level grant hides
// the values of every other column - it does NOT hide `count(*)`, and nothing
// here claims otherwise.
//
// WHY NO SEQUENCE PRIVILEGE. Sequence DEFINITION comes from
// `pg_catalog.pg_sequence`, which is ordinary catalogue metadata. Sequence STATE
// - `last_value`, `is_called` - comes only from the supervisor session that owns
// the S3 fences, through `readFencedSequenceState`. Granting the export role a
// sequence privilege would let a fenced copy read a position nothing was holding
// still, and `USAGE` would additionally let it call `nextval()`.

import { createHmac, createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, unlinkSync, writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { COPY_TABLES } from './schema-contract.js'

export class ExportRoleRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportRoleRefused'
  }
}

// ---------------------------------------------------------------------------
// The reviewed authority
// ---------------------------------------------------------------------------

/** Fixed. Nothing about this name is derived from input. */
export const EXPORT_ROLE_NAME = 'ai_capital_v3_export'

/**
 * The schemas the reviewed objects live in, plus the ledger's own schema, plus
 * `public`.
 *
 * WHY `public` IS ON THIS LIST. `capital.chunks.embedding` is a `public.vector`,
 * and the content digest calls that type's `vector_send` - which also lives in
 * `public`. Without USAGE there the digest fails with "permission denied for
 * schema public", which is how this was found: an earlier revision listed the
 * five object schemas plus `db`, and the claim that the manifest queries worked
 * had never executed the digest query at all.
 *
 * USAGE on a schema is not access to anything in it. Every table still needs its
 * own SELECT grant, and the denial matrix proves every relation outside the
 * reviewed 21 is refused - `public` included.
 */
export const EXPORT_SCHEMAS: readonly string[] = Object.freeze([
  'briefing', 'capital', 'db', 'graph', 'portfolio', 'public', 'thesis',
])

export const LEDGER_SCHEMA = 'db'
export const LEDGER_TABLE = 'schema_migrations'
export const LEDGER_RELATION = `${LEDGER_SCHEMA}.${LEDGER_TABLE}`
/** Exactly the two columns `MIGRATIONS_SQL` names. */
export const LEDGER_COLUMNS: readonly string[] = Object.freeze(['filename', 'sha256'])

/** The 21, ascending, from the one copy-set authority. */
export const EXPORT_TABLES: readonly string[] = Object.freeze(
  [...COPY_TABLES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))

const QNAME = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/
const IDENT = /^[a-z_][a-z0-9_]*$/

export function assertIdent(kind: string, v: string): string {
  if (!IDENT.test(v)) throw new ExportRoleRefused(`${kind} "${v}" is not a bare identifier.`)
  return v
}

export function assertQualified(v: string): string {
  if (!QNAME.test(v)) throw new ExportRoleRefused(`"${v}" is not a bare qualified name.`)
  return v
}

// ---------------------------------------------------------------------------
// Secret and SCRAM verifier
// ---------------------------------------------------------------------------

export const EXPORT_SECRET_BYTES = 32

/**
 * A fresh secret, in process memory. Never accepted from argv or env.
 *
 * ENCODED, NOT SAMPLED. An earlier revision walked the random bytes and indexed
 * a 64-character alphabet with `b & 0x3f`, which keeps only the low six bits of
 * each byte: 32 bytes in, 192 bits out, and the top two bits of every byte
 * discarded. `toString('base64url')` encodes all 256 bits into 43 unpadded
 * characters over the same alphabet, so the output looks identical and is a
 * quarter again as strong.
 *
 * base64url is the right alphabet twice over: every character is unreserved in
 * an RFC-3986 userinfo component, so the credential URL needs no escaping and
 * stays byte-stable; and every character is printable ASCII, so SASLprep - which
 * PostgreSQL applies to a password before SCRAM - is the identity function on
 * it. A secret containing anything SASLprep would fold or reject could
 * authenticate here and fail there.
 */
export function generateExportSecret(bytes: number = EXPORT_SECRET_BYTES): string {
  if (bytes < 32) {
    throw new ExportRoleRefused(`an export secret of ${bytes} bytes is below the reviewed 32.`)
  }
  return randomBytes(bytes).toString('base64url')
}

export const SCRAM_ITERATIONS = 4096
export const SCRAM_SALT_BYTES = 16

/**
 * A PostgreSQL-compatible SCRAM-SHA-256 verifier.
 *
 *   SaltedPassword = PBKDF2-HMAC-SHA256(secret, salt, 4096)
 *   ClientKey      = HMAC(SaltedPassword, "Client Key")
 *   StoredKey      = SHA256(ClientKey)
 *   ServerKey      = HMAC(SaltedPassword, "Server Key")
 *
 * The server stores only StoredKey and ServerKey, so deriving here and sending
 * the verifier means the plaintext never crosses the wire and never reaches the
 * server log - which is the point of doing this locally rather than letting
 * `CREATE ROLE ... PASSWORD 'plaintext'` do it.
 */
export function deriveScramSha256Verifier(
  secret: string,
  salt: Buffer = randomBytes(SCRAM_SALT_BYTES),
  iterations: number = SCRAM_ITERATIONS,
): string {
  if (salt.length < SCRAM_SALT_BYTES) {
    throw new ExportRoleRefused(`a ${salt.length}-byte salt is below the reviewed ${SCRAM_SALT_BYTES}.`)
  }
  const saltedPassword = pbkdf2Sync(secret, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest()
  const verifier =
    `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}` +
    `$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
  assertScramVerifier(verifier)
  return verifier
}

/** Exposed for the RFC 7677 cross-check; not used to build a verifier. */
export function scramSaltedPassword(
  secret: string, salt: Buffer, iterations: number = SCRAM_ITERATIONS,
): Buffer {
  return pbkdf2Sync(secret, salt, iterations, 32, 'sha256')
}

const VERIFIER =
  /^SCRAM-SHA-256\$([1-9][0-9]*):([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2})$/

/**
 * Refuse anything that is not exactly a SCRAM-SHA-256 verifier.
 *
 * This runs BEFORE any SQL is built, which is also what makes the SQL literal
 * safe: the accepted alphabet contains no quote and no backslash, so the
 * verifier cannot end the string it is embedded in. Escaping would be the wrong
 * answer - a verifier that needed escaping is not a verifier.
 */
export function assertScramVerifier(verifier: string): string {
  const m = VERIFIER.exec(verifier)
  if (!m) throw new ExportRoleRefused('the SCRAM verifier is not in the expected format.')
  if (Number(m[1]) !== SCRAM_ITERATIONS) {
    throw new ExportRoleRefused(`the SCRAM verifier uses ${m[1]} iterations, not ${SCRAM_ITERATIONS}.`)
  }
  if (Buffer.from(m[2], 'base64').length < SCRAM_SALT_BYTES) {
    throw new ExportRoleRefused('the SCRAM verifier salt is shorter than the reviewed minimum.')
  }
  if (Buffer.from(m[3], 'base64').length !== 32 || Buffer.from(m[4], 'base64').length !== 32) {
    throw new ExportRoleRefused('a SCRAM-SHA-256 key is not 32 bytes.')
  }
  return verifier
}

// ---------------------------------------------------------------------------
// Lifecycle batches
// ---------------------------------------------------------------------------

/**
 * Silence transaction sampling BEFORE the transaction begins.
 *
 * WHY THIS ONE IS DIFFERENT, AND WHY IT IS NOT `SET LOCAL`.
 * `log_transaction_sample_rate` at 1.0 logs every statement of a sampled
 * transaction regardless of duration - and PostgreSQL decides whether a
 * transaction is sampled AT THE MOMENT IT STARTS. By the time a `SET LOCAL`
 * inside the transaction runs, the die is already cast and the whole
 * transaction, `CREATE ROLE ... PASSWORD` included, is being logged. So this
 * setting has to be changed while no transaction is open, which means session
 * scope, which means plain `SET`.
 *
 * That is safe here and nowhere else: `runExportRoleBatch` owns a dedicated,
 * short-lived psql process that exists only for this batch. The setting dies
 * with the connection on success and on failure alike. It is never `ALTER
 * SYSTEM`, and it touches no persistent configuration.
 */
export const TRANSACTION_SAMPLING_SUPPRESSION_SQL = 'SET log_transaction_sample_rate = 0;'

/**
 * Keep the verifier out of the server log, for the length of this transaction.
 *
 * FIVE CHANNELS, NOT ONE. PostgreSQL will write a statement's text from any of
 * them, and silencing only the obvious one leaves the rest open:
 *
 *   log_statement            the statement itself, by category;
 *   log_min_error_statement  the copy logged ALONGSIDE an error - the case that
 *                            matters most, because a failed CREATE ROLE is
 *                            exactly when the text gets written out;
 *   log_min_duration_statement  the copy logged when a statement is "slow";
 *                            at 0 that is every statement;
 *   log_min_duration_sample  the sampled variant, which logs a fraction of
 *                            statements over its own threshold;
 *   log_transaction_sample_rate  every statement of a sampled TRANSACTION,
 *                            handled separately above because it is decided
 *                            before this transaction exists.
 *
 * `log_statement_sample_rate` is set to 0 as well: it governs how much of the
 * duration-sampled channel fires, and leaving it at 1 next to a disabled
 * threshold is a configuration one edit away from logging again.
 *
 * SCOPES, stated exactly, because they differ. FOUR statement-text channels are
 * suppressed transaction-locally by the `SET LOCAL` list below - log_statement,
 * log_min_error_statement, log_min_duration_statement and
 * log_min_duration_sample - and are undone by the COMMIT or ROLLBACK in the same
 * batch. log_transaction_sample_rate is NOT among them: it is suppressed at
 * SESSION scope before BEGIN, by the constant above, because its decision is
 * already made by the time a transaction-local setting could run.
 *
 * log_statement_sample_rate is the odd one out in a different way: it is not a
 * statement-text channel at all, but the fraction governing how much of the
 * duration-sampled channel fires. It is set to zero defensively, so a future
 * edit that re-enables log_min_duration_sample does not immediately start
 * logging. Nothing here changes persistent configuration.
 */
export const LOG_SUPPRESSION_SQL = [
  "SET LOCAL log_statement = 'none';",
  "SET LOCAL log_min_error_statement = 'panic';",
  'SET LOCAL log_min_duration_statement = -1;',
  'SET LOCAL log_min_duration_sample = -1;',
  'SET LOCAL log_statement_sample_rate = 0;',
].join(' ')

/**
 * ONE transactional batch. A half-created role is worse than none: it is a
 * principal nobody reviewed, holding some subset of grants nobody listed.
 */
export function createExportRoleSql(database: string, verifier: string): string {
  assertIdent('database', database)
  assertScramVerifier(verifier)
  const lines = [
    '\\set ON_ERROR_STOP on',
    // BEFORE BEGIN, deliberately: transaction sampling is chosen when the
    // transaction starts, so this is the one channel a SET LOCAL cannot close.
    TRANSACTION_SAMPLING_SUPPRESSION_SQL,
    'BEGIN;',
    // SERVER-LOG CONTAINMENT, before the only statement that carries a verifier.
    // SET LOCAL is transaction-scoped: it is undone by the COMMIT or ROLLBACK
    // below and changes no persistent configuration. `log_min_error_statement`
    // matters as much as `log_statement`: a FAILING CREATE ROLE is echoed into
    // the log with its whole text unless the error threshold is raised above the
    // level the error is reported at.
    LOG_SUPPRESSION_SQL,
    `CREATE ROLE ${EXPORT_ROLE_NAME} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    `  NOBYPASSRLS NOINHERIT NOREPLICATION PASSWORD '${verifier}';`,
    `GRANT CONNECT ON DATABASE ${database} TO ${EXPORT_ROLE_NAME};`,
    ...EXPORT_SCHEMAS.map(s => `GRANT USAGE ON SCHEMA ${assertIdent('schema', s)} TO ${EXPORT_ROLE_NAME};`),
    ...EXPORT_TABLES.map(t => `GRANT SELECT ON ${assertQualified(t)} TO ${EXPORT_ROLE_NAME};`),
    `GRANT SELECT (${LEDGER_COLUMNS.map(c => assertIdent('column', c)).join(', ')})` +
      ` ON ${LEDGER_RELATION} TO ${EXPORT_ROLE_NAME};`,
    'COMMIT;',
  ]
  return `${lines.join('\n')}\n`
}

/** The exact inverse, equally atomic. */
export function dropExportRoleSql(database: string): string {
  assertIdent('database', database)
  const lines = [
    '\\set ON_ERROR_STOP on',
    'BEGIN;',
    `REVOKE SELECT (${LEDGER_COLUMNS.join(', ')}) ON ${LEDGER_RELATION} FROM ${EXPORT_ROLE_NAME};`,
    ...EXPORT_TABLES.map(t => `REVOKE SELECT ON ${t} FROM ${EXPORT_ROLE_NAME};`),
    ...EXPORT_SCHEMAS.map(s => `REVOKE USAGE ON SCHEMA ${s} FROM ${EXPORT_ROLE_NAME};`),
    `REVOKE CONNECT ON DATABASE ${database} FROM ${EXPORT_ROLE_NAME};`,
    `DROP ROLE ${EXPORT_ROLE_NAME};`,
    'COMMIT;',
  ]
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

export interface CredentialTarget {
  readonly socketDir: string
  readonly port: number
  readonly database: string
}

/** The URL, percent-encoded component by component. Never logged. */
export function buildExportCredentialUrl(t: CredentialTarget, secret: string): string {
  assertIdent('database', t.database)
  if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) {
    throw new ExportRoleRefused('the credential port is not a port number.')
  }
  return `postgresql://${encodeURIComponent(EXPORT_ROLE_NAME)}:${encodeURIComponent(secret)}` +
         `@/${encodeURIComponent(t.database)}` +
         `?host=${encodeURIComponent(t.socketDir)}&port=${String(t.port)}`
}

/**
 * The credential name must be one plain basename inside the validated root.
 *
 * `join(root, '../victim')` is a perfectly good path, and it is not in the root.
 * Validating the STRING and then re-deriving the parent from the joined result
 * catches both the obvious traversal and the subtler case where the name is
 * accepted but the file lands one directory up.
 */
export function assertCredentialFilename(secretRoot: string, filename: string): string {
  if (filename === '' || filename === '.' || filename === '..') {
    throw new ExportRoleRefused('the credential filename is not a name.')
  }
  if (isAbsolute(filename) || filename.includes('/') || filename.includes('\\')) {
    throw new ExportRoleRefused('the credential filename must be a single plain basename.')
  }
  const finalPath = join(secretRoot, filename)
  if (resolve(dirname(finalPath)) !== resolve(secretRoot) || basename(finalPath) !== filename) {
    throw new ExportRoleRefused('the credential path is not an immediate child of the secret root.')
  }
  return finalPath
}

/** The post-link steps, named so a failure can say exactly where it stopped. */
export type PublishPhase =
  | 'fsync-parent-1' | 'unlink-temp' | 'fsync-parent-2' | 'lstat' | 'verify'

/**
 * A failure that must not be tidied away: the credential is already published.
 *
 * Carries ONLY the two paths and the phase. No URL, no verifier, no filesystem
 * error text and no file contents - an error raised at this point is going to be
 * logged by whoever catches it, and the whole reason the credential is on disk
 * rather than in a log is that logs travel.
 */
export class CredentialPublishedButUnverified extends ExportRoleRefused {
  constructor(
    readonly finalPath: string,
    readonly temporaryPath: string,
    readonly phase: PublishPhase,
  ) {
    super(
      `the credential was published but failed verification during "${phase}". ` +
      `It has NOT been removed. final=${finalPath} temporary=${temporaryPath}`)
    this.name = 'CredentialPublishedButUnverified'
  }
}

/**
 * The filesystem operations publication performs, as a seam.
 *
 * Every branch after `link` succeeds is a branch that only fires when the
 * filesystem misbehaves, and a test cannot make a real fsync fail on demand.
 * Injecting these is the only way those branches are ever executed; the default
 * is the real `node:fs`, and nothing but a test ever passes anything else.
 */
export interface PublishOps {
  openSync: typeof openSync
  writeSync: typeof writeSync
  fsyncSync: typeof fsyncSync
  fstatSync: typeof fstatSync
  closeSync: typeof closeSync
  linkSync: typeof linkSync
  unlinkSync: typeof unlinkSync
  lstatSync: typeof lstatSync
}

export const REAL_PUBLISH_OPS: PublishOps = {
  openSync, writeSync, fsyncSync, fstatSync, closeSync, linkSync, unlinkSync, lstatSync,
}

/**
 * Publish the URL with a no-clobber link, or publish nothing.
 *
 * WHY link() AND NOT rename(). `rename` OVERWRITES its destination. Checking
 * that the final path is absent and then renaming onto it is a check-then-act
 * race: anything created in the gap - a file, a directory entry, a symlink
 * pointing anywhere - is silently replaced, and the loser of the race never
 * learns it lost. `link` fails with EEXIST instead, so the race has a winner and
 * the loser refuses. The earlier absence check stays, because it turns the
 * common case into a clear error rather than an EEXIST.
 *
 * `lstat`, never `stat`: a dangling symlink at the final path is PRESENT, and
 * following it would write the credential wherever the link points.
 */
export function publishExportCredential(
  secretRoot: string, filename: string, url: string, ops: PublishOps = REAL_PUBLISH_OPS,
): string {
  const st = (() => {
    try { return ops.lstatSync(secretRoot) } catch { return null }
  })()
  if (st === null || !st.isDirectory()) {
    throw new ExportRoleRefused('the secret root is not an existing directory.')
  }
  if (st.isSymbolicLink()) throw new ExportRoleRefused('the secret root is a symlink.')
  if ((st.mode & 0o777) !== 0o700) {
    throw new ExportRoleRefused(`the secret root is mode ${(st.mode & 0o777).toString(8)}, not 700.`)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  if (uid !== -1 && st.uid !== uid) {
    throw new ExportRoleRefused('the secret root is owned by another user.')
  }

  const finalPath = assertCredentialFilename(secretRoot, filename)
  let present = true
  try { ops.lstatSync(finalPath) } catch { present = false }
  if (present) {
    throw new ExportRoleRefused('the credential path already exists; it is never overwritten.')
  }

  const tmpPath = join(secretRoot, `.${filename}.${randomBytes(8).toString('hex')}.tmp`)
  let fd = -1
  let preparedIno = -1
  try {
    fd = ops.openSync(tmpPath, 'wx', 0o600)
    ops.writeSync(fd, url)
    ops.fsyncSync(fd)
    preparedIno = ops.fstatSync(fd).ino
  } catch {
    if (fd !== -1) { try { ops.closeSync(fd) } catch { /* closing a broken fd */ } }
    try { ops.unlinkSync(tmpPath) } catch { /* nothing to remove */ }
    throw new ExportRoleRefused('the credential could not be written; nothing was published.')
  }
  ops.closeSync(fd)

  const syncParent = (): void => {
    const dirFd = ops.openSync(secretRoot, 'r')
    try { ops.fsyncSync(dirFd) } finally { ops.closeSync(dirFd) }
  }

  // THE PUBLICATION POINT. No fallback to rename, at any cost: a fallback would
  // reinstate exactly the overwrite this exists to prevent.
  try {
    ops.linkSync(tmpPath, finalPath)
  } catch {
    try { ops.unlinkSync(tmpPath) } catch { /* nothing to remove */ }
    throw new ExportRoleRefused(
      'the credential could not be published; something already holds that name.')
  }

  // EVERYTHING BELOW IS POST-LINK. The credential exists from here on, so every
  // failure is reported as CredentialPublishedButUnverified with the phase it
  // stopped at, nothing later is attempted, and the published name is never
  // unlinked - including when the TEMPORARY link could not be removed, where
  // both names are deliberately left for someone to look at.
  try {
    syncParent()
  } catch {
    throw new CredentialPublishedButUnverified(finalPath, tmpPath, 'fsync-parent-1')
  }

  try {
    ops.unlinkSync(tmpPath)
  } catch {
    throw new CredentialPublishedButUnverified(finalPath, tmpPath, 'unlink-temp')
  }

  try {
    syncParent()
  } catch {
    throw new CredentialPublishedButUnverified(finalPath, tmpPath, 'fsync-parent-2')
  }

  let fin
  try {
    fin = ops.lstatSync(finalPath)
  } catch {
    throw new CredentialPublishedButUnverified(finalPath, tmpPath, 'lstat')
  }

  if (fin.ino !== preparedIno || !fin.isFile() || fin.isSymbolicLink() ||
      (fin.mode & 0o777) !== 0o600 || fin.nlink !== 1 || (uid !== -1 && fin.uid !== uid)) {
    // NOT removed. A published credential that fails verification is a fact
    // someone has to look at; deleting it destroys the only evidence of how.
    throw new CredentialPublishedButUnverified(finalPath, tmpPath, 'verify')
  }
  return finalPath
}

/** Remove exactly the path that was published, never a pattern. */
export function removeExportCredential(path: string, secretRoot: string, filename: string): void {
  if (path !== assertCredentialFilename(secretRoot, filename)) {
    throw new ExportRoleRefused('the credential path to remove is not the published path.')
  }
  const st = lstatSync(path)
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new ExportRoleRefused('the credential path is not the regular file that was published.')
  }
  unlinkSync(path)
}

// ---------------------------------------------------------------------------
// Batch execution
// ---------------------------------------------------------------------------

/** Argument shapes that would put SQL or a secret where anyone can read it. */
export const FORBIDDEN_PSQL_ARGS: readonly string[] = Object.freeze([
  '-c', '--command', '-v', '--set', '--variable', '-f', '--file',
])

export function assertBatchArgs(args: readonly string[]): readonly string[] {
  for (const a of args) {
    const flag = a.split('=')[0]
    if (FORBIDDEN_PSQL_ARGS.includes(flag)) {
      throw new ExportRoleRefused(
        `psql argument "${flag}" is not permitted for the role lifecycle: SQL and secrets ` +
        'travel on stdin, where a process list cannot read them.')
    }
  }
  if (!args.includes('--no-psqlrc')) {
    throw new ExportRoleRefused('the role lifecycle must run with --no-psqlrc.')
  }
  return args
}

export interface BatchOutcome {
  readonly code: number
  readonly ok: boolean
}

/**
 * The ONLY variables the lifecycle child is allowed to see.
 *
 * Built here rather than filtered from `process.env`, because a deny-list is a
 * list of the leaks someone thought of. An allow-list means a variable nobody
 * anticipated - a new `PG*`, a `*_DATABASE_URL`, a shell export holding a
 * password - simply is not there. Connection identity stays in argv, where it is
 * inert; only the administrator's passfile PATH may enter the environment, and a
 * path is not a credential.
 */
export function sterileBatchEnv(pgPassFile?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LC_ALL: 'C',
    LANG: 'C',
  }
  if (pgPassFile !== undefined) {
    if (!isAbsolute(pgPassFile)) {
      throw new ExportRoleRefused('PGPASSFILE must be an absolute path.')
    }
    env.PGPASSFILE = pgPassFile
  }
  return env
}

/**
 * Send one batch to psql's STDIN and report only how it ended.
 *
 * Captured output is deliberately NOT returned or embedded in the error: the
 * batch contains a SCRAM verifier, and psql echoes a failing statement.
 */
export async function runExportRoleBatch(
  psqlPath: string, args: readonly string[], batch: string, pgPassFile?: string,
): Promise<BatchOutcome> {
  assertBatchArgs(args)
  // The caller cannot hand us an environment to forward: it is constructed here.
  const env = sterileBatchEnv(pgPassFile)
  return await new Promise<BatchOutcome>((res, reject) => {
    const child = spawn(psqlPath, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env })
    child.stdout.resume()
    child.stderr.resume()
    child.on('error', () => reject(new ExportRoleRefused('the role lifecycle process failed to start.')))
    child.on('close', code => res({ code: code ?? -1, ok: code === 0 }))
    child.stdin.end(batch)
  })
}

/** Constant-time comparison, for tests that must not leak by timing. */
export function secretsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
