#!/usr/bin/env tsx
// THE PRODUCTION OPERATIONS COMMAND FOR THE FENCED COPY.
//
// FIVE MODES, EXACTLY ONE PER INVOCATION:
//
//   --inspect --for=rehearse   print the rehearse-mode token and the scope digest
//   --inspect --for=apply      print the apply-mode token, over BOTH digests
//   --rehearse                 the NON-MUTATING operational rehearsal
//   --verify-restoration       prove producers came back, publish the record
//   --review-rehearsal         close the rehearsal, publishing the only bundle
//                              that may authorise an apply
//   --apply                    refused unless a reviewed rehearsal verifies
//
// WHY THE REHEARSAL COPIES NOTHING. Stage 2 requires all 21 target tables empty
// and all three sequences pristine. A rehearsal that ran the copy would commit
// rows to that target, and the real apply would then refuse at exactly that
// check - so "rehearse, then apply" was impossible by construction. The
// prerequisite was never meant to copy twice; it exists so somebody can watch
// the PRODUCTION ADAPTERS work. So this rehearsal proves the adapters, the
// topology, the source fence, the release path and the manual-restoration
// workflow, and it never opens a target at all.
//
// WHAT THE DISPOSABLE SUITES STILL OWN. The transactional copy lifecycle is
// proved against two live disposable clusters and nowhere else. Nothing here
// claims otherwise, and a mutation control asserts that this file never says it
// does.
//
// NO HIDDEN SWITCH. Every mode and every authority is argv-only. No environment
// variable, no NODE_ENV branch and no test-only flag reaches a live path. The
// launchctl binary is a CONSTANT in the adapter, not an option: anyone who can
// pass an argument must not be able to decide which program answers "is the
// fence quiescent".
//
// IT RUNS. `main()` below is guarded on being the process entry point, so
// importing this module for its exports - which every test does - starts
// nothing, opens nothing and exits nothing. `pnpm --filter @common/queue
// pg-copy-ops -- <args>` is the reviewed way to invoke it.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import {
  BACKEND_START_SQL, COMPLETE_FENCE_LOCKS, INSTALLATION_STATES,
  QUEUE_SAMPLE_INTERVAL_MS, RELEASE_GATE_PREFIX, REVIEWED_CONTRACT_DIGEST,
  COPY_BINDING_SHAPE_VERSION, canonicalJson, fenceRelationArray,
  releasedLockCensusSqlFor,
  acquireSourceFence, copyBindingDigest, copySetDigest, evidenceStamp, newRunId,
  openPsqlBackend, readPublishedBundle,
  REVIEWED_PRODUCERS, REVIEWED_QUEUES, assertConfirmationMatches,
  assertOperationalBindingUnchanged, confirmationToken, operationalBindingDigest,
  BindingRefused, DIGEST_FILE, EVIDENCE_RETRY_SCRATCH, EvidenceRefused,
  LifecycleEvidenceFailed, REAL_EVIDENCE_OPS, ReleaseGateRefused,
  discardScratch, inspectScratch,
  publishLifecycleBundle, releaseFence, runOperationalGate, verifyPublishedEvidence,
  withDeadline,
  type AdapterContext, type CopyBinding, type CopyMode, type DestinationCensusAdapter,
  type EvidenceOps, type ScratchInput,
  type InstallationState,
  type ExecutionBinding, type FenceExecutor, type OperationalAdapterBinding,
  type ProducerCensusRow, type ProducerIdentity, type QueueAdapter,
  type QuiescenceAdapter, type QuiescenceAttestation,
} from '@common/db/pg-copy'

import { BLOCKING_STATES, PAUSED_IS_BLOCKING, bullmqQueueAdapter } from '../src/pg-copy-ops/bullmq.js'
import {
  DestinationRefused, installationOf, proveDestinations,
  type DestinationPolicyEntry, type ReviewedSourceEndpoint,
} from '../src/pg-copy-ops/destination.js'
import {
  LaunchdInspectionRefused, PRODUCER_PROCESS_PATTERNS, inspectLabel,
  launchdQuiescenceAdapter, readDisabled,
  type CommandRunner, type LabelInspection, type LaunchdOptions,
} from '../src/pg-copy-ops/launchd.js'
import {
  SecureFileRefused, openReviewedContainer, openReviewedFileDescriptor,
} from '../src/pg-copy-ops/secure-file.js'
import { RedisConfigRefused, resolveRedis } from '../src/pg-copy-ops/redis-config.js'

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_REFUSED = 2
export const EXIT_COMMIT_UNKNOWN = 3
/** A copy or rehearsal that succeeded and still needs a person. */
export const EXIT_ACTION_REQUIRED = 4
/** An intervention hold that an operator resolved. */
export const EXIT_INTERVENTION_RESOLVED = 5

export const MODES: readonly string[] = Object.freeze([
  '--inspect', '--rehearse', '--verify-restoration', '--review-rehearsal', '--apply',
])

export const OPTIONS: readonly string[] = Object.freeze([
  '--for', '--confirm', '--evidence-root', '--producer-authority',
  '--rehearsal-authorization', '--quiescence-attestation', '--post-restoration-policy',
  '--destination-policy', '--reviewed-rehearsal', '--operational-rehearsal-bundle',
  '--producer-restoration-bundle',
  // WHERE THE SOURCE IS, not what it will turn out to be. The system
  // identifier used to be stated here and folded into the binding, which made
  // the binding agree with whatever was typed; it is measured now.
  '--source-host', '--source-port', '--source-database',
  '--redis-credential', '--redis-host', '--redis-port', '--redis-db',
  // AND WHICH CHECKOUT THIS IMPLEMENTATION IS. `--implementation-head` was the
  // same mistake: a forty-hex string somebody pasted, recorded as the commit
  // the code came from. `--checkout` names a directory; `git` says what is in it.
  '--agents-dir', '--run-id', '--stamp', '--reviewer',
  // THE APPLY INSPECTION'S OWN SCOPE.
  //
  // SELECTORS, NOT ASSERTIONS. `--bundle-dir` names which evidence to verify
  // and `--checkout` names which repository to measure. The target identity,
  // the provenance HEAD and the ingestion gitlink are NOT options any more:
  // they used to be typed in and folded into the token, which made the token
  // agree with whatever was typed - including a wrong target.
  '--bundle-dir', '--checkout',
  // WHERE TO LOOK, not what will be found. These say which server to open a
  // read-only identity session against; every identity FACT comes back from
  // that session, and a mismatch between what was reached and what the bundle
  // describes is a refusal rather than a value.
  '--target-host', '--target-port', '--target-database', '--target-user',
  '--target-passfile',
  // HOW A SOURCE SESSION IS OPENED. Paths to reviewed 0600 containers and
  // plain connection coordinates - never a URL, never a password.
  '--psql', '--source-user', '--source-passfile',
  // THE INTERVENTION HOLD.
  '--resolution-file',
])

/** The one accepted authority in this milestone. Stopping is a person's job. */
export const PRODUCER_AUTHORITY = 'manual-stop'

export class OpsRefused extends Error {
  constructor(readonly reason: string, readonly at: string | null = null) {
    super(`${reason}${at === null ? '' : ` (at ${at})`}`)
    this.name = 'OpsRefused'
  }
}

export interface ParsedArgs {
  readonly mode: string
  readonly values: Readonly<Record<string, string>>
}

/**
 * Parse argv into exactly one mode and a closed option set.
 *
 * An unknown option is refused rather than ignored: a misspelled
 * `--evidence-rot` that was silently dropped would publish into whatever the
 * default happened to be.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values: Record<string, string> = {}
  let mode: string | null = null
  for (const arg of argv) {
    if (MODES.includes(arg)) {
      if (mode !== null) throw new OpsRefused('exactly one mode is required')
      mode = arg
      continue
    }
    const eq = arg.indexOf('=')
    if (!arg.startsWith('--') || eq < 0) {
      throw new OpsRefused('every option must be --name=value', arg.slice(0, 32))
    }
    const name = arg.slice(0, eq)
    if (!OPTIONS.includes(name)) throw new OpsRefused('unknown option', name)
    if (name in values) throw new OpsRefused('an option was supplied twice', name)
    values[name] = arg.slice(eq + 1)
  }
  if (mode === null) throw new OpsRefused('exactly one mode is required')
  return { mode, values: Object.freeze(values) }
}

const required = (v: Readonly<Record<string, string>>, name: string): string => {
  const got = v[name]
  if (got === undefined || got === '') throw new OpsRefused('a required option is missing', name)
  return got
}

/** SHA-256 of a file's bytes, for the policy documents the binding pins. */
export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}


/** `device:inode` for the evidence root, so a relocated root invalidates. */
export function deviceInode(path: string): string {
  const st = statSync(path, { bigint: true }) as unknown as { dev: bigint; ino: bigint }
  return `${String(st.dev)}:${String(st.ino)}`
}

/** The reviewed destination policy: one declared disposition per label. */
export function readDestinationPolicy(path: string): readonly DestinationPolicyEntry[] {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
    producers?: Array<{ label?: unknown; expected?: unknown; installation?: unknown }>
  }
  const rows = Array.isArray(parsed.producers) ? parsed.producers : []
  if (rows.length !== REVIEWED_PRODUCERS.length) {
    throw new OpsRefused('the destination policy does not cover the reviewed producer set')
  }
  return Object.freeze(rows.map((r, n) => {
    if (r.label !== REVIEWED_PRODUCERS[n]) {
      throw new OpsRefused('the destination policy is not in the reviewed order', String(n))
    }
    if (typeof r.expected !== 'string') {
      throw new OpsRefused('a destination policy entry has no expected disposition',
                           String(r.label))
    }
    // AND WHAT STATE IT IS EXPECTED TO BE INSTALLED IN. Two different facts:
    // "this agent is not installed on this machine" is a reviewed answer, and
    // "this agent writes nowhere we could prove" is a refusal. A policy that
    // named only the second could not distinguish them.
    if (typeof r.installation !== 'string' ||
        !INSTALLATION_STATES.includes(r.installation as never)) {
      throw new OpsRefused('a destination policy entry has no reviewed installation state',
                           String(r.label))
    }
    return {
      label: r.label,
      expected: r.expected as DestinationPolicyEntry['expected'],
      installation: r.installation as DestinationPolicyEntry['installation'],
    }
  }))
}

/** The required post-restoration state per label, from a closed set. */
export type RestorationState = 'running' | 'loaded-scheduled-healthy' | 'absent'
export const RESTORATION_STATES: readonly RestorationState[] =
  Object.freeze(['running', 'loaded-scheduled-healthy', 'absent'])

export function readRestorationPolicy(
  path: string,
): readonly { label: string; required: RestorationState }[] {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
    producers?: Array<{ label?: unknown; required?: unknown }>
  }
  const rows = Array.isArray(parsed.producers) ? parsed.producers : []
  if (rows.length !== REVIEWED_PRODUCERS.length) {
    throw new OpsRefused('the restoration policy does not cover the reviewed producer set')
  }
  return Object.freeze(rows.map((r, n) => {
    if (r.label !== REVIEWED_PRODUCERS[n]) {
      throw new OpsRefused('the restoration policy is not in the reviewed order', String(n))
    }
    if (typeof r.required !== 'string' ||
        !RESTORATION_STATES.includes(r.required as RestorationState)) {
      // THE 126 AGENTS LAND HERE. A policy that declines to say what state they
      // must reach cannot be satisfied, which is the point: the decision is
      // forced into a file and made testable rather than merely recorded.
      throw new OpsRefused('a restoration policy entry has no reviewed required state',
                           String(r.label))
    }
    return { label: r.label, required: r.required as RestorationState }
  }))
}

export interface ScopeInputs {
  readonly source: ReviewedSourceEndpoint
  readonly sourceSystemIdentifier: string
  readonly evidenceRoot: string
  readonly postRestorationPolicyPath: string
  readonly destinationPolicyPath: string
  readonly implementationHead: string
  readonly launchd: LaunchdOptions
  readonly redis: ReturnType<typeof resolveRedis>
}

/**
 * Derive the current operational binding by MEASURING, never by accepting.
 *
 * Every field here comes from a file on disk, a launchctl reading, or a
 * credential container's identity. Nothing is taken from an operator's word.
 */
export async function deriveOperationalBinding(
  i: ScopeInputs, deadlineMs: number,
): Promise<OperationalAdapterBinding> {
  const producers: readonly ProducerIdentity[] = await withDeadline(
    'launchd', deadlineMs, ctx => proveDestinations(
      REVIEWED_PRODUCERS, i.source, readDestinationPolicy(i.destinationPolicyPath),
      i.launchd, ctx))

  const structured = producers.find(p => p.label.endsWith('.structured-worker'))
  if (structured === undefined) {
    throw new OpsRefused('the reviewed producer set has no structured worker')
  }
  return Object.freeze({
    sourceEndpoint: i.source.host,
    sourceDatabase: i.source.database,
    sourceSystemIdentifier: i.sourceSystemIdentifier,
    producers,
    queues: REVIEWED_QUEUES,
    blockingStates: BLOCKING_STATES as readonly string[],
    pausedIsBlocking: PAUSED_IS_BLOCKING,
    producerAuthority: PRODUCER_AUTHORITY,
    // ITS INSTALLATION STATE, NOT ITS DATABASE DESTINATION. Whether that agent
    // exists on this machine at all is what decides whether its absence from a
    // quiescence census is expected or alarming; where it would write if it
    // were installed answers a different question entirely.
    structuredWorkerInstallation: structured.installation,
    // THE PATTERNS THE PROCESS CENSUS MATCHES ON, in producer order. Part of
    // what "quiescent" means, so part of what is agreed to.
    producerProcessPolicy: producers.map(p => ({
      label: p.label,
      pattern: PRODUCER_PROCESS_PATTERNS[p.label] ?? '',
    })),
    redisHost: i.redis.sanitized.host,
    redisPort: i.redis.sanitized.port,
    redisDatabase: i.redis.sanitized.database,
    evidenceRoot: i.evidenceRoot,
    evidenceRootDeviceInode: deviceInode(i.evidenceRoot),
    postRestorationPolicyPath: i.postRestorationPolicyPath,
    postRestorationPolicySha256: fileSha256(i.postRestorationPolicyPath),
    implementationHead: i.implementationHead,
  })
}

/** The bundle a rehearsal review names, verified from disk rather than trusted. */
export function verifyReferencedBundle(
  dir: string, expectedRecord: string, manifestFile: string,
): Record<string, never> {
  // NAMED, NOT GUESSED. "The one JSON that is not the detail file" picks
  // whichever entry the directory listing happens to yield first, and a bundle
  // whose detail file parsed as a manifest would be read as the wrong record.
  const files = verifyPublishedEvidence(dir)
  if (!files.includes(manifestFile)) {
    throw new OpsRefused('a referenced bundle has no manifest', manifestFile)
  }
  const doc = JSON.parse(readFileSync(join(dir, manifestFile), 'utf-8')) as Record<string, never>
  if ((doc as { record?: unknown }).record !== expectedRecord) {
    throw new OpsRefused('a referenced bundle is not the expected record', expectedRecord)
  }
  if ((doc as { complete?: unknown }).complete !== true) {
    throw new OpsRefused('a referenced bundle is not complete')
  }
  return doc
}

/**
 * THE ONE PLACE `--apply` IS ALLOWED THROUGH, and it is not allowed through yet.
 *
 * WHAT IS MISSING IS CODE AND A DECISION, not neither. The core lifecycle is
 * complete and proved against disposable clusters; what does not exist is a
 * reviewed rehearsal bundle produced by an OBSERVED live run, and the operator
 * decisions the post-restoration policy forces. Until a rehearsal review exists
 * and verifies, this refuses before a target client could be constructed.
 */
export function assertApplyAuthorized(
  values: Readonly<Record<string, string>>, current: OperationalAdapterBinding,
): VerifiedChain {
  const dir = values['--reviewed-rehearsal']
  if (dir === undefined || dir === '') {
    throw new OpsRefused(
      'the standalone apply path requires a reviewed rehearsal that has been observed')
  }
  const review = verifyReferencedBundle(dir, 'rehearsal-review', 'review.json')
  const reviewed = (review as { operational_adapter_binding_digest?: unknown })
    .operational_adapter_binding_digest
  if (typeof reviewed !== 'string') {
    throw new OpsRefused('the reviewed rehearsal records no operational binding')
  }

  // THE WHOLE CHAIN, REREAD AND REVERIFIED - not just this manifest.
  //
  // A review's own DIGEST covers the review's bytes and nothing else. The two
  // bundles it NAMES are separate directories that anyone with write access
  // could have replaced since, and a check that stopped at the review would
  // authorise an apply on the strength of a document describing evidence that
  // is no longer there. So both are re-verified from disk and their recorded
  // digests are compared with what those directories hold right now.
  const named = review as {
    operational_rehearsal?: { name?: unknown; digest_file_digest?: unknown }
    producer_restoration?: { name?: unknown; digest_file_digest?: unknown }
  }
  const rehearsalPath = values['--operational-rehearsal-bundle']
  const restorationPath = values['--producer-restoration-bundle']
  if (rehearsalPath === undefined || restorationPath === undefined) {
    throw new OpsRefused(
      'an apply must name the rehearsal and restoration bundles its review closed')
  }
  const chain = verifyRehearsalChain(rehearsalPath, restorationPath)
  if (named.operational_rehearsal?.name !== chain.rehearsalName ||
      named.operational_rehearsal?.digest_file_digest !== chain.rehearsalDigest) {
    throw new OpsRefused('the review does not describe this rehearsal bundle')
  }
  if (named.producer_restoration?.name !== chain.restorationName ||
      named.producer_restoration?.digest_file_digest !== chain.restorationDigest) {
    throw new OpsRefused('the review does not describe this restoration bundle')
  }
  if (chain.bindingDigest !== reviewed) {
    throw new OpsRefused('the review and its evidence disagree about the binding')
  }

  // OPERATIONAL BINDING ONLY. The Stage-1 bundle and the content root are
  // deliberately absent: a real copy runs against a bundle that did not exist
  // when the rehearsal ran, and requiring those to match would make every
  // rehearsal invalid the moment it became useful.
  assertOperationalBindingUnchanged(reviewed, current)
  return chain
}

/**
 * THE COPY BINDING FOR AN APPLY, MEASURED - NOT STATED.
 *
 * WHAT WAS WRONG. Every "which target" field came from argv: the database, the
 * system identifier, the port, the endpoint, the role, the provenance HEAD and
 * the ingestion gitlink were all typed by whoever ran the command, and the
 * result was called a fresh binding. That inverts the entire purpose of the
 * token. The token exists so an operator can check that the apply is about to
 * do what they were shown - and a token computed from what they typed agrees
 * with whatever they typed. A wrong target produces a token that matches the
 * wrong target, perfectly.
 *
 * SO EVERY FIELD IS MEASURED:
 *
 *   source identity   asked of a read-only SOURCE session
 *   target identity   asked of a read-only TARGET session
 *   content and       read out of the Stage-1 bundle, whose DIGEST is verified
 *   provenance        before a single field is taken from it
 *   HEAD, gitlink     read from the repository with `git`
 *
 * ARGV MAY STILL SELECT, BUT IT MAY NOT STATE. `--bundle-dir` names which
 * evidence to verify and `--checkout` names which repository to measure; what
 * those things CONTAIN is not up for assertion. If a measurement is
 * unavailable the inspection refuses - it does not fall back to a value
 * somebody supplied, because that value is exactly the thing being checked.
 */
export interface MeasuredScope {
  readonly openSourceIdentity: () => Promise<FenceLike>
  readonly openTargetIdentity: () => Promise<FenceLike>
  readonly measureRepository: (checkout: string) => Promise<{
    head: string; ingestionGitlink: string
  }>
}

