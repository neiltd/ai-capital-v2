import { describe, it, expect } from 'vitest'
import { createPool, destinationOf } from '../src/pool.js'
// R3-4: pg-pool builds each client from `this.options` AT CHECKOUT, and options
// was plain and writable — so the record and the driver could be made to
// disagree permanently by mutating it after construction. That is the same
// shape as the finding the pinning work was written to kill: "agree by
// construction" was true only AT construction.
describe('pool options are immutable after construction', () => {
  it('pool.options cannot be mutated to diverge from the record', () => {
    const pool = createPool('postgres://u@localhost:5432/scratch_db')
    expect(Object.isFrozen(pool.options)).toBe(true)
    expect(() => { (pool.options as { connectionString?: string }).connectionString =
      'postgres://u@localhost:5432/ai_capital' }).toThrow()
    expect(destinationOf(pool)).toBe('scratch_db')
    void pool.end()
  })
})
