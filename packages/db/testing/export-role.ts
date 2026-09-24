// Provision and tear down the export role on a DISPOSABLE cluster.
//
// This is the harness, not the product: it supplies the connection arguments and
// the secret root, and everything it does with them comes from
// src/pg-copy/export-role.ts. Nothing here builds SQL, derives a verifier or
// formats a URL - if it did, the tests would be proving the harness correct
// instead of the module.

import {
  closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EXPORT_ROLE_NAME, createExportRoleSql, dropExportRoleSql,
  buildExportCredentialUrl, deriveScramSha256Verifier, generateExportSecret,
  publishExportCredential, removeExportCredential, runExportRoleBatch,
  type BatchOutcome,
} from '../src/pg-copy/export-role.js'
import {
  CENSUS_COLUMNS_SQL, CENSUS_DATABASE_SQL, CENSUS_DEFAULT_ACLS_SQL, CENSUS_MEMBERSHIPS_SQL,
  CENSUS_RELATIONS_SQL, CENSUS_ROLCONFIG_SQL, CENSUS_ROLES_SQL, CENSUS_SCHEMAS_SQL,
  censusJson, type RawCensus,
} from '../src/pg-copy/acl-census.js'
import { FIELD_SEP, PSQL, type DisposableCluster } from './disposable-cluster.js'
import { openPsqlSession, type PsqlSession } from './psql-session.js'

export const CREDENTIAL_FILENAME = 'export.url'

/**
 * Make the disposable cluster demand a real password from the export role.
 *
 * `startDisposableCluster` uses `--auth=trust`, which is right for a throwaway
 * harness and fatal for these tests: under trust, "the wrong password is
 * refused" passes without any password being checked at all. The rule is
 * PREPENDED because pg_hba.conf is first-match-wins - appended after the trust
 * line it would be dead, and the test would go green for the wrong reason.
 */
export async function requireScramForExportRole(c: DisposableCluster): Promise<void> {
  const hba = join(c.pgdata, 'pg_hba.conf')
  const current = readFileSync(hba, 'utf-8')
  const rule = `local all ${EXPORT_ROLE_NAME} scram-sha-256`
  if (!current.startsWith(rule)) writeFileSync(hba, `${rule}\n${current}`, 'utf-8')
  await c.sql('SELECT pg_catalog.pg_reload_conf()')
}

/** psql connection selection ONLY. No -c, no -v, no -f. */
export function adminPsqlArgs(c: DisposableCluster, database: string): string[] {
  return [
    '--no-psqlrc', '-X', '-q', '-A', '-t', '-F', FIELD_SEP,
    '-h', c.socketDir, '-p', String(c.port), '-U', c.user, '-d', database,
  ]
}

/** Every secret root this process created and has not yet removed. */
const SECRET_ROOTS = new Set<string>()

/**
 * A 0700 secret root outside the repository, as the reviewed design requires.
 *
 * REGISTERED ON CREATION. A credential root that outlives its test is residue
 * holding a URL, which is worse than an empty directory: the residue check would
 * flag it, and until it did, a secret would be sitting in /tmp.
 */
export function makeSecretRoot(): string {
  const base = tmpdir().length > 24 ? '/tmp' : tmpdir()
  const root = mkdtempSync(join(base, 'pgcopy-secret-'))
  mkdirSync(root, { recursive: true, mode: 0o700 })
  SECRET_ROOTS.add(root)
  return root
}

/** Remove every secret root this process created, contents included. */
export function cleanSecretRoots(): void {
  for (const root of [...SECRET_ROOTS]) {
    rmSync(root, { recursive: true, force: true })
    SECRET_ROOTS.delete(root)
  }
}

export async function runBatch(
  c: DisposableCluster, database: string, batch: string,
): Promise<BatchOutcome> {
  // No environment is passed: runExportRoleBatch builds a sterile one itself.
  return await runExportRoleBatch(PSQL, adminPsqlArgs(c, database), batch)
}

export interface ProvisionedExportRole {
  readonly secret: string
  readonly url: string
  readonly credentialPath: string
  readonly secretRoot: string
}

/** Create the role, then publish the credential - in that order, never the reverse. */
export async function provisionExportRole(
  c: DisposableCluster, database: string, secretRoot: string,
): Promise<ProvisionedExportRole> {
  const secret = generateExportSecret()
  const verifier = deriveScramSha256Verifier(secret)
  const outcome = await runBatch(c, database, createExportRoleSql(database, verifier))
  if (!outcome.ok) {
    throw new Error(`the export-role batch exited ${outcome.code}; no credential was published.`)
  }
  const url = buildExportCredentialUrl(
    { socketDir: c.socketDir, port: c.port, database }, secret)
  const credentialPath = publishExportCredential(secretRoot, CREDENTIAL_FILENAME, url)
  return { secret, url, credentialPath, secretRoot }
}

