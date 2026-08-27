import { describe, it, expect } from 'vitest'
import { requireIsolation, IsolationError } from '../testing/isolation.js'

// The harness must FAIL CLOSED unless all three destinations are isolated.
//
// The load-bearing case is the one you asked for explicitly: a deliberately
// supplied PRODUCTION Redis destination must be refused under the
// integration-test runtime, not merely discouraged.

const GOOD = {
  REDIS_URL: 'redis://127.0.0.1:6399',
  PIPELINE_RUNS_DB: '/tmp/iso-test/pipeline-runs.db',
  AI_CAPITAL_ROOT: '/tmp/iso-test',
} as NodeJS.ProcessEnv

describe('production Redis is refused', () => {
  it('rejects the exact production URL', () => {
    expect(() => requireIsolation({ ...GOOD, REDIS_URL: 'redis://localhost:6379' }))
      .toThrow(IsolationError)
  })

  it('rejects every spelling of the production destination', () => {
    for (const url of [
      'redis://localhost:6379',
      'redis://127.0.0.1:6379',
      'redis://[::1]:6379',
      'redis://localhost:6379/',
      'REDIS://LOCALHOST:6379',
      'redis://localhost',          // 6379 is the default port
      'redis://127.0.0.1',
      'redis://0.0.0.0:6379',
    ]) {
      expect(() => requireIsolation({ ...GOOD, REDIS_URL: url }), `should refuse ${url}`)
        .toThrow(IsolationError)
    }
  })

  it('rejects an UNSET REDIS_URL, because the default IS production', () => {
    const { REDIS_URL, ...rest } = GOOD
    void REDIS_URL
    expect(() => requireIsolation(rest as NodeJS.ProcessEnv)).toThrow(/default redis:\/\/localhost:6379/)
  })

  it('accepts a genuinely isolated instance', () => {
    expect(() => requireIsolation(GOOD)).not.toThrow()
    expect(requireIsolation(GOOD).redisUrl).toBe('redis://127.0.0.1:6399')
  })
})

describe('database dimension', () => {
  it('refuses an unset PIPELINE_RUNS_DB', () => {
    const { PIPELINE_RUNS_DB, ...rest } = GOOD
    void PIPELINE_RUNS_DB
    expect(() => requireIsolation(rest as NodeJS.ProcessEnv)).toThrow(/production run database/)
  })
  it('refuses a path inside the production data directory', () => {
    expect(() => requireIsolation({
      ...GOOD, PIPELINE_RUNS_DB: '/Users/thanapold/Desktop/Projects.nosync/data/pipeline-runs.db',
    })).toThrow(/production data directory/)
  })
})

describe('filesystem dimension', () => {
  it('refuses an unset AI_CAPITAL_ROOT', () => {
    const { AI_CAPITAL_ROOT, ...rest } = GOOD
    void AI_CAPITAL_ROOT
    expect(() => requireIsolation(rest as NodeJS.ProcessEnv)).toThrow(/logs, locks and markers/)
  })
  it('refuses the production repository root', () => {
    expect(() => requireIsolation({ ...GOOD, AI_CAPITAL_ROOT: '/Users/thanapold/Desktop/Projects.nosync' }))
      .toThrow(/production repository/)
  })
  it('refuses a path INSIDE the production repository', () => {
    expect(() => requireIsolation({ ...GOOD, AI_CAPITAL_ROOT: '/Users/thanapold/Desktop/Projects.nosync/tmp' }))
      .toThrow(/production repository/)
  })
})

describe('partial isolation is refused, because it is the dangerous case', () => {
  it('database isolated but Redis and filesystem production -> refused', () => {
    // This is the exact 2026-08-27 harness configuration.
    expect(() => requireIsolation({
      PIPELINE_RUNS_DB: '/tmp/iso/db.sqlite',
      REDIS_URL: 'redis://localhost:6379',
      AI_CAPITAL_ROOT: '/Users/thanapold/Desktop/Projects.nosync',
    })).toThrow(IsolationError)
  })
  it('two of three is still refused', () => {
    expect(() => requireIsolation({ ...GOOD, AI_CAPITAL_ROOT: '/Users/thanapold/Desktop/Projects.nosync' }))
      .toThrow(IsolationError)
  })
})
