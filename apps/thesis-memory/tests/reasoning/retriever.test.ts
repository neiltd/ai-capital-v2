// tests/reasoning/retriever.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createRetriever } from '../../src/reasoning/retriever.js'

vi.mock('@lancedb/lancedb', () => ({
  connect: vi.fn().mockResolvedValue({
    tableNames: vi.fn().mockResolvedValue(['chunks']),
    openTable: vi.fn().mockResolvedValue({
      vectorSearch: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            id: 'chunk-1', ticker: 'NVDA', source: 'sec_filing', docType: '10-Q',
            section: 'mda', publishedDate: '2026-05-20',
            content: 'Revenue grew 69% year over year to $44.1 billion.',
            vector: Array(384).fill(0.1),
          },
        ]),
      }),
    }),
  }),
}))

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ tolist: () => [Array(384).fill(0.1)] })
  ),
  env: { cacheDir: '' },
}))

describe('createRetriever', () => {
  it('returns relevant chunks for a query', async () => {
    const retriever = await createRetriever('/fake/ingestion/path')
    const chunks = await retriever.search('CUDA competitive advantage', 'NVDA', 5)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].ticker).toBe('NVDA')
    expect(chunks[0].content).toContain('Revenue grew')
  })

  it('returns empty array when ingestion store has no chunks table', async () => {
    const { connect } = await import('@lancedb/lancedb') as { connect: ReturnType<typeof vi.fn> }
    connect.mockResolvedValueOnce({
      tableNames: vi.fn().mockResolvedValue([]),
    })
    const retriever = await createRetriever('/fake/ingestion/path')
    const chunks = await retriever.search('query', 'NVDA', 5)
    expect(chunks).toHaveLength(0)
  })
})