/**
 * One session's reviewed identity, as that session reports it.
 *
 * WHAT A SESSION CAN AND CANNOT TELL YOU ABOUT ITS ENDPOINT. It knows the
 * server's listen ADDRESS (`inet_server_addr()`), and it knows whether it
 * reached the server over a Unix socket (that same function returning NULL).
 * It does NOT know which socket DIRECTORY it connected through: an earlier
 * revision read `unix_socket_directories`, which is the server's configured
 * LIST of directories, requires `pg_read_all_settings` to read at all, and
 * names none of them as the one this session used. Calling that list "the
 * endpoint" was wrong on all three counts.
 *
 * SO THE TWO ARE KEPT APART. `requestedEndpoint` is the selector the operator
 * validated and connected with - a fact about this invocation. `serverAddress`
 * and `unixTransport` are what the server says about itself. A reader can then
 * ask "did I reach the server I meant to" without either value pretending to
 * be the other.
 */
export interface MeasuredIdentity {
  readonly systemIdentifier: string
  readonly database: string
  /** The EFFECTIVE role: what privileges the session is actually running as. */
  readonly currentUser: string
  /** The AUTHENTICATED role. Differs from the above after `SET ROLE`. */
  readonly sessionUser: string
  readonly port: string
  /** `inet_server_addr()`, or null - which is what a Unix socket reports. */
  readonly serverAddress: string | null
  readonly unixTransport: boolean
  /** The validated selector this session was opened with. Not a measurement. */
  readonly requestedEndpoint: string
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/
const SYSID_RE = /^[1-9][0-9]{0,19}$/
const PORT_RE = /^[1-9][0-9]{0,4}$/
const HEX40_RE = /^[0-9a-f]{40}$/

/**
 * The six reviewed identity facts, asked of the session itself.
 *
 * EVERY ONE IS READABLE BY AN ORDINARY ROLE. Nothing here needs
 * `pg_read_all_settings`, which the reviewed export and migrator roles do not
 * have and must not be granted in order to satisfy an inspection.
 */
export const MEASURED_IDENTITY_SQL =
  'SELECT (pg_catalog.pg_control_system()).system_identifier::pg_catalog.text, ' +
  'pg_catalog.current_database(), ' +
  'CURRENT_USER::pg_catalog.text, ' +
  'SESSION_USER::pg_catalog.text, ' +
  "pg_catalog.current_setting('port'), " +
  "COALESCE(pg_catalog.inet_server_addr()::pg_catalog.text, ''), " +
  '(pg_catalog.inet_server_addr() IS NULL)::pg_catalog.text'

export const MEASURED_IDENTITY_COLUMNS = 7

/** Ask one session who it is. Every field is that session's own answer. */
export async function measureIdentity(
  session: FenceLike, requestedEndpoint: string,
): Promise<MeasuredIdentity> {
  const r = await session.send(MEASURED_IDENTITY_SQL)
  if (r.error !== null) {
    throw new OpsRefused('a reviewed identity session refused to identify itself')
  }
  const row = r.rows[0] ?? []
  if (row.length !== MEASURED_IDENTITY_COLUMNS) {
    throw new OpsRefused('a reviewed identity session did not answer in the reviewed form')
  }
  const [systemIdentifier, database, currentUser, sessionUser, port, address, isUnix] =
    row as unknown as [string, string, string, string, string, string, string]
  if (!SYSID_RE.test(systemIdentifier) || !IDENT_RE.test(database) ||
      !IDENT_RE.test(currentUser) || !IDENT_RE.test(sessionUser) || !PORT_RE.test(port)) {
    throw new OpsRefused('a reviewed identity is not in the reviewed form')
  }
  if (isUnix !== 'true' && isUnix !== 'false') {
    throw new OpsRefused('a reviewed identity is not in the reviewed form')
  }
  const unixTransport = isUnix === 'true'
  // A UNIX SESSION HAS NO SERVER ADDRESS, and a TCP one must have one. A row
  // claiming both, or neither, is not an answer this can use.
  if (unixTransport !== (address === '')) {
    throw new OpsRefused('a reviewed identity contradicts itself about its transport')
  }
  return Object.freeze({
    systemIdentifier, database, currentUser, sessionUser, port,
    serverAddress: address === '' ? null : address,
    unixTransport,
    requestedEndpoint,
  })
}

/** What a repository measurement establishes. Every field read with git. */
export interface MeasuredProvenance {
  /** HEAD of the checkout the copy is provenanced against. */
  readonly head: string
  /** The commit the PARENT tree pins for the ingestion submodule. */
  readonly ingestionGitlink: string
}

/**
 * HEAD and the pinned ingestion revision, read from the repository.
 *
 * THE GITLINK, NOT A REVISION FROM INSIDE THE SUBMODULE. `ls-tree` reports the
 * commit the PARENT pins, which is what a copy is provenanced against; a
 * `rev-parse` run inside the submodule reports whatever is checked out there,
 * which may not be the pinned one at all.
 */
export async function measureRepository(
  checkout: string, run: (file: string, args: readonly string[]) => Promise<string>,
): Promise<MeasuredProvenance> {
  const head = (await run('/usr/bin/git', ['-C', checkout, 'rev-parse', 'HEAD'])).trim()
  const line = (await run('/usr/bin/git',
    ['-C', checkout, 'ls-tree', 'HEAD', 'apps/capital-intelligence-ingestion'])).trim()
  const m = /^160000 commit ([0-9a-f]{40})\t/.exec(line)
  if (!HEX40_RE.test(head) || m === null) {
    throw new OpsRefused('the repository provenance could not be measured')
  }
  return Object.freeze({ head, ingestionGitlink: m[1] as string })
}

/**
 * THE STAGE-1 MANIFEST'S OWN ACCOUNT OF WHAT IT COVERS.
 *
 * Read out of the document whose DIGEST was verified before a single field was
 * taken from it - so these are the bundle's claims, and everything measured
 * live is checked against them rather than the other way round.
 */
export interface Stage1Authority {
  readonly bundleName: string
  readonly digestFileDigest: string
  readonly systemIdentifier: string
  readonly database: string
  /** The EFFECTIVE role the export ran as. This is `sourceExportRole`. */
  readonly currentUser: string
  readonly sessionUser: string
  readonly contentRootDigest: string
  readonly sourceContractDigest: string
  readonly copySet: readonly string[]
  readonly provenanceHead: string
  readonly ingestionGitlink: string
}

/** Read and validate the Stage-1 manifest's authority and provenance fields. */
export function readStage1Authority(bundleDir: string): Stage1Authority {
  let published
  try {
    published = readPublishedBundle(
      bundleDir, path => readFileSync(path, 'utf-8'),
      text => createHash('sha256').update(text).digest('hex'))
  } catch (e) {
    throw new OpsRefused(
      'the Stage-1 bundle does not verify, so no copy binding can be built',
      e instanceof Error ? e.name : null)
  }

  const doc = published.document as unknown as {
    source?: {
      system_identifier?: unknown; database?: unknown
      role?: unknown; session_user?: unknown
    }
    content?: { root_digest?: unknown; tables?: Array<{ qname?: unknown }> }
    source_contract?: { digest?: unknown }
    provenance?: { head?: unknown; ingestion_gitlink?: unknown }
  }

  const need = (value: unknown, what: string, re: RegExp): string => {
    if (typeof value !== 'string' || !re.test(value)) {
      throw new OpsRefused(`the Stage-1 bundle carries no reviewed ${what}`)
    }
    return value
  }

  const copySet = (doc.content?.tables ?? []).map(t => String(t.qname))
  if (copySet.length === 0) throw new OpsRefused('the Stage-1 bundle names no copy set')

  // THE EXPORT ROLE COMES FROM HERE, not from a session opened later. A live
  // session's `current_user` is whoever the inspection connected as, which has
  // no necessary relationship to whoever ran the export. Read once, because the
  // session-user comparison below is against THIS value.
  const exportRole = need(doc.source?.role, 'source export role', IDENT_RE)

  return Object.freeze({
    bundleName: published.bundleName,
    digestFileDigest: published.digestFileDigest,
    systemIdentifier: need(doc.source?.system_identifier, 'source system identifier', SYSID_RE),
    database: need(doc.source?.database, 'source database', IDENT_RE),
    currentUser: exportRole,
    // AND THE SESSION USER IS REQUIRED, EXPLICITLY, AND MUST AGREE.
    //
    // WHY THE FALLBACK IS GONE. This used to read `session_user ?? role`, so a
    // manifest that carried no session user at all was silently treated as
    // though it had declared the export role - which is precisely the claim
    // being checked. Every older bundle, and every hand-edited one, therefore
    // satisfied the session-user comparison by DEFINITION and the check proved
    // nothing. A manifest that does not state who the session was is a manifest
    // that cannot answer the question, and unanswered is refused.
    //
    // WHY THEY MUST BE EQUAL. `SESSION_USER` is who authenticated and
    // `CURRENT_USER` is who the statements executed as; they differ exactly when
    // the export ran under a `SET ROLE` or a `SECURITY DEFINER`. An export whose
    // effective role was not the role that logged in was performed under
    // borrowed authority, and its manifest's account of what the source
    // contained was produced under privileges the named session does not have.
    // The copy binding is built on that account, so the disagreement is refused
    // here rather than carried into a token that looks perfectly valid.
    sessionUser: (() => {
      const sessionUser = need(doc.source?.session_user, 'source session user', IDENT_RE)
      if (sessionUser !== exportRole) {
        throw new OpsRefused(
          'the Stage-1 bundle\'s session user and export role disagree')
      }
      return sessionUser
    })(),
    contentRootDigest: need(doc.content?.root_digest, 'content root digest', /^[0-9a-f]{64}$/),
    sourceContractDigest: need(doc.source_contract?.digest, 'source contract digest',
                               /^[0-9a-f]{64}$/),
    copySet: Object.freeze(copySet),
    provenanceHead: need(doc.provenance?.head, 'provenance head', HEX40_RE),
    ingestionGitlink: need(doc.provenance?.ingestion_gitlink, 'ingestion gitlink', HEX40_RE),
  })
}

/**
 * THE COPY BINDING FOR AN APPLY, MEASURED - NOT STATED - AND BOUND TO STAGE 1.
 *
 * WHAT WAS WRONG. Every "which target" field came from argv: the database, the
 * system identifier, the port, the endpoint, the role, the provenance HEAD and
 * the ingestion gitlink were all typed by whoever ran the command, and the
 * result was called a fresh binding. That inverts the entire purpose of the
 * token. The token exists so an operator can check that the apply is about to
 * do what they were shown - and a token computed from what they typed agrees
 * with whatever they typed. A wrong target produces a token that matches the
 * wrong target, perfectly.
 *
 * SO EVERY FIELD IS MEASURED OR READ FROM VERIFIED EVIDENCE:
 *
 *   source identity   asked of a read-only SOURCE session
 *   target identity   asked of a read-only TARGET session
 *   content, export   read out of the Stage-1 manifest, whose DIGEST is
 *   role, provenance  verified before a single field is taken from it
 *   HEAD, gitlink     read from the repository with `git`, and COMPARED with
 *                     what the manifest recorded
 *
 * AND STAGE 1'S ACCOUNT GOVERNS. The live source must be the cluster and
 * database the manifest was taken from; the measured checkout must be at the
 * commit the manifest was provenanced against; the pinned submodule must be the
 * one it recorded. Every mismatch refuses. Without that, a binding could pair
 * Stage-1 CONTENT with an unrelated later role or checkout and look entirely
 * well-formed.
 */
export function freshCopyBindingFrom(
  stage1: Stage1Authority, source: MeasuredIdentity, target: MeasuredIdentity,
  provenance: MeasuredProvenance,
): { binding: CopyBinding; digest: string } {
  // THE LIVE SOURCE IS THE ONE THE BUNDLE DESCRIBES.
  const bundleSource = `${stage1.systemIdentifier}|${stage1.database}`
  const liveSource = `${source.systemIdentifier}|${source.database}`
  if (bundleSource !== liveSource) {
    throw new OpsRefused('the live source is not the one the Stage-1 bundle describes')
  }
  // THE CHECKOUT IS AT THE COMMIT THE BUNDLE WAS PROVENANCED AGAINST.
  if (provenance.head !== stage1.provenanceHead) {
    throw new OpsRefused('the measured checkout is not the one the Stage-1 bundle records')
  }
  if (provenance.ingestionGitlink !== stage1.ingestionGitlink) {
    throw new OpsRefused('the measured ingestion gitlink is not the one the bundle records')
  }

  const binding: CopyBinding = {
    bindingShapeVersion: COPY_BINDING_SHAPE_VERSION,
    bundleName: stage1.bundleName,
    digestFileDigest: stage1.digestFileDigest,
    sourceDatabase: source.database,
    sourceSystemIdentifier: source.systemIdentifier,
    // FROM THE MANIFEST. The export role is a fact about the export.
    sourceExportRole: stage1.currentUser,
    sourceContractDigest: stage1.sourceContractDigest,
    contentRootDigest: stage1.contentRootDigest,
    copySetDigest: copySetDigest(stage1.copySet),
    provenanceHead: provenance.head,
    ingestionGitlink: provenance.ingestionGitlink,
    reviewedTargetContractDigest: REVIEWED_CONTRACT_DIGEST,
    targetDatabase: target.database,
    targetSystemIdentifier: target.systemIdentifier,
    targetPort: target.port,
    // THREE SEPARATE FACTS, none of them pretending to be another.
    targetRequestedEndpoint: target.requestedEndpoint,
    targetServerAddress: target.serverAddress,
    targetUnixTransport: target.unixTransport,
    targetRole: target.currentUser,
    targetSessionUser: target.sessionUser,
  }
  try {
    return { binding, digest: copyBindingDigest(binding) }
  } catch (e) {
    throw new OpsRefused(
      'the copy binding is not in the reviewed form',
      e instanceof BindingRefused ? e.reason : null)
  }
}

/**
 * Measure everything an apply's copy binding needs, then build it.
 *
 * REFUSES RATHER THAN SUBSTITUTES. A missing session, an unreadable
 * repository, a bundle that does not verify - each is a refusal, because the
 * alternative is a confirmation token minted from operator-supplied text.
 *
 * IT OPENS TWO READ-ONLY DATABASE SESSIONS, and closes both. That is a fact
 * the inspection reports rather than one it glosses: "opened no database
 * session" was true of the rehearsal inspection and never of this one.
 */
export async function measuredCopyBinding(
  v: Readonly<Record<string, string>>, deps: OpsDeps, sourceEndpoint: string,
): Promise<{ binding: CopyBinding; digest: string; stage1: Stage1Authority }> {
  const bundleDir = required(v, '--bundle-dir')
  const checkout = required(v, '--checkout')
  if (deps.openSourceIdentity === undefined || deps.openTargetIdentity === undefined) {
    throw new OpsRefused(
      'an apply inspection needs read-only source and target identity sessions')
  }
  // THE MANIFEST FIRST. If the evidence does not verify there is nothing to
  // measure against, and no session need be opened at all.
  const stage1 = readStage1Authority(bundleDir)

  const sourceSession = await deps.openSourceIdentity()
  let targetSession: FenceLike | null = null
  try {
    const source = await measureIdentity(sourceSession, sourceEndpoint)
    targetSession = await deps.openTargetIdentity()
    const target = await measureIdentity(
      targetSession as FenceLike, required(v, '--target-host'))
    const provenance = await (deps.measureRepository ?? defaultMeasureRepository)(checkout)
    return { ...freshCopyBindingFrom(stage1, source, target, provenance), stage1 }
  } finally {
    if (targetSession !== null) await targetSession.close().catch(() => undefined)
    await sourceSession.close().catch(() => undefined)
  }
}

/**
 * Open ONE read-only source session, measure its identity, and close it.
 *
 * EVERY MODE NEEDS THIS, because every mode's operational binding carries the
 * source system identifier and that value is no longer something an operator
 * may state. The session is opened for one statement and closed in a `finally`;
 * it takes no fence, holds no lock and writes nothing.
 */
export async function measureSourceIdentity(
  deps: OpsDeps, requestedEndpoint: string,
): Promise<MeasuredIdentity> {
  if (deps.openSourceIdentity === undefined) {
    throw new OpsRefused(
      'this build was given no way to open a read-only source identity session')
  }
  const session = await deps.openSourceIdentity()
  try {
    return await measureIdentity(session, requestedEndpoint)
  } finally {
    await session.close().catch(() => undefined)
  }
}

/** The real repository measurement. Bounded, read-only, no shell. */
const defaultMeasureRepository = async (
  checkout: string,
): Promise<MeasuredProvenance> =>
  await measureRepository(checkout, async (file, args) => await new Promise<string>(
    (resolve, reject) => {
      const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d: Buffer) => { out += d.toString('utf-8') })
      child.on('error', () => { reject(new OpsRefused('the repository could not be read')) })
      child.on('close', code => {
        if (code === 0) resolve(out)
        else reject(new OpsRefused('the repository could not be read'))
      })
    }))

/** The execution binding for one invocation, and its mode-bound token. */
export function executionBindingFor(
  mode: CopyMode, operationalDigest: string, copyDigest: string | null,
  runId: string, stamp: string, authorizationDigest: string,
): ExecutionBinding {
  return {
    copyBindingDigest: copyDigest,
    operationalAdapterBindingDigest: operationalDigest,
    mode,
    runId,
    stamp,
    modeAuthorizationDigest: authorizationDigest,
  }
}

export { assertConfirmationMatches, confirmationToken, operationalBindingDigest }
export { bullmqQueueAdapter, launchdQuiescenceAdapter, openReviewedContainer }
export { publishLifecycleBundle, releaseFence, runOperationalGate, resolveRedis }

// ---------------------------------------------------------------------------
// MODE DISPATCH
// ---------------------------------------------------------------------------

/** Everything the CLI needs from the world, injected so tests touch nothing live. */
export interface OpsDeps {
  readonly newRunId: () => string
  readonly stamp: () => string
  /** Opens the supervisor. BORROWED by the gate; this CLI owns its lifetime. */
  readonly openSupervisor?: () => Promise<FenceLike>
  readonly openProver?: () => Promise<FenceLike>
  readonly acquireFence?: (s: FenceLike) => Promise<AcquiredFenceLike>
  /** How a hold reaches a person. Injected, so no test arms a real handler. */
  readonly hold?: InterventionHold
  /**
   * How launchd is reached. Injected so a suite answers instead of the real
   * binary - and injectable ONLY from code, never from the command line.
   */
  readonly commands?: CommandRunner
  /**
   * The operational adapters, overridable.
   *
   * PRODUCTION SUPPLIES NEITHER, and gets the launchd and BullMQ adapters
   * built from the measured scope. Tests supply both, which is what keeps a
   * suite from opening a Redis connection to satisfy a queue sample.
   */
  readonly quiescence?: QuiescenceAdapter
  readonly queue?: QueueAdapter
  /** The fenced producer census. Injected so a suite never touches launchd. */
  readonly destinations?: DestinationCensusAdapter
  /** TEST-ONLY seam for the reviewed inter-sample interval. */
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * The evidence layer's filesystem primitives. Production passes nothing.
   *
   * The same injection `publishEvidence` and `runLifecycle` already accept, so
   * a suite can produce a failed rename or an occupied destination on purpose.
   * It bounds nothing: the hold keeps holding however the filesystem behaves.
   */
  readonly ops?: EvidenceOps
  /**
   * READ-ONLY IDENTITY SESSIONS for an apply inspection.
   *
   * Separate from the fence sessions on purpose: these ask five catalogue
   * questions and close. They exist so the copy binding is MEASURED rather
   * than taken from argv, and their absence is a refusal.
   */
  readonly openSourceIdentity?: () => Promise<FenceLike>
  readonly openTargetIdentity?: () => Promise<FenceLike>
  /** Reads HEAD and the ingestion gitlink. Injected so tests run no git. */
  readonly measureRepository?: (checkout: string) => Promise<{
    head: string; ingestionGitlink: string
  }>
  readonly deadlineMs?: number
}

export interface FenceLike {
  send(sql: string): Promise<{ rows: string[][]; error: 'statement-refused' | null }>
  close(): Promise<void>
}

