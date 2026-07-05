// Simple in-memory fixed-window rate limiter — single-user local app, no
// external dependency needed. Mirrors the pattern used in api/ask/route.ts,
// pulled out into a shared module so routes don't each duplicate the counter.

interface Bucket {
  count: number
  windowStart: number
}

const buckets = new Map<string, Bucket>()

export interface RateLimitOptions {
  limit?: number
  windowMs?: number
}

/**
 * Returns true if the request identified by `key` should be ALLOWED
 * (and increments its counter), false if it has exceeded the limit
 * for the current window.
 */
export function checkRateLimit(key: string, opts?: RateLimitOptions): boolean {
  const limit = opts?.limit ?? 5
  const windowMs = opts?.windowMs ?? 60_000

  const now = Date.now()
  const bucket = buckets.get(key)

  if (!bucket || now - bucket.windowStart > windowMs) {
    buckets.set(key, { count: 1, windowStart: now })
    return true
  }

  bucket.count++
  if (bucket.count > limit) {
    return false
  }
  return true
}
