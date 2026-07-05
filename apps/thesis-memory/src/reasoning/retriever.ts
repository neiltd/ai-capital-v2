// src/reasoning/retriever.ts
import { pipeline, env } from '@huggingface/transformers'
import { join } from 'path'
import { createLanceStore } from '@common/db'
import type { EvidenceChunk } from '../types.js'

env.cacheDir = './.cache/transformers'

const MODEL = 'Xenova/all-MiniLM-L6-v2'
// The @huggingface/transformers pipeline() return is a huge discriminated union
// over every task type; TS can't represent it. Narrow to a callable for our use.
type LooseExtractor = (...args: unknown[]) => Promise<unknown>
let _pipeline: LooseExtractor | null = null

async function embed(text: string): Promise<number[]> {
  if (!_pipeline) {
    _pipeline = (await pipeline('feature-extraction', MODEL)) as unknown as LooseExtractor
  }
  const out = await _pipeline([text], { pooling: 'mean', normalize: true })
  return (out as { tolist(): number[][] }).tolist()[0]
}

export interface Retriever {
  search(query: string, ticker: string, topK: number, dateFrom?: string): Promise<EvidenceChunk[]>
}

export async function createRetriever(ingestionDataPath: string): Promise<Retriever> {
  // createLanceStore picks pgvector when DATABASE_URL is set, LanceDB otherwise.
  // For the SQLite/LanceDB path, point at the ingestion project's lancedb dir.
  const store = await createLanceStore(join(ingestionDataPath, 'lancedb'))

  return {
    async search(query, ticker, topK, dateFrom) {
      const vector = await embed(query)
      const chunks = await store.search(vector, { ticker, dateFrom }, topK)
      return chunks.map(c => ({
        id:             c.id,
        ticker:         c.ticker,
        source:         c.source,
        docType:        c.docType,
        section:        c.section,
        publishedDate:  c.publishedDate,
        content:        c.content,
      }))
    },
  }
}