/**
 * The fence this run took: which backend, since when, under which mechanism.
 *
 * `backendStart` is NOT nullable. Acquisition refuses a backend whose start it
 * cannot read, because a pid alone identifies a backend only while that backend
 * lives - and an intervention hold routinely outlasts one.
 */
export interface AcquiredFenceLike {
  readonly supervisorPid: string
  readonly backendStart: string
  readonly mechanism: 'S3'
}

export interface CliResult {
  readonly exitCode: number
  readonly lines: readonly string[]
}


// ---------------------------------------------------------------------------
// THE INTERVENTION HOLD
// ---------------------------------------------------------------------------

export const REHEARSAL_PREFIX = 'operational-rehearsal'
export const RESTORATION_PREFIX = 'producer-restoration'
export const REVIEW_PREFIX = 'rehearsal-review'
export const INTENT_PREFIX = 'intervention-intent'
export const OUTCOME_PREFIX = 'intervention-outcome'

/**
 * WHAT A SUCCESSFUL REHEARSAL LEAVES BEHIND, said in full.
 *
 * Not "OK". The producers are still stopped when this is printed, and the
 * outcome name is the only part of the record an operator is certain to read.
 */
export const REHEARSAL_OUTCOME =
  'OPERATIONAL_REHEARSAL_VERIFIED_AWAITING_MANUAL_RESTORATION'

/**
 * WHAT THE PRE-RELEASE RECORD SAYS, and it is deliberately not a success.
 *
 * At the instant this bundle is written the fence is still held and the release
 * has not been attempted. A record claiming the rehearsal succeeded would be
 * read by `--review-rehearsal` - which verifies bundles from disk and asks no
 * questions about when they were written - and would authorise an apply on the
 * strength of a rehearsal that had not finished and might not.
 */
export const PRE_RELEASE_OUTCOME = 'OPERATIONAL_STATE_PROVED_AWAITING_RELEASE'

/**
 * WHAT IS KNOWN ABOUT THE FENCE AT THE MOMENT A HOLD BEGINS.
 *
 * FOUR STATES, AND THE LAST TWO ARE NOT DEGREES OF ONE THING. `released-unproved`
 * means the transaction provably ended and the confirming census did not
 * succeed; `release-unknown` means nobody can say whether the ROLLBACK ran at
 * all. Folding them together would tell an operator the lease is gone when the
 * only thing established is that nobody knows.
 */
export type HoldFenceState = 'held' | 'not-held' | 'unproved' | 'released'
  | 'released-unproved' | 'release-unknown'

/**
 * THE OPERATIONS AN OPERATOR MAY ACTUALLY PERFORM. Not labels - instructions.
 *
 *   REPROVE_AND_GATE
 *     Take a FRESH fence proof from the prover and, if it proves held, run a
 *     FRESH operational gate for a FRESH single-use authorization, then
 *     release and prove. The first gate's authorization is spent and its
 *     proofs are about a moment that has passed; nothing here replays either.
 *
 *   CENSUS_ONLY
 *     Ask the prover what the supervisor backend still holds, and record the
 *     answer. Sends NOTHING to the supervisor. This is the only operation
 *     offered after `released-unproved`, because the transaction provably
 *     ended and a second ROLLBACK would be an unauthorised statement against
 *     whatever transaction happens to exist now.
 *
 *   TERMINATE_SUPERVISOR_WITHOUT_PRIOR_RELEASE_PROOF
 *     `pg_terminate_backend` on the supervisor, issued from the PROVER, when
 *     the release outcome is unknown and the census cannot settle it. Named
 *     at this length on purpose: it ends a backend whose transaction nobody
 *     could account for, and the name is what an operator reads before
 *     agreeing to it. The prover stays alive afterwards so the post-termination
 *     census can be taken from the same independent session.
 *
 *   ABANDON
 *     The operator accepts, in writing and before anything happens, that the
 *     supervisor backend will be terminated and that the resulting database
 *     state may not be provable. Then the backend is terminated from the
 *     PROVER and reaped, and a post-termination census says what can and
 *     cannot be established. THIS IS NOT "WALK AWAY": walking away releases
 *     the fence by exiting, which is precisely what this is instead of.
 *     Recorded acceptance first, deliberate termination second, truthful
 *     record of what remained unprovable third.
 *
 *   NONE
 *     The fence is gone and proved gone. There is nothing left to do to it.
 */
export type HoldAction =
  | 'REPROVE_AND_GATE'
  | 'CENSUS_ONLY'
  | 'TERMINATE_SUPERVISOR_WITHOUT_PRIOR_RELEASE_PROOF'
  | 'ABANDON'
  | 'NONE'

/**
 * THE ACTIONS EACH STATE ALLOWS, and nothing wider.
 *
 * A single menu would offer "release the fence" to an operator whose fence is
 * already gone, and "roll back again" to one whose ROLLBACK provably ran. Both
 * are the same mistake: an operation whose precondition nobody established.
 *
 * `ABANDON` IS NOT "WALK AWAY". Walking away from a held fence is not an
 * operation this command can perform: it would mean exiting, and exiting ends
 * the supervisor `psql` child, releasing the very locks the hold exists to
 * keep - silently, with nothing written down. What `ABANDON` names instead is
 * the deliberate version: the operator accepts in writing what is about to be
 * lost, the backend is terminated from the prover and reaped, and a census
 * afterwards says what could and could not be established. "Keep holding" is
 * spelled `CENSUS_ONLY`: it records what is true and stays in the hold.
 */
export const HOLD_ACTIONS: Readonly<Record<HoldFenceState, readonly HoldAction[]>> =
  Object.freeze({
    // BEFORE ANY RELEASE WAS ATTEMPTED. A fresh proof and a fresh gate.
    held: Object.freeze(['REPROVE_AND_GATE', 'CENSUS_ONLY', 'ABANDON'] as HoldAction[]),
    'not-held': Object.freeze(['REPROVE_AND_GATE', 'CENSUS_ONLY', 'ABANDON'] as HoldAction[]),
    unproved: Object.freeze(['REPROVE_AND_GATE', 'CENSUS_ONLY', 'ABANDON'] as HoldAction[]),
    // THE ROLLBACK PROVABLY RAN AND THE CENSUS DID NOT CONFIRM IT. Census
    // only; a second ROLLBACK would be a statement nobody decided to send,
    // against a transaction that no longer exists.
    'released-unproved': Object.freeze(['CENSUS_ONLY', 'ABANDON'] as HoldAction[]),
    // NOBODY CAN SAY WHETHER IT RAN. Look first; only a census that finds the
    // same pid+backend_start still holding the COMPLETE fence licenses a fresh
    // reprove-and-gate. Otherwise the backend is ended from the prover.
    'release-unknown': Object.freeze([
      'CENSUS_ONLY', 'REPROVE_AND_GATE',
      'TERMINATE_SUPERVISOR_WITHOUT_PRIOR_RELEASE_PROOF', 'ABANDON'] as HoldAction[]),
    // GONE AND PROVED GONE.
    released: Object.freeze(['NONE'] as HoldAction[]),
  })

export interface HoldDecision {
  readonly action: HoldAction
  readonly operator: string
  /** The per-run token, checked BEFORE the action is performed. */
  readonly token: string
}

/**
 * THE PER-RUN RESOLUTION TOKEN.
 *
 * Derived from this run's own identifiers and the fence it is about, so a
 * resolution typed for one hold cannot resolve another - including the next
 * hold of the same command an hour later, which is the case a plain "yes"
 * would have silently satisfied.
 */
export function resolutionToken(
  runId: string, stamp: string, operationalDigest: string, backend: string,
): string {
  return `PGCOPY-RESOLVE-${createHash('sha256')
    .update(`pgcopy-resolve|1|${runId}|${stamp}|${operationalDigest}|${backend}`)
    .digest('hex')}`
}

/** How a hold reaches a person. Injected, so no test ever arms a real handler. */
export interface InterventionHold {
  /** Installs the handlers that HOLD. Returns the disarm. */
  arm(sentence: string): () => void
  decide(
    state: HoldFenceState, actions: readonly HoldAction[], token: string,
  ): Promise<HoldDecision>
}

/** Every signal a terminal or a supervisor can send that a handler can catch. */
export const HELD_SIGNALS: readonly NodeJS.Signals[] =
  Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'])

/**
 * The real hold: signal handlers that decline to exit, and a resolution.
 *
 * WHAT THE HANDLERS DO AND DO NOT BUY. They remove the ACCIDENT - a Ctrl-C in
 * the terminal where the hold is printed, a `kill` from habit, a SIGQUIT from
 * a keyboard that still has one bound, a SIGHUP when the window closes - and
 * nothing else. `SIGKILL` cannot be handled, a crash runs no handler, and a
 * closed laptop runs none either; in every one of those the supervisor `psql`
 * child dies and PostgreSQL releases the locks with it. So the handlers are a
 * convenience, NOT a durable lease, and the durable half of this protocol is
 * the intent bundle on disk, which survives all three.
 *
 * THE RESOLUTION ARRIVES TWO WAYS. A TTY, where a person types it; or a
 * reviewed file in the SAME EVIDENCE ROOT, for a hold nobody is sitting in
 * front of. The file must be under the root this run is already publishing to,
 * so resolving a hold requires write access to the evidence the hold produced.
 *
 * ONE READLINE INTERFACE FOR THE WHOLE HOLD. An earlier revision iterated
 * `process.stdin` directly and broke out of the loop after the first newline,
 * which leaves the async iterator closed and the stream destroyed: the FIRST
 * resolution consumed the input channel, and every later attempt - the ones the
 * loop exists to make - found nothing to read. A hold is a conversation, so the
 * interface is created once, asked for exactly one line per attempt, and closed
 * only when the hold ends.
 */
export function processHold(
  say: (l: string) => void, root: string, resolutionFile: string | null,
): InterventionHold {
  /** Created on first use, reused for every attempt, closed on disarm. */
  let lines: AsyncIterableIterator<string> | null = null
  let rl: Interface | null = null

  const nextLine = async (): Promise<string> => {
    if (process.stdin.isTTY !== true) {
      throw new OpsRefused(
        'this hold has no terminal and no --resolution-file, so nobody can resolve it')
    }
    if (lines === null) {
      // `terminal: false` keeps readline from taking over the tty's rendering;
      // this is a prompt for one line, not an editor.
      rl = createInterface({ input: process.stdin, terminal: false })
      lines = rl[Symbol.asyncIterator]()
    }
    const next = await (lines as AsyncIterableIterator<string>).next()
    if (next.done === true) {
      // THE CHANNEL CLOSED. Not a resolution, and not a reason to return: the
      // caller treats a refusal as an attempt that resolved nothing.
      throw new OpsRefused('the resolution channel closed before a line arrived')
    }
    return next.value
  }

  return {
    arm(sentence: string): () => void {
      const hold = (sig: NodeJS.Signals): void => {
        say(`${sig} IGNORED: this process is holding a source fence. ${sentence}`)
      }
      for (const sig of HELD_SIGNALS) process.on(sig, hold)
      return (): void => {
        for (const sig of HELD_SIGNALS) process.off(sig, hold)
        // THE INPUT CHANNEL OUTLIVES EVERY ATTEMPT and is closed here, once.
        if (rl !== null) { rl.close(); rl = null; lines = null }
      }
    },
    async decide(
      state: HoldFenceState, actions: readonly HoldAction[], token: string,
    ): Promise<HoldDecision> {
      say(`FENCE STATE: ${state}. Reviewed operations: ${actions.join(', ')}`)
      say(`Reply with: <OPERATION> <operator-name> ${token}`)
      const text = resolutionFile === null
        ? await nextLine()
        : readResolutionFile(root, resolutionFile)
      const [action = '', operator = '', supplied = ''] = text.trim().split(/\s+/, 3)
      // THE TOKEN IS CHECKED BEFORE THE OPERATION IS EVEN LOOKED UP, so a
      // resolution meant for another hold cannot select an operation here.
      if (supplied !== token) {
        throw new OpsRefused('the resolution does not carry this run\'s token')
      }
      if (!(actions as readonly string[]).includes(action)) {
        throw new OpsRefused('the chosen operation is not reviewed for this state', state)
      }
      if (!/^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/.test(operator)) {
        throw new OpsRefused('an intervention needs a named operator')
      }
      return { action: action as HoldAction, operator, token: supplied }
    },
  }
}

/**
 * A resolution file, which must live under THIS RUN'S evidence root.
 *
 * Resolving a hold then requires write access to the directory the hold's own
 * evidence is being published into - the same authority, rather than any path
 * on the filesystem that happens to contain the right words.
 */
function readResolutionFile(root: string, path: string): string {
  const realRoot = realpathSync(root)
  const real = realpathSync(path)
  if (!real.startsWith(`${realRoot}/`)) {
    throw new OpsRefused('the resolution file is not under this run\'s evidence root')
  }
  return openReviewedContainer(real).text
}

export interface HoldInputs {
  readonly root: string
  readonly stamp: string
  /** A FRESH run id per attempt. Published names are immutable and unique. */
  readonly newRunId: () => string
  readonly mode: CopyMode
  /**
   * THE OUTER RUN'S OWN ID - the one the operator's token was computed over.
   *
   * Recorded here so a derived attempt name can include it. Two rehearsals of
   * the same fence in the same second share a stamp and an operational digest;
   * they do not share this.
   */
  readonly outerRunId: string
  readonly operationalDigest: string
  readonly fenceState: HoldFenceState
  readonly supervisorPid: string
  readonly backendStart: string
  readonly reason: string
  readonly hold: InterventionHold
  readonly say: (l: string) => void
  /** Bundles already published by this run, by basename and DIGEST digest. */
  readonly priorBundles: readonly PriorBundle[]
  /** Performs the chosen operation for real. Returns what it established. */
  readonly perform: (d: HoldDecision) => Promise<HoldOutcome>
  /**
   * Closes the borrowed sessions. Called ONLY after a terminal resolution has
   * been published and verified - prover first, supervisor second.
   */
  readonly teardown: () => Promise<void>
  /** How the loop pauses between attempts. Injected so tests do not wait. */
  readonly sleep: (ms: number) => Promise<void>
  /**
   * THE FILESYSTEM PRIMITIVES THE EVIDENCE LAYER USES.
   *
   * Injected the way `runLifecycle` and `publishEvidence` already take them,
   * and for the same reason: a suite that needs to see what happens when a
   * rename fails, or when a destination is already occupied, has no other way
   * to produce those conditions deliberately. Production passes nothing and
   * gets `REAL_EVIDENCE_OPS`.
   *
   * THIS IS NOT A BOUND ON THE LOOP. It changes what the filesystem does, not
   * how many times the hold is willing to ask; a suite can make every
   * publication fail forever and the hold will keep holding, which is exactly
   * the behaviour one of the controls checks.
   */
  readonly ops?: EvidenceOps
}

export interface PriorBundle {
  readonly name: string
  readonly digestFileDigest: string
}

export interface HoldOutcome {
  /** What the fence state is AFTER the operation, measured not assumed. */
  readonly fenceState: HoldFenceState
  readonly detail: string
  /**
   * TERMINAL. Set only by a zero-lock census, or by a supervisor backend
   * proved gone or deliberately reaped. Never by an operation's name.
   */
  readonly resolved: boolean
  /**
   * Whether the resulting DATABASE state could be established.
   *
   * An `ABANDON` that reaped a backend nobody could census leaves the fence
   * gone and the database's contents unprovable, and those are two different
   * facts. Recording only the first would report a clean resolution.
   */
  readonly databaseStateProvable: boolean
}

/**
 * HOLD UNTIL THE FENCE IS TERMINALLY RESOLVED. THE HOLD DOES NOT RETURN EARLY.
 *
 * WHAT WAS WRONG BEFORE, TWICE OVER.
 *
 * FIRST, it performed ONE operation and returned when that operation did not
 * resolve the fence. Returning is the problem: the caller unwinds, the process
 * exits, the supervisor `psql` child dies with it, and PostgreSQL releases
 * every lock the hold existed to keep.
 *
 * SECOND - and this is what K1.3 corrects - the OUTCOME PUBLICATION sat outside
 * the inner `catch`. A full disk, a frozen evidence volume, a name already
 * taken: any of those threw straight past the loop, through the outer
 * `finally` that disarms the signal handlers, and out of the function. The
 * fence was then released by the unwinding of the code that existed to hold it,
 * and the last thing written down was an intent with no outcome.
 *
 * SO NOTHING IN THIS LOOP MAY THROW. Every step that can fail - minting a run
 * id, asking the operator, performing the operation, publishing either record,
 * pausing - is bounded here and turned into "this attempt resolved nothing",
 * which is a state the loop already knows how to be in. The only ways out are
 * terminal: a zero-lock census proving this backend holds no reviewed lock, or
 * a supervisor backend that is gone - found gone, or deliberately reaped after
 * the operator accepted that in writing.
 *
 * AND AN OPERATION'S OUTCOME IS PUBLISHED BEFORE THE NEXT ONE IS OFFERED. A
 * second database operation on top of an unrecorded first would leave the
 * evidence describing a sequence nobody performed.
 */
