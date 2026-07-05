import { join } from 'path'
import { randomUUID } from 'crypto'
import { createLanceStore } from '@common/db'
import type { GraphStore } from '../store/graph-store.js'
import type { Proposal, ProposalEdge } from '../types.js'
import { extractRelationships } from './extractor.js'

const INGESTION_LANCE_PATH = join(process.cwd(), '../capital-intelligence-ingestion/data/lancedb')

// Per-ticker chunk cap. Matches the LanceDB-era heuristic so the scanner's
// LLM-call shape is unchanged when DATABASE_URL toggles backend.
const MAX_CHUNKS_PER_TICKER = 500

export async function runScan(
  store: GraphStore,
  options: { ticker?: string } = {},
): Promise<number> {
  const allNodes = await store.getNodes()
  const nodes = options.ticker
    ? allNodes.filter(n => n.ticker === options.ticker)
    : allNodes

  if (allNodes.length < 2) {
    console.log('Not enough nodes. Run npm run seed first.')
    return 0
  }

  const vectorStore = await createLanceStore(INGESTION_LANCE_PATH)
  let proposalCount = 0

  for (const nodeA of nodes) {
    // Fetch all chunks for nodeA's ticker once per outer-loop iteration.
    // (Was inside the inner B-loop before — wasteful — but the in-memory
    // filtering against nodeB is cheap, so pull once and reuse.)
    const chunksForA = (await vectorStore.filterByTicker(nodeA.ticker))
      .slice(0, MAX_CHUNKS_PER_TICKER)
    if (chunksForA.length === 0) continue

    for (const nodeB of allNodes) {
      if (nodeA.ticker === nodeB.ticker) continue

      const companyKeyword = nodeB.company.split(' ')[0].toLowerCase()
      const tickerLower    = nodeB.ticker.toLowerCase()
      const relevant = chunksForA
        .filter(c => {
          const content = c.content.toLowerCase()
          return content.includes(tickerLower) || content.includes(companyKeyword)
        })
        .map(c => ({ id: c.id, content: c.content }))

      if (relevant.length === 0) continue

      console.log(`  Scanning ${nodeA.ticker} → ${nodeB.ticker} (${relevant.length} relevant chunks)`)

      const result = await extractRelationships(
        nodeA.ticker, nodeA.company,
        nodeB.ticker, nodeB.company,
        relevant,
      )

      if (result.relationships.length === 0) continue

      const newRels = []
      for (const r of result.relationships) {
        if (!(await store.edgeExists(r.from, r.to, r.type))) newRels.push(r)
      }
      if (newRels.length === 0) continue

      const now = new Date().toISOString()
      const proposal: Proposal = {
        id:              randomUUID(),
        status:          'pending',
        claudeReasoning: newRels.map(r => r.reasoning).join('; '),
        chunkIdsUsed:    relevant.map(c => c.id),
        createdAt:       now,
        resolvedAt:      null,
      }
      await store.insertProposal(proposal)

      for (const rel of newRels) {
        const pe: ProposalEdge = {
          id:            randomUUID(),
          proposalId:    proposal.id,
          from:          rel.from,
          to:            rel.to,
          type:          rel.type,
          strength:      rel.strength,
          description:   rel.description,
          evidenceQuote: rel.evidenceQuote,
          approved:      null,
        }
        await store.insertProposalEdge(pe)
        proposalCount++
      }
    }
  }

  return proposalCount
}
