import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { unlinkSync, existsSync } from 'fs'
import { createSqliteGraphStore as createGraphStore } from '../src/store/graph-store-sqlite.js'
import { loadSeed, SEED_NODES } from '../src/seed/seed-loader.js'
import { SEED_EDGES } from '../src/seed/seed.config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB = join(__dirname, 'test-seed.db')

describe('loadSeed', () => {
  let store: ReturnType<typeof createGraphStore>

  beforeEach(async () => { store = createGraphStore(TEST_DB) })
  afterEach(async () => {
    await store.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  it('loads all nodes', async () => {
    await loadSeed(store)
    expect(await store.getNodes()).toHaveLength(SEED_NODES.length)
  })

  it('loads all seed edges', async () => {
    const { edges } = await loadSeed(store)
    expect(edges).toBe(SEED_EDGES.length)
    expect(await store.getActiveEdges()).toHaveLength(SEED_EDGES.length)
  })

  it('all loaded edges have status seed', async () => {
    await loadSeed(store)
    const active = await store.getActiveEdges()
    expect(active.every(e => e.status === 'seed')).toBe(true)
  })

  it('is idempotent — second run adds zero edges', async () => {
    const first = await loadSeed(store)
    const second = await loadSeed(store)
    expect(second.edges).toBe(0)
    expect(await store.getActiveEdges()).toHaveLength(first.edges)
  })
})
