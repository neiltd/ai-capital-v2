import { describe, it, expect } from 'vitest'
import { createGraphEngine } from '../src/graph/engine.js'
import type { Node, Edge } from '../src/types.js'

const nodes: Node[] = [
  { ticker: 'NVDA', company: 'NVIDIA',     themes: ['ai-infrastructure'] },
  { ticker: 'TSM',  company: 'TSMC',       themes: ['semiconductors']   },
  { ticker: 'CRWV', company: 'CoreWeave',  themes: ['ai-infrastructure'] },
  { ticker: 'ASML', company: 'ASML',       themes: ['semiconductors']   },
]

function edge(id: string, from: string, to: string, type: Edge['type'] = 'supply_chain'): Edge {
  return {
    id, from, to, type, strength: 'strong', description: '', status: 'seed',
    sourceChunkIds: [], evidenceQuote: null, createdAt: '', updatedAt: '',
  }
}

const edges: Edge[] = [
  edge('1', 'NVDA', 'TSM',  'supply_chain'),
  edge('2', 'CRWV', 'NVDA', 'customer'),
  edge('3', 'TSM',  'ASML', 'supply_chain'),
]

describe('GraphEngine', () => {
  const engine = createGraphEngine(nodes, edges)

  it('upstream returns outgoing edges (who X depends on)', () => {
    const up = engine.upstream('NVDA')
    expect(up).toHaveLength(1)
    expect(up[0].to).toBe('TSM')
  })

  it('downstream returns incoming edges (who depends on X)', () => {
    const down = engine.downstream('NVDA')
    expect(down).toHaveLength(1)
    expect(down[0].from).toBe('CRWV')
  })

  it('filters upstream by relType', () => {
    expect(engine.upstream('NVDA', 'customer')).toHaveLength(0)
    expect(engine.upstream('NVDA', 'supply_chain')).toHaveLength(1)
  })

  it('neighbors returns both directions', () => {
    const n = engine.neighbors('NVDA')
    expect(n).toHaveLength(2)
  })

  it('finds multi-hop paths', () => {
    const paths = engine.paths('CRWV', 'ASML')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toHaveLength(3)
    expect(paths[0][0].from).toBe('CRWV')
    expect(paths[0][2].to).toBe('ASML')
  })

  it('returns empty array for node with no connections', () => {
    expect(engine.upstream('ASML')).toHaveLength(0)
  })

  it('toJSON returns correct structure', () => {
    const json = engine.toJSON()
    expect(json.nodes).toHaveLength(4)
    expect(json.edges).toHaveLength(3)
    expect(json.exportedAt).toBeTruthy()
    expect(json.edges[0]).toHaveProperty('from')
    expect(json.edges[0]).toHaveProperty('type')
    expect(json.edges[0]).not.toHaveProperty('status')
  })
})
