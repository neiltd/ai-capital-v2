import { describe, it, expect } from 'vitest'
import { shouldUpdate } from '../src/cli/update.js'

describe('shouldUpdate', () => {
  it('returns true when lastUpdated is older than thesisUpdateDays', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString()
    expect(shouldUpdate(tenDaysAgo, 7)).toBe(true)
  })

  it('returns false when lastUpdated is within thesisUpdateDays', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString()
    expect(shouldUpdate(twoDaysAgo, 7)).toBe(false)
  })

  it('returns true for daily company updated yesterday', () => {
    const yesterday = new Date(Date.now() - 25 * 3_600_000).toISOString()
    expect(shouldUpdate(yesterday, 1)).toBe(true)
  })

  it('returns false for daily company updated 2 hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString()
    expect(shouldUpdate(twoHoursAgo, 1)).toBe(false)
  })
})
