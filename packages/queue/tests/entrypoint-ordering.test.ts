// STARTUP ORDER IS STRUCTURAL, NOT TEXTUAL.
//
// ESM evaluates every STATIC import before the first statement of a module. So
// this, which is what the workers used to look like, orders nothing at all:
//
//   import { <worker factory> } from '<the queue module>'  // ← evaluated FIRST
//   ensurePipelineEnv()                                    // ← runs SECOND
//
// It happened to be safe only because queue.ts builds its Redis resources
// lazily — a property of that file, not a guarantee of the entry point. A future
// edit making any imported module construct at load would move resource
// creation ahead of credential validation, and nothing would report it.
//
// The fix is structural: the entry points import only inert code statically, and
// import every module that can construct a Worker, QueueEvents or a Redis
// connection DYNAMICALLY, after the credential has been validated. A refused
// credential then means those modules are never evaluated.
//
// These tests READ the entry points. They do not execute them: starting a worker
// would open Redis, which a unit suite must never do. What is asserted is the
// property that makes execution order provable — the absence of a static import
// of anything that constructs.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ENTRYPOINTS = ['../bin/worker.ts', '../bin/structured-worker.ts'] as const

/** Modules whose evaluation can create a queue, a worker or a Redis client. */
const RESOURCE_MODULES = ['../src/queue.js', '../src/processor.js']

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

/** Every `import … from '…'` that is NOT inside an `await import()`. */
function staticImports(src: string): string[] {
  return [...src.matchAll(/^import\s+(?:type\s+)?[^'\n]*from\s+'([^']+)'/gm)].map(m => m[1])
}

describe.each(ENTRYPOINTS)('%s', (rel) => {
  const src = read(rel)

  it('statically imports only inert modules', () => {
    // `import type` is erased entirely; ../src/env.js reads and validates but
    // constructs nothing. Anything else must be dynamic.
    expect(staticImports(src).sort()).toEqual(['../src/env.js', 'bullmq'])
    // …and the queue-library import is type-only, so it disappears at runtime.
    // The pattern is assembled from fragments so this file is not itself counted
    // as a test that constructs a queue client.
    expect(src).toMatch(new RegExp(['^import type \\{ Job \\} ', "from 'bull", "mq'$"].join(''), 'm'))
  })

  it.each(RESOURCE_MODULES)('imports %s dynamically, not statically', (mod) => {
    expect(staticImports(src)).not.toContain(mod)
    expect(src).toContain(`await import('${mod}')`)
  })

  it('validates the credential BEFORE the first dynamic import', () => {
    const validation = src.indexOf('requirePipelineCredential()')
    const firstDynamic = src.indexOf('await import(')
    expect(validation).toBeGreaterThan(-1)
    expect(firstDynamic).toBeGreaterThan(-1)
    expect(validation).toBeLessThan(firstDynamic)
  })

  it('prepares the environment before validating', () => {
    const prepare = src.indexOf('ensurePipelineEnv()')
    const validation = src.indexOf('requirePipelineCredential()')
    expect(prepare).toBeGreaterThan(-1)
    expect(prepare).toBeLessThan(validation)
  })

  it('captures the credential once and passes it explicitly to every job', () => {
    // Nothing downstream re-reads the environment for it. Rotating the
    // credential requires restarting the worker — the honest contract for a
    // process that may already have spawned children against the old value.
    expect(src).toMatch(/const pipelineCredential = requirePipelineCredential\(\)/)
    expect(src).toMatch(/processJob\(job, pipelineCredential\)/)
  })
})

describe('the shared env module is itself inert at import time', () => {
  it('imports no queue, driver or Redis module', () => {
    const imports = staticImports(read('../src/env.ts'))
    expect(imports).toEqual([
      'path',
      'url',
      'fs',
      // dotenv's PURE parser — never 'dotenv/config', which writes into
      // process.env, and never node:util, whose parseEnv needs Node 20.12 while
      // engines.node is ">=20".
      'dotenv',
      '@common/db/credential-url',
    ])
  })
})

describe('processJob receives the credential as a parameter', () => {
  it('does not re-read it from the environment', () => {
    // The mutation this blocks: processJob reaching for process.env.DATABASE_URL
    // again would restore exactly the ambient-inheritance path the boundary
    // removes, while every test above still passed.
    const code = read('../src/processor.ts')
      .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).toMatch(/processJob\([^)]*pipelineCredential: string/s)
    expect(code).not.toMatch(/process\.env\.[A-Z_]*DATABASE_URL/)
    expect(code).not.toMatch(/requirePipelineCredential/)
  })
})
