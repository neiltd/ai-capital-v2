import { describe, expect, it } from 'vitest'
import { canTransition, transition } from '../../src/reconciliation.js'

describe('reconciliation state machine', () => {
  it('supports review, match, resolution and explicit reopen', () => {
    expect(transition('none', 'OPEN')).toBe('open')
    expect(transition('open', 'FLAG_MISMATCH')).toBe('mismatch')
    expect(transition('mismatch', 'MATCH')).toBe('matched')
    expect(transition('matched', 'RESOLVE')).toBe('resolved')
    expect(transition('resolved', 'REOPEN')).toBe('open')
  })

  it('rejects illegal transitions', () => {
    expect(canTransition('none', 'MATCH')).toBe(false)
    expect(() => transition('resolved', 'MATCH')).toThrow(/illegal reconciliation transition/)
  })
})
