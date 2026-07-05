import { writeFileSync } from 'fs'
import type { GraphStore } from '../store/graph-store.js'
import type { GraphJSON } from '../types.js'

export async function exportGraph(store: GraphStore, outputPath: string): Promise<GraphJSON> {
  const nodes = await store.getNodes()
  const edges = await store.getActiveEdges()

  const graph: GraphJSON = {
    schemaVersion: '1.0',
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

  writeFileSync(outputPath, JSON.stringify(graph, null, 2), 'utf-8')
  return graph
}
