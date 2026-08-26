export { getPool, closePool, usePostgres, type PgPool } from './pool.js'
export { runMigrations, type MigrationResult } from './migrate.js'
export {
  CLAIM_PROTOCOL,
  parseClaimBlocks, parseCaptureBlocks, parseEventBlocks,
  recordClaims, applyEvent, recordAgentRun, ingestAgentOutput,
  claimHistory, closeClaimWriter, ClaimParseError,
  type ParsedClaim, type ParsedEvent, type ClaimProvenance, type ClaimRow,
  type PersistResult, type ClaimType, type Confidence, type CaptureMethod,
  type ClaimEvent, type VerificationStatus, type ResolutionType,
} from './agent-claims.js'
export { createLanceStore } from './vector-store/index.js'
export type {
  LanceStore, Chunk, ChunkMetadata, FilterOptions, SourceType, DocType,
} from './vector-store/types.js'
export {
  withProductionWrite, currentWriteIntent, assertProductionWriteAuthorized,
  assertPoolWriteAuthorized, isProtectedDestination,
  ProductionWriteRefused, UndeterminableDestination,
} from './write-intent.js'
export type { WriteOperation, WriteContext, WriteIntent } from './write-intent.js'
