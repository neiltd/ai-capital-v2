// THE WORKER'S CREDENTIAL IS EXPLICIT, SHARED-VALIDATED, AND HAS NO FALLBACK.
//
// requirePipelineCredential() is a thin binding of PIPELINE_DATABASE_URL to the
// canonical validator in @common/db. "Thin" is the claim under test: the queue
// must not acquire its own, weaker, second copy of credential policy — that is
// what slice S4C rejected and what this file prevents from drifting back.
//
// The environment is INJECTED into every case here. Nothing reads or writes the
// real process environment, and nothing connects.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { requirePipelineCredential } from '../src/env.js'

const SOURCE = fileURLToPath(new URL('../src/env.ts', import.meta.url))

const COMPLETE = 'postgres://fake_pipeline@fake.invalid:5432/fake_db'

describe('requirePipelineCredential', () => {
  it('returns the validated value byte for byte', () => {
    expect(requirePipelineCredential({ PIPELINE_DATABASE_URL: COMPLETE })).toBe(COMPLETE)
  })

  it('refuses an unset credential', () => {
    expect(() => requirePipelineCredential({})).toThrow(/PIPELINE_DATABASE_URL/)
  })

  it('does NOT fall back to DATABASE_URL', () => {
    // The whole point of the boundary: a worker started without its own
    // credential must fail, not inherit the one the old plist supplied.
    expect(() => requirePipelineCredential({ DATABASE_URL: COMPLETE }))
      .toThrow(/PIPELINE_DATABASE_URL/)
  })

  it.each([
    ['DASHBOARD_DATABASE_URL', 'the dashboard read-role credential'],
    ['CLAIM_WRITER_DATABASE_URL', 'the claim-writer credential'],
    ['TEST_DATABASE_URL', 'a test credential'],
  ])('does NOT fall back to %s (%s)', (key) => {
    expect(() => requirePipelineCredential({ [key]: COMPLETE }))
      .toThrow(/PIPELINE_DATABASE_URL/)
  })

  it('does NOT accept an incomplete URL completed from PG* variables', () => {
    expect(() => requirePipelineCredential({
      PIPELINE_DATABASE_URL: 'postgres://fake_pipeline@fake.invalid:5432',
      PGDATABASE: 'ambient_fake_db',
      PGUSER: 'ambient_fake_role',
    })).toThrow(/database/)
  })

  it.each([
    ['empty', ''],
    ['whitespace-only', '  '],
    ['whitespace-wrapped', ` ${COMPLETE} `],
    ['a file URL', 'file:///etc/passwd'],
    ['a scheme-relative shape', 'postgres:fake'],
  ])('refuses %s', (_label, value) => {
    expect(() => requirePipelineCredential({ PIPELINE_DATABASE_URL: value }))
      .toThrow(/PIPELINE_DATABASE_URL/)
  })

  it('never echoes the credential in the error message', () => {
    let message = ''
    try {
      requirePipelineCredential({ PIPELINE_DATABASE_URL: ' postgres://secret_role:secret_pw@secret.invalid:5432/secret_db ' })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/PIPELINE_DATABASE_URL/)
    for (const part of ['secret_role', 'secret_pw', 'secret.invalid', 'secret_db']) {
      expect(message).not.toContain(part)
    }
  })

  it('defaults to process.env when no environment is injected', () => {
    // Non-vacuity control for the injected-env cases above: the parameter has a
    // default, and it is the real environment. The isolation setup clears
    // PIPELINE_DATABASE_URL, so this must throw rather than silently pass.
    const prior = process.env.PIPELINE_DATABASE_URL
    delete process.env.PIPELINE_DATABASE_URL
    try {
      expect(() => requirePipelineCredential()).toThrow(/PIPELINE_DATABASE_URL/)
    } finally {
      if (prior !== undefined) process.env.PIPELINE_DATABASE_URL = prior
    }
  })
})

describe('the queue reuses the canonical validator instead of copying it', () => {
  it('imports it from the database package', () => {
    const src = readFileSync(SOURCE, 'utf-8')
    expect(src).toMatch(/import \{ requireExplicitPostgresUrl \} from '@common\/db\/credential-url'/)
  })

  it('declares that dependency, rather than resolving it by workspace accident', () => {
    // An undeclared workspace import resolves under pnpm only because a sibling
    // hoisted it. Declaring it is what makes the import supported.
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
    ) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies?.['@common/db']).toBe('workspace:*')
  })

  it('re-implements no validation of its own', () => {
    const src = readFileSync(SOURCE, 'utf-8')
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    // No second scheme test, no second parser, no trimming of a credential.
    expect(code).not.toMatch(/startsWith\(['"]postgres/)
    expect(code).not.toMatch(/new URL\(/)
    expect(code).not.toMatch(/parseConnectionString|pg-connection-string/)
    expect(code).toContain('requireExplicitPostgresUrl(')
  })
})
