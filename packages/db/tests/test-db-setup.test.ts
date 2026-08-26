import { describe, it, expect, afterEach } from 'vitest'
import { resolveTestUrl, assertSafeTestTarget } from '../testing/global-setup.js'

// Fail-closed coverage for the test-database bootstrap.
//
// The 2026-08-25 incident happened because a fallback quietly chose production.
// So the property under test here is not "the happy path works" — it is
// "every failure path STOPS rather than falling back to DATABASE_URL".

const saved = { db: process.env.DATABASE_URL, test: process.env.TEST_DATABASE_URL }

afterEach(() => {
  if (saved.db === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = saved.db
  if (saved.test === undefined) delete process.env.TEST_DATABASE_URL
  else process.env.TEST_DATABASE_URL = saved.test
})

describe('resolveTestUrl', () => {
  it('prefers an explicit TEST_DATABASE_URL', () => {
    process.env.TEST_DATABASE_URL = 'postgres://localhost:5432/my_scratch'
    process.env.DATABASE_URL = 'postgres://localhost:5432/ai_capital'
    expect(resolveTestUrl()).toBe('postgres://localhost:5432/my_scratch')
  })

  it('derives a _test database from DATABASE_URL, preserving host, port and user', () => {
    delete process.env.TEST_DATABASE_URL
    process.env.DATABASE_URL = 'postgres://someone@db.internal:5433/ai_capital'
    const derived = new URL(resolveTestUrl())
    expect(derived.pathname).toBe('/ai_capital_test')
    expect(derived.hostname).toBe('db.internal')
    expect(derived.port).toBe('5433')
    expect(derived.username).toBe('someone')
  })

  it('does not double-suffix an already-test database', () => {
    delete process.env.TEST_DATABASE_URL
    process.env.DATABASE_URL = 'postgres://localhost:5432/ai_capital_test'
    expect(new URL(resolveTestUrl()).pathname).toBe('/ai_capital_test')
  })

  it('FAILS CLOSED when neither variable is set — never guesses a database', () => {
    delete process.env.TEST_DATABASE_URL
    delete process.env.DATABASE_URL
    expect(() => resolveTestUrl()).toThrow(/no Postgres host is known/)
    expect(() => resolveTestUrl()).toThrow(/will NOT fall back to DATABASE_URL/)
  })

  it('FAILS CLOSED on a malformed DATABASE_URL', () => {
    delete process.env.TEST_DATABASE_URL
    process.env.DATABASE_URL = 'this is not a url'
    expect(() => resolveTestUrl()).toThrow(/not a parseable URL/)
  })

  it('FAILS CLOSED when DATABASE_URL names no database', () => {
    delete process.env.TEST_DATABASE_URL
    process.env.DATABASE_URL = 'postgres://localhost:5432'
    expect(() => resolveTestUrl()).toThrow(/no database name/)
  })
})

describe('assertSafeTestTarget — the bootstrap must never touch a live database', () => {
  it('refuses the live database outright', () => {
    expect(() => assertSafeTestTarget('postgres://localhost:5432/ai_capital'))
      .toThrow(/points at the LIVE database "ai_capital"/)
  })

  it('refuses percent-encoded spellings of the live name', () => {
    // Same canonicaliser as the pool guard, so the bootstrap cannot be tricked
    // by an encoding the connection layer would decode.
    expect(() => assertSafeTestTarget('postgres://localhost:5432/ai%5Fcapital')).toThrow(/LIVE database/)
    expect(() => assertSafeTestTarget('postgres://localhost:5432/AI_CAPITAL')).toThrow(/LIVE database/)
  })

  it('refuses a URL it cannot canonicalise', () => {
    expect(() => assertSafeTestTarget('nonsense')).toThrow(/could not be canonicalised/)
    expect(() => assertSafeTestTarget('postgres://localhost:5432/ai_capital%00')).toThrow(/could not be canonicalised/)
  })

  it('honours LIVE_DATABASE_NAMES', () => {
    const prev = process.env.LIVE_DATABASE_NAMES
    process.env.LIVE_DATABASE_NAMES = 'ai_capital,other_prod'
    try {
      expect(() => assertSafeTestTarget('postgres://localhost:5432/other_prod')).toThrow(/LIVE database/)
    } finally {
      if (prev === undefined) delete process.env.LIVE_DATABASE_NAMES
      else process.env.LIVE_DATABASE_NAMES = prev
    }
  })

  it('allows a throwaway database and returns its canonical name', () => {
    expect(assertSafeTestTarget('postgres://localhost:5432/ai_capital_test')).toBe('ai_capital_test')
    expect(assertSafeTestTarget('postgres://localhost:5432/scratch')).toBe('scratch')
  })
})
