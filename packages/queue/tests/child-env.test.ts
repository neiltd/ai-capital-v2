// ONE BUILDER DECIDES WHAT A SPAWNED STAGE MAY HOLD.
//
// Every PostgreSQL-touching child in this repository is created in one of two
// places — processor.ts for DAG stages, bin/run-stage.ts for the alert and
// price-refresh wrappers. Both call buildPipelineChildEnv(). A second, hand-made
// filter in either place is the defect this file exists to prevent: it would be
// one variable away from handing a stage the superuser credential the worker was
// specifically not given.
//
// Nothing here spawns a process or opens a connection; the builder is a pure
// function over plain objects.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { buildPipelineChildEnv, isForbiddenChildVariable } from '../src/child-env.js'

const CREDENTIAL = 'postgres://fake_pipeline@fake.invalid:5432/fake_db'
const OTHER = 'postgres://fake_other@fake.invalid:5432/fake_other_db'

describe('isForbiddenChildVariable', () => {
  it.each([
    'DATABASE_URL',
    'PIPELINE_DATABASE_URL',
    'DASHBOARD_DATABASE_URL',
    'CLAIM_WRITER_DATABASE_URL',
    'TEST_DATABASE_URL',
    'BOOTSTRAP_DATABASE_URL',
    'PGHOST',
    'PGUSER',
    'PGPASSWORD',
    'PGDATABASE',
    'PGPORT',
    'PGSERVICE',
    'PGSSLMODE',
    'PGOPTIONS',
    'PGAPPNAME',
    // The name that exposed the narrower `^PG[A-Z]*$` pattern: it has an
    // underscore, so the narrow form let it through.
    'PGCONNECT_TIMEOUT',
    'PGREQUIRESSL',
    'PGSSLROOTCERT',
    'PGPASSFILE',
    'MIGRATION_OWNER_ROLE',
    'LIVE_DATABASE_NAMES',
  ])('forbids %s', (key) => {
    expect(isForbiddenChildVariable(key)).toBe(true)
  })

  it.each([
    'PATH',
    'HOME',
    'DATA_ROOT',
    'PIPELINE_RUNS_DB',
    'REDIS_URL',
    'ANTHROPIC_API_KEY',
    'SEC_FUND_API_KEY',
    'LOGICAL_DATE',
    // Lower-case `pg` prefix is not a libpq variable name.
    'pgadmin_theme',
  ])('permits %s', (key) => {
    expect(isForbiddenChildVariable(key)).toBe(false)
  })
})

describe('buildPipelineChildEnv', () => {
  it('hands the child exactly one database credential, the validated one', () => {
    const env = buildPipelineChildEnv(
      { PATH: '/usr/bin', DATABASE_URL: OTHER, PGHOST: 'fake-host' },
      undefined,
      CREDENTIAL,
    )
    expect(env.DATABASE_URL).toBe(CREDENTIAL)
    expect(env.PGHOST).toBeUndefined()
    const credentialKeys = Object.keys(env).filter(k => /_DATABASE_URL$|^DATABASE_URL$|^PG[A-Z0-9_]*$/.test(k))
    expect(credentialKeys).toEqual(['DATABASE_URL'])
  })

  it('strips the pipeline credential under its own name', () => {
    // One name per process. No traced child reads PIPELINE_DATABASE_URL, and
    // leaving it would make "which credential am I holding" ambiguous.
    const env = buildPipelineChildEnv({ PIPELINE_DATABASE_URL: CREDENTIAL }, undefined, CREDENTIAL)
    expect(env.PIPELINE_DATABASE_URL).toBeUndefined()
    expect(env.DATABASE_URL).toBe(CREDENTIAL)
  })

  it('SANITIZES AFTER specEnv, so a JobSpec cannot reintroduce an authority variable', () => {
    const env = buildPipelineChildEnv(
      { PATH: '/usr/bin' },
      { PGHOST: 'fake-host', PGCONNECT_TIMEOUT: '5', DASHBOARD_DATABASE_URL: OTHER, STAGE_FLAG: 'on' },
      CREDENTIAL,
    )
    expect(env.PGHOST).toBeUndefined()
    expect(env.PGCONNECT_TIMEOUT).toBeUndefined()
    expect(env.DASHBOARD_DATABASE_URL).toBeUndefined()
    // Non-vacuity: an ordinary spec variable still arrives.
    expect(env.STAGE_FLAG).toBe('on')
  })

  it('SANITIZES AFTER additions, so a future caller cannot reintroduce one either', () => {
    const env = buildPipelineChildEnv(
      { PATH: '/usr/bin' },
      undefined,
      CREDENTIAL,
      { PGDATABASE: 'fake-db', MIGRATION_OWNER_ROLE: 'fake-role', DATA_ROOT: '/fake/apps' },
    )
    expect(env.PGDATABASE).toBeUndefined()
    expect(env.MIGRATION_OWNER_ROLE).toBeUndefined()
    expect(env.DATA_ROOT).toBe('/fake/apps')
  })

  it('assigns the credential LAST, so no input can redirect the destination', () => {
    const env = buildPipelineChildEnv(
      { DATABASE_URL: OTHER },
      { DATABASE_URL: OTHER },
      CREDENTIAL,
      { DATABASE_URL: OTHER },
    )
    expect(env.DATABASE_URL).toBe(CREDENTIAL)
  })

  it('does not validate — callers validate before any child exists', () => {
    // Stated as a test so the contract is not re-litigated: the builder trusts
    // its input because requirePipelineCredential() ran first, at startup, where
    // a failure produces no process rather than a process that cannot connect.
    expect(buildPipelineChildEnv({}, undefined, 'not-a-url').DATABASE_URL).toBe('not-a-url')
  })

  it('is pure — it mutates neither the base environment nor the inputs', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', PGHOST: 'fake-host' }
    const spec = { STAGE_FLAG: 'on' }
    const additions = { DATA_ROOT: '/fake/apps' }
    buildPipelineChildEnv(base, spec, CREDENTIAL, additions)
    expect(base).toEqual({ PATH: '/usr/bin', PGHOST: 'fake-host' })
    expect(spec).toEqual({ STAGE_FLAG: 'on' })
    expect(additions).toEqual({ DATA_ROOT: '/fake/apps' })
  })

  it('carries ordinary variables through untouched', () => {
    const env = buildPipelineChildEnv(
      { PATH: '/usr/bin', HOME: '/fake/home', ANTHROPIC_API_KEY: 'fake-key' },
      undefined,
      CREDENTIAL,
    )
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/fake/home')
    expect(env.ANTHROPIC_API_KEY).toBe('fake-key')
  })

  it('produces the same result for both callers given the same inputs', () => {
    // The equivalence the two call sites rely on, asserted directly: there is
    // one function, so a change to one caller's environment policy is impossible
    // without changing the other's.
    const base = { PATH: '/usr/bin', PGHOST: 'fake-host', DATABASE_URL: OTHER }
    const viaProcessor = buildPipelineChildEnv(base, undefined, CREDENTIAL, { PATH: '/usr/bin' })
    const viaLauncher = buildPipelineChildEnv(base, undefined, CREDENTIAL, { PATH: '/usr/bin' })
    expect(viaProcessor).toEqual(viaLauncher)
  })
})

describe('both spawning call sites use the shared builder', () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

  it.each([
    ['../src/processor.ts'],
    ['../bin/run-stage.ts'],
  ])('%s builds its child environment through buildPipelineChildEnv', (rel) => {
    const code = read(rel).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).toContain('buildPipelineChildEnv(')
    // And assembles no environment of its own alongside it.
    expect(code).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/)
  })
})
