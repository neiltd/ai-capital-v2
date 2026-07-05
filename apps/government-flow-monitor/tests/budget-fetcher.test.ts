import { describe, it, expect } from 'vitest'
import { isRelevantBill } from '../src/fetchers/budget-fetcher.js'

describe('isRelevantBill', () => {
  it('matches appropriations in title', () => {
    expect(isRelevantBill('Department of Defense Appropriations Act')).toBe(true)
  })

  it('matches CHIPS in title (case-insensitive)', () => {
    expect(isRelevantBill('chips and science act reauthorization')).toBe(true)
  })

  it('matches artificial intelligence', () => {
    expect(isRelevantBill('National Artificial Intelligence Initiative Act')).toBe(true)
  })

  it('rejects unrelated bill', () => {
    expect(isRelevantBill('Post Office Renaming Act')).toBe(false)
  })
})
