import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { unlinkSync, existsSync } from 'fs'
import { createGraphStore } from '../src/store/sqlite.js'
import { loadSeed, SEED_NODES } from '../src/seed/seed-loader.js'
import { SEED_EDGES } from '../src/seed/seed.config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB = join(__dirname, 'test-seed.db')

describe('loadSeed', () => {
  let store: ReturnType<typeof createGraphStore>

  beforeEach(() => { store = createGraphStore(TEST_DB) })
  afterEach(() => {
    store.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  it('loads all nodes', () => {
    loadSeed(store)
    expect(store.getNodes()).toHaveLength(SEED_NODES.length)
  })

  it('loads all seed edges', () => {
    const { edges } = loadSeed(store)
    expect(edges).toBe(SEED_EDGES.length)
    expect(store.getActiveEdges()).toHaveLength(SEED_EDGES.length)
  })

  it('all loaded edges have status seed', () => {
    loadSeed(store)
    const active = store.getActiveEdges()
    expect(active.every(e => e.status === 'seed')).toBe(true)
  })

  it('is idempotent — second run adds zero edges', () => {
    const first = loadSeed(store)
    const second = loadSeed(store)
    expect(second.edges).toBe(0)
    expect(store.getActiveEdges()).toHaveLength(first.edges)
  })
})
