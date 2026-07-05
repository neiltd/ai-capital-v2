// Vector chunk store — shared between LanceDB and pgvector backends.
// Types inlined for self-containment; capital-intelligence-ingestion's local
// types.ts re-exports them for backward compatibility.

export type SourceType =
  | 'sec_filing' | 'earnings_transcript' | 'news' | 'ir_page' | 'manual'
  | 'financialdata' | 'personal_note' | 'gmail_digest' | 'twitter'

export type DocType =
  | '10-K' | '10-Q' | '8-K' | 'transcript' | 'article' | 'ir_release'
  | 'manual' | 'press_release' | 'financial_statement' | 'note'
  | 'digest' | 'tweet_thread' | 'insider_form4'

export interface ChunkMetadata {
  id:             string
  ticker:         string
  company:        string
  source:         SourceType
  docType:        DocType
  section:        string
  publishedDate:  string
  fiscalPeriod:   string | null
  url:            string
  chunkIndex:     number
  parentDocId:    string
  contentHash:    string
  embeddingModel: string
}

export interface Chunk extends ChunkMetadata {
  content:   string
  embedding: number[]
}

export interface FilterOptions {
  ticker?:   string | string[]
  source?:   SourceType
  docType?:  DocType
  section?:  string
  dateFrom?: string
  dateTo?:   string
}

export interface LanceStore {
  insertChunks(chunks: Chunk[]): Promise<void>
  chunkExists(contentHash: string): Promise<boolean>
  filterByTicker(ticker: string): Promise<Chunk[]>
  search(queryVector: number[], filters: FilterOptions, topK: number): Promise<Chunk[]>
  close(): void
}
