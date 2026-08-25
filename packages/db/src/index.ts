export { getPool, closePool, usePostgres, type PgPool } from './pool.js'
export { runMigrations, type MigrationResult } from './migrate.js'
export {
  parseClaimBlocks, recordClaims, verifyClaim, resolveClaim, supersedeClaim,
  claimHistory, ClaimParseError,
  type ParsedClaim, type ClaimProvenance, type ClaimRow,
  type ClaimType, type Confidence, type VerificationStatus, type ResolutionType,
} from './agent-claims.js'
export { createLanceStore } from './vector-store/index.js'
export type {
  LanceStore, Chunk, ChunkMetadata, FilterOptions, SourceType, DocType,
} from './vector-store/types.js'
