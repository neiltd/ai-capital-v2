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

import { PIPELINE_FILE_VAR, PIPELINE_URL_VAR, requirePipelineCredential } from '../src/env.js'

const SOURCE = fileURLToPath(new URL('../src/env.ts', import.meta.url))

const COMPLETE = 'postgres://ai_capital_pipeline@fake.invalid:5432/fake_db'

describe('requirePipelineCredential', () => {
  it('returns the validated value byte for byte', () => {
    expect(requirePipelineCredential({ PIPELINE_DATABASE_URL: COMPLETE })).toBe(COMPLETE)
  })

  it('refuses when NEITHER source is set', () => {
    expect(() => requirePipelineCredential({})).toThrow(/neither PIPELINE_DATABASE_URL nor PIPELINE_CREDENTIAL_FILE/)
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
      PIPELINE_DATABASE_URL: 'postgres://ai_capital_pipeline@fake.invalid:5432',
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

// TWO EXPLICIT SOURCES, EXACTLY ONE CHOSEN.
//
// This is source SELECTION, not fallback. Both set is a refusal rather than a
// precedence rule: two sources of truth let an operator rotate one and keep
// running on the other without noticing.
describe('XOR source selection', () => {
  const FILE = '/abs/path/pipeline-database.url'
  const neverRead = (): string => { throw new Error('the file must not be read in this case') }

  it('refuses when BOTH sources are set', () => {
    expect(() => requirePipelineCredential(
      { [PIPELINE_URL_VAR]: COMPLETE, [PIPELINE_FILE_VAR]: FILE },
      neverRead,
    )).toThrow(/both PIPELINE_DATABASE_URL and PIPELINE_CREDENTIAL_FILE are set/)
  })

  it('refuses when both are set even if one is EMPTY — presence, not truthiness', () => {
    expect(() => requirePipelineCredential(
      { [PIPELINE_URL_VAR]: '', [PIPELINE_FILE_VAR]: FILE },
      neverRead,
    )).toThrow(/both/)
  })

  it('names no default path when neither is set', () => {
    let message = ''
    try { requirePipelineCredential({}, neverRead) } catch (e) { message = (e as Error).message }
    expect(message).toMatch(/no fallback and no default location/)
    // The message may NAME the things it refuses to use ("a path derived from
    // HOME"); what it must not contain is an actual candidate path.
    expect(message).not.toMatch(/\.config|\/Users\/|~\//)
  })

  it('reads the file only in file mode, and returns its contents validated', () => {
    const seen: string[] = []
    const read = (p: string) => { seen.push(p); return COMPLETE }
    expect(requirePipelineCredential({ [PIPELINE_FILE_VAR]: FILE }, read)).toBe(COMPLETE)
    expect(seen).toEqual([FILE])
  })

  it('does NOT read the file in direct-value mode', () => {
    expect(requirePipelineCredential({ [PIPELINE_URL_VAR]: COMPLETE }, neverRead)).toBe(COMPLETE)
  })

  it('applies the exact role to a file-loaded credential too', () => {
    const wrongRole = () => 'postgres://ai_capital_owner@fake.invalid:5432/fake_db'
    expect(() => requirePipelineCredential({ [PIPELINE_FILE_VAR]: FILE }, wrongRole))
      .toThrow(/must name the ai_capital_pipeline role/)
  })

  it('reports the FILE variable name when file mode fails', () => {
    const bad = () => 'not-a-url'
    expect(() => requirePipelineCredential({ [PIPELINE_FILE_VAR]: FILE }, bad))
      .toThrow(/PIPELINE_CREDENTIAL_FILE/)
  })

  it('NEVER writes the loaded value into process.env', () => {
    const before = { ...process.env }
    requirePipelineCredential({ [PIPELINE_FILE_VAR]: FILE }, () => COMPLETE)
    expect({ ...process.env }).toEqual(before)
    expect(process.env[PIPELINE_URL_VAR]).toBeUndefined()
    expect(process.env[PIPELINE_FILE_VAR]).toBeUndefined()
  })
})

describe('the exact role is required of the pipeline credential', () => {
  it.each([
    'postgres://ai_capital_owner@fake.invalid:5432/fake_db',
    'postgres://ai_capital_dashboard@fake.invalid:5432/fake_db',
  ])('refuses %s', (url) => {
    expect(() => requirePipelineCredential({ [PIPELINE_URL_VAR]: url }))
      .toThrow(/must name the ai_capital_pipeline role/)
  })
})
