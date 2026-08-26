import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { AsyncResource } from 'node:async_hooks'
import type { WriteIntent } from '../src/write-intent.js'
import {
  withProductionWrite, currentWriteIntent, assertProductionWriteAuthorized, assertPoolWriteAuthorized,
  isProtectedDestination, ProductionWriteRefused, UndeterminableDestination,
} from '../src/write-intent.js'
import { resolveDestination, destinationOf, createPool, pinDestination, databaseNameOf, databaseNameOfRaw } from '../src/pool.js'

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
  it('W-1: a BLANKED credential cannot bypass the gate', () => {
    // The original defect: `url ?? process.env.DATABASE_URL` — `??` does not
    // coalesce ''. Blanking CLAIM_WRITER_DATABASE_URL (the normal way to
    // disable a credential in .env) skipped the gate ENTIRELY and then fell
    // through to the MORE privileged DATABASE_URL.
    //
    // The invariant is not "empty string throws" — an empty credential simply
    // carries no destination, and the environment may legitimately supply one.
    // The invariant is that whatever the connection would ACTUALLY reach gets
    // checked. So: blank credential + environment pointing at production must
    // still refuse.
    const saved = process.env.PGDATABASE
    try {
      process.env.PGDATABASE = 'ai_capital'
      expect(() => assertProductionWriteAuthorized('', 'claim-persistence'))
        .toThrow(ProductionWriteRefused)
      expect(() => assertProductionWriteAuthorized(undefined, 'claim-persistence'))
        .toThrow(ProductionWriteRefused)
    } finally {
      if (saved === undefined) delete process.env.PGDATABASE; else process.env.PGDATABASE = saved
    }
  })

  it('W-1b: the refusal names the REAL destination, not "undeterminable"', () => {
    // It failed closed before this fix, but reported "the destination could not
    // be determined" about a destination that was determined and protected.
    // Right outcome, wrong explanation — the worst kind to meet at 2am.
    const saved = process.env.PGDATABASE
    try {
      process.env.PGDATABASE = 'ai_capital'
      try { assertProductionWriteAuthorized('', 'claim-persistence'); throw new Error('should refuse') }
      catch (e) { expect((e as Error).message).toContain('ai_capital') }
    } finally {
      if (saved === undefined) delete process.env.PGDATABASE; else process.env.PGDATABASE = saved
    }
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

// ── Round 2. Warden broke the FIXES; these pin the second set. ───────────────
describe('bypasses Warden proved against the hardened gate', () => {
  it('NEW-1: the destination is PINNED into the connection string', async () => {
    // pg.Pool does not connect at construction — it builds a Client per
    // checkout and reads PGDATABASE at CONNECT time. So recording the
    // destination when the pool was built produced a snapshot the driver could
    // later disagree with, and Warden drove that divergence to a real row in
    // desk.agent_runs on a protected database with no intent scope:
    //     recorded: thanapold   |   actually connected: ai_capital_test
    //
    // Passing `database` alongside `connectionString` does NOT fix it —
    // measured, pg ignores it and PGDATABASE wins. Only the database embedded
    // in the string is authoritative, so we resolve once and write it in.
    const saved = process.env.PGDATABASE
    try {
      delete process.env.PGDATABASE
      const pinned = pinDestination('postgres://someone@localhost:5432')
      process.env.PGDATABASE = 'ai_capital'          // env moves after pinning
      // The pinned string still names what was resolved, so pg cannot drift.
      expect(databaseNameOf(pinned)).not.toBe('ai_capital')
      expect(pinDestination(pinned)).toBe(pinned)    // idempotent
    } finally {
      if (saved === undefined) delete process.env.PGDATABASE; else process.env.PGDATABASE = saved
    }
  })

  it('NEW-1b: pinning preserves an explicitly named database exactly', () => {
    const cs = 'postgres://u:p@host:5432/Some_MixedCase_DB'
    expect(pinDestination(cs)).toBe(cs)   // case-sensitive: never normalised away
  })

  it('NEW-1c: a pool records what pg will actually connect to', () => {
    const saved = process.env.PGDATABASE
    try {
      process.env.PGDATABASE = 'ai_capital'
      // Path-less string + protected PGDATABASE: pinning resolves it to
      // ai_capital, which the guard then sees and (outside a scope) refuses.
      expect(() => createPool('postgres://someone@localhost:5432')).toThrow()
    } finally {
      if (saved === undefined) delete process.env.PGDATABASE; else process.env.PGDATABASE = saved
    }
  })

  it('NEW-5 / R3-3: the destination marker cannot be forged OR extracted', () => {
    // First fix used a module-private Symbol() and I claimed that made the
    // marker a capability. Wrong: own symbols are readable with
    // Object.getOwnPropertySymbols, so any holder of a pool could extract the
    // key and forge a marker on an object whose .query() still reached
    // production. Warden did exactly that, live. It is a WeakMap now.
    const pool = createPool('postgres://u@localhost:5432/scratch_db')
    try {
      // 1. Nothing about the marker is visible on the object.
      const leaked = Object.getOwnPropertySymbols(pool)
        .filter(sym => (sym.description ?? '').includes('destination'))
      expect(leaked, 'the destination marker must not be an own property').toEqual([])
      expect(JSON.stringify(Object.keys(pool))).not.toContain('destination')

      // 2. The registry symbol route stays dead.
      const forgedRegistry = { [Symbol.for('@common/db.destination')]: 'scratch_db' }
      expect(() => assertPoolWriteAuthorized(forgedRegistry, 'claim-persistence'))
        .toThrow(UndeterminableDestination)

      // 3. Prototype shadowing stays dead.
      expect(() => assertPoolWriteAuthorized(Object.create(pool), 'claim-persistence'))
        .toThrow(UndeterminableDestination)

      // 4. And a plain impostor is refused rather than believed.
      for (const impostor of [{}, null, undefined, 'a string', 42]) {
        expect(() => assertPoolWriteAuthorized(impostor, 'claim-persistence'))
          .toThrow(UndeterminableDestination)
      }
      // The real pool still resolves correctly.
      expect(destinationOf(pool)).toBe('scratch_db')
    } finally { void pool.end() }
  })

  it('R3-2: the connection-string USER is part of pg\'s database fallback', () => {
    // `postgres://ai_capital@localhost:5432` routes to the database
    // `ai_capital` — pg falls back database→user. The guard resolved $USER
    // instead and reported "not protected": an exported gate FAILING OPEN on a
    // string the driver sends to the real book.
    const saved = [process.env.PGDATABASE, process.env.PGUSER]
    try {
      delete process.env.PGDATABASE; delete process.env.PGUSER
      expect(resolveDestination('postgres://ai_capital@localhost:5432')).toBe('ai_capital')
      expect(isProtectedDestination('postgres://ai_capital@localhost:5432')).toBe(true)
      expect(() => assertProductionWriteAuthorized('postgres://ai_capital@localhost:5432', 'claim-persistence'))
        .toThrow(ProductionWriteRefused)
    } finally {
      const [a, b] = saved
      if (a === undefined) delete process.env.PGDATABASE; else process.env.PGDATABASE = a
      if (b === undefined) delete process.env.PGUSER; else process.env.PGUSER = b
    }
  })

  it('R3-5: a BLANKED PGDATABASE does not stop the fallback chain', () => {
    // `??` where pg uses `||` — W-1's exact bug, one function away.
    const saved = [process.env.PGDATABASE, process.env.PGUSER]
    try {
      process.env.PGDATABASE = ''
      process.env.PGUSER = 'ai_capital'
      expect(resolveDestination('postgres://h@localhost:5432')).toBe('h')  // cs user wins over PGUSER
      delete process.env.PGUSER
      process.env.PGDATABASE = ''
      expect(resolveDestination('postgres://ai_capital@localhost:5432')).toBe('ai_capital')
    } finally {
      const [a, b] = saved
      if (a === undefined) delete process.env.PGDATABASE; else process.env.PGDATABASE = a
      if (b === undefined) delete process.env.PGUSER; else process.env.PGUSER = b
    }
  })

  it('R3-7: pinning uses the encoder the driver decodes with', () => {
    // pg-connection-string reads the path with decodeURI, which does NOT decode
    // reserved characters. encodeURIComponent escaped '/', '?' and '#' into the
    // name and CHANGED the destination.
    const saved = process.env.PGDATABASE
    try {
      // Names that CAN round-trip must do so byte-exactly.
      for (const name of ['my/db', 'plain_db', 'MiXeD_Case', 'ünïcode_db', 'ai_capital_test']) {
        process.env.PGDATABASE = name
        const pinned = pinDestination('postgres://u@localhost:5432')
        expect(databaseNameOfRaw(pinned), `round-trip for ${name}`).toBe(name)
        expect(pinDestination(pinned), `idempotent for ${name}`).toBe(pinned)
      }
      // Names that CANNOT survive a URL round trip are REFUSED, never silently
      // altered. '?' and '#' must be escaped by the pathname setter or they
      // would terminate the path, so pinning them would change the destination.
      for (const name of ['db?x', 'db#y']) {
        process.env.PGDATABASE = name
        expect(() => pinDestination('postgres://u@localhost:5432'), `must refuse ${name}`)
          .toThrow(/without changing it/)
      }
    } finally {
      if (saved === undefined) delete process.env.PGDATABASE; else process.env.PGDATABASE = saved
    }
  })
})
