// Canonical document/chunk types used by the ingestion + analysis pipelines.
// Owner: capital-intelligence-ingestion (produces RawDocument + ChunkMetadata).

export type SourceType =
  | 'sec_filing'
  | 'earnings_transcript'
  | 'news'
  | 'ir_page'
  | 'manual'
  | 'financialdata'
  | 'personal_note'
  | 'gmail_digest'
  | 'twitter'

export type DocType =
  | '10-K'
  | '10-Q'
  | '8-K'
  | 'transcript'
  | 'article'
  | 'ir_release'
  | 'manual'
  | 'press_release'
  | 'financial_statement'
  | 'note'
  | 'digest'
  | 'tweet_thread'
  | 'insider_form4'

export interface RawDocument {
  id:         string
  source:     SourceType
  docType:    DocType
  ticker:     string | null
  url:        string | null
  publishedAt: string
  fetchedAt:  string
  title:      string
  body:       string
  metadata?:  Record<string, unknown>
}

export interface ChunkMetadata {
  docId:       string
  source:      SourceType
  docType:     DocType
  ticker:      string | null
  url:         string | null
  publishedAt: string
  chunkIndex:  number
}