export async function holdForIntervention(i: HoldInputs): Promise<CliResult> {
  const lines: string[] = []
  const say = (l: string): void => { lines.push(l); i.say(l) }
  const backend = `${i.supervisorPid}@${i.backendStart}`

  const sentence = i.fenceState === 'released'
    ? 'The fence is proved gone; this process is holding only to record the outcome.'
    : 'Exiting would end the psql child, and the fence state above is what is known.'
  // ARMED ONCE, FOR THE WHOLE HOLD. Disarmed in the `finally` below, which is
  // reached only once a terminal resolution has been published and verified.
  const disarm = i.hold.arm(sentence)

  /** A pause that cannot itself end the hold. */
  const pause = async (ms: number): Promise<void> => {
    try { await i.sleep(ms) } catch { /* a failed pause is not a resolution */ }
  }

  const priorBundles: PriorBundle[] = [...i.priorBundles]
  let state: HoldFenceState = i.fenceState
  let reason = i.reason
  let attempt = 0
  let resolved = false
  let terminalDetail = ''

  try {
    say(`INTERVENTION REQUIRED: ${reason}`)
    say(`Supervisor backend ${backend}; fence ${state}.`)

    // THE LOOP. Bounded only by resolution: there is no attempt count at which
    // walking away becomes correct, because walking away is what releases the
    // fence.
    for (;;) {
      attempt += 1
      // A FRESH RUN ID PER ATTEMPT, and a deterministic fallback if the minter
      // itself fails - an attempt that cannot be NAMED still has to be
      // recorded, and two attempts must never claim one name.
      const runId = attemptRunId(i, attempt)
      const actions = HOLD_ACTIONS[state]
      const token = resolutionToken(runId, i.stamp, i.operationalDigest, backend)

      const common = {
        intervention_version: 4,
        mode: i.mode,
        operational_adapter_binding_digest: i.operationalDigest,
        attempt,
        fence_state: state,
        supervisor_backend: backend,
        reason,
        prior_bundles: priorBundles.map(x => ({
          name: x.name, digest_file_digest: x.digestFileDigest,
        })),
      }

      let decision: HoldDecision | null = null
      let outcome: HoldOutcome = {
        fenceState: state, detail: 'the intervention attempt did not complete',
        resolved: false, databaseStateProvable: false,
      }
      let intent: PriorBundle | null = null
      let performed = false

      try {
        // THE DECISION FIRST, so the intent can name the chosen operation.
        decision = await i.hold.decide(state, actions, token)
      } catch (e) {
        outcome = {
          fenceState: state,
          detail: e instanceof OpsRefused ? `refused: ${e.message}`
            : 'the resolution could not be obtained',
          resolved: false, databaseStateProvable: false,
        }
      }

      if (decision !== null) {
        // PHASE 1. THE INTENT, FROZEN. Exact bytes, under this attempt's exact
        // identity, before a single byte of it has been written anywhere.
        const frozenIntent = freezeRecord({
          ...common,
          record: INTENT_PREFIX,
          complete: true,
          resolution_token: token,
          chosen_action: decision.action,
          operator: decision.operator,
          // WHAT THE OPERATOR IS ACCEPTING, recorded BEFORE the operation runs,
          // for the one operation that costs something irreversible.
          accepted: decision.action === 'ABANDON'
            ? 'the supervisor backend will be terminated and the resulting ' +
              'database state may not be provable'
            : null,
        }, { offered_actions: [...actions] })

        // PHASE 2. THAT INTENT, DURABLY, BEFORE ANYTHING IS PERFORMED - and
        // this does not come back until it is. A publication that will not
        // complete is not a reason to act anyway, not a reason to unwind, and
        // NOT a reason to go and ask the operator for a second decision: it is
        // a reason to keep holding and keep publishing THIS record.
        intent = await publishPhase(
          i, say, pause, runId, INTENT_PREFIX, 'intent.json', frozenIntent)
        priorBundles.push(intent)

        // PHASE 3. PERFORMED EXACTLY ONCE. There is exactly one `i.perform`
        // call in this function and it is reached only from here, so no
        // publication retry above or below can cause a second operation.
        try {
          performed = true
          outcome = await i.perform(decision)
        } catch (e) {
          outcome = {
            fenceState: state,
            detail: e instanceof OpsRefused ? `refused: ${e.message}`
              : 'the chosen operation did not complete',
            resolved: false, databaseStateProvable: false,
          }
        }
      }

      // PHASE 4. THE OUTCOME, FROZEN - exact bytes, same attempt identity.
      const frozenOutcome = freezeRecord({
        ...common,
        record: OUTCOME_PREFIX,
        complete: true,
        resolution_token: token,
        chosen_action: decision?.action ?? null,
        operator: decision?.operator ?? null,
        intent_bundle: intent === null ? null
          : { name: intent.name, digest_file_digest: intent.digestFileDigest },
        operation_executed: performed,
        fence_state_after: outcome.fenceState,
        resolved: outcome.resolved,
        terminal: outcome.resolved,
        // TRUTHFULLY, INCLUDING WHEN IT IS NOTHING. An ABANDON that reaped the
        // backend without being able to prove what the database now holds says
        // exactly that, rather than reporting a clean release.
        database_state_provable: outcome.databaseStateProvable,
      }, { offered_actions: [...actions], result: outcome.detail })

      // PHASE 5. THAT OUTCOME, DURABLY, BEFORE ANYTHING IS ACTED UPON - and
      // this does not come back until it is. Whatever the operation
      // established, this process may not act on it, may not offer another
      // database action, may not ask for another decision, and above all may
      // not return until the account of it is on disk and verified.
      const record = await publishPhase(
        i, say, pause, runId, OUTCOME_PREFIX, 'outcome.json', frozenOutcome)
      priorBundles.push(record)

      // PHASE 6. AND ONLY NOW may a terminal result be acted upon or another
      // decision be requested.

      say(`ATTEMPT ${attempt}: ${outcome.detail}`)
      say(`FENCE AFTER: ${outcome.fenceState}`)

      if (outcome.resolved) {
        // TERMINAL, AND THE RECORD OF IT IS VERIFIED ON DISK - which is what
        // `publishDurable` returning non-null means, and the precondition for
        // disarming and tearing down.
        resolved = true
        state = outcome.fenceState
        terminalDetail = outcome.detail
        break
      }

      // NOT TERMINAL. Carry the newly MEASURED state into the next attempt: an
      // operation that moved the fence from `held` to `release-unknown`
      // changes which operations are reviewed from here.
      state = outcome.fenceState
      reason = outcome.detail
      say('The fence is not resolved. This process is still holding it.')
      // AND PAUSE BEFORE ASKING AGAIN. Without this a resolution channel that
      // is simply unavailable - no terminal, an unreadable file - would be
      // re-consulted as fast as the event loop allows, burning a core while
      // holding a fence. The hold is still unbounded; it is not a spin.
      await pause(HOLD_RETRY_INTERVAL_MS)
      say(`Waited ${HOLD_RETRY_INTERVAL_MS}ms before asking again.`)
    }
  } finally {
    // DISARMED ONLY HERE, after a terminal resolution was published and
    // verified. Between the first line above and this point every catchable
    // signal is held.
    disarm()
  }

  // TEARDOWN, IN ORDER, AND ONLY NOW. The prover holds nothing of the fence and
  // goes first; the supervisor goes second, because closing it is what would
  // have released the fence, and it may do so only once the fence is proved
  // gone and the record of that is durable.
  await i.teardown()

  say(`INTERVENTION RESOLVED: ${terminalDetail}`)
  // EXIT 5, AND ONLY FROM HERE.
  //
  // `EXIT_ACTION_REQUIRED` DOES NOT APPEAR IN THIS FUNCTION, and a control
  // asserts that it does not. Exit 4 is the producer-restoration state - a copy
  // or rehearsal that finished with the agents still down for a person to
  // restore - and an unresolved fence is never that. The loop above cannot
  // reach here unresolved, so this is the second of two defences rather than
  // the only one.
  return { exitCode: resolved ? EXIT_INTERVENTION_RESOLVED : EXIT_FAILED, lines }
}

/**
 * A name for one attempt, and a deterministic fallback when the minter fails.
 *
 * AN ATTEMPT THAT CANNOT BE NAMED STILL HAS TO BE RECORDED. `newRunId` reads
 * the system's random source, which can fail; a throw there would have escaped
 * the hold entirely. So there is a derived name, and it has to be unique across
 * everything that could be deriving one at the same moment.
 *
 * WHY THE FENCE IDENTITY IS IN IT, not just the stamp and the ordinal. The
 * stamp has one-second resolution and the operational digest is a property of
 * the REVIEWED CONFIGURATION, not of a run - two rehearsals started in the same
 * second against the same reviewed scope share both. Derived from those two and
 * an ordinal alone, their first attempts would compute the SAME name, and the
 * second one to publish would find its destination occupied by a record of
 * somebody else's attempt: a collision that reads as evidence tampering.
 *
 * So the derivation also carries the outer run id, the supervisor's pid and
 * that backend's start time. The pid is a recycled number and the start time is
 * what makes it a particular backend; together they name the one session whose
 * fence is being held, and no two concurrent holds hold the same one - so the
 * INPUTS to this derivation are distinct for distinct holds.
 *
 * WHAT THAT DOES AND DOES NOT BUY. Distinct inputs give distinct SHA-256 digests;
 * they do not give distinct eight-character prefixes of them. Truncating a
 * digest to 32 bits is COLLISION-RESISTANT, not collision-free, and no amount of
 * adding inputs changes that - the output is 32 bits wide whatever goes in. A
 * claim of guaranteed uniqueness here would be false, and the reviewed run-id
 * shape is eight hexadecimal characters, so widening the identifier is not
 * available either: `assertRunId` refuses anything else, and the published names
 * an operator and every reviewed test expect are built from it.
 *
 * WHICH IS WHY NOTHING DEPENDS ON UNIQUENESS BEING GUARANTEED. A collision is
 * survivable rather than silent: the second record to reach the destination finds
 * it occupied, `acceptExistingRecord` compares the complete bundle byte for byte,
 * and a bundle that is not this record is reported as a collision that KEEPS THE
 * HOLD. Nothing is overwritten, nothing is abandoned, and no operator is told a
 * record landed that did not. The derivation makes a collision improbable; the
 * publication path makes it harmless.
 */
export function attemptRunId(i: HoldInputs, attempt: number): string {
  try {
    const minted = i.newRunId()
    if (/^[0-9a-f]{8}$/.test(minted)) return minted
  } catch { /* fall through to the derived name */ }
  return createHash('sha256')
    .update([
      'pgcopy-attempt', '2',
      i.outerRunId, i.stamp, i.operationalDigest,
      i.supervisorPid, i.backendStart,
      String(attempt),
    ].join('|'))
    .digest('hex').slice(0, 8)
}

/** How many times one phase's record is re-attempted before pausing again. */
export const PUBLICATION_ATTEMPTS = 3

/** The detail artifact's name. ONE name, used to write and to compare. */
export const DETAIL_FILE = 'actions.json'

/**
 * The exact file set a hold record consists of. Nothing else may be in one.
 *
 * Named here so the writer and the collision comparison cannot drift: a record
 * recognised as "already ours" is recognised because it has EXACTLY these
 * entries, not because it has at least the one we happened to look for.
 */
export const holdRecordFileSet = (manifestFile: string): readonly string[] =>
  Object.freeze([DETAIL_FILE, manifestFile, DIGEST_FILE].sort())

/**
 * ONE RECORD, SERIALIZED ONCE.
 *
 * The documents AND their bytes, together, produced in one place and then
 * treated as immutable. Every retry of a phase publishes these bytes; the
 * comparison against an occupied destination is made against these bytes. There
 * is no second serialization anywhere that could differ from the first.
 */
export interface FrozenRecord {
  readonly manifest: never
  readonly detail: never
  readonly manifestBytes: Buffer
  readonly detailBytes: Buffer
}

export function freezeRecord(
  manifest: Record<string, unknown>, detail: Record<string, unknown>,
): FrozenRecord {
  const bytes = (v: Record<string, unknown>): Buffer =>
    Buffer.from(`${canonicalJson(v as never)}\n`, 'utf-8')
  return Object.freeze({
    manifest: manifest as never, detail: detail as never,
    manifestBytes: bytes(manifest), detailBytes: bytes(detail),
  })
}

/**
 * What one publication attempt established - kept as three DIFFERENT answers.
 *
 * `unpublished` and `collision` were once both "null", and that conflation is
 * exactly what let a transient failure be handled like a permanent one. A
 * transient failure means try these same bytes again. A collision means the
 * name is held by something that is not this record, which no amount of trying
 * will change - but it is still not permission to overwrite it, abandon the
 * record, or offer the operator another database action, so it too keeps
 * holding and keeps saying so.
 */
type PublicationResult =
  | { readonly kind: 'published'; readonly bundle: PriorBundle }
  | { readonly kind: 'collision' }
  | { readonly kind: 'unpublished' }
  /**
   * NOTHING WAS DONE, BECAUSE NOTHING COULD BE PROVED SAFE TO DO.
   *
   * An unreported rename, a scratch directory whose state the filesystem would
   * not answer for, one that is present and not provably ours. Distinct from
   * `unpublished` because `unpublished` means "tried and failed" while this means
   * "did not touch anything", and the difference is exactly what keeps the retry
   * bounded: a cycle that creates nothing cannot grow.
   */
  | { readonly kind: 'unproved' }

/**
 * THE SCRATCH STATE ONE PHASE CARRIES, and the only thing it carries.
 *
 * Not a counter. K1.4 numbered each retry's temporary directory so that a record
 * whose first attempt left wreckage could still be retried, and that bounded
 * nothing: a persistent pre-rename failure - a read-only device, an fsync that
 * will not take, a freeze that cannot be applied - produced one more preserved
 * directory per cycle, and the cycles do not stop while the fence is held.
 *
 * WHAT IS LEFT IS ONE FLAG, and it is about a thing that must never be retried
 * blindly rather than about how many times anything has been tried.
 */
interface PhaseScratch {
  /**
   * Set once a rename reported INDETERMINATE.
   *
   * The helper can complete the rename and then be killed before its exit code
   * is observed, so "the syscall did not report" is not "the syscall did not
   * happen". From that point this phase only OBSERVES: it never renames again,
   * because a second rename could publish a second time, and it never removes
   * anything, because what it would remove may already be evidence under another
   * name.
   */
  indeterminate: boolean
  /**
   * THE RECEIPT FOR A RETRY SCRATCH DIRECTORY THIS PROCESS ITSELF CREATED.
   *
   * `device:inode`, captured the first time this phase built in the retry scratch
   * after observing it ABSENT - which `mkdir` makes an exclusive creation, since
   * it fails with EEXIST rather than adopting a directory that is already there.
   *
   * WHY OWNERSHIP AND DEVICE ARE NOT ENOUGH ON THEIR OWN. "Same user, same
   * filesystem" is true of every directory this user has ever left anywhere,
   * including the retry scratch of an EARLIER run of this same command against
   * this same record - which is somebody's evidence-in-progress, or somebody's
   * diagnostic wreckage, and not this process's to delete. Without a receipt the
   * guard proves "a process like this one made it", which is not the same claim.
   *
   * A pre-existing incomplete retry scratch therefore has no receipt, is never
   * cleared, and the hold keeps holding and says so.
   */
  retryReceipt: string | null
}

/** The reviewed scratch input for this record, at the named temporary name. */
function scratchFor(
  i: HoldInputs, runId: string, prefix: string, manifestFile: string,
  frozen: FrozenRecord, temporaryTag?: string,
): ScratchInput {
  return {
    root: i.root, prefix, stamp: i.stamp, runId,
    artifacts: [{ path: DETAIL_FILE, bytes: frozen.detailBytes }],
    manifest: { path: manifestFile, bytes: frozen.manifestBytes },
    ...(temporaryTag === undefined ? {} : { temporaryTag }),
  }
}

/**
 * Attempt one phase's record a few times. Never throws, never overwrites.
 *
 * THE SAME BYTES EVERY TIME. `FrozenRecord` was serialized once by the caller
 * and is handed to the publisher unchanged, so a record that lands on the
 * second try is byte-identical to the one that failed on the first. Minting a
 * fresh document - a new timestamp, a new id, a re-measured anything - would
 * put two different accounts of one operation into the evidence and leave a
 * reader to guess which happened.
 *
 * AND A DESTINATION THAT ALREADY EXISTS IS READ, NOT OVERWRITTEN. Published
 * evidence is immutable and claims its name with an atomic no-replace rename,
 * so an occupied destination means either this exact record already landed -
 * the previous attempt succeeded and its acknowledgement was lost - or
 * something else is using the name. The first is success; the second is a
 * collision. They are distinguished by comparing the complete bundle.
 *
 * TWO SCRATCH DIRECTORIES, WHATEVER THE RETRY COUNT. See `choosePublication`.
 */
async function publishDurable(
  i: HoldInputs, say: (l: string) => void, runId: string,
  prefix: string, manifestFile: string, frozen: FrozenRecord,
  scratch: PhaseScratch,
): Promise<PublicationResult> {
  for (let n = 0; n < PUBLICATION_ATTEMPTS; n += 1) {
    if (n > 0) {
      try { await i.sleep(HOLD_RETRY_INTERVAL_MS) } catch { /* not a resolution */ }
    }

    // AFTER AN INDETERMINATE RENAME, OBSERVE AND NOTHING ELSE. The one question
    // worth asking is whether the record is now at its final name; if it is,
    // that publication was ours and succeeded. If it is not, this phase keeps
    // holding without touching a single path, because every action available
    // here - rename again, clear the scratch - is one that could publish twice
    // or delete evidence.
    if (scratch.indeterminate) {
      const landed = acceptExistingRecord(i, runId, prefix, manifestFile, frozen)
      if (landed !== null) {
        say(`The ${prefix} record for attempt ${runId} is on disk after an ` +
            'unreported rename. Nothing was retried.')
        return { kind: 'published', bundle: landed }
      }
      say(`The ${prefix} rename for attempt ${runId} did not report. Everything ` +
          'is preserved exactly as it is; nothing has been retried or removed.')
      return { kind: 'unproved' }
    }

    const decision = choosePublication(
      i, say, runId, prefix, manifestFile, frozen, scratch)
    if (decision === null) {
      // NOTHING MAY BE DONE THIS CYCLE and nothing was. Reported, not acted on.
      return { kind: 'unproved' }
    }

    try {
      const published = publishLifecycleBundle({
        root: i.root, prefix, stamp: i.stamp, runId,
        manifestFile, detailFile: DETAIL_FILE,
        manifest: frozen.manifest, detail: frozen.detail,
        manifestBytes: frozen.manifestBytes, detailBytes: frozen.detailBytes,
        reuse: decision.reuse,
        ...(decision.temporaryTag === undefined
          ? {} : { temporaryTag: decision.temporaryTag }),
        ...(i.ops === undefined ? {} : { ops: i.ops }),
      })
      verifyPublishedEvidence(published.finalPath, i.ops)
      return {
        kind: 'published',
        bundle: {
          name: basename(published.finalPath),
          digestFileDigest: fileSha256(join(published.finalPath, DIGEST_FILE)),
        },
      }
    } catch (e) {
      // THE RECEIPT, TAKEN FROM THE PUBLISHER AND NEVER MINTED HERE.
      //
      // WHAT WAS WRONG BEFORE. This used to infer creation from "the path was
      // absent when I looked" plus a `pathIdentity()` of a predictable name in this
      // catch block - and between those two moments anything at all can appear
      // under that name. The receipt would then name somebody else's directory and
      // authorise its deletion. Absence a moment ago plus existence now is not
      // creation, and only the publisher's own `mkdir` knows the difference.
      //
      // So the identity is read from the error the publisher threw. A failure
      // before its `mkdir` - EEXIST included - carries none, and no receipt means
      // no permission to clear anything.
      //
      // RE-TAKEN ON EVERY EXCLUSIVE CREATION, not just the first. Clearing the
      // retry scratch and rebuilding it produces a NEW directory with a new inode,
      // and a receipt held over from the previous one names an object that no
      // longer exists - which would refuse the next cycle's cleanup for ever and
      // wedge the retry at two directories. Measured: `publishAttempts` stopped at
      // two under a persistent freeze failure, where it must keep rebuilding.
      //
      // AND EXAMINING IT CANNOT THROW OUT OF THE HOLD. A receipt that cannot be
      // read leaves the previous one in place and the hold holding.
      try {
        if (decision.temporaryTag === EVIDENCE_RETRY_SCRATCH &&
            e instanceof LifecycleEvidenceFailed && e.creationReceipt !== null) {
          scratch.retryReceipt = e.creationReceipt
        }
      } catch { /* a receipt that cannot be examined is not a resolution */ }
      // AN UNREPORTED RENAME LATCHES. From here this phase only observes.
      if (e instanceof LifecycleEvidenceFailed && e.publication === 'unknown') {
        scratch.indeterminate = true
        say(`The ${prefix} rename for attempt ${runId} did not report its outcome. ` +
            'Nothing will be retried or removed until the state is proved.')
        return { kind: 'unproved' }
      }
      const occupied = e instanceof LifecycleEvidenceFailed &&
        (e.publication === 'destination-occupied' ||
         e.publication === 'published-unverified')
      if (occupied) {
        const already = acceptExistingRecord(i, runId, prefix, manifestFile, frozen)
        if (already !== null) {
          say(`The ${prefix} record for attempt ${runId} was already on disk.`)
          return { kind: 'published', bundle: already }
        }
        say(`COLLISION: ${prefix}-${i.stamp}-${runId} exists and is not this record.`)
        return { kind: 'collision' }
      }
      say(`The ${prefix} record could not be published ` +
          `(attempt ${n + 1} of ${PUBLICATION_ATTEMPTS}).`)
    }
  }
  return { kind: 'unpublished' }
}

/** Which temporary directory this attempt uses, and whether it builds in it. */
interface PublicationChoice {
  readonly temporaryTag?: string
  readonly reuse: 'build' | 'retained'
  /**
   * This attempt is about to create that directory where nothing was.
   *
   * Set only when the path was observed ABSENT, so the `mkdir` that follows is an
   * exclusive creation and its result is this process's own. That is what earns a
   * receipt, and a receipt is the only thing that permits a later removal.
   */
  readonly createsExclusively?: boolean
}

