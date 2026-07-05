import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { unlinkSync, existsSync } from 'fs'
import { createGraphStore } from '../src/store/sqlite.js'
import type { Node, Edge } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB = join(__dirname, 'test-graph.db')

describe('GraphStore', () => {
  let store: ReturnType<typeof createGraphStore>

  beforeEach(() => { store = createGraphStore(TEST_DB) })
  afterEach(() => {
    store.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  const testEdge: Edge = {
    id: 'e1', from: 'NVDA', to: 'TSM', type: 'supply_chain', strength: 'strong',
    description: 'TSMC fabs NVIDIA chips', status: 'seed',
    sourceChunkIds: [], evidenceQuote: null,
    createdAt: '2026-05-23T00:00:00.000Z', updatedAt: '2026-05-23T00:00:00.000Z',
  }

  it('upserts and retrieves nodes', () => {
    const node: Node = { ticker: 'NVDA', company: 'NVIDIA', themes: ['ai-infrastructure'] }
    store.upsertNode(node)
    const nodes = store.getNodes()
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toEqual(node)
  })

  it('upsert is idempotent', () => {
    const node: Node = { ticker: 'NVDA', company: 'NVIDIA', themes: ['ai-infrastructure'] }
    store.upsertNode(node)
    store.upsertNode({ ...node, company: 'NVIDIA Corporation' })
    expect(store.getNodes()).toHaveLength(1)
    expect(store.getNodes()[0].company).toBe('NVIDIA Corporation')
  })

  it('inserts edge and retrieves active edges', () => {
    store.insertEdge(testEdge)
    const edges = store.getActiveEdges()
    expect(edges).toHaveLength(1)
    expect(edges[0].from).toBe('NVDA')
    expect(edges[0].to).toBe('TSM')
    expect(edges[0].sourceChunkIds).toEqual([])
  })

  it('does not return rejected edges as active', () => {
    store.insertEdge({ ...testEdge, id: 'e2', status: 'rejected' })
    expect(store.getActiveEdges()).toHaveLength(0)
  })

  it('detects existing edges (ignores direction and different types)', () => {
    store.insertEdge(testEdge)
    expect(store.edgeExists('NVDA', 'TSM', 'supply_chain')).toBe(true)
    expect(store.edgeExists('TSM', 'NVDA', 'supply_chain')).toBe(false)
    expect(store.edgeExists('NVDA', 'TSM', 'customer')).toBe(false)
  })

  it('ignores duplicate edge inserts', () => {
    store.insertEdge(testEdge)
    store.insertEdge(testEdge)
    expect(store.getActiveEdges()).toHaveLength(1)
  })

  it('manages proposal lifecycle', () => {
    store.insertProposal({
      id: 'p1', status: 'pending', claudeReasoning: 'test',
      chunkIdsUsed: ['c1'], createdAt: '2026-05-23T00:00:00.000Z', resolvedAt: null,
    })
    store.insertProposalEdge({
      id: 'pe1', proposalId: 'p1', from: 'AMZN', to: 'NVDA',
      type: 'customer', strength: 'strong',
      description: 'AWS buys NVIDIA GPUs', evidenceQuote: null, approved: null,
    })
    expect(store.getPendingProposalEdges()).toHaveLength(1)
    store.resolveProposalEdge('pe1', true)
    expect(store.getPendingProposalEdges()).toHaveLength(0)
  })
})
