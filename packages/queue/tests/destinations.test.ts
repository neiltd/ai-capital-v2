import { describe, it, expect } from 'vitest'
import { resolveRedisEndpoint, canonicalPath, isInsideProductionRepo, DestinationError } from '../src/destinations.js'

// Adversarial destination cases.
//
// Every URL in PRODUCTION_FORMS defeated the previous string blocklist and
// reached the real production Redis holding the 228 parked incident jobs. The
// resolver judges the RESOLVED endpoint, so all of them collapse to loopback.

const PRODUCTION_FORMS = [
  'redis://localhost:6379',
  'redis://127.0.0.1:6379',
  'redis://[::1]:6379',
  'redis://localhost:6379/',
  'REDIS://LOCALHOST:6379',
  'redis://localhost',                       // default port is 6379
  'redis://127.0.0.1',
  'redis://0.0.0.0:6379',
  'redis://localhost:6379?x=1',              // query string defeated the old anchor
  'redis://@localhost:6379',                 // empty userinfo
  'redis://127.1:6379',                      // short-form loopback
  'redis://2130706433:6379',                 // integer-form loopback
  'redis://[0:0:0:0:0:0:0:1]:6379',          // expanded IPv6 loopback
  'redis://localhost.:6379',                 // FQDN root dot
  'rediss://localhost:6379',                 // TLS scheme
  'redis+tls://localhost:6379',
  'redis://user:pass@localhost:6379',
  'redis://localhost:6379#frag',
]

describe('production Redis is detected however it is spelled', () => {
  it.each(PRODUCTION_FORMS)('%s resolves to production', async url => {
    const ep = await resolveRedisEndpoint(url)
    expect(ep.isProduction, `${url} -> ${ep.addresses.join(',')}:${ep.port}`).toBe(true)
  })

  it('the machine\'s own hostname is production too', async () => {
    // Resolves to a LAN address as well as loopback; ANY production address counts.
    const ep = await resolveRedisEndpoint('redis://Thanapols-MacBook-Pro.local:6379')
    expect(ep.isProduction).toBe(true)
  })

  it('a unix socket is treated as local', async () => {
    expect((await resolveRedisEndpoint('unix:///tmp/redis.sock')).isProduction).toBe(true)
  })
})

describe('genuinely isolated endpoints are allowed', () => {
  it.each([
    'redis://127.0.0.1:6399',
    'redis://localhost:6399',
    'redis://[::1]:6399',
  ])('%s is isolated', async url => {
    expect((await resolveRedisEndpoint(url)).isProduction).toBe(false)
  })
})

describe('undeterminable destinations FAIL CLOSED', () => {
  it('refuses an empty URL', async () => {
    await expect(resolveRedisEndpoint('')).rejects.toThrow(DestinationError)
  })
  it('refuses an unresolvable host', async () => {
    await expect(resolveRedisEndpoint('redis://nonexistent.invalid:6399')).rejects.toThrow(/cannot resolve/)
  })
  it('refuses a non-redis scheme', async () => {
    await expect(resolveRedisEndpoint('http://localhost:6379')).rejects.toThrow(/unsupported Redis scheme/)
  })
  it('refuses an unparseable URL', async () => {
    await expect(resolveRedisEndpoint('not a url')).rejects.toThrow(DestinationError)
  })
})

describe('filesystem targets are canonicalised, not string-matched', () => {
  const REPO = '/Users/thanapold/Desktop/Projects.nosync'

  it('a RELATIVE path resolves against cwd — which IS production inside the repo', () => {
    const prev = process.cwd()
    try {
      process.chdir(REPO)
      // The old prefix check accepted this; it is the production database.
      expect(isInsideProductionRepo('data/pipeline-runs.db')).toBe(true)
    } finally { process.chdir(prev) }
  })

  it('a path traversing .. back into the repo is caught', () => {
    expect(isInsideProductionRepo(`${REPO}/apps/../data/pipeline-runs.db`)).toBe(true)
  })

  it('the repo root itself is production, not merely paths under data/', () => {
    expect(isInsideProductionRepo(REPO)).toBe(true)
    expect(isInsideProductionRepo(`${REPO}/anything.db`)).toBe(true)
  })

  it('a genuinely outside path is isolated', () => {
    expect(isInsideProductionRepo('/tmp/iso/pipeline-runs.db')).toBe(false)
  })

  it('canonicalPath returns an absolute path', () => {
    expect(canonicalPath('data/x.db').startsWith('/')).toBe(true)
  })
})
