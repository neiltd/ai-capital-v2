import dns from 'node:dns/promises'
import { resolve as pathResolve, sep } from 'node:path'
import { realpathSync, existsSync } from 'node:fs'

/**
 * ── Canonical destination resolution ───────────────────────────────────────
 *
 * Judge where a connection ACTUALLY GOES, never how the string is spelled.
 *
 * WHY. The first isolation guard was a string blocklist against three literals
 * and one regex. Warden defeated it fifteen ways in a single pass — every one
 * of these reached the real production Redis holding the 228 parked incident
 * jobs:
 *
 *   redis://localhost:6379?x=1     the (\/|$) anchor is defeated by a query string
 *   redis://@localhost:6379        empty userinfo
 *   redis://127.1:6379             short-form loopback
 *   redis://2130706433:6379        integer-form loopback
 *   redis://localhost.:6379        FQDN root dot
 *   redis://<machine>.local:6379   hostname alias
 *   rediss:// redis+tls://         scheme not checked
 *
 * This is the same lesson `packages/db/src/pool.ts` already learned about
 * Postgres: canonicalise first, then judge. A blocklist enumerates spellings an
 * attacker — or an ordinary developer with a slightly different habit — can
 * always extend. `dns.lookup` collapses all of the above to 127.0.0.1 / ::1,
 * because that is what the OS resolver will do when the client actually
 * connects.
 *
 * UNRESOLVABLE MEANS REFUSED. Cannot prove safe must never mean allowed.
 */

/** The port production BullMQ listens on. */
export const PRODUCTION_REDIS_PORT = 6379

/** Addresses that mean "this machine", where the production instance lives. */
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '0.0.0.0', '::'])

export const PRODUCTION_REPO = '/Users/thanapold/Desktop/Projects.nosync'

export class DestinationError extends Error {
  constructor(message: string) { super(message); this.name = 'DestinationError' }
}

export interface RedisEndpoint {
  /** Every address the host resolves to. */
  addresses: string[]
  port: number
  /** True when this endpoint reaches the production queue. */
  isProduction: boolean
  /** Unix socket path, when the URL names one instead of a host. */
  socketPath?: string
}

/**
 * Resolve a Redis URL to the endpoint it will really reach.
 *
 * Throws rather than guessing: an unparseable or unresolvable destination is
 * refused, because a test that cannot prove where it is pointing must not run.
 */
export async function resolveRedisEndpoint(url: string): Promise<RedisEndpoint> {
  const raw = (url ?? '').trim()
  if (!raw) throw new DestinationError('empty Redis URL — cannot determine the destination')

  // Unix sockets bypass host/port entirely and are local by definition.
  if (raw.startsWith('unix:') || raw.startsWith('/')) {
    const socketPath = raw.replace(/^unix:(\/\/)?/, '')
    return { addresses: [], port: 0, isProduction: true, socketPath }
  }

  let parsed: URL
  try {
    // Normalise the scheme so redis:, rediss:, redis+tls: all parse alike;
    // WHATWG URL treats unknown schemes as opaque and will not expose hostname.
    parsed = new URL(raw.replace(/^redis\+tls:/i, 'rediss:'))
  } catch {
    throw new DestinationError(`unparseable Redis URL (${url}) — refusing rather than guessing`)
  }

  if (!/^rediss?:$/i.test(parsed.protocol)) {
    throw new DestinationError(`unsupported Redis scheme "${parsed.protocol}" in ${url}`)
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')  // strip brackets and FQDN root dot
  if (!host) throw new DestinationError(`Redis URL has no host (${url})`)

  const port = parsed.port ? Number(parsed.port) : PRODUCTION_REDIS_PORT   // redis defaults to 6379

  let addresses: string[]
  try {
    const found = await dns.lookup(host, { all: true, verbatim: true })
    addresses = found.map(a => a.address)
  } catch {
    throw new DestinationError(
      `cannot resolve Redis host "${host}" (${url}). An unresolvable destination is refused: ` +
      'cannot prove safe must never mean allowed.')
  }
  if (addresses.length === 0) throw new DestinationError(`Redis host "${host}" resolved to nothing (${url})`)

  const isProduction = port === PRODUCTION_REDIS_PORT && addresses.some(a => LOCAL_ADDRESSES.has(a))
  return { addresses, port, isProduction }
}

/**
 * Canonicalise a filesystem path.
 *
 * `path.resolve` handles the relative case — a bare `data/pipeline-runs.db` IS
 * the production database when cwd is the repo, which the previous prefix check
 * accepted. `realpath` additionally collapses symlinks and `..`, so a path like
 * `<repo>/apps/../data/pipeline-runs.db` cannot slip through.
 */
export function canonicalPath(p: string): string {
  const abs = pathResolve(p)
  try { return realpathSync(abs) } catch { return abs }   // may not exist yet; absolute is still better than raw
}

/** True when a path is the production repository or lives inside it. */
export function isInsideProductionRepo(p: string): boolean {
  const canon = canonicalPath(p)
  const repo = canonicalPath(PRODUCTION_REPO)
  return canon === repo || canon.startsWith(repo + sep)
}

/** True when this SQLite path is (or would be) the production run database. */
export function isProductionRunDb(p: string): boolean {
  return isInsideProductionRepo(p)
}

export function pathExists(p: string): boolean {
  return existsSync(canonicalPath(p))
}