export async function teardownExportRole(
  c: DisposableCluster, database: string, p?: ProvisionedExportRole,
): Promise<BatchOutcome> {
  const outcome = await runBatch(c, database, dropExportRoleSql(database))
  if (outcome.ok && p !== undefined) {
    removeExportCredential(p.credentialPath, p.secretRoot, CREDENTIAL_FILENAME)
  }
  return outcome
}

/** Every connection component, taken from a published credential URL. */
export interface ParsedCredential {
  readonly user: string
  readonly password: string
  readonly database: string
  readonly host: string
  readonly port: string
}

/**
 * Parse a published credential URL into its components.
 *
 * THE TEST PATH MUST GO THROUGH THIS. Authenticating with the secret the
 * provisioner happens to still hold in memory proves the secret works, not that
 * the published file does; if the URL were written for the wrong role, or
 * written malformed, only reading it back would show it.
 *
 * PARSED EXPLICITLY, NOT WITH `new URL`. The reviewed credential is the libpq
 * socket form - `postgresql://user:secret@/db?host=/path&port=N` - whose
 * authority has credentials and an EMPTY host. The WHATWG parser rejects that
 * outright ("Invalid URL"), so using it here would make a correctly written
 * credential unreadable.
 */
export function parseCredentialUrl(url: string): ParsedCredential {
  const PREFIX = 'postgresql://'
  if (!url.startsWith(PREFIX)) {
    throw new Error('the credential URL is not a postgresql URL.')
  }
  const [beforeQuery, query = ''] = url.slice(PREFIX.length).split('?')
  const at = beforeQuery.lastIndexOf('@')
  if (at < 0) throw new Error('the credential URL carries no credentials.')
  const userinfo = beforeQuery.slice(0, at)
  const hostAndPath = beforeQuery.slice(at + 1)
  if (!hostAndPath.startsWith('/')) {
    throw new Error('the credential URL is not the reviewed socket form.')
  }
  const colon = userinfo.indexOf(':')
  if (colon < 0) throw new Error('the credential URL carries no password.')
  const params = new URLSearchParams(query)
  const host = params.get('host')
  const port = params.get('port')
  const database = decodeURIComponent(hostAndPath.slice(1))
  const user = decodeURIComponent(userinfo.slice(0, colon))
  const password = decodeURIComponent(userinfo.slice(colon + 1))
  if (host === null || port === null || database === '' || user === '' || password === '') {
    throw new Error('the credential URL is missing a required component.')
  }
  return { user, password, database, host, port }
}

/**
 * A 0600 pgpass file built from PARSED credential components, so the secret
 * reaches psql through a FILE and never through argv or the child environment.
 */
export function writePassfileFromCredential(
  secretRoot: string, cred: ParsedCredential, name = 'export.pgpass',
): string {
  const esc = (v: string): string => v.replace(/([\\:])/g, '\\$1')
  const line = `${esc(cred.host)}:${cred.port}:${esc(cred.database)}:` +
               `${esc(cred.user)}:${esc(cred.password)}\n`
  const path = join(secretRoot, name)
  const fd = openSync(path, 'wx', 0o600)
  try { writeSync(fd, line) } finally { closeSync(fd) }
  return path
}

/** Read the published file and derive everything from it. */
export function readPublishedCredential(credentialPath: string): ParsedCredential {
  return parseCredentialUrl(readFileSync(credentialPath, 'utf-8'))
}

/** A session authenticated AS the export role, over the private socket. */
export async function openExportSession(
  c: DisposableCluster, database: string, passfile: string, user = EXPORT_ROLE_NAME,
): Promise<PsqlSession> {
  return await openPsqlSession(c, database, { user, passfile })
}

export async function takeCensus(
  s: PsqlSession, excludeRoleExactly?: string,
): Promise<string> {
  const raw: RawCensus = {
    roles: await s.must(CENSUS_ROLES_SQL),
    rolconfig: await s.must(CENSUS_ROLCONFIG_SQL),
    memberships: await s.must(CENSUS_MEMBERSHIPS_SQL),
    database: await s.must(CENSUS_DATABASE_SQL),
    schemas: await s.must(CENSUS_SCHEMAS_SQL),
    relations: await s.must(CENSUS_RELATIONS_SQL),
    columns: await s.must(CENSUS_COLUMNS_SQL),
    defaultAcls: await s.must(CENSUS_DEFAULT_ACLS_SQL),
  }
  return censusJson(raw, excludeRoleExactly === undefined ? {} : { excludeRoleExactly })
}
