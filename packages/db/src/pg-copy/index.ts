// THE NARROW PUBLIC SURFACE OF THE REVIEWED COPY CORE.
//
// WHY A SUBPATH AND NOT THE PACKAGE ROOT. `@common/db` is imported by most of
// this repository; exporting the copy core from its root would put a fenced
// production lifecycle one autocomplete away from every pipeline stage. This
// subpath is imported by exactly one consumer - the operations CLI in
// `@common/queue` - and it exports what that CLI needs and nothing else.
//
// WHY THE DEPENDENCY RUNS THIS WAY. `@common/queue` already depends on
// `@common/db` through `@common/db/credential-url`. The adapters need BullMQ
// and launchd; putting them here would make `@common/db` depend on
// `@common/queue` and close a cycle. So the core stays here, the adapters and
// the CLI live there, and the graph keeps its existing direction.
//
// NOTHING MUTATING IS EXPORTED THAT IS NOT ALREADY REVIEWED. The adapter
// INTERFACES cross this boundary; no adapter implementation does.

export {
  BINDING_VERSION, APPLY_PREFIX, REHEARSE_PREFIX, TOKEN_PATTERN, TOKEN_PREFIX,
  BindingRefused, COPY_BINDING_SHAPE_VERSION, DESTINATION_DISPOSITIONS,
  INSTALLATION_STATES, INSTALLED_STATES, STABLE_INSTALLATIONS, stableInstallationOf,
  modeObservationDocument, modeObservationDigest,
  INSTALLED_DISPOSITIONS,
  MEASURED_DESTINATIONS,
  assertConfirmationMatches, assertOperationalBindingUnchanged,
  confirmationToken, copyBindingDigest, copyBindingDocument, copySetDigest,
  executionBindingDocument, operationalBindingDigest, operationalBindingDocument,
  type BindingReason, type CopyBinding, type CopyMode, type DestinationDisposition,
  type ExecutionBinding, type InstallationState, type StableInstallation,
  type ObservedProducerState, type OperationalAdapterBinding,
  type ProducerIdentity,
} from './bindings.js'

export {
  ADAPTER_DEADLINE_MS, AdapterDeadlineExceeded, LIFECYCLE_FENCE_SENTENCE,
  COMMIT_DISPOSITION_FILE, PRISTINE_RELEASE_FILE,
  LIFECYCLE_FILE, LIFECYCLE_PREFIX, LifecycleEvidenceFailed,
  LifecycleInterventionRequired, LifecyclePreCommitCleanupRequired, LifecycleRefused,
  ACTIVITY_CENSUS_SQL, BACKEND_START_SHAPE, BACKEND_START_SQL, COMPLETE_FENCE_LOCKS,
  QUEUE_SAMPLE_INTERVAL_MS, releasedLockCensusSqlFor,
  RELEASE_GATE_FILE, RELEASE_GATE_PREFIX, RELEASE_SQL, SESSION_IDENTITY_SQL,
  RESTORE_ORDER, SUPERVISOR_ALIVE_SQL,
  REVIEWED_BACKEND_TYPES, REVIEWED_PRODUCERS, REVIEWED_QUEUES, ReleaseGateRefused,
  assertFencedSupervisorUnchanged,
  assertQuiescent, isAuthorizationConsumed, isInterventionRequired,
  isReleaseAuthorization, proveOperationalState, publishLifecycleBundle,
  releaseFence, rollbackAndProveReleased, runLifecycle, runOperationalGate,
  type LifecycleInput, type LifecycleResult,
  runReleaseGate, withDeadline,
  type AdapterContext, type LifecycleFenceState, type OperationalFindings,
  type OperationalGateInput, type OperationalReleaseAuthorization,
  type DestinationCensusAdapter, type IdentifiableSession, type ProducerAdapter,
  type ProducerCensusRow, type ProducerQuiescenceMeasurement, type ProducerState,
  type QueueAdapter, type QueueSample,
  type QuiescenceAttestation,
  type QuiescenceAdapter, type ReleaseAuthorization, type ReleaseResult,
  type ReviewedSession,
} from './lifecycle.js'

// The narrow driver-credential grammar. See driver-credential.ts for why this
// is separate from the export-role reader rather than a widening of it.
export {
  DriverCredentialRefused, parseDriverCredentialUrl, pgpassRecordFor,
  type DriverCredentialForm, type ParsedDriverCredential,
} from './driver-credential.js'

export {
  classifyTargetDisposition, dispositionDocument, isCommitUnknownHandoff,
  mintCommitUnknownHandoff,
  type CommitUnknownHandoff, type DispositionResult, type TargetDisposition,
} from './commit-disposition.js'

