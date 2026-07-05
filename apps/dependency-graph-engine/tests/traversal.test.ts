import { describe, it, expect } from 'vitest'
import { findPaths } from '../src/graph/traversal.js'
import type { Edge } from '../src/types.js'

function edge(from: string, to: string): Edge {
  return {
    id: `${from}-${to}`, from, to, type: 'supply_chain', strength: 'strong',
    description: '', status: 'seed', sourceChunkIds: [],
    evidenceQuote: null, createdAt: '', updatedAt: '',
  }
}

describe('findPaths', () => {
  it('finds a direct one-hop path', () => {
    const forward = new Map([['A', [edge('A', 'B')]]])
    const paths = findPaths(forward, 'A', 'B')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toHaveLength(1)
    expect(paths[0][0].from).toBe('A')
    expect(paths[0][0].to).toBe('B')
  })

  it('finds a two-hop path', () => {
    const forward = new Map([
      ['A', [edge('A', 'B')]],
      ['B', [edge('B', 'C')]],
    ])
    const paths = findPaths(forward, 'A', 'C')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toHaveLength(2)
  })

  it('finds multiple paths', () => {
    const forward = new Map([
      ['A', [edge('A', 'B'), edge('A', 'C')]],
      ['B', [edge('B', 'D')]],
      ['C', [edge('C', 'D')]],
    ])
    const paths = findPaths(forward, 'A', 'D')
    expect(paths).toHaveLength(2)
  })

  it('returns empty array when no path exists', () => {
    const forward = new Map([['A', [edge('A', 'B')]]])
    expect(findPaths(forward, 'A', 'C')).toEqual([])
    expect(findPaths(forward, 'B', 'A')).toEqual([])
  })

  it('avoids cycles', () => {
    const forward = new Map([
      ['A', [edge('A', 'B')]],
      ['B', [edge('B', 'A'), edge('B', 'C')]],
    ])
    const paths = findPaths(forward, 'A', 'C')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toHaveLength(2)
  })

  it('respects maxDepth', () => {
    const forward = new Map([
      ['A', [edge('A', 'B')]],
      ['B', [edge('B', 'C')]],
      ['C', [edge('C', 'D')]],
    ])
    expect(findPaths(forward, 'A', 'D', 2)).toHaveLength(0)
    expect(findPaths(forward, 'A', 'D', 3)).toHaveLength(1)
  })
})