/**
 * DECIDE WHERE THIS ATTEMPT WORKS, AND BOUND WHAT ONE RECORD CAN OCCUPY.
 *
 * A record may occupy at most TWO directories, however many times it is retried:
 *
 *   THE DIAGNOSTIC DIRECTORY is the untagged temporary name the first attempt
 *   builds under. If that attempt fails before its rename, the directory is left
 *   EXACTLY as it is, for ever - which is what a person debugging a persistent
 *   publication failure needs, and is why nothing below ever removes it.
 *
 *   THE RETRY SCRATCH is one stable name that every later attempt reuses. It is
 *   cleared before it is rebuilt, through `discardScratch`, which refuses unless
 *   it has proved the directory is this record's own unpublished scratch space.
 *
 * AND A RETAINED DIRECTORY THAT IS ALREADY THE WHOLE RECORD IS RENAMED, NOT
 * REBUILT. A rename that failed while the bytes were already frozen and fsynced
 * leaves a directory one syscall away from being evidence; rebuilding it would
 * mean unfreezing 0400 files for no gain, since the bytes on disk are the bytes
 * we would write. `inspectScratch` proves that byte for byte before it is
 * believed.
 *
 * RETURNS NULL WHEN NOTHING MAY BE DONE. A directory whose state could not be
 * established, or one that is present and not provably ours, is left alone -
 * and since the only two names this record may use are these, "left alone" means
 * this cycle does nothing at all and the hold continues. That is bounded: no
 * path is created, so repeated failure of this kind grows nothing.
 */
function choosePublication(
  i: HoldInputs, say: (l: string) => void, runId: string,
  prefix: string, manifestFile: string, frozen: FrozenRecord,
  scratch: PhaseScratch,
): PublicationChoice | null {
  const ops = i.ops ?? REAL_EVIDENCE_OPS
  const diagnostic = scratchFor(i, runId, prefix, manifestFile, frozen)
  const first = inspectScratch(diagnostic, ops)

  // THE FIRST ATTEMPT'S OWN NAME. Complete means its rename is the only thing
  // left to do; absent means this is the first attempt.
  if (first === 'complete') {
    say(`The ${prefix} scratch directory for attempt ${runId} already holds the ` +
        'complete record. Retrying its publication only; nothing was rebuilt.')
    return { reuse: 'retained' }
  }
  if (first === 'absent') return { reuse: 'build' }

  // ANYTHING ELSE IS PRESERVED AND NOT TOUCHED AGAIN. `incomplete` is the
  // diagnostic directory a failed first attempt left; `foreign` and `unproved`
  // are things this run may not act on at all. All three mean: work in the retry
  // scratch instead.
  const retry = scratchFor(i, runId, prefix, manifestFile, frozen, EVIDENCE_RETRY_SCRATCH)
  const second = inspectScratch(retry, ops)
  if (second === 'complete') {
    say(`The ${prefix} retry scratch for attempt ${runId} already holds the ` +
        'complete record. Retrying its publication only; nothing was rebuilt.')
    return { reuse: 'retained', temporaryTag: EVIDENCE_RETRY_SCRATCH }
  }
  if (second === 'absent') {
    // NOTHING IS THERE, so the `mkdir` that follows is an exclusive creation and
    // what it makes is this process's own. That is what earns the receipt.
    return {
      reuse: 'build', temporaryTag: EVIDENCE_RETRY_SCRATCH, createsExclusively: true,
    }
  }
  if (second === 'incomplete') {
    // ONLY WHAT THIS PROCESS ITSELF CREATED MAY BE CLEARED.
    //
    // An incomplete retry scratch with no receipt was there before this phase built
    // anything - the leftovers of an earlier run of this same command against this
    // same record. Same user, same device, same name, and still not this process's
    // to delete.
    //
    // THIS CHECK IS A DIAGNOSTIC, NOT THE AUTHORITY. It exists so the log can say
    // why nothing happened without a removal even being attempted; `discardScratch`
    // requires the receipt itself and proves the root against it inside the
    // destructive operation, because between here and there the root can be
    // replaced.
    if (scratch.retryReceipt === null) {
      say(`The ${prefix} retry scratch for attempt ${runId} was not created by ` +
          'this process. It is preserved untouched; nothing was removed. Still holding.')
      return null
    }
    // CLEARED, NOT ACCUMULATED - and only after `discardScratch` has proved the
    // receipt and validated the whole tree read-only. This is the one removal in
    // the publication path.
    const cleanup = discardScratch(retry, scratch.retryReceipt, ops)
    if (cleanup === 'refused-untouched') {
      say(`The ${prefix} retry scratch for attempt ${runId} could not be proved ` +
          'safe to clear. Nothing was removed. Still holding.')
      return null
    }
    if (cleanup === 'partial-or-unknown') {
      // NOT "NOTHING WAS REMOVED". Something was, and how much cannot be
      // established: a multi-entry deletion cannot be rolled back. The remaining
      // tree is left exactly as it is for a person to look at, and the hold holds.
      say(`The ${prefix} retry scratch for attempt ${runId} was PARTIALLY removed ` +
          'and its remaining state could not be established. Nothing further has ' +
          'been touched. Still holding.')
      scratch.retryReceipt = null
      return null
    }
    return {
      reuse: 'build', temporaryTag: EVIDENCE_RETRY_SCRATCH, createsExclusively: true,
    }
  }
  // `foreign` or `unproved`. Nothing is removed, nothing is created.
  say(`The ${prefix} retry scratch for attempt ${runId} is not in a state this ` +
      'run may act on. Nothing was removed or created. Still holding.')
  return null
}

/**
 * ONE PHASE OF THE HOLD: publish THIS record, and do not come back until it is
 * durably on disk and verified.
 *
 * WHY THIS IS A SEPARATE, UNBOUNDED LOOP. The phases of an attempt are
 * ordered - freeze the intent, publish the intent, perform once, freeze the
 * outcome, publish the outcome - and the ordering is the whole guarantee. If a
 * failed publication rejoined the outer loop, then a full disk during the
 * intent phase would bump the attempt counter, mint a NEW run id, ask the
 * operator to `decide()` AGAIN, and write a second record of what is one
 * decision; and a full disk during the outcome phase would offer another
 * database action while the last one's result was still unrecorded. Neither is
 * a thing a reader of the evidence could untangle afterwards.
 *
 * So a phase that cannot complete stays in the phase. The identity is fixed,
 * the bytes are fixed, and the only way out is the record landing - which is
 * why this function's return type has no failure in it.
 *
 * IT THEREFORE NEVER RETURNS WHILE THE FENCE MAY BE HELD AND THE RECORD IS NOT
 * WRITTEN, and that is not a defect to be fixed with a ceiling. A ceiling here
 * would mean "after N tries, release a fence whose state nobody wrote down".
 * Tests contain this from OUTSIDE the process; see `tests/support/contained.ts`.
 */
async function publishPhase(
  i: HoldInputs, say: (l: string) => void, pause: (ms: number) => Promise<void>,
  runId: string, prefix: string, manifestFile: string, frozen: FrozenRecord,
): Promise<PriorBundle> {
  // THE SCRATCH STATE FOR THIS PHASE, carried across every retry. Not a ceiling:
  // nothing reads it to decide whether to stop.
  const scratch: PhaseScratch = { indeterminate: false, retryReceipt: null }
  for (;;) {
    const result = await publishDurable(
      i, say, runId, prefix, manifestFile, frozen, scratch)
    if (result.kind === 'published') return result.bundle
    if (result.kind === 'collision') {
      // NOT OURS, AND STILL NOT OVERWRITABLE. The same pending record is
      // re-reported and re-attempted; the fence stays exactly where it is.
      say(`The ${prefix} record for attempt ${runId} cannot claim its name. ` +
          'Still holding, and still trying to publish THAT record.')
    } else if (result.kind === 'unproved') {
      // THE FILESYSTEM DID NOT ANSWER, so nothing was done and nothing will be
      // until it does. Everything on disk is preserved exactly as it is.
      say(`The ${prefix} record for attempt ${runId} is in an unproved state. ` +
          'Still holding; nothing has been removed, rebuilt or republished.')
    } else {
      say(`The ${prefix} record for attempt ${runId} is NOT on disk. ` +
          'Still holding, and still trying to publish THAT record.')
    }
    await pause(HOLD_RETRY_INTERVAL_MS)
  }
}

/**
 * Is the record already at this destination the EXACT one we meant to write?
 *
 * ALL OF IT, NOT THE PART THAT WAS CONVENIENT TO CHECK. This used to verify the
 * bundle, confirm the manifest was among its files, and compare the manifest's
 * bytes - which accepted a bundle whose `actions.json` said something else
 * entirely, and a bundle carrying extra files nobody wrote. Since accepting is
 * how the hold decides that a previous attempt already succeeded, accepting on
 * a partial match is accepting somebody else's record as this run's evidence.
 *
 * So four things must hold, and each is checked:
 *   1. `verifyPublishedEvidence` succeeds - frozen modes, no links, one link
 *      each, and a DIGEST that covers exactly the published bytes;
 *   2. the file set is EXACTLY the reviewed set - nothing extra, nothing
 *      missing;
 *   3. the manifest's bytes equal the bytes we froze, exactly;
 *   4. `actions.json`'s bytes equal the detail bytes we froze, exactly.
 *
 * (3) and (4) are compared against the SAME `Buffer`s that were handed to the
 * publisher, so "the same bytes" is literally true rather than a claim about
 * two separate serializations agreeing.
 */