export {
  CommitOutcomeUnknown, Stage2Refused, loadReviewedTarget, readPublishedBundle,
  runApply, runInspect, isVerifiedBundle,
  type InspectResult,
  type ApplyResult, type PublishedManifest, type SourceStageInput,
} from './stage2.js'

// STAGE 1, EXPORTED FOR THE ONE ORCHESTRATOR THAT OWNS THE CONTINUOUS FENCE.
//
// The standalone Stage-1 CLI releases the fence in its `finally`, which is
// correct for a manifest taken on its own and fatal for a copy: the production
// sequence needs the manifest AND the fence that produced it to survive into
// Stage 2. `runStage1` never releases anything - the caller does - so the
// orchestrator can hold one supervisor across both stages. That is why this is
// exported here rather than reached through the CLI.
export {
  MANIFEST_FILE, MANIFEST_PREFIX, SOURCE_CONTRACT_FILE, assertOperatorInput,
  proveFence, runStage1,
  type Stage1Input, type Stage1Result,
} from './source-manifest.js'

export {
  DIGEST_FILE, EVIDENCE_RETRY_SCRATCH, EvidencePublicationUnknown,
  EvidencePublishedButUnverified,
  EvidenceRefused, REAL_EVIDENCE_OPS, REVIEWED_PREFIXES, TEMPORARY_NAME_PREFIX,
  assertCompletionMarker, assertEvidenceRoot, discardScratch,
  evidenceNames, evidenceStamp, inspectScratch, newRunId, pathIdentity, pathIsPresent,
  publishEvidence, publishRetainedScratch,
  verifyPublishedEvidence,
  type EvidenceOps, type PublishedEvidence, type ScratchCleanup,
  type ScratchDisposition, type ScratchInput,
} from './evidence.js'

export {
  COPY_TABLES, REVIEWED_CONTRACT_DIGEST, canonicalJson, contractDigest,
  serializeArtifact, sha256Hex,
  type Canonical, type ContractArtifact,
} from './schema-contract.js'

export {
  FENCE_SEQUENCES, FENCE_SEQUENCE_LOCK_MODE, FENCE_TABLES, FENCE_TABLE_LOCK_MODE,
  IDENTITY_SQL, acquireSourceFence, assertFenceProof,
  fenceRelationArray, parseLockRows,
  SELECTED_SEQUENCE_FENCE,
  type AcquiredFence, type FenceExecutor, type SequenceFenceId,
} from './source-fence.js'

export {
  EXPORT_BEGIN_SQL, EXPORT_ROLLBACK_SQL,
  // Stage 1's session type, exported so a factory can be typed EXACTLY as the
  // field it will fill rather than cast into it.
  type ExportSession, type OperatorInput,
} from './source-manifest.js'

export {
  EXPORT_ROLE_NAME, EXPORT_SCHEMAS, EXPORT_SECRET_BYTES, EXPORT_TABLES,
  ExportRoleRefused, LEDGER_COLUMNS, LEDGER_RELATION, REAL_PUBLISH_OPS,
  CredentialPublishedButUnverified, assertCredentialFilename,
  buildExportCredentialTcpUrl, buildExportPgpassLine, credentialReceipt,
  publishExportCredential as publishReviewedCredential,
  type CredentialReceipt,
  createExportRoleSql, deriveScramSha256Verifier, dropExportRoleSql,
  generateExportSecret, publishExportCredential, removeExportCredential,
  runExportRoleBatch, secretsEqual,
  type BatchOutcome, type PublishOps, type TcpCredentialTarget,
} from './export-role.js'
export { TARGET_COPY_LOGIN_ROLE, TARGET_COPY_TRANSPORT, TARGET_OWNER_ROLE, type TargetExpectation } from './target-authority.js'
// `DriverSession` is exported alongside the openers so the operations CLI can
// type its factories EXACTLY. It structurally satisfies every consumer in this
// core - `ExportSession`/`ContractQueryExecutor` want `pid` + `rows`, and
// `VerifyCloseable` wants those plus `end` - so the orchestration needs no
// cast, which matters: an `as unknown as` between a session authority and
// `runLifecycle` is the one place a wrong session passes unnoticed.
export {
  openDriverSession, openSilentDriverSession,
  type DriverSession, type DriverTarget,
} from './driver-session.js'
export {
  VERIFICATION_FILE, VERIFICATION_PREFIX, attemptFenceProof,
  type FenceProofResult, type VerifierHandoff, type VerifyCloseable,
} from './verify.js'

// The secret-safe psql session the operations command opens its source
// sessions through. Exported here so the queue package never has to reach
// past this subpath into `@common/db`'s internals.
export {
  INHERITED_FD_DIR, PASSFILE_CHILD_FD, PsqlBackendRefused, openPsqlBackend,
  type PsqlBackend, type PsqlBackendOptions, type SqlResult,
} from './psql-backend.js'
