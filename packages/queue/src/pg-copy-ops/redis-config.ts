// WHERE REDIS IS, WITHOUT A SECRET EVER BEING SOMEWHERE IT CAN BE READ.
//
// `--redis-url` is gone. A URL on a command line is in the process table, in
// shell history, in whatever captured the invocation and in any error that
// echoes argv - and a Redis URL may carry a password. Two forms replace it, and
// neither can put a secret anywhere durable:
//
//   --redis-credential=<absolute 0600 file>   authenticated Redis; the secret
//                                             is read from a reviewed container
//                                             into memory and dropped
//   --redis-host/--redis-port/--redis-db      unauthenticated Redis; this form
//                                             CANNOT express a password, which
//                                             is the point
//
// Only the sanitized triple ever leaves this module.

import { openReviewedContainer } from './secure-file.js'

export class RedisConfigRefused extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'RedisConfigRefused'
  }
}

/** What evidence and bindings are allowed to see. No userinfo field exists. */
export interface SanitizedRedisEndpoint {
  readonly host: string
  readonly port: string
  readonly database: string
}

/** What the adapter connects with. Held in memory, never recorded. */
export interface RedisConnection {
  readonly host: string
  readonly port: number
  readonly db: number
  readonly username?: string
  readonly password?: string
}

export interface RedisResolution {
  readonly connection: RedisConnection
  readonly sanitized: SanitizedRedisEndpoint
}

const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$|^\/[^\0]{1,1023}$/

/** The explicit non-secret form. It cannot carry authentication material. */
export function resolveExplicitRedis(
  host: string, port: string, db: string,
): RedisResolution {
  if (!HOST.test(host) || host.includes('@') || host.includes('://')) {
    throw new RedisConfigRefused('the redis host is not in the reviewed form')
  }
  if (!/^[1-9][0-9]{0,4}$/.test(port)) {
    throw new RedisConfigRefused('the redis port is not in the reviewed form')
  }
  if (!/^\d{1,5}$/.test(db)) {
    throw new RedisConfigRefused('the redis database is not in the reviewed form')
  }
  return Object.freeze({
    connection: Object.freeze({ host, port: Number(port), db: Number(db) }),
    sanitized: Object.freeze({ host, port, database: db }),
  })
}

/**
 * The credential-container form.
 *
 * The URL is parsed in memory and the parsed object is dropped when this
 * returns; only the sanitized triple and the connection fields survive, and the
 * connection fields never reach evidence.
 */
export function resolveRedisCredential(path: string): RedisResolution {
  const opened = openReviewedContainer(path)
  const raw = opened.text.endsWith('\n') ? opened.text.slice(0, -1) : opened.text
  if (raw.includes('\n') || raw.includes('\r') || raw.includes('\0')) {
    throw new RedisConfigRefused('the redis credential container is not a single URL')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RedisConfigRefused('the redis credential container is not a single URL')
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new RedisConfigRefused('the redis credential container is not a redis URL')
  }
  const host = url.hostname
  if (!HOST.test(host)) throw new RedisConfigRefused('the redis host is not in the reviewed form')
  const port = url.port === '' ? '6379' : url.port
  const db = url.pathname.length > 1 ? url.pathname.slice(1) : '0'
  if (!/^[1-9][0-9]{0,4}$/.test(port) || !/^\d{1,5}$/.test(db)) {
    throw new RedisConfigRefused('the redis endpoint is not in the reviewed form')
  }
  return Object.freeze({
    connection: Object.freeze({
      host, port: Number(port), db: Number(db),
      ...(url.username === '' ? {} : { username: url.username }),
      ...(url.password === '' ? {} : { password: url.password }),
    }),
    sanitized: Object.freeze({ host, port, database: db }),
  })
}

/** Exactly one form, never both, never neither. */
export function resolveRedis(args: {
  credential?: string; host?: string; port?: string; db?: string
}): RedisResolution {
  const explicit = args.host !== undefined || args.port !== undefined || args.db !== undefined
  if (args.credential !== undefined && explicit) {
    throw new RedisConfigRefused(
      'the redis credential and the explicit endpoint are mutually exclusive')
  }
  if (args.credential !== undefined) return resolveRedisCredential(args.credential)
  if (args.host !== undefined && args.port !== undefined && args.db !== undefined) {
    return resolveExplicitRedis(args.host, args.port, args.db)
  }
  throw new RedisConfigRefused(
    'a redis credential or a complete explicit endpoint is required')
}
