import { randomUUID } from 'crypto'
import type { GraphStore } from '../store/graph-store.js'
import type { Edge } from '../types.js'
import { SEED_EDGES, SEED_NODES } from './seed.config.js'

export { SEED_NODES }

export async function loadSeed(store: GraphStore): Promise<{ nodes: number; edges: number }> {
  for (const node of SEED_NODES) {
    await store.upsertNode(node)
  }

  let edgesLoaded = 0
  const now = new Date().toISOString()

  for (const seed of SEED_EDGES) {
    if (await store.edgeExists(seed.from, seed.to, seed.type)) continue
    const edge: Edge = {
      id:             randomUUID(),
      from:           seed.from,
      to:             seed.to,
      type:           seed.type,
      strength:       seed.strength,
      description:    seed.description,
      status:         'seed',
      sourceChunkIds: [],
      evidenceQuote:  null,
      createdAt:      now,
      updatedAt:      now,
    }
    await store.insertEdge(edge)
    edgesLoaded++
  }

  return { nodes: SEED_NODES.length, edges: edgesLoaded }
}
