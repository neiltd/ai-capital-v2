import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { unlinkSync, existsSync } from 'fs'
import { createSqliteGraphStore as createGraphStore } from '../src/store/graph-store-sqlite.js'
import type { Node, Edge } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB = join(__dirname, 'test-graph.db')

describe('GraphStore', () => {
  let store: ReturnType<typeof createGraphStore>

  beforeEach(async () => { store = createGraphStore(TEST_DB) })
  afterEach(async () => {
    await store.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  const testEdge: Edge = {
    id: 'e1', from: 'NVDA', to: 'TSM', type: 'supply_chain', strength: 'strong',
    description: 'TSMC fabs NVIDIA chips', status: 'seed',
    sourceChunkIds: [], evidenceQuote: null,
    createdAt: '2026-05-23T00:00:00.000Z', updatedAt: '2026-05-23T00:00:00.000Z',
  }

  it('upserts and retrieves nodes', async () => {
    const node: Node = { ticker: 'NVDA', company: 'NVIDIA', themes: ['ai-infrastructure'] }
    await store.upsertNode(node)
    const nodes = await store.getNodes()
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toEqual(node)
  })

  it('upsert is idempotent', async () => {
    const node: Node = { ticker: 'NVDA', company: 'NVIDIA', themes: ['ai-infrastructure'] }
    await store.upsertNode(node)
    await store.upsertNode({ ...node, company: 'NVIDIA Corporation' })
    expect(await store.getNodes()).toHaveLength(1)
    expect((await store.getNodes())[0].company).toBe('NVIDIA Corporation')
  })

  it('inserts edge and retrieves active edges', async () => {
    await store.insertEdge(testEdge)
    const edges = await store.getActiveEdges()
    expect(edges).toHaveLength(1)
    expect(edges[0].from).toBe('NVDA')
    expect(edges[0].to).toBe('TSM')
    expect(edges[0].sourceChunkIds).toEqual([])
  })

  it('does not return rejected edges as active', async () => {
    await store.insertEdge({ ...testEdge, id: 'e2', status: 'rejected' })
    expect(await store.getActiveEdges()).toHaveLength(0)
  })

  it('detects existing edges (ignores direction and different types)', async () => {
    await store.insertEdge(testEdge)
    expect(await store.edgeExists('NVDA', 'TSM', 'supply_chain')).toBe(true)
    expect(await store.edgeExists('TSM', 'NVDA', 'supply_chain')).toBe(false)
    expect(await store.edgeExists('NVDA', 'TSM', 'customer')).toBe(false)
  })

  it('ignores duplicate edge inserts', async () => {
    await store.insertEdge(testEdge)
    await store.insertEdge(testEdge)
    expect(await store.getActiveEdges()).toHaveLength(1)
  })

  it('manages proposal lifecycle', async () => {
    await store.insertProposal({
      id: 'p1', status: 'pending', claudeReasoning: 'test',
      chunkIdsUsed: ['c1'], createdAt: '2026-05-23T00:00:00.000Z', resolvedAt: null,
    })
    await store.insertProposalEdge({
      id: 'pe1', proposalId: 'p1', from: 'AMZN', to: 'NVDA',
      type: 'customer', strength: 'strong',
      description: 'AWS buys NVIDIA GPUs', evidenceQuote: null, approved: null,
    })
    expect(await store.getPendingProposalEdges()).toHaveLength(1)
    await store.resolveProposalEdge('pe1', true)
    expect(await store.getPendingProposalEdges()).toHaveLength(0)
  })
})
