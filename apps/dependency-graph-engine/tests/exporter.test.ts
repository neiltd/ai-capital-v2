import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { unlinkSync, existsSync, readFileSync } from 'fs'
import { createGraphStore } from '../src/store/sqlite.js'
import { exportGraph } from '../src/export/exporter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB  = join(__dirname, 'test-export.db')
const TEST_OUT = join(__dirname, 'test-graph.json')

describe('exportGraph', () => {
  let store: ReturnType<typeof createGraphStore>

  beforeEach(() => {
    store = createGraphStore(TEST_DB)
    store.upsertNode({ ticker: 'NVDA', company: 'NVIDIA', themes: ['ai-infrastructure'] })
    store.upsertNode({ ticker: 'TSM',  company: 'TSMC',   themes: ['semiconductors'] })
    store.insertEdge({
      id: 'e1', from: 'NVDA', to: 'TSM', type: 'supply_chain', strength: 'strong',
      description: 'TSMC fabs NVIDIA chips', status: 'seed', sourceChunkIds: [],
      evidenceQuote: null, createdAt: '2026-05-23T00:00:00.000Z', updatedAt: '2026-05-23T00:00:00.000Z',
    })
    // rejected edge should NOT appear in export
    store.insertEdge({
      id: 'e2', from: 'NVDA', to: 'TSM', type: 'customer', strength: 'weak',
      description: 'should be excluded', status: 'rejected', sourceChunkIds: [],
      evidenceQuote: null, createdAt: '2026-05-23T00:00:00.000Z', updatedAt: '2026-05-23T00:00:00.000Z',
    })
  })

  afterEach(() => {
    store.close()
    if (existsSync(TEST_DB))  unlinkSync(TEST_DB)
    if (existsSync(TEST_OUT)) unlinkSync(TEST_OUT)
  })

  it('returns correct graph shape', () => {
    const graph = exportGraph(store, TEST_OUT)
    expect(graph.nodes).toHaveLength(2)
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0].from).toBe('NVDA')
    expect(graph.edges[0].to).toBe('TSM')
    expect(graph.exportedAt).toBeTruthy()
  })

  it('does not expose internal status field', () => {
    const graph = exportGraph(store, TEST_OUT)
    expect((graph.edges[0] as any).status).toBeUndefined()
  })

  it('writes valid JSON to disk', () => {
    exportGraph(store, TEST_OUT)
    const written = JSON.parse(readFileSync(TEST_OUT, 'utf-8'))
    expect(written.nodes).toHaveLength(2)
    expect(written.edges).toHaveLength(1)
    expect(written.exportedAt).toBeTruthy()
  })
})
