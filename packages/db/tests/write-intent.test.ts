import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { AsyncResource } from 'node:async_hooks'
import type { WriteIntent } from '../src/write-intent.js'
import {
  withProductionWrite, currentWriteIntent, assertProductionWriteAuthorized,
  isProtectedDestination, ProductionWriteRefused, UndeterminableDestination,
} from '../src/write-intent.js'
import { resolveDestination, destinationOf, createPool } from '../src/pool.js'

// The invariant:
//   Possessing a production write credential is not itself sufficient to
//   perform a production write. Production mutation requires explicit intent.
//
// This covers the hole Warden found after the 2026-08-26 remediation: every
// guard until then keyed on `process.env.VITEST`, so OUTSIDE vitest — an
// ad-hoc `tsx` run that sourced .env — nothing was guarded at all.

const PROD = 'postgres://ai_capital_claim_writer@localhost:5432/ai_capital'
const TEST = 'postgres://someone@localhost:5432/ai_capital_test'

describe('production-write intent', () => {
  it('refuses a protected destination when no intent is declared', () => {
    expect(() => assertProductionWriteAuthorized(PROD, 'claim-persistence'))
      .toThrow(ProductionWriteRefused)
  })

  it('names the destination, the operation class, and the absence of authorization', () => {
    // The error is the thing a developer reads at 2am. It has to say what was
    // refused and why, not just "denied".
    try {
      assertProductionWriteAuthorized(PROD, 'claim-persistence')
      throw new Error('should have refused')
    } catch (e) {
      const m = (e as Error).message
      expect(m).toContain('ai_capital')
      expect(m).toContain('claim-persistence')
      expect(m).toContain('ABSENT')
      // and it must promise neither of the two silent failures
      expect(m).toMatch(/nothing was silently redirected/i)
    }
  })

  it('does not gate a throwaway destination — tests need no ceremony', () => {
    expect(isProtectedDestination(TEST)).toBe(false)
    expect(() => assertProductionWriteAuthorized(TEST, 'claim-persistence')).not.toThrow()
  })

  it('allows the write inside a declared scope', async () => {
    await withProductionWrite(
      { operation: 'claim-persistence', context: 'pipeline', reason: 'regression test' },
      async () => { expect(() => assertProductionWriteAuthorized(PROD, 'claim-persistence')).not.toThrow() },
    )
  })

  it('a scope authorizes ONLY its own operation class', async () => {
    // A migration scope must not become a blanket licence to write claims.
    await withProductionWrite(
      { operation: 'migration', context: 'migration', reason: 'regression test' },
      async () => {
        expect(() => assertProductionWriteAuthorized(PROD, 'claim-persistence')).toThrow(ProductionWriteRefused)
        expect(() => assertProductionWriteAuthorized(PROD, 'migration')).not.toThrow()
      },
    )
  })

  it('the scope does not leak after it closes', async () => {
    await withProductionWrite(
      { operation: 'claim-persistence', context: 'admin', reason: 'regression test' },
      async () => { expect(currentWriteIntent()).toBeDefined() },
    )
    expect(currentWriteIntent()).toBeUndefined()
    expect(() => assertProductionWriteAuthorized(PROD, 'claim-persistence')).toThrow(ProductionWriteRefused)
  })

  it('the scope does not leak into a sibling async task', async () => {
    let sawIntentOutside: unknown = 'unset'
    const sibling = new Promise<void>(resolve => {
      setTimeout(() => { sawIntentOutside = currentWriteIntent(); resolve() }, 0)
    })
    await withProductionWrite(
      { operation: 'claim-persistence', context: 'pipeline', reason: 'regression test' },
      async () => { await sibling },
    )
    expect(sawIntentOutside).toBeUndefined()
  })

  it('demands a reason — an authorization nobody can explain is not one', () => {
    expect(() => withProductionWrite(
      { operation: 'claim-persistence', context: 'admin', reason: '  ' }, async () => {},
    )).toThrow(/non-empty `reason`/)
  })

  it('NO environment variable can grant intent', () => {
    // The load-bearing property. Authorization must be ungrantable by .env,
    // because ambient presence of a credential is what caused the incident.
    // If any of these ever authorizes a write, the mechanism has failed.
    const candidates = [
      'ALLOW_WRITES', 'ALLOW_PRODUCTION_WRITE', 'ALLOW_TEST_PRODUCTION_INTENT',
      'PRODUCTION_WRITE', 'WRITE_INTENT', 'FORCE_WRITE', 'CLAIM_WRITER_DATABASE_URL',
    ]
    const saved = candidates.map(k => [k, process.env[k]] as const)
    try {
      for (const k of candidates) process.env[k] = '1'
      expect(() => assertProductionWriteAuthorized(PROD, 'claim-persistence')).toThrow(ProductionWriteRefused)
      expect(currentWriteIntent()).toBeUndefined()
    } finally {
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  })

  it('intent cannot cross a process boundary', () => {
    // An env var would be inherited by every child for free; a call scope is
    // not representable in an environment at all. Assert the shape of that:
    // nothing about the active scope appears in process.env.
    return withProductionWrite(
      { operation: 'claim-persistence', context: 'pipeline', reason: 'boundary check' },
      async () => {
        const serialized = JSON.stringify(process.env)
        expect(serialized).not.toContain('boundary check')
        expect(serialized).not.toContain('claim-persistence')
      },
    )
  })
})

// ── Warden's bypasses, 2026-08-26. Each of these DEFEATED the first version. ──
describe('bypasses Warden proved against the first gate', () => {
  it('W-1: an EMPTY destination fails closed instead of skipping the gate', () => {
    // `const destination = url ?? process.env.DATABASE_URL` — `??` does not
    // coalesce ''. Blanking CLAIM_WRITER_DATABASE_URL (the normal way to
    // disable a credential in .env) made destination '', which skipped the
    // gate entirely AND fell through to the more privileged DATABASE_URL.
    expect(() => assertProductionWriteAuthorized('', 'claim-persistence'))
      .toThrow(UndeterminableDestination)
    expect(() => assertProductionWriteAuthorized('   ', 'claim-persistence'))
      .toThrow(UndeterminableDestination)
  })

  it('W-2: a path-less URL resolves through PGDATABASE, the way pg does', () => {
    const saved = process.env.PGDATABASE
    try {
      process.env.PGDATABASE = 'ai_capital'
      // The guard used to read only the connection string, see null, and
      // conclude "not protected" — while pg was about to connect to ai_capital.
      expect(resolveDestination('postgres://thanapold@localhost:5432')).toBe('ai_capital')
      expect(isProtectedDestination('postgres://thanapold@localhost:5432')).toBe(true)
      expect(() => assertProductionWriteAuthorized('postgres://thanapold@localhost:5432', 'claim-persistence'))
        .toThrow(ProductionWriteRefused)
    } finally {
      if (saved === undefined) delete process.env.PGDATABASE; else process.env.PGDATABASE = saved
    }
  })

  it('W-2b: an undeterminable destination is REFUSED, not allowed', () => {
    // The polarity inversion at the root of every bypass: "cannot determine"
    // must never mean "not protected". Every other guard in this package fails
    // closed here; this one used to fail open.
    const saved = [process.env.PGDATABASE, process.env.PGUSER, process.env.USER]
    try {
      delete process.env.PGDATABASE; delete process.env.PGUSER; delete process.env.USER
      expect(() => assertProductionWriteAuthorized('postgres://@localhost:5432', 'claim-persistence'))
        .toThrow(UndeterminableDestination)
    } finally {
      const [a, b, c] = saved
      if (a === undefined) delete process.env.PGDATABASE; else process.env.PGDATABASE = a
      if (b === undefined) delete process.env.PGUSER; else process.env.PGUSER = b
      if (c === undefined) delete process.env.USER; else process.env.USER = c
    }
  })

  it('W-3: a pool carries the destination it was BUILT with', () => {
    // TOCTOU: getPool() caches, the environment can change afterwards, and the
    // gate used to inspect the environment rather than the pool it hands back.
    // global-setup.ts mutates and restores DATABASE_URL, so this pattern is
    // genuinely present in this repo.
    const pool = createPool('postgres://u@localhost:5432/scratch_db')
    const saved = process.env.PGDATABASE
    try {
      process.env.PGDATABASE = 'ai_capital'          // repoint the environment
      expect(destinationOf(pool)).toBe('scratch_db') // pool still knows the truth
    } finally {
      if (saved === undefined) delete process.env.PGDATABASE; else process.env.PGDATABASE = saved
      void pool.end()
    }
  })

  it('W-4: intent does NOT survive for resources created inside the scope', async () => {
    // AsyncLocalStorage propagates to every async resource created within a
    // scope, and those keep the context after the scope returns. My original
    // test only checked a sibling created OUTSIDE — the easy direction. These
    // are the four escapes Warden actually demonstrated.
    let floating!: Promise<WriteIntent | undefined>
    let timerSaw: unknown = 'unset'
    let tickSaw: unknown = 'unset'
    let replay!: () => WriteIntent | undefined

    const timerDone = new Promise<void>(res => {
      const inner = new Promise<void>(r2 => {
        void withProductionWrite(
          { operation: 'claim-persistence', context: 'pipeline', reason: 'escape test' },
          async () => {
            floating = new Promise(r => setTimeout(() => r(currentWriteIntent()), 5))
            setTimeout(() => { timerSaw = currentWriteIntent(); res() }, 10)
            process.nextTick(() => { tickSaw = currentWriteIntent() })
            replay = AsyncResource.bind(() => currentWriteIntent())
            r2()
          },
        )
      })
      void inner
    })

    await timerDone
    expect(await floating, 'floating promise awaited after the scope closed').toBeUndefined()
    expect(timerSaw, 'setTimeout scheduled inside the scope').toBeUndefined()
    expect(tickSaw, 'process.nextTick scheduled inside the scope').toBeUndefined()
    expect(replay(), 'AsyncResource.bind capture-and-replay').toBeUndefined()
  })

  it('W-5: the mechanism is reachable from a consumer', async () => {
    // As shipped it was exported from neither index.ts nor package.json, so the
    // documented call site could not compile in any app and the ONLY routes to
    // a production claim write were the bypasses above.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
    expect(Object.keys(pkg.exports)).toContain('./write-intent')
    const index = await import('../src/index.js')
    expect(index).toHaveProperty('withProductionWrite')
    expect(index).toHaveProperty('ProductionWriteRefused')
  })
})
