import { describe, it, expect } from 'vitest'
import {
  withProductionWrite, currentWriteIntent, assertProductionWriteAuthorized,
  isProtectedDestination, ProductionWriteRefused,
} from '../src/write-intent.js'

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
