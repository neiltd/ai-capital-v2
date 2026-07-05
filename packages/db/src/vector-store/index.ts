// Vector store — picks LanceDB or pgvector based on DATABASE_URL.

import { usePostgres } from '../pool.js'
import { createLanceStore as createLanceLanceStore } from './lance.js'
import { createPgVectorStore }                       from './pg.js'

export * from './types.js'

/**
 * Picks pgvector (capital.chunks) when DATABASE_URL is set; otherwise opens
 * the LanceDB file at `lanceFallbackPath` and exposes the same interface.
 */
export async function createLanceStore(lanceFallbackPath: string) {
  if (usePostgres()) return createPgVectorStore()
  return await createLanceLanceStore(lanceFallbackPath)
}
