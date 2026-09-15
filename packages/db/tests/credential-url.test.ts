// THE EXTRACTED VALIDATOR, TESTED AT ITS OWN SEAM.
//
// src/credential-url.ts was carved out of src/pool.ts in slice S4D so the
// pipeline worker in packages/queue could reuse it without pulling the database
// driver into a long-running process. Two things therefore need proving, and
// tests/dashboard-pool.test.ts proves neither:
//
//   1. the rules did not change in the move — that file still passes unmodified,
//      which is the regression evidence; this file pins the rules directly at
//      the new module's own entry point, so a future edit to credential-url.ts
//      cannot quietly relax them;
//   2. the module is IMPORT-INERT and driver-free, which is the entire reason it
//      exists as a separate file.
//
// No test here connects to anything: the validator is a pure function over a
// string and constructs nothing.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { requireExplicitPostgresUrl } from '../src/credential-url.js'

const SOURCE = fileURLToPath(new URL('../src/credential-url.ts', import.meta.url))

/** A complete, explicit, obviously-fake credential. Never a real destination. */
const COMPLETE = 'postgres://fake_role@fake.invalid:5432/fake_db'

describe('requireExplicitPostgresUrl — the rules survived extraction', () => {
  it('returns a complete URL byte for byte', () => {
    const out = requireExplicitPostgresUrl('SOME_VAR', COMPLETE)
    expect(out).toBe(COMPLETE)
  })

  it('preserves percent-encoding rather than normalising it', () => {
    // A rewritten database name is exactly the class of mutation the live-database
    // guard exists to catch, so the returned string must not be reassembled.
    const encoded = 'postgres://fake_role@fake.invalid:5432/fake%5Fdb'
    expect(requireExplicitPostgresUrl('SOME_VAR', encoded)).toBe(encoded)
  })

  it('accepts a Unix-socket target with an explicit ?host= parameter', () => {
    // The WHATWG URL parser THROWS on this shape because the authority is empty.
    // It is a perfectly good destination, and the validator must admit it.
    const socket = 'postgresql://fake_role@/fake_db?host=%2Ftmp%2Ffake-socket'
    expect(requireExplicitPostgresUrl('SOME_VAR', socket)).toBe(socket)
  })

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('refuses a %s value', (_label, value) => {
    expect(() => requireExplicitPostgresUrl('SOME_VAR', value)).toThrow(/SOME_VAR/)
  })

  it('refuses surrounding whitespace rather than trimming it', () => {
    expect(() => requireExplicitPostgresUrl('SOME_VAR', ` ${COMPLETE} `))
      .toThrow(/refused\s+rather than trimmed|leading or trailing whitespace/)
  })

  it.each([
    'file:///etc/passwd',
    'http://fake.invalid/fake_db',
    'redis://fake.invalid:6379',
  ])('refuses the non-PostgreSQL scheme %s', (value) => {
    expect(() => requireExplicitPostgresUrl('SOME_VAR', value)).toThrow(/must be a PostgreSQL URL/)
  })

  it.each([
    // Accepted by the WHATWG parser, names no server at all.
    'postgres:fake',
    'postgres:/fake_db',
  ])('refuses the scheme-relative shape %s', (value) => {
    expect(() => requireExplicitPostgresUrl('SOME_VAR', value)).toThrow(/must be a PostgreSQL URL/)
  })

  it.each([
    ['database', 'postgres://fake_role@fake.invalid:5432'],
    ['user', 'postgres://fake.invalid:5432/fake_db'],
  ])('refuses a URL missing its %s, which the environment would otherwise supply', (field, value) => {
    expect(() => requireExplicitPostgresUrl('SOME_VAR', value)).toThrow(new RegExp(field))
  })

  it('never echoes the credential in an error message', () => {
    // An operator needs to know WHICH variable is wrong. A log needs not to
    // contain the value. Both hold at once only if the message names neither the
    // value nor its parts.
    const bad = ' postgres://secret_role:secret_pw@secret.invalid:5432/secret_db '
    let message = ''
    try {
      requireExplicitPostgresUrl('SOME_VAR', bad)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/SOME_VAR/)
    for (const part of ['secret_role', 'secret_pw', 'secret.invalid', 'secret_db']) {
      expect(message).not.toContain(part)
    }
  })

  it('consults no ambient variable when completing a URL', () => {
    // pinDestination() resolves a missing database through PGDATABASE. This
    // validator must refuse first, so the ambient value is never consulted.
    const prior = process.env.PGDATABASE
    process.env.PGDATABASE = 'ambient_fake_db'
    try {
      expect(() => requireExplicitPostgresUrl('SOME_VAR', 'postgres://fake_role@fake.invalid:5432'))
        .toThrow(/database/)
    } finally {
      if (prior === undefined) delete process.env.PGDATABASE
      else process.env.PGDATABASE = prior
    }
  })
})