export function acceptExistingRecord(
  i: HoldInputs, runId: string, prefix: string, manifestFile: string,
  frozen: FrozenRecord,
): PriorBundle | null {
  try {
    const dir = join(i.root, `${prefix}-${i.stamp}-${runId}`)
    // 1. VERIFIED, OR NOTHING ELSE IS LOOKED AT. A bundle that does not verify
    //    is not this record however much of it happens to match.
    const files = [...verifyPublishedEvidence(dir, i.ops)].sort()
    // 2. EXACTLY THE REVIEWED FILE SET.
    const expected = holdRecordFileSet(manifestFile)
    if (files.length !== expected.length) return null
    if (files.some((f, n) => f !== expected[n])) return null
    // 3 and 4. EXACTLY THE BYTES WE FROZE, compared as bytes.
    for (const [file, intended] of [
      [manifestFile, frozen.manifestBytes] as const,
      [DETAIL_FILE, frozen.detailBytes] as const,
    ]) {
      const onDisk = readFileSync(join(dir, file))
      if (onDisk.length !== intended.length) return null
      if (!onDisk.equals(intended)) return null
    }
    return {
      name: basename(dir),
      digestFileDigest: fileSha256(join(dir, DIGEST_FILE)),
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// THE REVIEWED SESSION ATTESTATION
// ---------------------------------------------------------------------------

/**
 * THE MANUAL STOP PROCEDURE, AUTHORIZED AND STAMPED - AND NOTHING ELSE.
 *
 * This is what remains of the quiescence attestation. It used to carry exact
 * pid+role pairs that the source census then checked its findings against,
 * which made an operator-typed file the authority on which connections were
 * legitimate: one added line would have licensed exactly the unreviewed session
 * the census exists to find. The gate now asks each session it holds who it is.
 *
 * WHAT IS LEFT IS WORTH KEEPING. Somebody carried out the A-G stop procedure at
 * a particular time and put their name to it, and that belongs in the evidence.
 * It is RECORDED, never consulted for a census value.
 */
export function readAttestation(path: string): QuiescenceAttestation {
  const parsed = JSON.parse(openReviewedContainer(path).text) as {
    authorized_by?: unknown; authorized_at?: unknown; procedure?: unknown
    sessions?: unknown
  }
  // A FILE THAT STILL CARRIES SESSIONS IS REFUSED RATHER THAN IGNORED. Silently
  // dropping them would leave an operator believing the list still mattered.
  if (parsed.sessions !== undefined) {
    throw new OpsRefused(
      'the quiescence attestation may no longer supply session census values')
  }
  if (typeof parsed.authorized_by !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/.test(parsed.authorized_by)) {
    throw new OpsRefused('the quiescence attestation names no operator')
  }
  if (typeof parsed.authorized_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(parsed.authorized_at)) {
    throw new OpsRefused('the quiescence attestation carries no reviewed timestamp')
  }
  if (typeof parsed.procedure !== 'string' || parsed.procedure.length === 0 ||
      parsed.procedure.length > 200) {
    throw new OpsRefused('the quiescence attestation names no procedure')
  }
  return Object.freeze({
    authorizedBy: parsed.authorized_by,
    authorizedAt: parsed.authorized_at,
    procedure: parsed.procedure,
  })
}

// ---------------------------------------------------------------------------
// THE ACTING MODES
// ---------------------------------------------------------------------------

/**
 * The run this invocation IS, carried from the inspection that authorised it.
 *
 * WHY THE OPERATOR CARRIES IT. The token digests the run id and the stamp, so
 * an acting mode that minted its own would compute a different token from the
 * one it was handed and refuse every time. Carrying them makes the token bind
 * ONE inspection rather than "an inspection of a world that still looks like
 * this" - and the evidence bundle then takes the same names, so the record and
 * the token an operator pasted are the same run by construction.
 */
function runOf(v: Readonly<Record<string, string>>): { runId: string; stamp: string } {
  const runId = required(v, '--run-id')
  const stamp = required(v, '--stamp')
  if (!/^[0-9a-f]{8}$/.test(runId)) throw new OpsRefused('the run id is not in the reviewed form')
  if (!/^\d{8}T\d{6}Z$/.test(stamp)) throw new OpsRefused('the stamp is not in the reviewed form')
  return { runId, stamp }
}

export interface ModeInputs {
  readonly v: Readonly<Record<string, string>>
  readonly scope: ScopeInputs
  readonly binding: OperationalAdapterBinding
  readonly operationalDigest: string
  readonly deps: OpsDeps
  readonly deadlineMs: number
  readonly say: (l: string) => void
}

/**
 * THE OPERATIONAL REHEARSAL. It never opens a target and copies nothing.
 *
 * What it exercises is everything BETWEEN the operator and the copy: the
 * destination proof, the launchd census, the Redis endpoint, the BullMQ
 * samples, the source fence, the operational gate, the release, and the
 * evidence bundles. What it deliberately does not exercise is the transactional
 * copy, which is proved against disposable clusters and nowhere else - and
 * which could not be rehearsed here anyway, because Stage 2 requires an empty
 * target and a rehearsal copy would leave one that is not.
 *
 * THE EVIDENCE ORDER IS THE POINT OF THIS FUNCTION.
 *
 *   1. prove the operational gate WHILE FENCED;
 *   2. publish and VERIFY a `release-gate` record - the authorization and what
 *      it was proved against - which claims nothing about a rehearsal having
 *      succeeded, because at that instant it has not;
 *   3. consume the authorization exactly once;
 *   4. release, and prove the release;
 *   5. and ONLY THEN publish the `operational-rehearsal` outcome.
 *
 * An earlier revision published the success bundle at step 2. That bundle said
 * OPERATIONAL_REHEARSAL_VERIFIED_AWAITING_MANUAL_RESTORATION while the fence
 * was still held and the release had not been attempted - and a refused,
 * released-unproved or release-unknown outcome left it on disk, where
 * `--review-rehearsal` would read it, verify it, and authorise an apply on the
 * strength of a rehearsal that never finished.
 *
 * IT ENDS WITH THE PRODUCERS STILL DOWN. Restoring them is a person's job in
 * this milestone, so the rehearsal reports `EXIT_ACTION_REQUIRED` on success.
 * A zero here would read as "finished", and it is not finished.
 */
export async function runRehearsal(i: ModeInputs): Promise<CliResult> {
  const lines: string[] = []
  const say = (l: string): void => { lines.push(l); i.say(l) }
  const { v, deps } = i
  const { runId, stamp } = runOf(v)

  const authorizationDigest = createHash('sha256')
    .update(openReviewedContainer(required(v, '--rehearsal-authorization')).text)
    .digest('hex')
  assertConfirmationMatches(
    required(v, '--confirm'),
    executionBindingFor('rehearse', i.operationalDigest, null, runId, stamp, authorizationDigest),
    'rehearse')

  const attestation = readAttestation(required(v, '--quiescence-attestation'))
  const open = deps.openSupervisor
  const openProver = deps.openProver
  const acquire = deps.acquireFence
  if (open === undefined || openProver === undefined || acquire === undefined) {
    throw new OpsRefused('this build was given no way to open a source session')
  }

  const quiescence = deps.quiescence ??
    launchdQuiescenceAdapter(REVIEWED_PRODUCERS, i.scope.launchd)
  const queue = deps.queue ?? bullmqQueueAdapter(REVIEWED_QUEUES, i.scope.redis.connection)
  const destinations = deps.destinations ?? {
    measure: async (ctx: AdapterContext) => await proveDestinations(
      REVIEWED_PRODUCERS, i.scope.source,
      readDestinationPolicy(i.scope.destinationPolicyPath), i.scope.launchd, ctx),
  }

  const supervisor = await open()
  let prover: FenceLike | null = null
  let fence: AcquiredFenceLike | null = null
  let held = false
  /** Set when a hold took ownership of the sessions and will close them. */
  let torndown = false
  let releaseAttempted = false
  const priorBundles: PriorBundle[] = []

  /**
   * The one place a hold is entered from. Keeps the prover ALIVE, and does not
   * return until the fence is terminally resolved.
   *
   * `held` IS SET FALSE HERE, before the hold begins, and that is deliberate:
   * the hold owns both sessions from this point, closes them itself through
   * `teardown` after a terminal record is published, and the `finally` below
   * must therefore neither close them again nor leak them. Ownership moves; it
   * is not shared.
   */
  const hold = async (state: HoldFenceState, reason: string): Promise<CliResult> => {
    const f = fence as AcquiredFenceLike
    held = false
    torndown = true
    return await holdForIntervention({
      root: i.scope.evidenceRoot, stamp, newRunId: deps.newRunId, mode: 'rehearse',
      outerRunId: runId,
      operationalDigest: i.operationalDigest,
      fenceState: state,
      supervisorPid: f.supervisorPid, backendStart: f.backendStart,
      reason, priorBundles,
      hold: deps.hold ?? processHold(say, i.scope.evidenceRoot, v['--resolution-file'] ?? null),
      say,
      sleep: deps.sleep ?? ((ms: number) => new Promise<void>(r => { setTimeout(r, ms) })),
      ...(deps.ops === undefined ? {} : { ops: deps.ops }),
      perform: async d => await performHoldOperation(d, {
        sleep: deps.sleep ?? ((ms: number) => new Promise<void>(r => { setTimeout(r, ms) })),
        supervisor, prover, fence: f, scope: i.scope, deps,
        quiescence, queue, destinations, deadlineMs: i.deadlineMs,
        expectedProducers: i.binding.producers, say,
      }),
      // PROVER FIRST, SUPERVISOR SECOND, and only after the terminal record is
      // durable. Closing the supervisor is what ends the psql child.
      teardown: async () => {
        if (prover !== null) await prover.close().catch(() => undefined)
        await supervisor.close().catch(() => undefined)
      },
    })
  }

  try {
    fence = await acquire(supervisor)
    held = true
    prover = await openProver()

    // 1. THE OPERATIONAL GATE, WHILE FENCED.
    const authorization = await runOperationalGate({
      fence: {
        supervisorPid: fence.supervisorPid,
        backendStart: fence.backendStart,
        mechanism: fence.mechanism,
      },
      supervisor: supervisor as unknown as FenceExecutor,
      prover: prover as unknown as FenceExecutor,
      quiescence, queue, destinations,
      expectedProducers: i.binding.producers as unknown as ProducerCensusRow[],
      attestation,
      deadlineMs: i.deadlineMs,
      ...(deps.sleep === undefined ? {} : { __sleep: deps.sleep }),
    })

    // 2. THE PRE-RELEASE RECORD. It says what was PROVED and nothing about a
    //    rehearsal having succeeded - because at this instant it has not.
    const gate = publishLifecycleBundle({
      root: i.scope.evidenceRoot, prefix: RELEASE_GATE_PREFIX, stamp, runId,
      manifestFile: 'release-gate.json', detailFile: 'gate-detail.json',
      manifest: {
        record: RELEASE_GATE_PREFIX,
        complete: true,
        outcome: PRE_RELEASE_OUTCOME,
        mode: 'rehearse',
        operational_adapter_binding_digest: i.operationalDigest,
        run: { id: runId, stamp },
        fence: { ...authorization.fence },
        fenced_backend: {
          supervisor_pid: fence.supervisorPid,
          backend_start: fence.backendStart,
          mechanism: fence.mechanism,
          proving_pid: authorization.fence.provingPid,
          reviewed_relations: authorization.fence.relations,
        },
        // NO TARGET SESSION. A rehearsal never opens one; the source identity
        // session every mode opens is a different thing and is named elsewhere.
        target_sessions_opened: 0,
        copy_lifecycle_rehearsed: false,
      },
      detail: {
        // THE INDEPENDENT PROCESS CENSUS, IN FULL. `{name, stopped}` records a
        // conclusion and throws away what produced it - whether launchd had
        // the label, whether it was disabled, which pattern was searched for
        // and what it found. Those are three different stories behind one word.
        producers: authorization.producerMeasurements.map(p => ({
          label: p.name,
          stopped: p.stopped,
          presence: p.presence,
          disabled: p.disabled,
          running: p.running,
          launchd_pid: p.launchdPid,
          process_pattern: p.processPattern,
          process_pids: [...p.processPids],
        })),
        // BOTH SAMPLES, IN ORDER, WITH THE INTERVAL BETWEEN THEM. Keeping only
        // the second depth map discards the very thing the pair establishes:
        // that the queues were still empty after time had passed.
        queue_samples: authorization.queueSamples.map((x, n) => ({
          ordinal: n + 1, depths: { ...x.depths },
        })),
        queue_sample_interval_ms: QUEUE_SAMPLE_INTERVAL_MS,
        blocking_policy: {
          states: [...BLOCKING_STATES], paused_is_blocking: PAUSED_IS_BLOCKING,
        },
        activity: { ...authorization.activity },
        derived_sessions: authorization.derivedSessions.map(x => ({ ...x })),
        fenced_producers: authorization.fencedProducers.map(x => ({ ...x })),
        attestation: attestation === undefined ? null : { ...attestation },
      },
    })
    // VERIFIED FROM DISK BEFORE THE RELEASE IS ATTEMPTED. A record that does
    // not verify is a record nobody can read afterwards, and the release is
    // the step that cannot be taken back.
    verifyPublishedEvidence(gate.finalPath)
    const gateBundle: PriorBundle = {
      name: basename(gate.finalPath),
      digestFileDigest: fileSha256(join(gate.finalPath, 'DIGEST')),
    }
    priorBundles.push(gateBundle)
    say(`release gate published ${gateBundle.name}`)

    // 3-4. CONSUME EXACTLY ONCE, RELEASE, PROVE.
    releaseAttempted = true
    const released = await releaseFence(supervisor as unknown as FenceExecutor, authorization)
    held = released.state !== 'released'
    if (released.state !== 'released') {
      return await hold(released.state as HoldFenceState,
                        `the rehearsal fence release ended in ${released.state}`)
    }

    // 5. AND ONLY NOW THE SUCCESS BUNDLE.
    const published = publishLifecycleBundle({
      root: i.scope.evidenceRoot, prefix: REHEARSAL_PREFIX, stamp, runId,
      manifestFile: 'rehearsal.json', detailFile: 'findings.json',
      manifest: {
        record: REHEARSAL_PREFIX,
        complete: true,
        outcome: REHEARSAL_OUTCOME,
        mode: 'rehearse',
        operational_adapter_binding_digest: i.operationalDigest,
        run: { id: runId, stamp },
        // THE RELEASE IS PROVED, and the record says so in its own fields.
        fence_state: 'released',
        remaining_locks: released.remainingLocks,
        // WHICH FENCE WAS RELEASED. A digest, a binding and a run id say the
        // gate record is the right bundle from the right run in the right
        // world; none of them says it is about the same BACKEND. Recording the
        // fence identity here lets the link be checked on the one axis the
        // other three do not cover.
        released_fence: {
          supervisor_pid: fence.supervisorPid,
          backend_start: fence.backendStart,
          mechanism: fence.mechanism,
          proving_pid: authorization.fence.provingPid,
          reviewed_relations: authorization.fence.relations,
        },
        release_gate_bundle: {
          name: gateBundle.name, digest_file_digest: gateBundle.digestFileDigest,
        },
        // SAID IN THE RECORD, not only in this comment.
        target_sessions_opened: 0,
        copy_lifecycle_rehearsed: false,
      },
      detail: {
        fence: { ...authorization.fence },
        producers: authorization.producers.map(p => ({ name: p.name, stopped: p.stopped })),
        queue_samples: authorization.queueSamples.map(x => ({ depths: { ...x.depths } })),
        activity: { ...authorization.activity },
      },
    })
    verifyPublishedEvidence(published.finalPath)
    say(`operational rehearsal published ${basename(published.finalPath)}`)
    say('fence released and proved; the source is unfrozen.')
    say(`OUTCOME ${REHEARSAL_OUTCOME}`)
    say('The reviewed producers are still stopped. Restore them, then run')
    say('--verify-restoration before anything else uses this checkout.')
    return { exitCode: EXIT_ACTION_REQUIRED, lines }
  } catch (e) {
    if (!held || fence === null) throw e
    // THE FENCE IS STILL THIS PROCESS'S. Throwing here would run the `finally`
    // below, end the psql child and release it with nothing written down.
    //
    // A THROW FROM INSIDE THE RELEASE SAYS NOTHING about whether PostgreSQL
    // ran it, so that is `release-unknown` and not `held`.
    return await hold(
      releaseAttempted ? 'release-unknown' : 'held',
      e instanceof Error ? e.message : 'the rehearsal did not complete')
  } finally {
    // NO ROLLBACK HERE, EVER. Closing the supervisor ends the psql child, and
    // ending it releases the locks - which is the one thing a hold exists to
    // prevent.
    //
    // AND NOTHING LEAKS EITHER. There are exactly three ways out of the body
    // above: a proved release, which leaves `held` false and `torndown` false;
    // a hold, which took ownership of both sessions and closed them itself
    // (`torndown` true); and a throw before the fence existed, which also
    // leaves `held` false. The sessions are closed here in precisely the case
    // that remains - and never twice, because a hold's teardown is its own.
    if (!held && !torndown) {
      if (prover !== null) await prover.close().catch(() => undefined)
      await supervisor.close().catch(() => undefined)
    }
  }
}

/**
 * WHAT AN INDEPENDENT SESSION CAN ESTABLISH ABOUT THE SUPERVISOR'S LOCKS.
 *
 * SIX ANSWERS, AND THE OLD CODE COLLAPSED THREE OF THEM. It asked
 * `attemptFenceProof` whether the COMPLETE fence was held and called anything
 * else `not-held` - which is true of a backend holding twenty-four of its
 * twenty-five reviewed locks. A partial fence is still a fence: the tables it
 * holds are still unwritable, and reporting that as "not held" invites an
 * operator to conclude the source is free.
 *
 * So this counts. Zero reviewed locks is the only count that resolves a hold,
 * and a partial count is its own answer with its own name.
 */
export type LockCensus =
  | 'complete-fence-held'
  | 'partial-locks-held'
  | 'zero-locks-proved'
  | 'supervisor-gone'
  | 'pid-reused'
  | 'census-unavailable'

export interface CensusResult {
  readonly census: LockCensus
  readonly state: HoldFenceState
  readonly reviewedLocks: number | null
  readonly detail: string
}

/**
 * Census the supervisor's reviewed locks from the PROVER.
 *
 * PID AND BACKEND START TOGETHER, FIRST. A recycled pid holding somebody
 * else's locks must not read as "the fence is still ours", and a pid whose
 * backend is gone must not read as "unavailable".
 */
export async function censusFromProver(
  prover: FenceLike, fence: AcquiredFenceLike,
): Promise<CensusResult> {
  let alive
  try {
    alive = await prover.send(BACKEND_START_SQL(fence.supervisorPid))
  } catch {
    return {
      census: 'census-unavailable', state: 'release-unknown', reviewedLocks: null,
      detail: 'the prover could not be reached',
    }
  }
  if (alive.error !== null) {
    return {
      census: 'census-unavailable', state: 'release-unknown', reviewedLocks: null,
      detail: 'the census was refused',
    }
  }
  const start = alive.rows[0]?.[0] ?? ''
  if (start === '') {
    // THE BACKEND IS GONE. PostgreSQL released everything it held with it.
    return {
      census: 'supervisor-gone', state: 'released', reviewedLocks: 0,
      detail: 'the supervisor backend is gone, so its locks are gone with it',
    }
  }
  if (start !== fence.backendStart) {
    return {
      census: 'pid-reused', state: 'released', reviewedLocks: 0,
      detail: 'the supervisor backend is gone and its pid has been reused',
    }
  }

  // THE BACKEND IS ALIVE. COUNT WHAT IT ACTUALLY HOLDS.
  let counted
  try {
    counted = await prover.send(
      releasedLockCensusSqlFor(fence.supervisorPid).replace('$1', fenceRelationArray()))
  } catch {
    return {
      census: 'census-unavailable', state: 'unproved', reviewedLocks: null,
      detail: 'the lock census could not be taken',
    }
  }
  if (counted.error !== null) {
    return {
      census: 'census-unavailable', state: 'unproved', reviewedLocks: null,
      detail: 'the lock census was refused',
    }
  }
  const n = Number(counted.rows[0]?.[0] ?? NaN)
  if (!Number.isSafeInteger(n) || n < 0) {
    return {
      census: 'census-unavailable', state: 'unproved', reviewedLocks: null,
      detail: 'the lock census did not return a count',
    }
  }
  if (n === 0) {
    return {
      census: 'zero-locks-proved', state: 'released', reviewedLocks: 0,
      detail: 'the supervisor backend holds no reviewed lock',
    }
  }
  if (n >= COMPLETE_FENCE_LOCKS) {
    return {
      census: 'complete-fence-held', state: 'held', reviewedLocks: n,
      detail: `the supervisor backend holds the complete fence (${n} reviewed locks)`,
    }
  }
  // BETWEEN THE TWO. Not held, not released - and named as neither.
  return {
    census: 'partial-locks-held', state: 'unproved', reviewedLocks: n,
    detail: `the supervisor backend holds ${n} of ${COMPLETE_FENCE_LOCKS} reviewed locks`,
  }
}

/**
 * PERFORM ONE REVIEWED INTERVENTION OPERATION, for real.
 *
 * Every branch MEASURES what it did. `resolved` is set by a census proving
 * zero reviewed locks, or by a backend proved gone - never by the fact that an
 * operation was named.
 */
export async function performHoldOperation(
  d: HoldDecision, c: HoldContext,
): Promise<HoldOutcome> {
  const { supervisor, prover, fence } = c
  if (prover === null) {
    return {
      fenceState: 'unproved', detail: 'there is no independent session to look from',
      resolved: false, databaseStateProvable: false,
    }
  }

  if (d.action === 'NONE') {
    // STILL MEASURED. "It was already released" is a claim like any other.
    const census = await censusFromProver(prover, fence)
    return {
      fenceState: census.state,
      detail: `census from the prover: ${census.detail}`,
      resolved: census.state === 'released',
      databaseStateProvable: census.census !== 'census-unavailable',
    }
  }

  if (d.action === 'CENSUS_ONLY') {
    // NOTHING IS SENT TO THE SUPERVISOR. This is the only operation offered
    // after `released-unproved`, where a second ROLLBACK would be a statement
    // nobody decided to send against whatever transaction exists now.
    const census = await censusFromProver(prover, fence)
    return {
      fenceState: census.state,
      detail: `census from the prover: ${census.detail}`,
      // ONLY ZERO REVIEWED LOCKS, OR A BACKEND PROVED GONE.
      resolved: census.state === 'released',
      databaseStateProvable: census.census !== 'census-unavailable',
    }
  }

  if (d.action === 'TERMINATE_SUPERVISOR_WITHOUT_PRIOR_RELEASE_PROOF' ||
      d.action === 'ABANDON') {
    // ISSUED FROM THE PROVER, never from the supervisor - the supervisor is
    // the thing being ended, and a session cannot be relied on to report on
    // its own termination. For ABANDON the operator's acceptance is already
    // durable: the intent bundle carrying it was published before this ran.
    const r = await prover.send(
      `SELECT pg_catalog.pg_terminate_backend(${fence.supervisorPid})`)
    if (r.error !== null) {
      return {
        fenceState: 'release-unknown', detail: 'the termination was refused',
        resolved: false, databaseStateProvable: false,
      }
    }
    // AND THE PROVER IS STILL ALIVE TO SAY WHAT FOLLOWED. A terminated
    // backend is not instantly reaped, so the census is retried until the
    // reaping is observable or the attempts run out.
    let after = await censusFromProver(prover, fence)
    for (let n = 0; n < TERMINATION_CENSUS_ATTEMPTS && after.state !== 'released'; n += 1) {
      await c.sleep(TERMINATION_CENSUS_INTERVAL_MS)
      after = await censusFromProver(prover, fence)
    }
    const gone = after.state === 'released'
    return {
      fenceState: after.state,
      detail: `terminated the supervisor backend; ${after.detail}`,
      // RESOLVED ONLY WHEN THE BACKEND CAN NO LONGER HOLD THE FENCE.
      resolved: gone,
      // AND THE DATABASE'S CONTENTS ARE A SEPARATE QUESTION. A reaped backend
      // whose transaction nobody could account for leaves the fence gone and
      // what it had written unestablished.
      databaseStateProvable: gone && after.census !== 'census-unavailable' &&
        d.action !== 'ABANDON',
    }
  }

  // REPROVE_AND_GATE. A FRESH proof, a FRESH gate, a FRESH single-use
  // authorization. Nothing from the first gate is replayed: its authorization
  // is spent and its proofs are about a moment that has passed.
  const census = await censusFromProver(prover, fence)
  if (census.census !== 'complete-fence-held') {
    return {
      fenceState: census.state,
      detail: `nothing to re-gate: ${census.detail}`,
      resolved: census.state === 'released',
      databaseStateProvable: census.census !== 'census-unavailable',
    }
  }
  let authorization
  try {
    authorization = await runOperationalGate({
      fence: {
        supervisorPid: fence.supervisorPid,
        backendStart: fence.backendStart,
        mechanism: fence.mechanism,
      },
      supervisor: supervisor as unknown as FenceExecutor,
      prover: prover as unknown as FenceExecutor,
      quiescence: c.quiescence, queue: c.queue, destinations: c.destinations,
      expectedProducers: c.expectedProducers as unknown as ProducerCensusRow[],
      deadlineMs: c.deadlineMs,
      ...(c.deps.sleep === undefined ? {} : { __sleep: c.deps.sleep }),
    })
  } catch (e) {
    return {
      fenceState: 'held',
      detail: `the fresh gate refused: ${e instanceof Error ? e.message : 'unknown'}`,
      resolved: false, databaseStateProvable: true,
    }
  }
  const released = await releaseFence(supervisor as unknown as FenceExecutor, authorization)
  // THE ROLLBACK'S OWN ANSWER IS NOT THE PROOF. `released` means the statement
  // was acknowledged and the supervisor's own census agreed; the hold resolves
  // on an INDEPENDENT zero-lock census, taken here.
  const proof = await censusFromProver(prover, fence)
  return {
    fenceState: proof.state,
    detail: `a fresh gate authorised one release; it ended in ${released.state}, ` +
      `and the prover says ${proof.detail}`,
    resolved: proof.state === 'released',
    databaseStateProvable: proof.census !== 'census-unavailable',
  }
}

/**
 * How long the hold waits before re-consulting the resolution channel.
 *
 * NOT A TIMEOUT. Nothing gives up when it elapses; it is the difference
 * between a hold and a busy loop.
 */
export const HOLD_RETRY_INTERVAL_MS = 5_000

/** How many times a termination is re-censused before it is called unproved. */
export const TERMINATION_CENSUS_ATTEMPTS = 5
export const TERMINATION_CENSUS_INTERVAL_MS = 500

export interface HoldContext {
  /** How a termination waits before re-censusing. Injected for tests. */
  readonly sleep: (ms: number) => Promise<void>
  readonly supervisor: FenceLike
  readonly prover: FenceLike | null
  readonly fence: AcquiredFenceLike
  readonly scope: ScopeInputs
  readonly deps: OpsDeps
  readonly quiescence: QuiescenceAdapter
  readonly queue: QueueAdapter
  readonly destinations: DestinationCensusAdapter
  readonly expectedProducers: readonly ProducerIdentity[]
  readonly deadlineMs: number
  readonly say: (l: string) => void
}

/**
 * PROVE THE PRODUCERS CAME BACK - ALL OF IT, NOT JUST THAT THEY ARE RUNNING.
 *
 * An earlier revision compared one field per label: the launchd state. That
 * answers "is something running under this name" and nothing else. A producer
 * can come back running from a DIFFERENT plist, serving a DIFFERENT checkout,
 * holding a DIFFERENT credential that points at a DIFFERENT database - and
 * every one of those reads as "restored" to a check that only looks at the
 * state word. What the fence was taken to protect is where these agents write,
 * so that is what has to be proved unchanged when they come back.
 *
 * SO THIS RE-PROVES, PER LABEL: the exact reviewed end state, the plist's
 * SHA-256 and the checkout it serves, the credential container's identity and
 * the sanitized destination it points at - and, across the whole system, both
 * reviewed queues under the complete blocking policy, the structured worker's
 * reviewed expected-absent installation, and the current operational binding.
 *
 * `loaded-scheduled-healthy` REQUIRES AN EXACT SUCCESSFUL LAST EXIT. A null is
 * not success: it means launchd has no record of the agent ever having run,
 * which for a scheduled job that should have fired is the thing to look at, not
 * the thing to wave through.
 *
 * NOTHING HERE STARTS, STOPS OR LOADS ANYTHING. An agent that did not come
 * back is reported, not fixed.
 */
export async function runVerifyRestoration(i: ModeInputs): Promise<CliResult> {
  const lines: string[] = []
  const say = (l: string): void => { lines.push(l); i.say(l) }
  const { runId, stamp } = runOf(i.v)
  const policy = readRestorationPolicy(i.scope.postRestorationPolicyPath)

  // 1. THE CURRENT BINDING. Re-derived by MEASUREMENT at the top of the
  //    command, and pinned into this record so the restoration is a statement
  //    about a world somebody can identify afterwards.
  const rehearsalDir = required(i.v, '--operational-rehearsal-bundle')
  const rehearsal = verifyReferencedBundle(rehearsalDir, REHEARSAL_PREFIX, 'rehearsal.json')
  const rehearsalBinding = (rehearsal as { operational_adapter_binding_digest?: unknown })
    .operational_adapter_binding_digest
  if (typeof rehearsalBinding !== 'string') {
    throw new OpsRefused('the referenced rehearsal records no operational binding')
  }
  // THE REHEARSAL MUST HAVE PROVED ITS RELEASE. A restoration that closed over
  // a rehearsal which ended held, unproved or unknown would be recording that
  // the world came back from a fence nobody established was ever lifted.
  if ((rehearsal as { fence_state?: unknown }).fence_state !== 'released') {
    throw new OpsRefused('the referenced rehearsal does not record a proved release')
  }
  assertOperationalBindingUnchanged(rehearsalBinding, i.binding)

  // 2. PER-LABEL RE-PROOF, against the pre-fence measurement in the binding.
  const measured = await withDeadline('launchd', i.deadlineMs, async ctx => {
    const disabled = await readDisabled(i.scope.launchd, ctx)
    const out: RestorationRow[] = []
    for (const entry of policy) {
      const seen = await inspectLabel(entry.label, i.scope.launchd, ctx, disabled)
      // THREE STATES, AND NO FOURTH. "Loaded but not running" is what a
      // scheduled agent looks like between runs, and collapsing it into
      // "running" would report a healthy calendar job as a failure - or,
      // worse, a dead one as healthy.
      const state: RestorationState = seen.presence === 'absent' ? 'absent'
        : seen.running ? 'running' : 'loaded-scheduled-healthy'
      // AN EXACT SUCCESSFUL LAST EXIT, and `null` is not one.
      const healthy = state !== 'loaded-scheduled-healthy' || seen.lastExitCode === '0'
      const before = i.binding.producers.find(p => p.label === entry.label)
      const identity = compareIdentity(before, seen)
      out.push(Object.freeze({
        label: entry.label,
        required: entry.required,
        observed: state,
        lastExitCode: seen.lastExitCode,
        plistSha256: seen.plistSha256,
        servedCheckout: seen.servedCheckout,
        identityDrift: identity,
        matched: state === entry.required && healthy && identity === null,
      }))
    }
    return Object.freeze(out)
  })

  // 3. THE DESTINATIONS, RE-PROVED AGAINST THE REHEARSAL'S OWN RECORD.
  //
  // NOT AGAINST `i.binding`. That was re-derived from the same measurement a
  // few lines ago, so comparing the two would compare a value with itself and
  // pass whatever the producers did. The rehearsal bundle's fenced census is
  // an INDEPENDENT source - bytes on disk, covered by a DIGEST, written while
  // the source was frozen - and "did these agents come back pointing where
  // they pointed under the fence" is the question this mode exists to answer.
  let destinationDrift: string | null = null
  try {
    const recorded = readFencedCensus(rehearsalDir)
    const now = await withDeadline('launchd', i.deadlineMs, ctx => proveDestinations(
      REVIEWED_PRODUCERS, i.scope.source,
      readDestinationPolicy(i.scope.destinationPolicyPath), i.scope.launchd, ctx))
    destinationDrift = compareProducerSets(recorded, now)
  } catch (e) {
    destinationDrift = e instanceof Error ? e.message : 'the destinations could not be proved'
  }

  // 4. BOTH QUEUES, EMPTY AND STAYING EMPTY, UNDER THE COMPLETE POLICY.
  //
  // CHECKING THAT THE NAMES APPEAR PROVES NOTHING. An earlier revision did
  // exactly that and would have accepted two queues with a thousand jobs
  // waiting in each - which is the state the restoration exists to rule out,
  // because it means the producers came back and immediately started work the
  // copy's window was supposed to contain.
  let queueDrift: string | null = null
  let depths: Record<string, number> = {}
  let queueSamples: readonly Record<string, number>[] = []
  try {
    const queue = i.deps.queue ??
      bullmqQueueAdapter(REVIEWED_QUEUES, i.scope.redis.connection)
    const proof = await proveQueuesRestored(queue, i.deadlineMs, i.deps.sleep)
    depths = proof.depths
    // BOTH SAMPLES, IN ORDER. Keeping only the second discards the very thing
    // the pair establishes: that the queues were still empty after time passed.
    queueSamples = proof.samples
    queueDrift = proof.refusal
  } catch (e) {
    queueDrift = e instanceof Error ? e.message : 'the queues could not be sampled'
  }

  // 5. THE STRUCTURED WORKER, FROM A FRESH MEASUREMENT.
  //
  // THE OLD CHECK COMPARED THE BINDING WITH ITSELF. `structuredWorkerInstallation`
  // is copied out of the same producer record the comparison then looked at, so
  // it held whatever the world happened to be and would have passed for any
  // state at all. What matters is whether the agent came back into the state
  // the REVIEWED POLICY declares - and the policy is a separate document.
  const structuredLabel = REVIEWED_PRODUCERS.find(l => l.endsWith('.structured-worker'))
  let structuredActual: InstallationState | null = null
  let structuredExpected: InstallationState | null = null
  let structuredDrift: string | null = null
  if (structuredLabel === undefined) {
    structuredDrift = 'the reviewed producer set has no structured worker'
  } else {
    // THE EXPECTED STATE COMES FROM THE REHEARSAL'S OWN RECORD, on disk.
    //
    // NOT FROM `i.binding`, which was re-derived from the same measurement a
    // few lines ago - comparing those two compares a value with itself. And
    // not from the policy alone either: the policy says what a reviewed
    // installation looks like, while the rehearsal says what was actually
    // there when the fence was lifted, which is the state the producers have
    // to come back to.
    const recordedStructured = readFencedCensus(rehearsalDir)
      .find(p => p.label === structuredLabel)
    structuredExpected = (recordedStructured?.installation as InstallationState | undefined)
      ?? null
    const declared = readDestinationPolicy(i.scope.destinationPolicyPath)
      .find(e => e.label === structuredLabel)?.installation ?? null
    if (structuredExpected !== declared) {
      structuredDrift = `the rehearsal recorded the structured worker as ` +
        `${String(structuredExpected)}, and the reviewed policy declares ${String(declared)}`
    }
    try {
      structuredActual = await withDeadline('launchd', i.deadlineMs, async ctx => {
        const disabled = await readDisabled(i.scope.launchd, ctx)
        return installationOf(
          await inspectLabel(structuredLabel, i.scope.launchd, ctx, disabled))
      })
    } catch (e) {
      structuredDrift = e instanceof Error ? e.message
        : 'the structured worker could not be inspected'
    }
    if (structuredDrift === null && structuredActual !== structuredExpected) {
      structuredDrift = `the structured worker is ${String(structuredActual)}, ` +
        `and the reviewed policy expects ${String(structuredExpected)}`
    }
  }

  const failed = measured.filter(o => !o.matched)
  const systemDrift = [destinationDrift, queueDrift, structuredDrift].filter(x => x !== null)
  const restored = failed.length === 0 && systemDrift.length === 0

  const published = publishLifecycleBundle({
    root: i.scope.evidenceRoot, prefix: RESTORATION_PREFIX, stamp, runId,
    manifestFile: 'restoration.json', detailFile: 'producers.json',
    manifest: {
      record: RESTORATION_PREFIX,
      complete: true,
      outcome: restored ? 'RESTORED' : 'NOT_RESTORED',
      operational_adapter_binding_digest: i.operationalDigest,
      post_restoration_policy_sha256: i.binding.postRestorationPolicySha256,
      structured_worker: {
        label: structuredLabel ?? null,
        expected: structuredExpected,
        // MEASURED FRESH, not copied from the binding this record also carries.
        actual: structuredActual,
        verdict: structuredDrift === null ? 'as-reviewed' : 'drifted',
      },
      run: { id: runId, stamp },
      // THE REHEARSAL THIS RESTORATION IS ABOUT, by basename AND by the digest
      // of its DIGEST file - so a bundle replaced after the fact cannot be the
      // one this record claims to close.
      operational_rehearsal: {
        name: basename(rehearsalDir),
        digest_file_digest: fileSha256(join(rehearsalDir, 'DIGEST')),
      },
    },
    detail: {
      producers: measured.map(o => ({
        label: o.label, required: o.required, observed: o.observed,
        last_exit_code: o.lastExitCode, plist_sha256: o.plistSha256,
        served_checkout: o.servedCheckout, identity_drift: o.identityDrift,
        matched: o.matched,
      })),
      queue_samples: queueSamples.map((x, n) => ({ ordinal: n + 1, depths: { ...x } })),
      queue_sample_interval_ms: QUEUE_SAMPLE_INTERVAL_MS,
      queue_depths: depths,
      blocking_policy: { states: [...BLOCKING_STATES], paused_is_blocking: PAUSED_IS_BLOCKING },
      system_drift: systemDrift,
    },
  })
  verifyPublishedEvidence(published.finalPath)

  for (const f of failed) {
    say(`NOT RESTORED ${f.label}: observed ${f.observed}` +
        `${f.identityDrift === null ? '' : ` (${f.identityDrift})`}`)
  }
  for (const d of systemDrift) say(`NOT RESTORED: ${String(d)}`)
  say(`producer restoration published ${basename(published.finalPath)}`)
  return { exitCode: restored ? EXIT_OK : EXIT_ACTION_REQUIRED, lines }
}

/**
 * Two interval-separated samples, both empty, both complete, neither paused.
 *
 * ONE INSTANT IS NOT A STATE. A single observation says the queues were empty
 * when it was taken; the pair says they were still empty afterwards, which is
 * the difference between "nothing is queued" and "nothing is arriving".
 */
export async function proveQueuesRestored(
  queue: QueueAdapter, deadlineMs: number,
  sleep: ((ms: number) => Promise<void>) | undefined,
): Promise<{
  samples: readonly Record<string, number>[]
  depths: Record<string, number>
  refusal: string | null
}> {
  const wait = sleep ?? ((ms: number) => new Promise<void>(r => { setTimeout(r, ms) }))
  const samples: Array<Record<string, number>> = []
  for (let n = 0; n < 2; n += 1) {
    if (n > 0) await wait(QUEUE_SAMPLE_INTERVAL_MS)
    const sample = await withDeadline('queue', deadlineMs, ctx => queue.sample(ctx))
    samples.push({ ...sample.depths })
  }
  const last = samples[1] as Record<string, number>
  const frozen = Object.freeze(samples.map(x => Object.freeze({ ...x })))
  for (const sample of samples) {
    const names = Object.keys(sample)
    // EXACTLY THE REVIEWED SET: nothing missing, nothing extra.
    if (names.length !== REVIEWED_QUEUES.length ||
        !REVIEWED_QUEUES.every(q => names.includes(q))) {
      return { samples: frozen, depths: last,
               refusal: 'the sample does not cover the reviewed queue set' }
    }
    for (const q of REVIEWED_QUEUES) {
      const depth = sample[q]
      // A COUNT, AND `-0` IS NOT ONE. `-0 !== 0` is false, so the emptiness
      // test below would wave it through - and a negative zero arriving from a
      // depth calculation means an arithmetic error nobody has looked at.
      if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0 ||
          Object.is(depth, -0)) {
        return { samples: frozen, depths: last,
                 refusal: `${q} reported a depth that is not a count` }
      }
      // A PAUSED QUEUE IS BLOCKING, and the adapter signals it as a negative
      // depth rather than by omitting the queue - an omission would look like
      // a set problem and send the operator to the wrong question.
      if (depth !== 0) {
        return { samples: frozen, depths: last, refusal: `${q} is not empty` }
      }
    }
  }
  return { samples: frozen, depths: last, refusal: null }
}

interface RestorationRow {
  readonly label: string
  readonly required: RestorationState
  readonly observed: RestorationState
  readonly lastExitCode: string | null
  readonly plistSha256: string | null
  readonly servedCheckout: string | null
  readonly identityDrift: string | null
  readonly matched: boolean
}

/**
 * Did this label come back as the SAME installation the binding recorded?
 *
 * FOUR STATES NOW, AND `presence` NO LONGER DECIDES ON ITS OWN. Both
 * `expected-absent` and `installed-unloaded` report `presence === 'absent'`, so
 * a comparison written against presence alone would accept a plist appearing
 * under a previously-uninstalled label, and would reject an installed-unloaded
 * agent that had not changed at all. The installation state recorded in the
 * binding is compared against the state remeasured now, and every field that
 * state binds is compared with it.
 */
export function compareIdentity(
  before: ProducerIdentity | undefined, now: LabelInspection,
): string | null {
  if (before === undefined) return 'the label is not in the operational binding'

  if (before.installation === 'expected-absent') {
    if (now.presence !== 'absent') return 'an expected-absent label is now loaded'
    // A PLIST WHERE THERE WAS NONE. launchd still holds no label, so presence is
    // unchanged and the old check passed; what changed is that the agent is now
    // installed and one bootstrap away from running.
    if (now.installedUnloaded) return 'an expected-absent label is now installed'
    return null
  }

  if (before.installation === 'installed-unloaded') {
    // A LABEL THAT APPEARED IS A DIFFERENT INSTALLATION, and it is the dangerous
    // direction: the plists are on disk, so a bootstrap is all it takes.
    if (now.presence !== 'absent') return 'an installed-unloaded label is now loaded'
    if (!now.installedUnloaded) return 'an installed-unloaded plist has been removed'
  } else if (now.presence === 'absent') {
    return now.installedUnloaded
      ? 'a loaded label is now installed-unloaded'
      : 'a loaded label is now absent'
  }

  if (before.plistSha256 !== now.plistSha256) return 'the plist is not the one measured'
  if (before.plistPath !== now.plistPath) return 'the plist path has moved'
  if (before.plistDeviceInode !== now.plistDeviceInode) return 'the plist has been replaced'
  if (before.servedCheckout !== now.servedCheckout) return 'the served checkout has changed'
  if (before.credentialPath !== now.credentialPath) return 'the credential container has changed'
  return null
}

/**
 * The fenced producer census the rehearsal recorded, read back from disk.
 *
 * The rehearsal's release-gate bundle is named by the rehearsal manifest and
 * carries the census taken WHILE THE SOURCE WAS FROZEN. That is the state the
 * producers must come back to.
 */
export function readFencedCensus(rehearsalDir: string): readonly ProducerIdentity[] {
  const manifest = verifyReferencedBundle(rehearsalDir, REHEARSAL_PREFIX, 'rehearsal.json')
  return verifyGateLink(rehearsalDir, manifest).producers
}

export interface VerifiedGateLink {
  readonly name: string
  readonly digestFileDigest: string
  readonly producers: readonly ProducerIdentity[]
}

/**
 * FOLLOW A REHEARSAL'S RELEASE-GATE REFERENCE, AND PROVE IT IS THE SAME BUNDLE.
 *
 * AN EARLIER REVISION READ THE NAME AND IGNORED THE DIGEST. The rehearsal
 * manifest records the gate bundle by basename AND by the SHA-256 of that
 * bundle's DIGEST file - and only the first was being used. A gate bundle
 * republished under the same name would then have been followed happily, which
 * is exactly the substitution the second field exists to detect: the rehearsal
 * manifest is frozen and covered by its own DIGEST, so the recorded value
 * cannot be edited to match a swapped bundle without breaking the rehearsal.
 *
 * BASENAME ONLY. The reference is resolved inside the rehearsal's own parent
 * directory; a value carrying a separator or a traversal segment is refused
 * rather than joined, so a record cannot point outside the evidence root.
 */
export function verifyGateLink(
  rehearsalDir: string, manifest: Record<string, never>,
): VerifiedGateLink {
  const gate = (manifest as {
    release_gate_bundle?: { name?: unknown; digest_file_digest?: unknown }
  }).release_gate_bundle
  if (typeof gate?.name !== 'string' || typeof gate.digest_file_digest !== 'string') {
    throw new OpsRefused('the referenced rehearsal names no release-gate record')
  }
  if (gate.name !== basename(gate.name) || gate.name === '.' || gate.name === '..') {
    throw new OpsRefused('the release-gate reference is not a basename')
  }
  if (!new RegExp(`^${RELEASE_GATE_PREFIX}-\\d{8}T\\d{6}Z-[0-9a-f]{8}$`).test(gate.name)) {
    throw new OpsRefused('the release-gate reference is not a reviewed bundle name')
  }
  const gateDir = join(dirname(rehearsalDir), gate.name)

  // INDEPENDENTLY VERIFIED FROM DISK, then compared with what was recorded.
  verifyPublishedEvidence(gateDir)
  const actual = fileSha256(join(gateDir, 'DIGEST'))
  if (actual !== gate.digest_file_digest) {
    throw new OpsRefused('the release-gate bundle is not the one the rehearsal recorded')
  }

  const gateManifest = JSON.parse(
    readFileSync(join(gateDir, 'release-gate.json'), 'utf-8')) as Record<string, unknown>
  if (gateManifest.record !== RELEASE_GATE_PREFIX || gateManifest.complete !== true) {
    throw new OpsRefused('the release-gate bundle is not a complete release-gate record')
  }
  // THE TWO RECORDS MUST BE ABOUT THE SAME RUN, THE SAME WORLD AND THE SAME
  // FENCE. A gate from another run of the same command would verify, carry the
  // right record name, and describe a different fence entirely.
  if (gateManifest.operational_adapter_binding_digest !==
      (manifest as { operational_adapter_binding_digest?: unknown })
        .operational_adapter_binding_digest) {
    throw new OpsRefused('the release-gate bundle describes a different operational binding')
  }
  const gateRun = gateManifest.run as { id?: unknown; stamp?: unknown } | undefined
  const rehearsalRun = (manifest as { run?: { id?: unknown; stamp?: unknown } }).run
  if (gateRun?.id !== rehearsalRun?.id || gateRun?.stamp !== rehearsalRun?.stamp) {
    throw new OpsRefused('the release-gate bundle belongs to a different run')
  }

  // AND THE TWO ARE ABOUT THE SAME FENCE.
  //
  // The digest says the gate bundle is the one that was recorded; the binding
  // says it describes this world; the run id says it comes from this
  // invocation. NONE OF THEM SAYS IT IS ABOUT THE SAME BACKEND. A run that
  // took a fence, lost it, and took another would satisfy all three and pair a
  // release proof for one backend with a gate record for a different one - so
  // the identity is carried on both sides and compared here.
  const released = (manifest as { released_fence?: Record<string, unknown> }).released_fence
  const fenced = gateManifest.fenced_backend as Record<string, unknown> | undefined
  if (released === undefined || fenced === undefined) {
    throw new OpsRefused('the release-gate link records no fence identity')
  }
  for (const field of ['supervisor_pid', 'backend_start', 'mechanism',
                       'proving_pid', 'reviewed_relations']) {
    if (released[field] === undefined || released[field] !== fenced[field]) {
      throw new OpsRefused(
        'the release-gate bundle describes a different fence', field)
    }
  }

  const detail = JSON.parse(readFileSync(join(gateDir, 'gate-detail.json'), 'utf-8')) as {
    fenced_producers?: unknown
  }
  if (!Array.isArray(detail.fenced_producers) ||
      detail.fenced_producers.length !== REVIEWED_PRODUCERS.length) {
    throw new OpsRefused('the release-gate record carries no fenced producer census')
  }
  // STRUCTURALLY VALIDATED. A census read back from disk is data, and the
  // comparison that follows would silently pass on rows that carry none of the
  // fields it compares.
  const rows = detail.fenced_producers.map((raw, n) => {
    const row = raw as Record<string, unknown>
    if (row.label !== REVIEWED_PRODUCERS[n]) {
      throw new OpsRefused('the fenced producer census is not in the reviewed order', String(n))
    }
    for (const k of ['installation', 'disposition']) {
      if (typeof row[k] !== 'string') {
        throw new OpsRefused('a fenced producer census row is incomplete', `${String(row.label)}.${k}`)
      }
    }
    for (const k of ['plistPath', 'plistSha256', 'plistDeviceInode', 'servedCheckout',
                     'credentialPath', 'credentialDeviceInode', 'databaseHost',
                     'databasePort', 'databaseName']) {
      const v = row[k]
      if (v !== null && typeof v !== 'string') {
        throw new OpsRefused('a fenced producer census row is incomplete', `${String(row.label)}.${k}`)
      }
    }
    return row as unknown as ProducerIdentity
  })

  return Object.freeze({
    name: gate.name, digestFileDigest: actual, producers: Object.freeze(rows),
  })
}

/** Did every producer come back pointing where the fenced census said? */
export function compareProducerSets(
  before: readonly ProducerIdentity[], now: readonly ProducerIdentity[],
): string | null {
  if (before.length !== now.length) return 'the producer set has a different size'
  for (let n = 0; n < before.length; n += 1) {
    const a = before[n] as ProducerIdentity
    const b = now[n] as ProducerIdentity
    if (a.label !== b.label) return `the producer order changed at ${a.label}`
    // EVERY BOUND FIELD, not a chosen subset. The plist identity and the served
    // checkout were previously left out of this comparison, which was harmless
    // only while no reviewed agent bound them outside the loaded state. An
    // installed-unloaded agent binds all of them, so a plist replaced between
    // the fenced census and the restoration would otherwise compare equal.
    for (const k of ['disposition', 'installation',
                     'plistPath', 'plistSha256', 'plistDeviceInode', 'servedCheckout',
                     'credentialPath', 'credentialDeviceInode',
                     'databaseHost', 'databasePort', 'databaseName'] as const) {
      if (a[k] !== b[k]) return `${a.label} came back with a different ${k}`
    }
  }
  return null
}

/**
 * CLOSE THE REHEARSAL, publishing the only bundle that may authorise an apply.
 *
 * BOTH REFERENCED BUNDLES ARE READ BACK FROM DISK AND INDEPENDENTLY REVERIFIED,
 * and both are recorded by BASENAME AND DIGEST-FILE DIGEST. A review that
 * trusted its arguments would authorise an apply on the strength of two
 * directory names, and a review that recorded only the names would be satisfied
 * later by whatever those names came to contain.
 *
 * THE TWO BUNDLES MUST AGREE ABOUT THE WORLD. The rehearsal and the restoration
 * each carry the operational binding digest they were taken against; if those
 * differ, the producers came back into a different world from the one whose
 * fence was lifted, and neither record describes the other's subject.
 *
 * AND THE REHEARSAL MUST RECORD A PROVED RELEASE. A rehearsal that ended held,
 * unproved or unknown did not finish, and closing it as though it had is the
 * failure this whole ordering exists to prevent.
 */
export async function runReviewRehearsal(i: ModeInputs): Promise<CliResult> {
  const lines: string[] = []
  const say = (l: string): void => { lines.push(l); i.say(l) }
  const { runId, stamp } = runOf(i.v)

  const chain = verifyRehearsalChain(
    required(i.v, '--operational-rehearsal-bundle'),
    required(i.v, '--producer-restoration-bundle'))

  // THE WORLD HAS NOT MOVED SINCE THE REHEARSAL. Compared against what THIS
  // invocation measured, not against what the bundles say about themselves.
  assertOperationalBindingUnchanged(chain.bindingDigest, i.binding)

  const published = publishLifecycleBundle({
    root: i.scope.evidenceRoot, prefix: REVIEW_PREFIX, stamp, runId,
    manifestFile: 'review.json', detailFile: 'referenced.json',
    manifest: {
      record: REVIEW_PREFIX,
      complete: true,
      operational_adapter_binding_digest: i.operationalDigest,
      reviewer: required(i.v, '--reviewer'),
      run: { id: runId, stamp },
      // BOTH BUNDLES, BY NAME AND BY DIGEST.
      operational_rehearsal: {
        name: chain.rehearsalName, digest_file_digest: chain.rehearsalDigest,
      },
      producer_restoration: {
        name: chain.restorationName, digest_file_digest: chain.restorationDigest,
      },
      // WHAT THE REHEARSAL ESTABLISHED ABOUT ITS OWN FENCE.
      rehearsal_fence_state: 'released',
      // WHAT THIS REVIEW DOES NOT SAY. Named in the record so an apply that
      // reads it cannot mistake it for a copy that was rehearsed.
      copy_lifecycle_rehearsed: false,
    },
    detail: {
      operational_rehearsal_path: chain.rehearsalPath,
      producer_restoration_path: chain.restorationPath,
    },
  })
  verifyPublishedEvidence(published.finalPath)
  say(`rehearsal review published ${basename(published.finalPath)}`)
  say('An apply may now reference this review. It is not itself an apply.')
  return { exitCode: EXIT_OK, lines }
}

export interface VerifiedChain {
  readonly bindingDigest: string
  readonly rehearsalPath: string
  readonly rehearsalName: string
  readonly rehearsalDigest: string
  readonly restorationPath: string
  readonly restorationName: string
  readonly restorationDigest: string
}

/**
 * VERIFY THE WHOLE REHEARSAL -> RESTORATION CHAIN FROM DISK.
 *
 * Used both when the review is written and every time one is read, so an apply
 * cannot be authorised by a review whose own evidence has since been replaced.
 */
export function verifyRehearsalChain(
  rehearsalPath: string, restorationPath: string,
): VerifiedChain {
  const rehearsal = verifyReferencedBundle(rehearsalPath, REHEARSAL_PREFIX, 'rehearsal.json')
  const restoration =
    verifyReferencedBundle(restorationPath, RESTORATION_PREFIX, 'restoration.json')

  if ((rehearsal as { outcome?: unknown }).outcome !== REHEARSAL_OUTCOME) {
    throw new OpsRefused('the referenced rehearsal did not verify its own outcome')
  }
  // THE RELEASE WAS PROVED. Not "a release was attempted".
  if ((rehearsal as { fence_state?: unknown }).fence_state !== 'released') {
    throw new OpsRefused('the referenced rehearsal does not record a proved release')
  }
  if ((restoration as { outcome?: unknown }).outcome !== 'RESTORED') {
    throw new OpsRefused('the referenced restoration did not prove the producers came back')
  }

  const rehearsalBinding = (rehearsal as { operational_adapter_binding_digest?: unknown })
    .operational_adapter_binding_digest
  const restorationBinding = (restoration as { operational_adapter_binding_digest?: unknown })
    .operational_adapter_binding_digest
  if (typeof rehearsalBinding !== 'string') {
    throw new OpsRefused('the referenced rehearsal records no operational binding')
  }
  if (restorationBinding !== rehearsalBinding) {
    throw new OpsRefused(
      'the referenced bundles do not agree about the operational binding')
  }

  // AND THE RESTORATION MUST NAME THE REHEARSAL IT CLOSED, by name AND digest.
  const named = (restoration as { operational_rehearsal?: { name?: unknown
                                                            digest_file_digest?: unknown } })
    .operational_rehearsal
  const rehearsalName = basename(rehearsalPath)
  const rehearsalDigest = fileSha256(join(rehearsalPath, 'DIGEST'))
  if (named?.name !== rehearsalName || named?.digest_file_digest !== rehearsalDigest) {
    throw new OpsRefused('the referenced restoration closes a different rehearsal')
  }

  // AND THE REHEARSAL'S OWN GATE LINK, verified here too - so an apply that
  // reads a review is standing on a chain every link of which was followed.
  verifyGateLink(rehearsalPath, rehearsal)

  return Object.freeze({
    bindingDigest: rehearsalBinding,
    rehearsalPath, rehearsalName, rehearsalDigest,
    restorationPath,
    restorationName: basename(restorationPath),
    restorationDigest: fileSha256(join(restorationPath, 'DIGEST')),
  })
}

/**
 * The operations command.
 *
 * Every mode derives the operational binding by MEASUREMENT first, so a
 * mismatch is refused before a session is opened, a fence is taken, or a token
 * is printed that would later prove to describe a different world.
 */
export async function runOpsCli(argv: readonly string[], deps: OpsDeps): Promise<CliResult> {
  const lines: string[] = []
  const say = (l: string): void => { lines.push(l) }
  try {
    const parsed = parseArgs(argv)
    const v = parsed.values
    const deadlineMs = deps.deadlineMs ?? 30_000

    if ((v['--producer-authority'] ?? PRODUCER_AUTHORITY) !== PRODUCER_AUTHORITY) {
      throw new OpsRefused(
        'the only reviewed producer authority in this milestone is manual-stop')
    }

    // THE SOURCE IDENTITY AND THIS IMPLEMENTATION'S COMMIT, MEASURED.
    //
    // Every mode's operational binding covers both, so every mode measures
    // both - which means every mode opens ONE read-only source session and
    // runs `git` against the reviewed checkout. That is stated in the output
    // rather than glossed: an inspection that says it opened no database
    // session has to be telling the truth after this.
    const sourceEndpoint = required(v, '--source-host')
    const measuredSource = await measureSourceIdentity(deps, sourceEndpoint)
    const implementation = await (deps.measureRepository ?? defaultMeasureRepository)(
      required(v, '--checkout'))

    const scope: ScopeInputs = {
      source: {
        host: sourceEndpoint,
        port: required(v, '--source-port'),
        database: required(v, '--source-database'),
      },
      sourceSystemIdentifier: measuredSource.systemIdentifier,
      evidenceRoot: required(v, '--evidence-root'),
      postRestorationPolicyPath: required(v, '--post-restoration-policy'),
      destinationPolicyPath: required(v, '--destination-policy'),
      implementationHead: implementation.head,
      launchd: {
        uid: String(process.getuid?.() ?? 0),
        agentsDir: required(v, '--agents-dir'),
        // WHICH `launchctl` IS NOT AN ARGUMENT. The adapter's own constant is
        // the only binary production reaches; what a suite injects instead is
        // the COMMAND RUNNER, which arrives through `deps` and can therefore
        // only be supplied by code, never by whoever is typing the command.
        ...(deps.commands === undefined ? {} : { commands: deps.commands }),
      },
      redis: resolveRedis({
        ...(v['--redis-credential'] === undefined
          ? {} : { credential: v['--redis-credential'] }),
        ...(v['--redis-host'] === undefined ? {} : { host: v['--redis-host'] }),
        ...(v['--redis-port'] === undefined ? {} : { port: v['--redis-port'] }),
        ...(v['--redis-db'] === undefined ? {} : { db: v['--redis-db'] }),
      }),
    }

    const binding = await deriveOperationalBinding(scope, deadlineMs)
    const operationalDigest = operationalBindingDigest(binding)

    // ----- INSPECT -----------------------------------------------------
    if (parsed.mode === '--inspect') {
      const forMode = required(v, '--for')
      if (forMode !== 'rehearse' && forMode !== 'apply') {
        throw new OpsRefused('--for must be rehearse or apply')
      }
      // THE APPLY INSPECTION BUILDS A REAL COPY BINDING, and does it BEFORE a
      // token is computed. An apply token over a null copy binding would bind
      // the operational world and leave what is being copied unnamed.
      let copyDigest: string | null = null
      let authorizationDigest: string
      if (forMode === 'apply') {
        // THE COMPLETE CHAIN, REVERIFIED FROM DISK. Refused here, before
        // anything is printed that an operator could mistake for authority.
        assertApplyAuthorized(v, binding)
        const fresh = await measuredCopyBinding(v, deps, sourceEndpoint)
        copyDigest = fresh.digest
        authorizationDigest = fileSha256(join(required(v, '--reviewed-rehearsal'), 'DIGEST'))
        say(`copy binding ${copyDigest}`)
        say(`bundle ${fresh.binding.bundleName}`)
      } else {
        authorizationDigest = createHash('sha256')
          .update(openReviewedContainer(required(v, '--rehearsal-authorization')).text)
          .digest('hex')
      }
      const runId = deps.newRunId()
      const stamp = deps.stamp()
      // EXACTLY ONE TOKEN, for the named mode. Printing both would be the
      // ambiguity the two prefixes exist to remove.
      const token = confirmationToken(executionBindingFor(
        forMode, operationalDigest, copyDigest, runId, stamp, authorizationDigest))
      say(`mode ${forMode}`)
      say(`operational adapter binding ${operationalDigest}`)
      say(`run ${runId} ${stamp}`)
      say(`confirmation ${token}`)
      // TRUTHFULLY, AND THE TWO MODES DIFFER.
      //
      // Both now measure the source identity, so neither can say it opened no
      // database session - that claim was true when the system identifier came
      // from argv and became false the moment it was measured. What an apply
      // inspection additionally opens is a TARGET identity session, and saying
      // so is the difference between "read-only" and "never connected".
      say('This inspection changed nothing.')
      if (forMode === 'apply') {
        say('It opened and closed TWO read-only sessions - one on the source and')
        say('one on the target - to measure their identities. It issued no write,')
        say('no target mutation and no copy.')
      } else {
        say('It opened and closed ONE read-only session on the source to measure')
        say('its identity. It opened no target session and issued no write.')
      }
      return { exitCode: EXIT_OK, lines }
    }

    // ----- APPLY (still refused) ---------------------------------------
    if (parsed.mode === '--apply') {
      // GATE-VERIFIED FIRST, THEN REFUSED - and the refusal is truthful about
      // what is missing.
      //
      // THE OLD SENTENCE WAS WRONG. It said the observed rehearsal had not been
      // run, in a branch that is only reached when a review PROVING one has
      // been run and its producers restored has just verified from disk. What
      // is actually out of scope in this milestone is the production apply
      // ITSELF: the copy against the live target. The chain is complete, the
      // token is computable, and the step that follows has not been authorized.
      const chain = assertApplyAuthorized(v, binding)
      const fresh = await measuredCopyBinding(v, deps, sourceEndpoint)
      say(`copy binding ${fresh.digest}`)
      say(`reviewed rehearsal ${chain.rehearsalName}`)
      say(`producer restoration ${chain.restorationName}`)
      say('REFUSED: the production apply is out of scope in this milestone.')
      say('The reviewed rehearsal and its restoration verify from disk, and the copy')
      say('binding recomputes - what has not been authorized is running the copy')
      say('against the live target.')
      // NOT "NO TARGET CONNECTION WAS OPENED". Building the copy binding opened
      // a read-only TARGET session to measure its identity, and closed it. The
      // honest claim is about what was DONE through that connection, which is
      // nothing: no write, no mutation, no copy.
      say('A read-only target identity session was opened and closed while the copy')
      say('binding was measured. No write, no target mutation and no production')
      say('copy occurred.')
      return { exitCode: EXIT_REFUSED, lines }
    }

    const modeInputs: ModeInputs = {
      v, scope, binding, operationalDigest, deps, deadlineMs, say,
    }
    if (parsed.mode === '--rehearse') {
      const r = await runRehearsal(modeInputs)
      return { exitCode: r.exitCode, lines: [...lines, ...r.lines] }
    }
    if (parsed.mode === '--verify-restoration') {
      const r = await runVerifyRestoration(modeInputs)
      return { exitCode: r.exitCode, lines: [...lines, ...r.lines] }
    }
    if (parsed.mode === '--review-rehearsal') {
      const r = await runReviewRehearsal(modeInputs)
      return { exitCode: r.exitCode, lines: [...lines, ...r.lines] }
    }
    throw new OpsRefused('the mode is not implemented in this milestone', parsed.mode)
  } catch (e) {
    // A BOUNDED REFUSAL IS A REFUSAL, WHICHEVER MODULE RAISED IT. Reporting a
    // mismatched confirmation or a producer that points somewhere undeclared as
    // `FAILED` would put "this command refuses to proceed" and "this command
    // broke" behind one exit status, and an operator reading a 1 cannot tell
    // which. Everything else stays `FAILED`, and says nothing about itself.
    const bounded = e instanceof OpsRefused || e instanceof BindingRefused ||
      e instanceof DestinationRefused || e instanceof LaunchdInspectionRefused ||
      e instanceof SecureFileRefused || e instanceof RedisConfigRefused ||
      e instanceof ReleaseGateRefused || e instanceof EvidenceRefused ||
      e instanceof LifecycleEvidenceFailed
    say(bounded ? `REFUSED: ${(e as Error).message}` : 'FAILED: the command did not complete')
    return { exitCode: bounded ? EXIT_REFUSED : EXIT_FAILED, lines }
  }
}

// ---------------------------------------------------------------------------
// PRODUCTION WIRING AND THE ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * A real source session, through the reviewed secret-safe psql backend.
 *
 * NO URL, NO PASSWORD, NO ENVIRONMENT. The host is a socket directory or a
 * hostname, the port and database are plain values, the role is a name, and the
 * only secret that can be involved is a PGPASSFILE PATH - which is checked as a
 * reviewed 0600 container before it is handed over, and whose CONTENTS are
 * never read here. `psql` takes SQL on stdin, so no statement reaches a process
 * list either.
 */
export async function openProductionSession(
  v: Readonly<Record<string, string>>, source: ReviewedSourceEndpoint,
  userOption = '--source-user', passfileOption = '--source-passfile',
): Promise<FenceLike> {
  const psqlPath = required(v, '--psql')
  const passfile = v[passfileOption]

  // METADATA ONLY, AND THE DESCRIPTOR IS PINNED ACROSS THE SPAWN.
  //
  // `openReviewedFileDescriptor` opens the file, `fstat`s the OPEN FD -
  // canonical path, no symlink, regular file, owned by this user, 0600, one
  // link - and never issues a read. An earlier revision called
  // `openReviewedContainer` here, which RETURNS THE BYTES, while a comment
  // claimed the contents were not read; the password was in this process's
  // memory by the time that comment was reached.
  //
  // AND VALIDATING A PATHNAME IS NOT ENOUGH. Everything proved was proved
  // about the file that WAS there; psql then opens whatever is at that name
  // when it starts, and anyone who can write the directory can swap it in
  // between. The validated DESCRIPTOR is inherited by the child instead and
  // named to it as `/dev/fd/3`, so the file that was checked and the file that
  // is authenticated with are the same object.
  //
  // PSQL ITSELF READS IT. That is unavoidable and correct: PGPASSFILE exists
  // so the password reaches libpq without passing through an argument list, an
  // environment variable or this program.
  const held = passfile === undefined || passfile === ''
    ? null : openReviewedFileDescriptor(passfile)
  try {
    const backend = await openPsqlBackend({
      psqlPath,
      host: source.host,
      port: Number(source.port),
      database: source.database,
      user: required(v, userOption),
      ...(held === null ? {} : { passfileFd: held.fd }),
    })
    return {
      send: async (sql: string) => await backend.send(sql),
      close: async () => { await backend.close() },
    }
  } finally {
    // CLOSED ONLY AFTER THE CHILD HAS IT. `spawn` dups the descriptor into the
    // child before it returns, so the child's copy is independent and already
    // acquired by the time this runs - on the success path and on every
    // failure path alike.
    if (held !== null) held.close()
  }
}

/** The dependencies a real invocation runs with. Nothing here is a stub. */
export function productionDeps(
  v: Readonly<Record<string, string>>, source: ReviewedSourceEndpoint,
): OpsDeps {
  return {
    newRunId,
    stamp: () => evidenceStamp(new Date()),
    openSupervisor: async () => await openProductionSession(v, source),
    openProver: async () => await openProductionSession(v, source),
    // THE REVIEWED ACQUISITION, and it refuses a backend whose start it cannot
    // read rather than continuing on a pid that may be recycled.
    // READ-ONLY IDENTITY SESSIONS. Opened for five catalogue questions and
    // closed; they take no fence and hold nothing.
    openSourceIdentity: async () => await openProductionSession(v, source),
    openTargetIdentity: async () => await openProductionSession(v, {
      host: required(v, '--target-host'),
      port: required(v, '--target-port'),
      database: required(v, '--target-database'),
    }, '--target-user', '--target-passfile'),
    acquireFence: async (s: FenceLike) => {
      const fence = await acquireSourceFence(s as unknown as FenceExecutor)
      return {
        supervisorPid: fence.supervisorPid,
        backendStart: fence.backendStart,
        mechanism: fence.mechanism as 'S3',
      }
    },
  }
}

/**
 * THE ENTRY POINT, and it is GUARDED.
 *
 * Importing this module - which every test does, for `parseArgs`, `HOLD_ACTIONS`
 * and the mode functions - must start nothing, open nothing and exit nothing.
 * The guard compares the resolved path of this file with the script node was
 * actually asked to run, so the difference between "imported" and "invoked" is
 * a fact about the process rather than a convention.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (e) {
    process.stdout.write(`REFUSED: ${e instanceof Error ? e.message : 'bad arguments'}\n`)
    return EXIT_REFUSED
  }
  const v = parsed.values
  const source: ReviewedSourceEndpoint = {
    host: v['--source-host'] ?? '',
    port: v['--source-port'] ?? '',
    database: v['--source-database'] ?? '',
  }
  const result = await runOpsCli(argv, productionDeps(v, source))
  for (const line of result.lines) process.stdout.write(`${line}\n`)
  return result.exitCode
}

/** True only when node was asked to run THIS file. */
export function isEntryPoint(argv1: string | undefined, here: string): boolean {
  if (argv1 === undefined) return false
  try {
    return realpathSync(argv1) === realpathSync(here)
  } catch {
    return false
  }
}

if (isEntryPoint(process.argv[1], fileURLToPath(import.meta.url))) {
  // EXIT CODE, NOT `process.exit` MID-FLIGHT. The command's own result decides
  // it, and the process ends only after every line has been written.
  process.exitCode = await main(process.argv.slice(2))
}
