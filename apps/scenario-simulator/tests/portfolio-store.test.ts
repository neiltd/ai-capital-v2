import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { createPortfolioStore } from '../src/portfolio/portfolio-store.js'

const TEST_DIR = 'tests/tmp-portfolio'
const DB_PATH  = join(TEST_DIR, 'portfolio-test.db')

beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }) })
afterEach(() => { try { rmSync(TEST_DIR, { recursive: true }) } catch {} })

describe('PortfolioStore', () => {
  it('upserts a position and reads it back', () => {
    const store = createPortfolioStore(DB_PATH)
    store.upsertPosition('NVDA', 'NVIDIA Corporation', 100, 68.50)
    const positions = store.getPositions()
    store.close()

    expect(positions).toHaveLength(1)
    expect(positions[0].ticker).toBe('NVDA')
    expect(positions[0].shares).toBe(100)
    expect(positions[0].avgCost).toBe(68.50)
    expect(positions[0].currentPrice).toBe(0)
  })

  it('overwrites an existing position on upsert', () => {
    const store = createPortfolioStore(DB_PATH)
    store.upsertPosition('NVDA', 'NVIDIA', 100, 68.50)
    store.upsertPosition('NVDA', 'NVIDIA Corporation', 200, 75.00)
    const positions = store.getPositions()
    store.close()

    expect(positions).toHaveLength(1)
    expect(positions[0].shares).toBe(200)
    expect(positions[0].avgCost).toBe(75.00)
  })

  it('updates prices and computes currentValue and unrealizedPnl', () => {
    const store = createPortfolioStore(DB_PATH)
    store.upsertPosition('NVDA', 'NVIDIA', 100, 68.50)
    store.updatePrices({ NVDA: 92.00 })
    const positions = store.getPositions()
    store.close()

    expect(positions[0].currentPrice).toBe(92.00)
    expect(positions[0].currentValue).toBeCloseTo(9200.00)
    expect(positions[0].unrealizedPnl).toBeCloseTo(2350.00) // (92 - 68.5) * 100
  })

  it('ignores updatePrices for unknown tickers', () => {
    const store = createPortfolioStore(DB_PATH)
    store.upsertPosition('NVDA', 'NVIDIA', 100, 68.50)
    store.updatePrices({ MSFT: 400.00 })
    const positions = store.getPositions()
    store.close()

    expect(positions[0].currentPrice).toBe(0)
  })
})