describe('the optional exact-role constraint', () => {
  const PIPELINE = 'postgres://ai_capital_pipeline@fake.invalid:5432/fake_db'

  it('accepts the expected role', () => {
    expect(requireExplicitPostgresUrl('SOME_VAR', PIPELINE, { user: 'ai_capital_pipeline' })).toBe(PIPELINE)
  })

  it('accepts a PERCENT-ENCODED spelling of the expected role', () => {
    // Measured, not assumed: pg-connection-string decodes the userinfo, so the
    // comparison must be against the decoded name or a legitimate credential
    // would be refused.
    const encoded = 'postgres://ai%5Fcapital%5Fpipeline@fake.invalid:5432/fake_db'
    expect(requireExplicitPostgresUrl('SOME_VAR', encoded, { user: 'ai_capital_pipeline' })).toBe(encoded)
  })

  it.each([
    'postgres://ai_capital_owner@fake.invalid:5432/fake_db',
    'postgres://ai_capital_dashboard@fake.invalid:5432/fake_db',
    'postgres://postgres@fake.invalid:5432/fake_db',
    'postgres://AI_Capital_Pipeline@fake.invalid:5432/fake_db',
  ])('refuses %s', (url) => {
    expect(() => requireExplicitPostgresUrl('SOME_VAR', url, { user: 'ai_capital_pipeline' }))
      .toThrow(/must name the ai_capital_pipeline role/)
  })

  it('never names the role it actually found', () => {
    let message = ''
    try {
      requireExplicitPostgresUrl('SOME_VAR', 'postgres://secret_role@secret.invalid:5432/secret_db', { user: 'ai_capital_pipeline' })
    } catch (e) { message = (e as Error).message }
    expect(message).toContain('SOME_VAR')
    for (const part of ['secret_role', 'secret.invalid', 'secret_db']) {
      expect(message).not.toContain(part)
    }
  })

  it('is OPT-IN: omitting the constraint leaves every existing caller unchanged', () => {
    // The dashboard pool and the claim writer pass no `expected`; a role that
    // would fail the constraint must still pass without it.
    const other = 'postgres://ai_capital_dashboard@fake.invalid:5432/fake_db'
    expect(requireExplicitPostgresUrl('SOME_VAR', other)).toBe(other)
  })

  it('still applies every other rule when a role is required', () => {
    expect(() => requireExplicitPostgresUrl('SOME_VAR', ' ' + PIPELINE, { user: 'ai_capital_pipeline' }))
      .toThrow(/whitespace/)
    expect(() => requireExplicitPostgresUrl('SOME_VAR', 'postgres://ai_capital_pipeline@fake.invalid:5432', { user: 'ai_capital_pipeline' }))
      .toThrow(/database/)
  })
})

describe('credential-url.ts is driver-free and import-inert', () => {
  it('imports exactly one module, the connection-string reader', () => {
    const src = readFileSync(SOURCE, 'utf-8')
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1])
    expect(imports).toEqual(['pg-connection-string'])
  })

  it('names no database driver, store or pool module', () => {
    const src = readFileSync(SOURCE, 'utf-8')
    // Assembled from fragments so this test file is not itself a match for the
    // repository's own driver-import scans.
    const forbidden = [
      ['from ', "'", 'pg', "'"].join(''),
      ['better', '-sqlite3'].join(''),
      ['@lancedb', '/lancedb'].join(''),
      ['./', 'pool.js'].join(''),
    ]
    for (const token of forbidden) expect(src).not.toContain(token)
  })

  it('reads no environment variable at module scope', () => {
    const src = readFileSync(SOURCE, 'utf-8')
    // The function bodies name PG* variables in prose and in one error message;
    // what must not appear anywhere is an actual read of process.env.
    expect(src).not.toMatch(/process\.env/)
  })
})
