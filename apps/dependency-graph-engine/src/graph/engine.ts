import type { Edge, Node, GraphJSON, RelType } from '../types.js'
import { findPaths } from './traversal.js'

export interface GraphEngine {
  upstream(ticker: string, relType?: RelType): Edge[]
  downstream(ticker: string, relType?: RelType): Edge[]
  neighbors(ticker: string, relType?: RelType): Edge[]
  paths(from: string, to: string): Edge[][]
  nodes(): Node[]
  edges(): Edge[]
  toJSON(): GraphJSON
}

export function createGraphEngine(nodes: Node[], edges: Edge[]): GraphEngine {
  const forward = new Map<string, Edge[]>()
  const reverse = new Map<string, Edge[]>()

  for (const edge of edges) {
    if (!forward.has(edge.from)) forward.set(edge.from, [])
    forward.get(edge.from)!.push(edge)

    if (!reverse.has(edge.to)) reverse.set(edge.to, [])
    reverse.get(edge.to)!.push(edge)
  }

  function filter(arr: Edge[], relType?: RelType): Edge[] {
    return relType ? arr.filter(e => e.type === relType) : arr
  }

  return {
    upstream(ticker, relType)   { return filter(forward.get(ticker) ?? [], relType) },
    downstream(ticker, relType) { return filter(reverse.get(ticker) ?? [], relType) },
    neighbors(ticker, relType)  {
      return filter([...(forward.get(ticker) ?? []), ...(reverse.get(ticker) ?? [])], relType)
    },
    paths(from, to) { return findPaths(forward, from, to) },
    nodes()         { return nodes },
    edges()         { return edges },
    toJSON(): GraphJSON {
      return {
        exportedAt: new Date().toISOString(),
        nodes: nodes.map(n => ({ ticker: n.ticker, company: n.company, themes: n.themes })),
        edges: edges.map(e => ({
          from:          e.from,
          to:            e.to,
          type:          e.type,
          strength:      e.strength,
          description:   e.description,
          evidenceQuote: e.evidenceQuote,
        })),
      }
    },
  }
}
