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
  INSTALLATION_STATES,
  MEASURED_DESTINATIONS,
  assertConfirmationMatches, assertOperationalBindingUnchanged,
  confirmationToken, copyBindingDigest, copyBindingDocument, copySetDigest,
  executionBindingDocument, operationalBindingDigest, operationalBindingDocument,
  type BindingReason, type CopyBinding, type CopyMode, type DestinationDisposition,
  type ExecutionBinding, type InstallationState, type OperationalAdapterBinding,
  type ProducerIdentity,
} from './bindings.js'

export {
  ADAPTER_DEADLINE_MS, AdapterDeadlineExceeded, LIFECYCLE_FENCE_SENTENCE,
  LIFECYCLE_FILE, LIFECYCLE_PREFIX, LifecycleEvidenceFailed,
  LifecycleInterventionRequired, LifecyclePreCommitCleanupRequired, LifecycleRefused,
  ACTIVITY_CENSUS_SQL, BACKEND_START_SQL, COMPLETE_FENCE_LOCKS,
  QUEUE_SAMPLE_INTERVAL_MS, releasedLockCensusSqlFor,
  RELEASE_GATE_FILE, RELEASE_GATE_PREFIX, RELEASE_SQL, SESSION_IDENTITY_SQL,
  RESTORE_ORDER, SUPERVISOR_ALIVE_SQL,
  REVIEWED_BACKEND_TYPES, REVIEWED_PRODUCERS, REVIEWED_QUEUES, ReleaseGateRefused,
  assertQuiescent, isAuthorizationConsumed, isInterventionRequired,
  isReleaseAuthorization, proveOperationalState, publishLifecycleBundle,
  releaseFence, rollbackAndProveReleased, runLifecycle, runOperationalGate,
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

export {
  classifyTargetDisposition, dispositionDocument, isCommitUnknownHandoff,
  mintCommitUnknownHandoff,
  type CommitUnknownHandoff, type DispositionResult, type TargetDisposition,
} from './commit-disposition.js'

export {
  CommitOutcomeUnknown, Stage2Refused, loadReviewedTarget, readPublishedBundle,
  runApply, runInspect, isVerifiedBundle,
  type ApplyResult, type PublishedManifest,
} from './stage2.js'

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
  type AcquiredFence, type FenceExecutor, type SequenceFenceId,
} from './source-fence.js'

export {
  EXPORT_BEGIN_SQL, EXPORT_ROLLBACK_SQL, type OperatorInput,
} from './source-manifest.js'

export { EXPORT_ROLE_NAME } from './export-role.js'
export { TARGET_OWNER_ROLE, type TargetExpectation } from './target-authority.js'
export { openDriverSession, openSilentDriverSession, type DriverTarget }
  from './driver-session.js'
export {
  VERIFICATION_FILE, attemptFenceProof,
  type FenceProofResult, type VerifierHandoff, type VerifyCloseable,
} from './verify.js'

// The secret-safe psql session the operations command opens its source
// sessions through. Exported here so the queue package never has to reach
// past this subpath into `@common/db`'s internals.
export {
  INHERITED_FD_DIR, PASSFILE_CHILD_FD, PsqlBackendRefused, openPsqlBackend,
  type PsqlBackend, type PsqlBackendOptions,
} from './psql-backend.js'
