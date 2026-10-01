// K7-B4: the driver-credential grammar.
//
// This decides WHICH DATABASE A PRODUCTION COPY WRITES TO, from operator input,
// so every ambiguity is refused rather than corrected. The export-role reader
// cannot do this job: it hard-refuses any authority not starting with `/`, so
// the reviewed TCP target credential does not parse there at all.
import { describe, expect, it } from 'vitest'
import {
  DriverCredentialRefused, parseDriverCredentialUrl,
} from '../src/pg-copy/driver-credential.js'

const SECRET = 'sUp3r-s3cret-pw'
const TCP = `postgresql://ai_capital_owner:${SECRET}@127.0.0.1:5433/ai_capital_v3`
const SOCKET =
  `postgresql://ai_capital_v3_export:${SECRET}@/ai_capital` +
  '?host=%2FUsers%2Fthanapold%2Fai-capital-v3-run&port=5433'

describe('K7-B4: accepted forms', () => {
  it('accepts the reviewed TCP form', () => {
    expect(parseDriverCredentialUrl(TCP)).toEqual({
      form: 'tcp', user: 'ai_capital_owner', password: SECRET,
      database: 'ai_capital_v3', host: '127.0.0.1', port: 5433,
    })
  })

  it('accepts the reviewed socket form, decoding the socket directory', () => {
    const p = parseDriverCredentialUrl(SOCKET)
    expect(p.form).toBe('socket')
    expect(p.host).toBe('/Users/thanapold/ai-capital-v3-run')
    expect(p.port).toBe(5433)
    expect(p.database).toBe('ai_capital')
    expect(p.user).toBe('ai_capital_v3_export')
  })

  it('accepts a percent-encoded password without altering it', () => {
    const odd = 'p@ss:w%2Frd'
    const p = parseDriverCredentialUrl(
      `postgresql://u:${encodeURIComponent(odd)}@127.0.0.1:5432/d`)
    expect(p.password).toBe(odd)
  })
})

describe('K7-B4: refusals', () => {
  const bad: Array<[string, string]> = [
    ['an empty string', ''],
    ['another scheme', 'postgres://u:p@127.0.0.1:5432/d'],
    ['a fragment', 'postgresql://u:p@127.0.0.1:5432/d#frag'],
    ['no userinfo', 'postgresql://127.0.0.1:5432/d'],
    ['no password', 'postgresql://u@127.0.0.1:5432/d'],
    ['an empty password', 'postgresql://u:@127.0.0.1:5432/d'],
    ['an empty username', 'postgresql://:p@127.0.0.1:5432/d'],
    ['no database', 'postgresql://u:p@127.0.0.1:5432'],
    ['an empty database', 'postgresql://u:p@127.0.0.1:5432/'],
    ['a nested database path', 'postgresql://u:p@127.0.0.1:5432/a/b'],
    ['a duplicate port parameter', 'postgresql://u:p@/d?host=%2Fs&port=1&port=2'],
    ['an unknown parameter', 'postgresql://u:p@/d?host=%2Fs&port=1&sslmode=require'],
    ['a query parameter on the TCP form', 'postgresql://u:p@127.0.0.1:5432/d?port=1'],
    ['a non key=value parameter', 'postgresql://u:p@/d?host'],
    ['a socket host that is not absolute', 'postgresql://u:p@/d?host=sock&port=1'],
    ['a socket form missing port', 'postgresql://u:p@/d?host=%2Fs'],
    ['port zero', 'postgresql://u:p@127.0.0.1:0/d'],
    ['a port above 65535', 'postgresql://u:p@127.0.0.1:65536/d'],
    ['a non-canonical port', 'postgresql://u:p@127.0.0.1:05432/d'],
    ['a signed port', 'postgresql://u:p@127.0.0.1:+5432/d'],
    ['a non-numeric port', 'postgresql://u:p@127.0.0.1:abc/d'],
    ['embedded whitespace', 'postgresql://u:p@127.0.0.1:5432/d e'],
    ['a NUL', 'postgresql://u:p@127.0.0.1:5432/d\u0000'],
    ['a CR', 'postgresql://u:p@127.0.0.1:5432/d\r'],
    ['two lines', 'postgresql://u:p@127.0.0.1:5432/d\npostgresql://u:p@h:1/d'],
    ['KEY=value keyword syntax', 'host=127.0.0.1 port=5432 dbname=d user=u password=p'],
    ['invalid percent encoding', 'postgresql://u:p%ZZ@127.0.0.1:5432/d'],
    ['a bracketed host', 'postgresql://u:p@[::1]:5432/d'],
    ['no host:port on the TCP form', 'postgresql://u:p@127.0.0.1/d'],
  ]
  for (const [what, url] of bad) {
    it(`refuses ${what}`, () => {
      expect(() => parseDriverCredentialUrl(url)).toThrow(DriverCredentialRefused)
    })
  }

  it('NEVER echoes the URL, the userinfo or the password in an error', () => {
    // An error string reaches logs, evidence and test output. A digest would
    // still be a function of the secret, so there is none either.
    for (const url of [
      `postgresql://u:${SECRET}@127.0.0.1:99999/d`,
      `postgresql://u:${SECRET}@127.0.0.1:5432/d#f`,
      `postgresql://u:${SECRET}@/d?host=%2Fs&port=1&port=2`,
    ]) {
      const err = (() => {
        try { parseDriverCredentialUrl(url); return null } catch (e) { return e as Error }
      })()
      expect(err).toBeInstanceOf(DriverCredentialRefused)
      const text = `${err?.message ?? ''}|${String(err)}|${JSON.stringify(err)}`
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(url)
      expect(text).not.toContain('127.0.0.1')
    }
  })
})
