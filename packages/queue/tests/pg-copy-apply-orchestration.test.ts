// K7-B6: the one-process continuous-fence apply, exercised end to end with the
// reviewed core injected. Every property here is about IDENTITY and ORDER -
// which session, which fence object, which channel, in what sequence - because
// those are the things a live run cannot be asked to demonstrate safely.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import {
  EXIT_ACTION_REQUIRED, EXIT_REFUSED, OpsRefused,
  REVIEWED_EXPECTED_TARGET_LABEL, REVIEWED_SOURCE_LABEL,
  HELD_SIGNALS, HOLD_ACTIONS, applyOperatorInput, awaitCopyConfirmation,
  holdForIntervention,
  holdStateOf, holdStateOfRelease, operatorChannel,
  processHold, resolutionToken, runProductionApply, verifyPublishedStage1,
  type ApplyOrchestration, type CliResult, type HoldDecision, type HoldFenceState,
  type HoldOutcome, type InterventionHold, type OperatorChannel, type PriorBundle,
} from '../bin/pg-copy-ops.js'
import {
  LifecycleInterventionRequired, LifecyclePreCommitCleanupRequired, LifecycleRefused,
  assertOperatorInput, isInterventionRequired, isVerifiedBundle,
  type AcquiredFence, type LifecycleInput, type ReleaseResult,
  type OperationalAdapterBinding,
  type ProducerIdentity, type PublishedEvidence, type PublishedManifest,
  type DestinationCensusAdapter, type QueueAdapter, type QuiescenceAdapter,
  type StableInstallation,
  type SourceStageInput, type Stage1Input,
} from '@common/db/pg-copy'
import { fileDigestOf, stage1Bundle, strip, world, type World } from './support/ops-world.js'
import { resolveRedis } from '../src/pg-copy-ops/redis-config.js'

/**
 * An `EvidenceState`.
 *
 * K7-B6.3 B: `digestFileDigest` is now part of it, non-null IF AND ONLY IF
 * `verified`, carried from the publisher. A verified publication with no
 * digest is a state the production code must refuse to LINK, so this helper
 * can build that case too.
 */
const findings = (publishedPath: string | null) => ({
  attempted: true as const, note: null, publication: null,
  evidencePhase: null, evidenceReason: null,
  finalPath: publishedPath, finalPathState: null,
  temporaryPath: null, temporaryPathState: null,
})

/**
 * A publication that verified, and therefore carries a digest.
 *
 * TYPED STRUCTURALLY, not by an imported name: `VerifiedEvidenceState` is not
 * re-exported from `@common/db/pg-copy`, and adding it there is outside what
 * this correction is permitted to change. The `as const` discriminants are
 * what make these assignable to the reviewed union at the call site, so a
 * wrong shape is still a compile error where it is used.
 */
const verifiedPub = (publishedPath: string, digestFileDigest = 'f'.repeat(64)) => ({
  ...findings(publishedPath), verified: true as const, publishedPath, digestFileDigest,
})

/** A publication that did not verify. `digestFileDigest` is null BY TYPE. */
const unverifiedPub = (publishedPath: string | null) => ({
  ...findings(publishedPath), verified: false as const, publishedPath,
  digestFileDigest: null,
})

/**
 * THE STATE THE DISCRIMINATED UNION MAKES UNREPRESENTABLE: `verified: true`
 * with a digest that is not a reviewed one.
 *
 * ONE CAST, IN A TEST, ON PURPOSE. `EvidenceState` is now a union precisely so
 * production cannot build this, and the queue's own 64-hex check is a
 * CROSS-PACKAGE boundary guard on data that arrives inside an exception - the
 * kind of thing a future or foreign producer could still get wrong. Modelling
 * that requires stepping outside the type once, here, and nowhere else.
 */
const verifiedWithBadDigest = (
  publishedPath: string, digestFileDigest: string | null,
) => ({
  ...findings(publishedPath), verified: true as const, publishedPath,
  digestFileDigest: digestFileDigest as string,
})

/** Distinct digests, so a swapped or blanked link cannot pass. */
const GATE_DIGEST = 'a1b2c3d4'.repeat(8)
const OUTCOME_DIGEST = '9f8e7d6c'.repeat(8)

const TOKEN = `PGCOPY-COPY-${'a'.repeat(64)}`
/** The ONE bundle Stage 1 publishes. Which bundle is the property under test. */
const PUBLISHED_NAME = 'source-manifest-20260930T000000Z-aabbccdd'
const PUBLISHED_DIGEST = 'd'.repeat(64)
/** A bundle from some earlier process. Nothing may read or bind to it. */
const STALE_NAME = 'source-manifest-20260101T000000Z-99999999'
/**
 * A COMPLETE `CopyBinding` and `Stage1Authority`.
 *
 * Four fields of twenty and an empty object used to stand in for these, which
 * type-checked only because the whole fixture was cast through
 * `as unknown as ApplyOrchestration`. Removing that cast is what surfaced them.
 */
const COPY_BINDING = Object.freeze({
  bindingShapeVersion: 1,
  bundleName: 'source-manifest-20260930T000000Z-aabbccdd',
  digestFileDigest: 'd'.repeat(64),
  sourceDatabase: 'ai_capital',
  sourceSystemIdentifier: '7',
  sourceExportRole: 'ai_capital_v3_export',
  sourceContractDigest: 'a'.repeat(64),
  contentRootDigest: 'b'.repeat(64),
  copySetDigest: 'e'.repeat(64),
  provenanceHead: 'f'.repeat(40),
  ingestionGitlink: 'e'.repeat(40),
  reviewedTargetContractDigest: '9'.repeat(64),
  targetDatabase: 'ai_capital_v3',
  targetSystemIdentifier: '9',
  targetPort: '5433',
  targetRequestedEndpoint: '127.0.0.1',
  targetServerAddress: null,
  targetUnixTransport: true,
  targetRole: 'ai_capital_owner',
  targetSessionUser: 'ai_capital_owner',
})

const STAGE1_AUTHORITY = Object.freeze({
  // K7-B7.1: the run identity the copy chain reads out of the manifest.
  runId: 'aabbccdd',
  generatedAtUtc: '2026-09-30T00:00:00Z',
  bundleName: 'source-manifest-20260930T000000Z-aabbccdd',
  digestFileDigest: 'd'.repeat(64),
  systemIdentifier: '7',
  database: 'ai_capital',
  currentUser: 'ai_capital_v3_export',
  sessionUser: 'ai_capital_v3_export',
  contentRootDigest: 'b'.repeat(64),
  sourceContractDigest: 'a'.repeat(64),
  copySet: ['briefing.predictions'] as readonly string[],
  provenanceHead: 'f'.repeat(40),
  ingestionGitlink: 'e'.repeat(40),
})

const OPERATIONAL_BINDING: OperationalAdapterBinding = Object.freeze({
  sourceEndpoint: '/tmp/s',
  sourceDatabase: 'ai_capital',
  sourceSystemIdentifier: '7',
  producers: [] as readonly ProducerIdentity[],
  queues: ['daily'] as readonly string[],
  blockingStates: ['active', 'waiting'] as readonly string[],
  pausedIsBlocking: true,
  producerAuthority: 'manual-stop',
  producerProcessPolicy: [] as readonly { label: string; pattern: string }[],
  structuredWorkerInstallation: 'absent' as StableInstallation,
  redisHost: '127.0.0.1',
  redisPort: '6379',
  redisDatabase: '0',
  evidenceRoot: '/e',
  evidenceRootDeviceInode: '1:2',
  postRestorationPolicyPath: '/e/post-restoration-policy.json',
  postRestorationPolicySha256: '0'.repeat(64),
  implementationHead: 'f'.repeat(40),
})

/** What the injected verifier returns. Identity is the property under test. */
const VERIFIED_MANIFEST = Object.freeze({
  bundleName: PUBLISHED_NAME,
  digestFileDigest: PUBLISHED_DIGEST,
  document: {} as Record<string, never>,
  contract: { digest: 'c'.repeat(64), text: '{}' } as never,
})
/** The one fence object Stage 1 returns; identity is the property under test. */
const FENCE: AcquiredFence = Object.freeze({
  supervisorPid: '41512',
  backendStart: '2026-09-30 10:00:00.000000-07',
  mechanism: 'S3',
  // THE REST OF THE REVIEWED SHAPE. Three fields of seven used to be enough
  // because the whole orchestration input was cast through `as never`.
  tables: ['briefing.predictions'] as readonly string[],
  sequences: ['briefing.predictions_id_seq'] as readonly string[],
  candidateInputs: {},
  statements: ['SELECT pg_catalog.pg_advisory_xact_lock(1)'] as readonly string[],
})

const session = (tag: string, log: string[]) => ({
  tag, pid: '1', client: {} as never,
  rows: async (sql: string) => { log.push(`${tag}:${sql.slice(0, 12)}`); return [] as string[][] },
  command: async () => ({ rows: [] as string[][], tag: 'SELECT 0' }),
  end: async () => { log.push(`${tag}:end`) },
  alive: () => true,
})

/**
 * A supervisor/prover stub that can NAME AND DATE THE BACKEND.
 *
 * Needed because a hold entered after Stage 1 threw has no
 * `stage1Result.fence` and must measure the supervisor's own identity instead.
 * A stub that answered nothing modelled a database that will not answer, which
 * the production code correctly refuses - so it could never reach the hold.
 */
/** The prover is a DIFFERENT backend. A self-proof is refused, correctly. */
const PROVER_PID = '41513'

const backend = (tag: string, log: string[], pid: string) => ({
  tag,
  // K7-B6.1 F: the reviewed `FenceLike` now declares the capabilities the real
  // `PsqlBackend` always had - `pid`, `rows`, `alive` - because the production
  // path used to satisfy `SupervisorSession` by casting instead.
  pid,
  send: async (sql: string) => {
    if (sql.includes('pg_backend_pid')) return { rows: [[pid]] as string[][], error: null }
    if (sql.includes('backend_start')) {
      return { rows: [[FENCE.backendStart]] as string[][], error: null }
    }
    return { rows: [] as string[][], error: null }
  },
  rows: async () => [] as string[][],
  close: async () => { log.push(`${tag}:close`) },
  alive: () => true,
})

interface Harness {
  readonly root: string
  readonly log: string[]
  readonly channel: OperatorChannel
  readonly input: ApplyOrchestration
  readonly calls: Record<string, number>
  readonly seen: Record<string, unknown>
}

const harness = (over: Record<string, unknown> = {}): Harness => {
  const log: string[] = []
  const lines: string[] = []
  const calls = { stage1: 0, inspect: 0, lifecycle: 0, confirm: 0, release: 0, channels: 0 }
  const seen: Record<string, unknown> = {}
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b6-')))
  const cred = (n: string, u: string, h: string, port: string, db: string): string => {
    const p = join(root, n)
    writeFileSync(p, `postgresql://${u}:pw@${h}:${port}/${db}`, { mode: 0o600 })
    return p
  }
  let armedOnce = false
  let releasedOnce = false
  let closedOnce = false
  const releaseLease = (): void => {
    if (releasedOnce) return
    releasedOnce = true
    log.push('disarm')
  }
  const channel: OperatorChannel = {
    preflight: () => { log.push('preflight') },
    // MIRRORS THE REVIEWED LEASE: one installation, and a disarm that does
    // its work once however often it is called. The REAL channel's version of
    // this is proved separately against `process.listenerCount`.
    arm: () => {
      if (armedOnce) return releaseLease
      armedOnce = true
      log.push('arm')
      return releaseLease
    },
    nextLine: async () => '',
    close: () => {
      if (closedOnce) return
      closedOnce = true
      log.push('channel:close')
    },
  }
  const handles: Array<{ tag: string }> = []
  const authority = {
    openStage1ExportSource: async () => { log.push('open:stage1-export(silent)'); const s = session('s1', log); handles.push(s); return s },
    openStage2Source: async () => { log.push('open:stage2-source'); const s = session('s2src', log); handles.push(s); return s },
    openStage2Target: async () => { log.push('open:stage2-target'); const s = session('s2tgt', log); handles.push(s); return s },
    openVerifierSource: async () => { log.push('open:verify-source'); const s = session('vsrc', log); handles.push(s); return s },
    openVerifierTarget: async () => { log.push('open:verify-target'); const s = session('vtgt', log); handles.push(s); return s },
  }
  const sup = backend('supervisor', log, FENCE.supervisorPid)
  seen.supervisorStub = sup
  const prv = backend('prover', log, PROVER_PID)
  const deps = {
    newRunId: () => 'aabbccdd', stamp: () => '20260930T000000Z',
    openSupervisor: async () => { calls.channels += 0; log.push('open:supervisor'); return sup },
    openProver: async () => { log.push('open:prover'); return prv },
    openSourceIdentity: async () => { log.push('identity:source'); return sup },
    openTargetIdentity: async () => { log.push('identity:target'); return sup },
    measureRepository: async () => ({ head: 'f'.repeat(40), ingestionGitlink: 'e'.repeat(40) }),
    measureFenceIdentity: async () => { log.push('measureFenceIdentity'); return FENCE },
    authority: (inputs: unknown) => { seen.authorityInputs = inputs; return authority },
    // REAL PARAMETER TYPES. With the production casts gone these seams carry
    // the reviewed input types, so a fixture cannot be handed - or hand back -
    // something the production call would not accept.
    stage1: async (i: Stage1Input) => {
      calls.stage1 += 1
      seen.stage1Supervisor = i.supervisor; seen.stage1Prover = i.prover
      seen.stage1Export = i.exportSession
      seen.stage1Operator = i.operator
      log.push('runStage1')
      // A REAL `PublishedEvidence` - which is exactly the object that cannot
      // stand in for a `PublishedManifest`, and the point of Phase C.
      const published: PublishedEvidence = {
        finalPath: join(root, PUBLISHED_NAME),
        temporaryPath: join(root, `.tmp-${PUBLISHED_NAME}`),
        files: ['manifest.json', 'source-contract.json', 'DIGEST'],
        digestFileDigest: PUBLISHED_DIGEST,
      }
      seen.stage1Published = published
      return { fence: FENCE, published }
    },
    inspect: async (i: SourceStageInput, published: PublishedManifest) => {
      calls.inspect += 1
      seen.inspectFence = i.preAcquiredFence; seen.inspectSupervisor = i.supervisor
      seen.inspectSource = i.source
      seen.inspectPublished = published
      log.push('runInspect')
      return { confirmation: TOKEN }
    },
    lifecycle: async (i: LifecycleInput) => {
      calls.lifecycle += 1
      seen.lifecycleFence = i.preAcquiredFence; seen.lifecycleSupervisor = i.supervisor
      seen.lifecycleProver = i.prover
      seen.lifecycleBundleDir = i.bundleDir
      seen.lifecycleDestinations = i.destinations
      seen.lifecycleTargetExpectation = i.targetExpectation
      log.push('runLifecycle')
      // Open the sessions the lifecycle owns, so their freshness is observable.
      await i.openStageTarget()
      await i.openVerifyTarget()
      return {
        outcome: 'COPY_VERIFIED_AWAITING_MANUAL_RESTORATION' as const,
        fence: 'released' as const,
        verifierBundle: 'verification-x', releaseGateBundle: 'release-gate-x',
        lifecycleBundle: 'copy-lifecycle-x',
      }
    },
    confirm: async (c: OperatorChannel, t: string) => {
      calls.confirm += 1; seen.confirmChannel = c; seen.confirmToken = t
      log.push('awaitCopyConfirmation')
      return { operator: 'thanapold', token: t }
    },
    releaseAndProve: async () => { calls.release += 1; log.push('rollbackAndProveReleased'); return { state: 'released' as const, remainingLocks: 0 } },
    hold: {
      arm: () => () => undefined,
      // A REVIEWED ACTION. 'RELEASE' is not one of them, and only survived
      // because the whole fixture was cast through `as unknown as`.
      decide: async () => ({ action: 'CENSUS_ONLY' as const, operator: 'x', token: 't' }),
    },
    // The chain and binding checks are exercised by their own suites; here they
    // are satisfied so the ORDER and IDENTITY properties past the gate can be
    // reached at all. Production binds both to the real functions.
    // A COMPLETE VerifiedChain. Two of seven fields used to be supplied and
    // the rest were hidden by the fixture's `as unknown as` cast.
    authorize: () => ({
      bindingDigest: 'b'.repeat(64),
      rehearsalPath: '/e/operational-rehearsal-x', rehearsalName: 'operational-rehearsal-x',
      rehearsalDigest: 'r'.repeat(64),
      restorationPath: '/e/producer-restoration-x', restorationName: 'producer-restoration-x',
      restorationDigest: 's'.repeat(64),
    }),
    // THE VERIFIER, INJECTED. This harness is about ORDER and IDENTITY and
    // publishes no real bundle; the REAL verifier and the real `runInspect`
    // boundary are exercised in the production-shape suite below, which
    // publishes one and proves a raw `PublishedEvidence` is refused.
    verifyPublished: (bundleDir: string) => {
      seen.verifiedPath = bundleDir
      log.push('verifyPublished')
      return VERIFIED_MANIFEST
    },
    copyBinding: async (published: PublishedManifest) => {
      // RECORDED, so a test can prove WHICH bundle the binding was built from.
      seen.bindingManifest = published
      log.push('copyBinding')
      return { digest: 'c'.repeat(64), binding: COPY_BINDING, stage1: STAGE1_AUTHORITY }
    },
    // THE ADAPTERS THE ORCHESTRATION PASSES STRAIGHT THROUGH. Declared with
    // the reviewed shapes rather than `{} as never`, so a fixture cannot hand
    // the lifecycle something the production call would refuse.
    quiescence: {
      report: async () => [],
      assert: async () => undefined,
    } as unknown as QuiescenceAdapter,
    queue: { sample: async () => ({ counts: {}, paused: [] }) } as unknown as QueueAdapter,
    destinations: { measure: async () => [] } as unknown as DestinationCensusAdapter,
    ...over,
  }
  const input = {
    v: {
      '--source-host': '127.0.0.1', '--source-port': '5432', '--source-database': 'ai_capital',
      '--target-host': '127.0.0.1', '--checkout': '/x', '--evidence-root': root,
      '--export-driver-credential': cred('e.url', 'ai_capital_v3_export', '127.0.0.1', '5432', 'ai_capital'),
      '--target-driver-credential': cred('t.url', 'ai_capital_owner', '127.0.0.1', '5433', 'ai_capital_v3'),
      '--reviewed-rehearsal': 'x', '--operational-rehearsal-bundle': 'y',
      '--producer-restoration-bundle': 'z',
    },
    deps,
    // A COMPLETE `ScopeInputs`. Three fields of eight used to be supplied.
    scope: {
      source: {
        host: '/tmp/s', port: '5432', database: 'ai_capital', label: 'ai-capital',
      },
      sourceSystemIdentifier: '7',
      evidenceRoot: root,
      postRestorationPolicyPath: join(root, 'post-restoration-policy.json'),
      destinationPolicyPath: join(root, 'destination-policy.json'),
      implementationHead: 'f'.repeat(40),
      launchd: { uid: '501', agentsDir: join(root, 'agents') },
      redis: resolveRedis({ host: '127.0.0.1', port: '6379', db: '0' }),
    },
    // BOTH: a truncated marker in the ordering log, and the FULL line in the
    // result's `lines`, which is what production returns to the operator.
    say: (l: string) => { log.push(`say:${l.slice(0, 24)}`); lines.push(l) }, lines,
    channel, sourceEndpoint: '127.0.0.1',
    // K7-B6.1 Phase C: a COMPLETE measured identity and provenance, because
    // the orchestration now builds a real `OperatorInput` and passes it
    // through `assertOperatorInput`. The old two-field fixtures were accepted
    // only because the production code cast the record.
    measuredSource: {
      systemIdentifier: '7', database: 'ai_capital', currentUser: 'ai_capital_v3_export',
      sessionUser: 'ai_capital_v3_export', port: '5432', serverAddress: null,
      unixTransport: true, requestedEndpoint: '/tmp/s',
    },
    implementation: { head: 'f'.repeat(40), ingestionGitlink: 'e'.repeat(40) },
    // A COMPLETE `OperationalAdapterBinding`. One field of eighteen used to
    // stand in for it. `assertApplyAuthorized` takes the whole binding, so
    // this is genuinely required rather than an over-wide interface.
    binding: OPERATIONAL_BINDING,
    operationalDigest: 'o', observationDigest: 'b',
    deadlineMs: 1000,
  }
  return { log, channel, input, calls, seen, root }
}

describe('K7-B6: the reviewed order', () => {
  it('calls Stage 1, inspect, confirmation and lifecycle exactly once, in order', async () => {
    const h = harness()
    const r = await runProductionApply(h.input)
    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED)
    expect(h.calls).toMatchObject({ stage1: 1, inspect: 1, lifecycle: 1, confirm: 1 })
    const order = h.log.filter(l =>
      ['preflight', 'arm', 'runStage1', 'runInspect', 'awaitCopyConfirmation', 'runLifecycle'].includes(l))
    expect(order).toEqual(
      ['arm', 'runStage1', 'runInspect', 'awaitCopyConfirmation', 'runLifecycle'])
  })
})

describe('K7-B6: identity across the continuous fence', () => {
  it('passes the EXACT Stage-1 fence object to inspect and lifecycle', async () => {
    const h = harness()
    await runProductionApply(h.input)
    expect(h.seen.inspectFence).toBe(FENCE)
    expect(h.seen.lifecycleFence).toBe(FENCE)
  })

  it('gives every stage the SAME supervisor, and a distinct reused prover', async () => {
    const h = harness()
    await runProductionApply(h.input)
    expect(h.seen.inspectSupervisor).toBe(h.seen.stage1Supervisor)
    expect(h.seen.lifecycleSupervisor).toBe(h.seen.stage1Supervisor)
    expect(h.seen.lifecycleProver).toBe(h.seen.stage1Prover)
    expect(h.seen.stage1Prover).not.toBe(h.seen.stage1Supervisor)
    // ONE supervisor and ONE prover for the whole copy.
    expect(h.log.filter(l => l === 'open:supervisor')).toHaveLength(1)
    expect(h.log.filter(l => l === 'open:prover')).toHaveLength(1)
  })

  it('opens exactly one supervisor even though three stages use it', async () => {
    const h = harness()
    await runProductionApply(h.input)
    expect(h.log.filter(l => l === 'open:supervisor')).toHaveLength(1)
  })

  it('hands Stage 1 the SILENT export session, and closes only that session', async () => {
    const h = harness()
    await runProductionApply(h.input)
    expect(h.log).toContain('open:stage1-export(silent)')
    // Its own handle ends; the supervisor does not close here.
    const s1end = h.log.indexOf('s1:end')
    const supClose = h.log.indexOf('supervisor:close')
    expect(s1end).toBeGreaterThan(-1)
    expect(s1end).toBeLessThan(supClose)
  })

  it('rolls back AND closes the inspection source before the confirmation wait', async () => {
    const h = harness()
    await runProductionApply(h.input)
    const rollback = h.log.findIndex(l => l.startsWith('s2src:ROLLBACK'))
    const close = h.log.indexOf('s2src:end')
    const wait = h.log.indexOf('awaitCopyConfirmation')
    expect(rollback).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(rollback)
    expect(close).toBeLessThan(wait)
  })

  it('uses the EXACT preflighted channel for the confirmation', async () => {
    const h = harness()
    await runProductionApply(h.input)
    expect(h.seen.confirmChannel).toBe(h.channel)
    expect(h.seen.confirmToken).toBe(TOKEN)
  })

  it('closes PROVER before SUPERVISOR, and the channel last', async () => {
    const h = harness()
    await runProductionApply(h.input)
    const p = h.log.indexOf('prover:close')
    const s = h.log.indexOf('supervisor:close')
    const d = h.log.indexOf('disarm')
    const c = h.log.indexOf('channel:close')
    expect(p).toBeGreaterThan(-1)
    expect(p).toBeLessThan(s)
    expect(s).toBeLessThan(d)
    expect(d).toBeLessThan(c)
  })

  it('the lifecycle opens FRESH Stage-2 and verifier target sessions', async () => {
    const h = harness()
    await runProductionApply(h.input)
    expect(h.log).toContain('open:stage2-target')
    expect(h.log).toContain('open:verify-target')
  })

  it('exits 4, never 0, on the manual-stop outcome', async () => {
    const h = harness()
    const r = await runProductionApply(h.input)
    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED)
    expect(r.exitCode).not.toBe(0)
  })
})

describe('K7-B6: wrong confirmation takes the pre-COMMIT release path', () => {
  const refusing = {
    confirm: async () => { throw new Error('the reply does not carry this run\'s copy confirmation') },
  }

  it('opens NO target session and releases exactly once', async () => {
    const h = harness(refusing)
    const r = await runProductionApply(h.input)
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(h.calls.lifecycle).toBe(0)
    expect(h.log).not.toContain('open:stage2-target')
    expect(h.calls.release).toBe(1)
  })

  it('closes prover before supervisor once release is PROVED', async () => {
    const h = harness(refusing)
    await runProductionApply(h.input)
    expect(h.log.indexOf('prover:close')).toBeLessThan(h.log.indexOf('supervisor:close'))
  })

  it('an UNPROVED release does NOT close the supervisor and reaches intervention', async () => {
    // BOUNDED ON PURPOSE. A real hold loops until an operator resolves it - a
    // test that entered one would never return, which is exactly what happened
    // the first time this case was written. The injected hold refuses
    // immediately, so the assertion is about what had NOT been closed by the
    // time the hold was reached.
    let reachedHold = false
    // Held in a FIELD, not a `let`: a variable assigned only inside a callback
    // is narrowed to `null` at the read site, and `seenHold?.fenceState` then
    // types as `never` - an assertion that cannot fail is not an assertion.
    const observed: { hold: { reason: string; fenceState: string } | null } = { hold: null }
    const h = harness({
      ...refusing,
      releaseAndProve: async () => ({ state: 'release-unknown' as const, remainingLocks: null }),
      // The ENTRY is injected, not the decision: `holdForIntervention` is a
      // deliberate for(;;) and a test that entered it would never return.
      enterHold: async (h: { reason: string; fenceState: string }) => {
        reachedHold = true
        observed.hold = h
        return { exitCode: 1, lines: [] }
      },
    })
    await runProductionApply(h.input).catch(() => undefined)
    expect(reachedHold).toBe(true)
    // AND IT WAS TOLD THE EXACT STATE THE RELEASE ATTEMPT ESTABLISHED.
    // K7-B6.3 C: `release-unknown` is no longer flattened to `unproved`.
    expect(observed.hold?.fenceState).toBe('release-unknown')
    // The fence may still be held, so nothing was closed and no second channel
    // was built.
    expect(h.log).not.toContain('supervisor:close')
    expect(h.log).not.toContain('prover:close')
    expect(h.log).not.toContain('channel:close')

  })
})

// ---------------------------------------------------------------------------
// K7-B6.1 PHASE B — THE APPLY BINDS TO THE BUNDLE IT CREATED
// ---------------------------------------------------------------------------

describe('K7-B6.1 B: one process, one bundle', () => {
  it('succeeds with NO --bundle-dir at all', async () => {
    const h = harness()
    expect(h.input.v['--bundle-dir']).toBeUndefined()
    const r = await runProductionApply(h.input)
    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED)
  })

  it('REFUSES a --bundle-dir, rather than quietly preferring one', async () => {
    // A pre-existing bundle is exactly what broke the chain: the token and the
    // target expectation came from it while the lifecycle consumed the newly
    // published one. Ignoring the option would leave an operator believing the
    // copy they named is the copy being made.
    const h = harness()
    const input = { ...h.input, v: { ...h.input.v, '--bundle-dir': '/some/older/bundle' } }
    await expect(runProductionApply(input as ApplyOrchestration))
      .rejects.toThrow(/creates its own Stage-1 bundle and accepts no --bundle-dir/)
    // AND IT REFUSED BEFORE TAKING ANYTHING. No supervisor, no fence, no arm.
    expect(h.log).not.toContain('open:supervisor')
    expect(h.log).not.toContain('arm')
    expect(h.calls.stage1).toBe(0)
  })

  it('binds and runs the lifecycle against the EXACT published finalPath', async () => {
    const h = harness()
    await runProductionApply(h.input)
    const published = join(h.root, PUBLISHED_NAME)
    // THE VERIFIER WAS POINTED AT THAT DIRECTORY, and no other.
    expect(h.seen.verifiedPath).toBe(published)
    // THE BINDING WAS BUILT FROM THE VERIFIER'S OWN OBJECT - by identity, so
    // a second read or a look-alike literal would not satisfy this.
    expect(h.seen.bindingManifest).toBe(VERIFIED_MANIFEST)
    // AND INSPECT RECEIVED THE SAME VERIFIED OBJECT, not Stage 1's
    // `PublishedEvidence`, which carries no document or contract at all.
    expect(h.seen.inspectPublished).toBe(VERIFIED_MANIFEST)
    expect(h.seen.inspectPublished).not.toBe(h.seen.stage1Published)
    // AND THE LIFECYCLE RE-READS THE SAME FINAL DIRECTORY ITSELF.
    expect(h.seen.lifecycleBundleDir).toBe(published)
  })

  it('a stale bundle influences NOTHING - not the binding, not the lifecycle', async () => {
    const h = harness()
    await runProductionApply(h.input)
    const everything = [
      String(h.seen.verifiedPath), String(h.seen.lifecycleBundleDir),
      ...h.log,
    ].join('\n')
    expect(everything).not.toContain(STALE_NAME)
    expect(everything).toContain(PUBLISHED_NAME)
  })

  it('STAGE 1 RUNS BEFORE the binding measures any identity', async () => {
    const h = harness()
    await runProductionApply(h.input)
    // The binding is what opens the source and target identity sessions (its
    // own suite proves that); here the ORDER is the property. A binding
    // measured first is a binding that cannot describe the bundle Stage 1 is
    // about to publish.
    expect(h.log.indexOf('runStage1')).toBeGreaterThanOrEqual(0)
    expect(h.log.indexOf('runStage1')).toBeLessThan(h.log.indexOf('copyBinding'))
  })

  it('opens NO target session until the publication exists', async () => {
    // STRUCTURAL, not ordering-by-convention. The authority holds the target
    // expectation as a thunk; before Stage 1 publishes there is nothing for it
    // to return, so it refuses and no credential is read and no connection
    // attempted.
    const h = harness()
    const inputs = h.seen.authorityInputs as { target: () => unknown } | undefined
    expect(inputs).toBeUndefined()
    // Build the authority by starting a run that fails at Stage 1, so the
    // thunk is captured while no publication has happened.
    const failing = harness({
      stage1: async () => { throw new Error('stage 1 refused') },
      releaseAndProve: async () => ({ state: 'released' as const, remainingLocks: 0 }),
    })
    await runProductionApply(failing.input)
    const captured = failing.seen.authorityInputs as { target: () => unknown }
    expect(typeof captured.target).toBe('function')
    expect(() => captured.target())
      .toThrow(/no Stage-2 or verifier target session may open/)
  })

  it('the target expectation comes ONLY from the new bundle\'s binding', async () => {
    const h = harness()
    await runProductionApply(h.input)
    const captured = h.seen.authorityInputs as { target: () => Record<string, string> }
    // AFTER the run the thunk resolves, and every field traces to the binding
    // the harness returned for the published bundle - not to argv.
    expect(captured.target()).toEqual({
      host: '127.0.0.1', port: '5433',
      database: 'ai_capital_v3', role: 'ai_capital_owner',
    })
  })
})

// ---------------------------------------------------------------------------
// K7-B6.1 PHASE C — A COMPLETE, VALIDATED OPERATOR INPUT
// ---------------------------------------------------------------------------

type OperatorArgs = Parameters<typeof applyOperatorInput>[0]

/**
 * NOT `Object.freeze` WITH INFERRED LITERALS. Frozen literal types made every
 * refusal case below a compile error rather than a test - and because `tsx`
 * does not typecheck, the suite ran green while the fixture was not actually a
 * `MeasuredIdentity` at all. Typed explicitly so an override is legal and a
 * WRONG override is caught.
 */
const OPERATOR_ARGS: OperatorArgs = {
  runId: 'aabbccdd',
  stamp: '20260930T000000Z',
  provenance: { head: 'f'.repeat(40), ingestionGitlink: 'e'.repeat(40) },
  measuredSource: {
    systemIdentifier: '7689229024919775231', database: 'ai_capital',
    currentUser: 'ai_capital_v3_export', sessionUser: 'ai_capital_v3_export',
    port: '5432', serverAddress: null, unixTransport: true,
    requestedEndpoint: '/tmp/s',
  },
  requestedEndpoint: '/tmp/s',
  sourcePort: '5432',
  sourceDatabase: 'ai_capital',
}

describe('K7-B6.1 C: the operator input is complete and proved', () => {
  it('passes the REAL assertOperatorInput, with every field populated', () => {
    const o = applyOperatorInput(OPERATOR_ARGS)
    // THE VALIDATOR ACCEPTED IT. That is the property; the fields below say
    // where each value came from.
    expect(assertOperatorInput(o)).toBe(o)
    expect(o).toEqual({
      runId: 'aabbccdd',
      generatedAtUtc: '2026-09-30T00:00:00Z',
      implementationHead: 'f'.repeat(40),
      provenanceHead: 'f'.repeat(40),
      ingestionGitlink: 'e'.repeat(40),
      expectedTargetLabel: REVIEWED_EXPECTED_TARGET_LABEL,
      expectedSystemIdentifier: '7689229024919775231',
      sourceLabel: REVIEWED_SOURCE_LABEL,
      requestedEndpoint: '/tmp/s',
      sourcePort: '5432',
      sourceDatabase: 'ai_capital',
    })
    // NO FIELD IS LEFT UNSET. Eleven, counted, so a field added to the
    // reviewed type cannot be silently skipped here.
    expect(Object.keys(o)).toHaveLength(11)
    for (const [k, val] of Object.entries(o)) {
      expect(String(val).trim(), k).not.toBe('')
    }
  })

  it('refuses every ABSENT, BLANK or SWAPPED required field', () => {
    const bad: Array<[string, Partial<OperatorArgs>]> = [
      ['runId absent', { runId: '' }],
      ['runId not 8 hex', { runId: 'AABBCCDD' }],
      ['stamp blank', { stamp: '' }],
      ['stamp not an instant', { stamp: '2026-09-30' }],
      ['head blank', { provenance: { head: '', ingestionGitlink: 'e'.repeat(40) } }],
      ['gitlink blank', { provenance: { head: 'f'.repeat(40), ingestionGitlink: '' } }],
      ['head not hex40', { provenance: { head: 'zz', ingestionGitlink: 'e'.repeat(40) } }],
      ['system identifier blank', {
        measuredSource: { ...OPERATOR_ARGS.measuredSource, systemIdentifier: '' } }],
      ['system identifier not decimal', {
        measuredSource: { ...OPERATOR_ARGS.measuredSource, systemIdentifier: 'ai_capital' } }],
      ['endpoint blank', { requestedEndpoint: '' }],
      ['endpoint is a URL', { requestedEndpoint: 'postgresql://h/db' }],
      ['port blank', { sourcePort: '' }],
      ['port not a port', { sourcePort: '0' }],
      ['database blank', { sourceDatabase: '' }],
      ['database not an identifier', { sourceDatabase: 'Ai-Capital' }],
    ]
    for (const [label, over] of bad) {
      expect(() => applyOperatorInput({ ...OPERATOR_ARGS, ...over }), label).toThrow()
    }
    // A SWAP IS ALSO REFUSED: a port where a database belongs, and vice versa.
    expect(() => applyOperatorInput({
      ...OPERATOR_ARGS, sourcePort: 'ai_capital', sourceDatabase: '5432',
    })).toThrow()
  })

  it('the production apply hands Stage 1 that proved record, not a cast', async () => {
    const h = harness()
    await runProductionApply(h.input)
    const o = h.seen.stage1Operator as Record<string, unknown>
    expect(Object.keys(o)).toHaveLength(11)
    // IT SURVIVES THE REAL VALIDATOR, which is what the old cast bypassed:
    // three fields of eleven were supplied and the real path would have been
    // refused the moment it reached Stage 1.
    expect(() => assertOperatorInput(o as never)).not.toThrow()
    expect(o.ingestionGitlink).toBe('e'.repeat(40))
    expect(o.generatedAtUtc).toBe('2026-09-30T00:00:00Z')
  })

  it('leaves NO unsafe cast in the production apply', () => {
    // EXECUTABLE TEXT ONLY. Written against the raw file this guard matched a
    // COMMENT explaining why `undefined as never` was removed - reporting a
    // cast that is not there, which is the same defect as missing one that is.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const open = src.indexOf('export async function runProductionApply(')
    expect(open).toBeGreaterThan(0)
    const rest = src.slice(open + 1)
    const end = rest.search(/\nexport (async function|function|const) /)
    expect(end).toBeGreaterThan(0)
    const fn = src.slice(open, open + 1 + end)
    expect(fn).not.toContain('as unknown as')
    expect(fn).not.toContain('undefined as never')
    expect(fn).not.toContain('as unknown as OperatorInput')
  })
})

// ---------------------------------------------------------------------------
// K7-B6.1 PHASE D — FAIL CLOSED FROM THE INSTANT STAGE 1 MAY TAKE A LOCK
// ---------------------------------------------------------------------------

/**
 * A run whose Stage 1 fails at a chosen boundary.
 *
 * `where` is honest about what the SEAM can express. A throw from the export
 * session's opener is provably before any acquisition: control never entered
 * Stage 1. Everything else - partial locks, all locks, locks plus a published
 * manifest - is indistinguishable from outside `runStage1`, which is exactly
 * why the production code may not try to tell them apart: once the call has
 * begun, the fence MAY be held, and that is the only safe reading.
 */
const failingStage1 = (
  where: 'before-any-acquisition' | 'partial' | 'complete' | 'after-publication',
  over: Record<string, unknown> = {},
): Harness => harness(
  where === 'before-any-acquisition'
    ? {
      authority: () => ({
        openStage1ExportSource: async () => { throw new Error('the export session was refused') },
      }),
      ...over,
    }
    : { stage1: async () => { throw new Error(`stage 1 failed: ${where}`) }, ...over },
)

describe('K7-B6.1 D: every Stage-1 failure boundary fails closed', () => {
  it('a failure BEFORE any acquisition closes normally and never releases', async () => {
    const h = failingStage1('before-any-acquisition')
    await expect(runProductionApply(h.input)).rejects.toThrow(/export session was refused/)
    // NO RELEASE ATTEMPT: there was provably nothing to release, and that fact
    // is structural - control never entered `stage1`.
    expect(h.calls.release).toBe(0)
    expect(h.calls.stage1).toBe(0)
    // THE SESSIONS ARE CLOSED, prover then supervisor.
    expect(h.log.indexOf('prover:close')).toBeLessThan(h.log.indexOf('supervisor:close'))
    expect(h.log).toContain('channel:close')
  })

  for (const where of ['partial', 'complete', 'after-publication'] as const) {
    it(`a MAY-BE-HELD failure (${where}) takes the reviewed release path`, async () => {
      let releases = 0
      const h = failingStage1(where, {
        releaseAndProve: async () => {
          releases += 1
          return { state: 'released' as const, remainingLocks: 0 }
        },
      })
      const r = await runProductionApply(h.input)
      // RELEASED AND PROVED: a truthful refusal, exactly one release attempt.
      expect(r.exitCode).toBe(EXIT_REFUSED)
      expect(releases).toBe(1)
      expect(h.log.join('\n')).not.toContain('runLifecycle')
      expect(h.log.indexOf('prover:close')).toBeLessThan(h.log.indexOf('supervisor:close'))
    })

    it(`an UNPROVED ${where} failure holds with BOTH sessions open`, async () => {
      let seenHold: Record<string, unknown> | null = null
      const observed: { hold: Record<string, unknown> | null } = { hold: null }
      const h = failingStage1(where, {
        releaseAndProve: async () => ({ state: 'release-unknown' as const, remainingLocks: null }),
        enterHold: async (x: Record<string, unknown>) => {
          observed.hold = x
          return { exitCode: 1, lines: [] }
        },
      })
      await runProductionApply(h.input).catch(() => undefined)
      seenHold = observed.hold
      expect(seenHold, where).not.toBeNull()
      // K7-B6.3 C: the EXACT release outcome, not a flattened one. This
      // injected `release-unknown` used to arrive as `unproved`, which offers
      // a different reviewed action set.
      expect(seenHold?.fenceState).toBe('release-unknown')
      // NOTHING WAS CLOSED BY THE OUTER PATH. The hold owns both sessions and
      // closes them itself, through its own teardown.
      expect(h.log, where).not.toContain('supervisor:close')
      expect(h.log, where).not.toContain('prover:close')
      expect(h.log, where).not.toContain('channel:close')
    })
  }

  it('does NOT read the error text to decide whether a lock was taken', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const open = src.indexOf('export async function runProductionApply(')
    const rest = src.slice(open + 1)
    const fn = src.slice(open, open + 1 + rest.search(/\nexport (async function|function|const) /))
    // THE STATE DECIDES. A `message`-matching catch would be exactly the
    // inference this phase forbids.
    expect(fn).not.toMatch(/e\.message/)
    expect(fn).not.toMatch(/instanceof OpsRefused/)
    // AND THE STATE IS SET BEFORE THE CALL, NOT AFTER IT RETURNS.
    expect(fn.indexOf("own.state = 'may-be-held'"))
      .toBeLessThan(fn.indexOf('stage1Result = await stage1('))
  })
})

// ---------------------------------------------------------------------------
// K7-B6.1 PHASE E — THE HOLD IS REAL
// ---------------------------------------------------------------------------

describe('K7-B6.1 E: the production hold is the reviewed one', () => {
  /** A run that reaches the hold after a complete Stage 1, capturing its input. */
  const holding = async (): Promise<{
    h: Harness; hold: Record<string, unknown>
  }> => {
    const observed: { hold: Record<string, unknown> | null } = { hold: null }
    const h = harness({
      confirm: async () => { throw new Error('the reply does not carry this run\'s copy confirmation') },
      releaseAndProve: async () => ({ state: 'release-unknown' as const, remainingLocks: null }),
      enterHold: async (x: Record<string, unknown>) => {
        observed.hold = x
        return { exitCode: 1, lines: [] }
      },
    })
    await runProductionApply(h.input).catch(() => undefined)
    expect(observed.hold).not.toBeNull()
    return { h, hold: observed.hold as Record<string, unknown> }
  }

  it('names the EXACT fence identity, never a blank pid or backend start', async () => {
    const { hold } = await holding()
    expect(hold.supervisorPid).toBe(FENCE.supervisorPid)
    expect(hold.backendStart).toBe(FENCE.backendStart)
    expect(String(hold.supervisorPid)).not.toBe('')
    expect(String(hold.backendStart)).not.toBe('')
  })

  it('cross-links the Stage-1 bundle as a prior bundle, with its DIGEST digest', async () => {
    const { hold } = await holding()
    expect(hold.priorBundles).toEqual([
      { name: PUBLISHED_NAME, digestFileDigest: PUBLISHED_DIGEST },
    ])
  })

  it('carries a REAL operation, not a dummy unresolved result', async () => {
    const { hold } = await holding()
    const perform = hold.perform as (d: unknown) => Promise<Record<string, unknown>>
    expect(typeof perform).toBe('function')
    // THE DUMMY RETURNED `{resolved:false}` WITHOUT TOUCHING ANYTHING. The real
    // one reaches the reviewed operation, which needs a decision it understands
    // - so an unrecognised one is refused rather than silently unresolved.
    const out = await perform({ action: 'CENSUS_ONLY', operator: 'x', token: 't' })
      .catch((e: Error) => ({ threw: e.name }))
    expect(out).not.toEqual({ resolved: false })
  })

  it('reuses the already-preflighted channel and the resolution-file policy', async () => {
    const { h, hold } = await holding()
    expect(typeof hold.hold).toBe('object')
    // EXACTLY ONE CHANNEL FOR THE WHOLE RUN: the hold did not build a second.
    expect(h.log.filter(l => l === 'preflight')).toHaveLength(0)
    expect(h.log.filter(l => l === 'arm')).toHaveLength(1)
  })

  it('tears down PROVER then SUPERVISOR, and only through the hold', async () => {
    const { h, hold } = await holding()
    const teardown = hold.teardown as () => Promise<void>
    expect(typeof teardown).toBe('function')
    // NOTHING CLOSED YET: ownership transferred, the outer path closed nothing.
    expect(h.log).not.toContain('prover:close')
    expect(h.log).not.toContain('supervisor:close')
    await teardown()
    expect(h.log.indexOf('prover:close')).toBeLessThan(h.log.indexOf('supervisor:close'))
  })

  it('builds the DEFAULT destination adapter when none is injected', async () => {
    // `undefined as never` here meant the production hold could not measure
    // destinations at all. The rehearsal's default is reused verbatim.
    const h = harness({ destinations: undefined })
    await runProductionApply(h.input)
    const d = h.seen.lifecycleDestinations as { measure?: unknown }
    expect(d).toBeDefined()
    expect(typeof d.measure).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// K7-B6.1 PHASE F2 — EXACTLY ONE LIFECYCLE CALL, BEHAVIOURALLY
// ---------------------------------------------------------------------------

describe('K7-B6.1 F2: the lifecycle runs exactly once', () => {
  it('one apply invokes runLifecycle exactly once - counted, not grepped', async () => {
    const h = harness()
    await runProductionApply(h.input)
    // A COUNT OF REAL INVOCATIONS. The retired check read the source text and
    // would have been satisfied by an import, a comment or a test double's
    // declaration; a second real call is what actually matters, and only a
    // count of calls can see it.
    expect(h.calls.lifecycle).toBe(1)
    expect(h.log.filter(l => l === 'runLifecycle')).toHaveLength(1)
  })

  it('and a refused run invokes it ZERO times', async () => {
    const h = harness({
      confirm: async () => { throw new Error('refused') },
      releaseAndProve: async () => ({ state: 'released' as const, remainingLocks: 0 }),
    })
    await runProductionApply(h.input)
    expect(h.calls.lifecycle).toBe(0)
  })
})

describe('K7-B6.1 D/E: a hold after Stage 1 THREW still names the fence', () => {
  /**
   * THE CASE A HOLD MATTERS MOST IN.
   *
   * Stage 1 can take locks and then throw, so `stage1Result.fence` does not
   * exist exactly when the fence may be held. The first draft of this
   * orchestration refused to hold at all in that state, which failed OPEN: a
   * possibly-fenced production database with no hold and no evidence.
   */
  const heldWithoutStage1Fence = async (over: Record<string, unknown> = {}): Promise<{
    h: Harness; hold: Record<string, unknown> | null; error: Error | null
  }> => {
    const observed: { hold: Record<string, unknown> | null } = { hold: null }
    const h = harness({
      stage1: async () => { throw new Error('stage 1 took locks and then failed') },
      releaseAndProve: async () => ({ state: 'release-unknown' as const, remainingLocks: null }),
      enterHold: async (x: Record<string, unknown>) => {
        observed.hold = x
        return { exitCode: 1, lines: [] }
      },
      ...over,
    })
    let error: Error | null = null
    await runProductionApply(h.input).catch((e: Error) => { error = e })
    return { h, hold: observed.hold, error }
  }

  it('measures the SUPERVISOR\'s own pid and backend start, and holds', async () => {
    const { hold } = await heldWithoutStage1Fence()
    expect(hold).not.toBeNull()
    expect(hold?.supervisorPid).toBe(FENCE.supervisorPid)
    expect(hold?.backendStart).toBe(FENCE.backendStart)
    // K7-B6.3 C: the injected release said `release-unknown`, and that is
    // what the hold is told.
    expect(hold?.fenceState).toBe('release-unknown')
    // NO STAGE-1 BUNDLE TO CROSS-LINK, because nothing was published.
    expect(hold?.priorBundles).toEqual([])
  })

  it('REFUSES BEFORE STAGE 1 when the supervisor will not name itself', async () => {
    // K7-B6.2 PHASE D MOVED THIS EARLIER, and that is the whole correction.
    // The identity used to be measured at hold time, which is precisely when
    // an aborted Stage-1 transaction refuses `pg_backend_pid()`. It is now
    // total before the fence boundary, so a supervisor that will not name
    // itself is refused while nothing can have been fenced at all.
    const mute = {
      pid: '0',
      send: async () => ({ rows: [] as string[][], error: null }),
      rows: async () => [] as string[][],
      close: async () => undefined,
      alive: () => true,
    }
    const h = harness({
      measureFenceIdentity: undefined,
      openSupervisor: async () => mute,
    })
    await expect(runProductionApply(h.input))
      .rejects.toThrow(/would not name its own backend, so no fence may be attempted/)
    // NO FENCE WAS ATTEMPTED.
    expect(h.calls.stage1).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// K7-B6.2 PHASE C — A VERIFIED PublishedManifest, NEVER A CAST
// ---------------------------------------------------------------------------

/** A bounded world for the tests that need a REAL published bundle on disk. */
const realWorld = (): World => world({})

describe('K7-B6.2 C: the real verifier is the only source of a manifest', () => {
  it('verifyPublishedStage1 returns a BRANDED manifest the consumers accept', () => {
    const w = realWorld()
    const dir = stage1Bundle(w)
    const verified = verifyPublishedStage1(dir)
    // THE REAL FIELDS THE COPY NEEDS, which a PublishedEvidence does not have.
    expect(verified.bundleName).toBe(basename(dir))
    expect(verified.document).toBeDefined()
    expect(verified.contract).toBeDefined()
    expect(isVerifiedBundle(verified)).toBe(true)
  })

  it('REFUSES a forged object literal with all the right fields', () => {
    const w = realWorld()
    const verified = verifyPublishedStage1(stage1Bundle(w))
    // STRUCTURALLY IDENTICAL, and still not the thing the verifier returned.
    const forged = { ...verified }
    expect(isVerifiedBundle(forged)).toBe(false)
    // A JSON round trip and a structuredClone are different objects too.
    expect(isVerifiedBundle(JSON.parse(JSON.stringify({
      bundleName: verified.bundleName, digestFileDigest: verified.digestFileDigest,
      document: {}, contract: {},
    })))).toBe(false)
  })

  it('a raw PublishedEvidence has NONE of the manifest fields', () => {
    // THIS IS WHY THE CAST COULD NOT WORK. `runInspect` and the binding read
    // `document` and `contract`; `PublishedEvidence` carries finalPath,
    // temporaryPath, files and digestFileDigest. The cast type-checked and
    // produced an object whose `document` was `undefined`, so the injected
    // suite passed while the live apply could not have worked at all.
    const evidence = {
      finalPath: '/x/source-manifest-a', temporaryPath: '/x/.tmp-a',
      files: ['manifest.json'], digestFileDigest: 'd'.repeat(64),
    }
    expect('document' in evidence).toBe(false)
    expect('contract' in evidence).toBe(false)
    expect('bundleName' in evidence).toBe(false)
    expect(isVerifiedBundle(evidence)).toBe(false)
  })

  it('the apply verifies STAGE 1\'s exact final path, through the real verifier', async () => {
    // NO INJECTED VERIFIER HERE. The harness's Stage 1 names a real published
    // bundle, so the production line under test is the real
    // `verifyPublishedStage1(stage1Result.published.finalPath)`.
    const w = realWorld()
    const dir = stage1Bundle(w)
    const h = harness({
      verifyPublished: undefined,
      stage1: async () => ({
        fence: FENCE,
        published: {
          finalPath: dir, bundleName: basename(dir),
          digestFileDigest: fileDigestOf(dir),
        },
      }),
      copyBinding: async (published: unknown) => {
        // THE REAL VERIFIER'S OWN OBJECT REACHED THE BINDING.
        expect(isVerifiedBundle(published as object)).toBe(true)
        return {
          digest: 'c'.repeat(64),
          binding: {
            targetSystemIdentifier: '9', targetDatabase: 'ai_capital_v3',
            targetPort: '5433', targetRole: 'ai_capital_owner',
          },
          stage1: {},
        }
      },
      inspect: async (_i: unknown, published: unknown) => {
        // AND SO DID INSPECT. This is the boundary the cast broke.
        expect(isVerifiedBundle(published as object)).toBe(true)
        return { confirmation: TOKEN }
      },
    })
    const r = await runProductionApply(h.input)
    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED)
  })

  it('REFUSES when Stage 1 names a directory that does not verify', async () => {
    const h = harness({ verifyPublished: undefined })
    const r = await runProductionApply(h.input)
    // The harness's finalPath is a name under a temp root with nothing in it.
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(h.log.join('\n')).not.toContain('runInspect')
    expect(h.log.join('\n')).not.toContain('runLifecycle')
  })
})

// ---------------------------------------------------------------------------
// K7-B6.2 PHASE D — HOLD IDENTITY IS TOTAL BEFORE THE FENCE BOUNDARY
// ---------------------------------------------------------------------------

describe('K7-B6.2 D: identity is proved before Stage 1 can poison anything', () => {
  it('measures pid and backend start BEFORE Stage 1 runs', async () => {
    const h = harness()
    await runProductionApply(h.input)
    // The measurement issues statements on both sessions; the ORDER is the
    // property, because after Stage 1 fails the supervisor's transaction may
    // be aborted and refuse them.
    expect(h.log.indexOf('measureFenceIdentity'))
      .toBeLessThan(h.log.indexOf('runStage1'))
  })

  it('a hold still gets the EXACT identity when every later statement REJECTS', async () => {
    // THE CASE THAT MOTIVATED THIS PHASE. Stage 1 fails on a statement error,
    // which leaves its transaction aborted, so `SELECT pg_backend_pid()` is
    // refused from then on. Measuring at hold time threw out of the catch that
    // asked for it and the possibly-held fence vanished with no evidence.
    const observed: { hold: Record<string, unknown> | null } = { hold: null }
    let poisoned = false
    const h = harness({
      stage1: async () => { poisoned = true; throw new Error('statement refused in Stage 1') },
      releaseAndProve: async () => ({ state: 'release-unknown' as const, remainingLocks: null }),
      enterHold: async (x: Record<string, unknown>) => {
        observed.hold = x
        return { exitCode: 1, lines: [] }
      },
    })
    // EVERY supervisor statement after the failure rejects outright.
    const sup = h.seen.supervisorStub as { send: (s: string) => Promise<unknown> }
    const realSend = sup.send.bind(sup)
    sup.send = async (sql: string) => {
      if (poisoned) throw new Error('current transaction is aborted')
      return await realSend(sql)
    }
    await runProductionApply(h.input).catch(() => undefined)
    expect(observed.hold).not.toBeNull()
    expect(observed.hold?.supervisorPid).toBe(FENCE.supervisorPid)
    expect(observed.hold?.backendStart).toBe(FENCE.backendStart)
    // BOTH SESSIONS STILL OPEN: the hold owns them.
    expect(h.log).not.toContain('supervisor:close')
    expect(h.log).not.toContain('prover:close')
  })

  it('REFUSES BEFORE STAGE 1 when the identity cannot be established', async () => {
    for (const [label, over] of [
      ['supervisor will not name itself', {
        measureFenceIdentity: async () => {
          throw new OpsRefused(
            'the supervisor would not name its own backend, so no fence may be attempted')
        },
      }],
    ] as const) {
      const h = harness(over)
      await expect(runProductionApply(h.input), label).rejects.toThrow(/no fence may be attempted/)
      // NO FENCE WAS ATTEMPTED, and both sessions were closed in order.
      expect(h.calls.stage1, label).toBe(0)
      expect(h.log.indexOf('prover:close')).toBeLessThan(h.log.indexOf('supervisor:close'))
    }
  })

  it('a self-proof is refused: the prover may not BE the supervisor', async () => {
    const h = harness({ measureFenceIdentity: undefined })
    // Both stubs answer the same pid, which is exactly a self-proof.
    const same = backend('prover', h.log, FENCE.supervisorPid)
    const h2 = harness({ measureFenceIdentity: undefined, openProver: async () => same })
    await expect(runProductionApply(h2.input))
      .rejects.toThrow(/prover is the supervisor, so no independent fence proof/)
    expect(h2.calls.stage1).toBe(0)
    expect(h.input).toBeDefined()
  })

  it('REFUSES a Stage-1 fence on a backend this run did not measure', async () => {
    const h = harness({
      stage1: async () => ({
        fence: { ...FENCE, supervisorPid: '99999' },
        published: { finalPath: 'x', bundleName: 'x', digestFileDigest: 'd'.repeat(64) },
      }),
      releaseAndProve: async () => ({ state: 'released' as const, remainingLocks: 0 }),
    })
    const r = await runProductionApply(h.input)
    // MAY-BE-HELD, so it takes the reviewed release path rather than closing.
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(h.log.join('\n')).not.toContain('runInspect')
  })
})

// ---------------------------------------------------------------------------
// K7-B6.2 PHASE E — LIFECYCLE STATES SURVIVE; NOTHING ROLLS BACK TWICE
// ---------------------------------------------------------------------------

/**
 * A run whose lifecycle throws `thrown`, counting every ROLLBACK the
 * orchestration issues on the supervisor.
 *
 * THE COUNT IS THE POINT. Every reviewed lifecycle exception has already done
 * its own cleanup, and the old code mapped all of them onto one more ROLLBACK:
 * unauthorized after a proved release, duplicated after a pre-COMMIT cleanup,
 * and issued after a COMMIT that had already happened.
 */
const lifecycleThrows = async (
  thrown: unknown, over: Record<string, unknown> = {},
): Promise<{
  h: Harness; hold: Record<string, unknown> | null; result: CliResult | null
  rollbacks: number; releases: number
}> => {
  const observed: { hold: Record<string, unknown> | null } = { hold: null }
  let rollbacks = 0
  let releases = 0
  const h = harness({
    lifecycle: async () => { throw thrown },
    releaseAndProve: async () => {
      releases += 1
      return { state: 'released' as const, remainingLocks: 0 }
    },
    enterHold: async (x: Record<string, unknown>) => {
      observed.hold = x
      return { exitCode: 1, lines: [] }
    },
    ...over,
  })
  const sup = h.seen.supervisorStub as { send: (s: string) => Promise<unknown> }
  const realSend = sup.send.bind(sup)
  sup.send = async (sql: string) => {
    if (/ROLLBACK/i.test(sql)) rollbacks += 1
    return await realSend(sql)
  }
  let result: CliResult | null = null
  await runProductionApply(h.input).then(r => { result = r }).catch(() => undefined)
  return { h, hold: observed.hold, result, rollbacks, releases }
}

describe('K7-B6.2 E: each lifecycle exception keeps its own meaning', () => {
  it('LifecycleRefused: already rolled back and proved - NO second ROLLBACK', async () => {
    const { hold, result, rollbacks, releases, h } = await lifecycleThrows(
      new LifecycleRefused(
        'L1-bundle', 'the published bundle or reviewed target was not accepted', null))
    expect(result?.exitCode).toBe(EXIT_REFUSED)
    // NOT A HOLD, and not another release attempt of any kind.
    expect(hold).toBeNull()
    expect(releases).toBe(0)
    expect(rollbacks).toBe(0)
    // THE TRUTH IS REPORTED: the lifecycle proved the release, not this code.
    expect(result?.lines.join('\n')).toMatch(/lifecycle rolled back and proved/)
    // AND THE SESSIONS ARE CLOSED IN ORDER.
    expect(h.log.indexOf('prover:close')).toBeLessThan(h.log.indexOf('supervisor:close'))
  })

  for (const state of ['held', 'not-held', 'unproved', 'release-unknown',
                       'released-unproved'] as const) {
    it(`LifecyclePreCommitCleanupRequired preserves the EXACT state '${state}'`, async () => {
      const { hold, rollbacks, releases } = await lifecycleThrows(
        new LifecyclePreCommitCleanupRequired(
          { phase: 'L5-verify', reason: 'the independent verification did not pass', at: null },
          state, { send: async () => ({ rows: [], error: null }) }))
      expect(hold, state).not.toBeNull()
      // THE LIFECYCLE'S OWN CLASSIFICATION, carried through unflattened.
      expect(hold?.fenceState, state).toBe(state)
      // EXACTLY ONE ROLLBACK EXISTED, and the lifecycle issued it - not this.
      expect(rollbacks, state).toBe(0)
      expect(releases, state).toBe(0)
    })
  }

  it('a genuine post-COMMIT intervention is NOT flattened to unproved', async () => {
    const committed = new LifecycleInterventionRequired(
      { phase: 'L5-verify', reason: 'the independent verification did not pass', at: null },
      'release-unknown', { send: async () => ({ rows: [], error: null }) },
      // TWO VERIFIED PUBLICATIONS to cross-link, and one only ATTEMPTED, which
      // must NOT be linked as if it were evidence.
      verifiedPub('/e/copy-release-gate-20260930T000000Z-aabbccdd', GATE_DIGEST),
      verifiedPub('/e/copy-lifecycle-20260930T000000Z-aabbccdd', OUTCOME_DIGEST))
    const { hold, rollbacks, releases } = await lifecycleThrows(committed, {
      classifyIntervention: (v: unknown): v is LifecycleInterventionRequired =>
        v === committed,
    })
    expect(hold).not.toBeNull()
    // THE COMMIT TRUTH AND THE EXACT FENCE STATE SURVIVE.
    expect(hold?.fenceState).toBe(holdStateOf(committed.fence))
    expect(hold?.fenceState).not.toBe('unproved')
    // AND NO ROLLBACK WAS ISSUED AFTER A COMMIT THAT ALREADY HAPPENED.
    expect(rollbacks).toBe(0)
    expect(releases).toBe(0)
    // EVERY VERIFIED BUNDLE, CROSS-LINKED COMPLETELY AND IN ORDER.
    //
    // THE COMPLETE OBJECTS, not the names. The first version of this link
    // wrote `digestFileDigest: ''` and a name-only assertion passed - so a
    // blank digest serialized beside a real bundle name, which reads as a
    // verified reference and is not one.
    expect(hold?.priorBundles).toEqual([
      { name: PUBLISHED_NAME, digestFileDigest: PUBLISHED_DIGEST },
      {
        name: 'copy-release-gate-20260930T000000Z-aabbccdd',
        digestFileDigest: GATE_DIGEST,
      },
      {
        name: 'copy-lifecycle-20260930T000000Z-aabbccdd',
        digestFileDigest: OUTCOME_DIGEST,
      },
    ])
    // AND EVERY DIGEST IS A REAL ONE: 64 lowercase hex, all three distinct.
    const digests = (hold?.priorBundles as PriorBundle[]).map(b => b.digestFileDigest)
    for (const d of digests) expect(d).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(digests).size).toBe(3)
  })

  it('REFUSES to link a verified publication that carries no digest', async () => {
    // The lifecycle says verified and did not carry the digest that would
    // prove which bytes. OMITTED from the record's linked bundles - not
    // linked with a blank or invented digest, and not "named in the record"
    // either: the only mention is in this process's own output.
    const committed = new LifecycleInterventionRequired(
      { phase: 'L5-verify', reason: 'the independent verification did not pass', at: null },
      'release-unknown', { send: async () => ({ rows: [], error: null }) },
      verifiedWithBadDigest('/e/copy-release-gate-x', null),
      verifiedWithBadDigest('/e/copy-lifecycle-x', 'NOT-HEX'))
    const { hold, h } = await lifecycleThrows(committed, {
      classifyIntervention: (v: unknown): v is LifecycleInterventionRequired =>
        v === committed,
    })
    expect(hold?.priorBundles).toEqual([
      { name: PUBLISHED_NAME, digestFileDigest: PUBLISHED_DIGEST },
    ])
    // THE RUN'S OWN OUTPUT, not the injected hold's return value - which
    // carries its own empty `lines` and would have matched nothing forever.
    expect(h.input.lines.join('\n')).toMatch(/carried no reviewed digest/)
    // AND THE CLAIM MATCHES WHAT IS SERIALIZED: omitted, reported only.
    expect(h.input.lines.join('\n')).toMatch(/OMITTED from this record's linked bundles/)
    expect(h.input.lines.join('\n')).not.toMatch(/named in this record/)
  })

  it('REFUSES to link an UNVERIFIED publication even with a valid digest', async () => {
    // THE `verified` CHECK IS SEPARATE FROM THE DIGEST CHECK. With only the
    // digest check, dropping `!ev.verified` changed nothing observable,
    // because the unverified fixtures happened to carry no digest.
    const committed = new LifecycleInterventionRequired(
      { phase: 'L5-verify', reason: 'the independent verification did not pass', at: null },
      'release-unknown', { send: async () => ({ rows: [], error: null }) },
      unverifiedPub('/e/copy-release-gate-unverified'),
      unverifiedPub('/e/copy-lifecycle-unverified'))
    const { hold } = await lifecycleThrows(committed, {
      classifyIntervention: (v: unknown): v is LifecycleInterventionRequired =>
        v === committed,
    })
    // ONLY STAGE 1's BUNDLE. An unverified publication is not evidence, and a
    // well-formed digest does not make it one.
    expect(hold?.priorBundles).toEqual([
      { name: PUBLISHED_NAME, digestFileDigest: PUBLISHED_DIGEST },
    ])
  })

  it('an ATTEMPTED-but-unverified publication is NOT cross-linked', async () => {
    const committed = new LifecycleInterventionRequired(
      { phase: 'L5-verify', reason: 'the independent verification did not pass', at: null },
      'release-unknown', { send: async () => ({ rows: [], error: null }) },
      unverifiedPub('/e/copy-release-gate-x'),
      unverifiedPub(null))
    const { hold } = await lifecycleThrows(committed, {
      classifyIntervention: (v: unknown): v is LifecycleInterventionRequired =>
        v === committed,
    })
    // ONLY STAGE 1's BUNDLE. An unverified publication is not evidence, and
    // naming it in an intervention record would assert something nobody proved.
    expect((hold?.priorBundles as Array<{ name: string }>).map(x => x.name))
      .toEqual([PUBLISHED_NAME])
  })

  it('the DEFAULT classifier refuses a forged intervention', async () => {
    // NO SEAM INJECTED, so production's own `isInterventionRequired` decides -
    // and a structurally identical object it did not mint is not believed.
    const forged = new LifecycleInterventionRequired(
      { phase: 'L5-verify', reason: 'the independent verification did not pass', at: null },
      'held', { send: async () => ({ rows: [], error: null }) })
    expect(isInterventionRequired(forged)).toBe(false)
    const { hold, rollbacks } = await lifecycleThrows(forged)
    expect(hold).not.toBeNull()
    // IT FALLS THROUGH TO THE UNKNOWN-BOUNDARY PATH, which is the safe
    // reading: not a pre-COMMIT release, and no ROLLBACK.
    expect(hold?.fenceState).toBe('unproved')
    expect(rollbacks).toBe(0)
  })

  it('an UNEXPECTED throw after lifecycle entry does NOT auto-ROLLBACK', async () => {
    const { hold, rollbacks, releases } = await lifecycleThrows(
      new Error('something nobody classified'))
    expect(hold).not.toBeNull()
    // COMMIT BOUNDARY UNKNOWN: an intervention, not a pre-COMMIT release.
    expect(hold?.fenceState).toBe('unproved')
    expect(String(hold?.reason)).toMatch(/lifecycle stopped/)
    expect(rollbacks).toBe(0)
    expect(releases).toBe(0)
  })

  it('a normal RELEASED return with the wrong outcome does not release again', async () => {
    let releases = 0
    const h = harness({
      lifecycle: async () => ({
        // A REVIEWED OUTCOME THAT IS NOT THE MANUAL-STOP ONE, with the fence
        // already proved released by the lifecycle itself.
        outcome: 'COMPLETE' as const, fence: 'released' as const,
        verifierBundle: 'v', releaseGateBundle: 'r', lifecycleBundle: 'l',
      }),
      releaseAndProve: async () => { releases += 1; return { state: 'released' as const, remainingLocks: 0 } },
    })
    let rollbacks = 0
    const sup = h.seen.supervisorStub as { send: (s: string) => Promise<unknown> }
    const realSend = sup.send.bind(sup)
    sup.send = async (sql: string) => {
      if (/ROLLBACK/i.test(sql)) rollbacks += 1
      return await realSend(sql)
    }
    const r = await runProductionApply(h.input)
    expect(r.exitCode).toBe(EXIT_REFUSED)
    // THE RETURN ALREADY PROVED `released`. Asking again would be a second
    // ROLLBACK on a transaction the lifecycle already finished.
    expect(releases).toBe(0)
    expect(rollbacks).toBe(0)
    expect(r.lines.join('\n')).toMatch(/released and that release was proved by the lifecycle/)
  })
})

// ---------------------------------------------------------------------------
// K7-B6.2 PHASE F — OWNERSHIP, CLOSE ORDER, AND NO CASTS
// ---------------------------------------------------------------------------

describe('K7-B6.2 F: acquisition is exception-safe and casts are gone', () => {
  it('a failed PROVER open closes the supervisor', async () => {
    const h = harness({ openProver: async () => { throw new Error('prover refused') } })
    await expect(runProductionApply(h.input)).rejects.toThrow(/prover refused/)
    // THE SUPERVISOR WAS NOT LEAKED. A live psql child with no handle is a
    // held connection nobody can close.
    expect(h.log).toContain('supervisor:close')
  })

  it('a failed identity measurement closes prover THEN supervisor', async () => {
    const h = harness({
      measureFenceIdentity: async () => { throw new Error('identity refused') },
    })
    await expect(runProductionApply(h.input)).rejects.toThrow(/identity refused/)
    expect(h.log.indexOf('prover:close')).toBeLessThan(h.log.indexOf('supervisor:close'))
  })

  it('a failed channel ARM closes prover then supervisor', async () => {
    const h = harness()
    const armFails: ApplyOrchestration = {
      ...h.input,
      channel: { ...h.input.channel, arm: () => { throw new Error('arm refused') } },
    }
    await expect(runProductionApply(armFails)).rejects.toThrow(/arm refused/)
    expect(h.log.indexOf('prover:close')).toBeLessThan(h.log.indexOf('supervisor:close'))
  })

  it('the production apply contains NO type assertion at all', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    const open = src.indexOf('export async function runProductionApply(')
    const rest = src.slice(open + 1)
    const fn = src.slice(open, open + 1 + rest.search(/\nexport (async function|function|const) /))
    expect(fn).not.toContain('as never')
    expect(fn).not.toContain('as unknown as')
    expect(fn).not.toContain('as DriverOpeners')
    // AND NOTHING SPELLED DIFFERENTLY EITHER: no `as <Type>` of any kind.
    expect(fn).not.toMatch(/\bas\s+[A-Z]/)
  })

  it('the injected fixture is a REAL ApplyOrchestration, not a cast', () => {
    // EXECUTABLE TEXT ONLY, for the third time in this milestone: written
    // against the raw file, this guard matched the COMMENT above that explains
    // why the cast was removed.
    const src = strip(readFileSync(
      new URL('./pg-copy-apply-orchestration.test.ts', import.meta.url), 'utf-8'))
    // THE NEEDLE IS ASSEMBLED, because this file reads ITSELF: spelled as one
    // literal, the assertion's own text is the match it reports.
    const needle = ['as', 'unknown', 'as', 'ApplyOrchestration'].join(' ')
    expect(src).not.toContain(needle)
  })
})

// ---------------------------------------------------------------------------
// K7-B6.3 PHASE C — THE PRE-LIFECYCLE RELEASE MAPPING IS TOTAL
// ---------------------------------------------------------------------------

/**
 * Reach `releaseOrHold` through a chosen boundary and report the exact state
 * the intervention was entered with, plus the ROLLBACKs this code issued.
 */
const releaseBoundary = async (
  boundary: 'confirmation' | 'stage-1',
  release: ReleaseResult | 'not-released',
): Promise<{
  h: Harness; hold: Record<string, unknown> | null; rollbacks: number; releases: number
}> => {
  const observed: { hold: Record<string, unknown> | null } = { hold: null }
  let rollbacks = 0
  let releases = 0
  const h = harness({
    ...(boundary === 'confirmation'
      ? { confirm: async () => { throw new Error('the reply does not carry this run\'s copy confirmation') } }
      : { stage1: async () => { throw new Error('stage 1 took locks and then failed') } }),
    releaseAndProve: async () => { releases += 1; return release },
    enterHold: async (x: Record<string, unknown>) => {
      observed.hold = x
      return { exitCode: 1, lines: [] }
    },
  })
  const sup = h.seen.supervisorStub as { send: (s: string) => Promise<unknown> }
  const realSend = sup.send.bind(sup)
  sup.send = async (sql: string) => {
    if (/ROLLBACK/i.test(sql)) rollbacks += 1
    return await realSend(sql)
  }
  await runProductionApply(h.input).catch(() => undefined)
  return { h, hold: observed.hold, rollbacks, releases }
}

describe('K7-B6.3 C: every release outcome keeps its own reviewed state', () => {
  const CASES: Array<[ReleaseResult | 'not-released', HoldFenceState]> = [
    // AN ACKNOWLEDGED REFUSAL. The statement completed and the fence may
    // remain - `unproved`, NOT `held`, which would mean no release had ever
    // been attempted and would invite a first attempt that already happened.
    ['not-released', 'unproved'],
    // NOBODY CAN SAY WHETHER THE ROLLBACK RAN.
    [{ state: 'release-unknown', remainingLocks: null }, 'release-unknown'],
    // IT PROVABLY RAN AND THE CENSUS DID NOT CONFIRM IT.
    [{ state: 'released-unproved', remainingLocks: 2 }, 'released-unproved'],
  ]

  for (const boundary of ['confirmation', 'stage-1'] as const) {
    for (const [release, expected] of CASES) {
      const label = release === 'not-released' ? 'not-released' : release.state
      it(`${boundary}: ${label} enters intervention as '${expected}'`, async () => {
        const { h, hold, rollbacks, releases } = await releaseBoundary(boundary, release)
        expect(hold, label).not.toBeNull()
        expect(hold?.fenceState, label).toBe(expected)
        // EXACTLY ONE RELEASE ATTEMPT, and no second ROLLBACK from this code.
        expect(releases, label).toBe(1)
        expect(rollbacks, label).toBe(0)
        // BOTH SESSIONS STILL OPEN until the hold's own teardown.
        expect(h.log, label).not.toContain('supervisor:close')
        expect(h.log, label).not.toContain('prover:close')
        expect(h.log, label).not.toContain('channel:close')
        // AND THE HANDLERS WERE NEVER DISARMED ON THE WAY IN. A disarm here
        // opens a window in which a signal kills the process WHILE THE FENCE
        // MAY BE HELD - and asserting only on `channel:close` missed it.
        expect(h.log, label).not.toContain('disarm')
      })
    }
  }

  it('offers the EXACT reviewed actions for each state', async () => {
    // THE ACTION SETS ARE WHY FLATTENING MATTERS. Read from the reviewed table
    // for the state each outcome actually produces.
    const { hold: unknownHold } = await releaseBoundary(
      'confirmation', { state: 'release-unknown', remainingLocks: null })
    const { hold: unprovedHold } = await releaseBoundary(
      'confirmation', { state: 'released-unproved', remainingLocks: 2 })

    const unknownActions = HOLD_ACTIONS[unknownHold?.fenceState as HoldFenceState]
    const unprovedActions = HOLD_ACTIONS[unprovedHold?.fenceState as HoldFenceState]

    // `released-unproved` MUST NOT OFFER REPROVE_AND_GATE: the transaction no
    // longer exists. Flattening it to `unproved` offered it anyway.
    expect(unprovedActions).toEqual(['CENSUS_ONLY', 'ABANDON'])
    expect(unprovedActions).not.toContain('REPROVE_AND_GATE')
    // `release-unknown` MUST NOT BE CALLED `unproved`: only this state
    // licenses ending the backend without a prior release proof, and
    // flattening silently removed that option.
    expect(unknownHold?.fenceState).not.toBe('unproved')
    expect(unknownActions).toContain('TERMINATE_SUPERVISOR_WITHOUT_PRIOR_RELEASE_PROOF')
    expect(HOLD_ACTIONS.unproved)
      .not.toContain('TERMINATE_SUPERVISOR_WITHOUT_PRIOR_RELEASE_PROOF')
  })

  it('the APPLY hands the hold a cleanup that disarms AND closes', async () => {
    // THE PRODUCTION `cleanup`, not one a test supplied. The handoff tests
    // elsewhere pass their own, so nothing exercised the line where
    // `runProductionApply` gives the hold authority over the lease and channel
    // it armed - dropping the close from it changed no test at all.
    const { h, hold } = await releaseBoundary(
      'confirmation', { state: 'release-unknown', remainingLocks: null })
    const cleanup = hold?.cleanup as (() => void) | undefined
    expect(typeof cleanup).toBe('function')
    // NOTHING WAS CLEANED UP YET: the hold had not reached a terminal record.
    expect(h.log).not.toContain('disarm')
    expect(h.log).not.toContain('channel:close')
    // AND IT RELEASES BOTH, exactly once each, however often it is called.
    ;(cleanup as () => void)()
    expect(h.log.filter(l => l === 'disarm')).toHaveLength(1)
    expect(h.log.filter(l => l === 'channel:close')).toHaveLength(1)
    ;(cleanup as () => void)()
    expect(h.log.filter(l => l === 'disarm')).toHaveLength(1)
  })

  it('holdStateOfRelease is TOTAL over ReleaseResult, with no default', () => {
    expect(holdStateOfRelease('not-released')).toBe('unproved')
    expect(holdStateOfRelease({ state: 'release-unknown', remainingLocks: null }))
      .toBe('release-unknown')
    expect(holdStateOfRelease({ state: 'released-unproved', remainingLocks: 1 }))
      .toBe('released-unproved')
    expect(holdStateOfRelease({ state: 'released', remainingLocks: 0 })).toBe('released')
    // EVERY `ReleaseResult` STATE IS MAPPED, so a state added later must be
    // mapped deliberately rather than inheriting somebody else's actions.
    const states: Array<ReleaseResult['state']> =
      ['released', 'released-unproved', 'release-unknown']
    for (const state of states) {
      expect(HOLD_ACTIONS[holdStateOfRelease({ state, remainingLocks: null })], state)
        .toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// K7-B6.3 PHASE D — ONE CONTINUOUS ARM ACROSS CONFIRMATION AND INTERVENTION
// ---------------------------------------------------------------------------

/** Everything a channel was asked to do, in order. */
interface ChannelLog {
  readonly installs: string[]
  readonly sentences: string[]
  readonly disarms: number[]
  readonly closes: number[]
  readonly reads: string[]
}

/**
 * A channel that RECORDS, and whose arm behaves like the reviewed one: a
 * second arm updates the sentence on the existing lease and returns the same
 * disarm rather than installing a second handler set.
 *
 * `reply` is asked for the next line and is given the token the hold has just
 * printed - because the hold mints a FRESH token per attempt and a scripted
 * literal would never match, which turns the real unbounded hold into a hang.
 */
const recordingChannel = (
  reply: (attempt: number, token: string) => string,
): { channel: OperatorChannel; rec: ChannelLog; observe: (l: string) => void } => {
  const rec: ChannelLog = {
    installs: [], sentences: [], disarms: [], closes: [], reads: [],
  }
  let attempt = 0
  let token = ''
  let lease: (() => void) | null = null
  let released = false
  const channel: OperatorChannel = {
    preflight: () => undefined,
    arm(sentence: string): () => void {
      rec.sentences.push(sentence)
      if (lease !== null) return lease
      rec.installs.push(sentence)
      lease = (): void => {
        if (released) return
        released = true
        lease = null
        rec.disarms.push(attempt)
      }
      return lease
    },
    nextLine: async () => {
      attempt += 1
      const line = reply(attempt, token)
      rec.reads.push(line)
      return line
    },
    close: () => { rec.closes.push(attempt) },
  }
  /** Watch the hold's own output for the token it is asking to be echoed. */
  const observe = (l: string): void => {
    const m = /Reply with: <OPERATION> <operator-name> (\S+)/.exec(l)
    if (m !== null) token = m[1] as string
  }
  return { channel, rec, observe }
}

const NONTERMINAL: HoldOutcome = {
  fenceState: 'release-unknown', detail: 'the census could not be taken',
  resolved: false, databaseStateProvable: false,
}
const TERMINAL: HoldOutcome = {
  fenceState: 'released', detail: 'the fence was proved gone',
  resolved: true, databaseStateProvable: true,
}

describe('K7-B6.3 D: the arm lease survives the handoff, once', () => {
  let root = ''
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b63-arm-'))) })
  afterEach(() => {
    // PUBLISHED EVIDENCE IS DELIBERATELY READ-ONLY, so a plain recursive
    // remove fails with ENOTEMPTY. Write permission is restored under this
    // test's own bounded root and nowhere else, then the root is removed and
    // its absence asserted.
    execFileSync('/bin/chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  })

  /**
   * Arm as the apply does BEFORE Stage 1, then run the REAL
   * `holdForIntervention` over the REAL `processHold` on that SAME channel.
   * This is the production transition, not a captured `deps.enterHold`.
   *
   * BOUNDED BY THE SCRIPT, not by a ceiling in the hold: the second attempt
   * resolves terminally, so the reviewed unbounded loop exits the way
   * production would. The hold itself is untouched.
   */
  const handoff = async (outcomes: readonly HoldOutcome[]): Promise<{
    rec: ChannelLog; result: CliResult; teardowns: number[]; performed: HoldDecision[]
  }> => {
    const { channel, rec, observe } = recordingChannel(
      (attempt, token) => `${attempt === 1 ? 'CENSUS_ONLY' : 'ABANDON'} operator ${token}`)
    const lines: string[] = []
    const say = (l: string): void => { lines.push(l); observe(l) }

    // THE APPLY'S OWN ARM, before any fence could exist.
    const applyDisarm = channel.arm('Reply with the copy confirmation to proceed.')
    expect(rec.installs).toHaveLength(1)

    const teardowns: number[] = []
    const performed: HoldDecision[] = []
    let n = 0
    const result = await holdForIntervention({
      root, stamp: '20260930T000000Z',
      newRunId: () => `aabbcc${(n++).toString(16).padStart(2, '0')}`,
      mode: 'apply', outerRunId: 'aabbccdd',
      operationalDigest: 'o'.repeat(64), observationDigest: 'b'.repeat(64),
      fenceState: 'release-unknown',
      supervisorPid: FENCE.supervisorPid, backendStart: FENCE.backendStart,
      reason: 'the copy confirmation was not returned',
      // THE REVIEWED TRANSPORT OVER THE ALREADY-ARMED CHANNEL.
      hold: processHold(say, root, null, channel),
      say,
      priorBundles: [{ name: PUBLISHED_NAME, digestFileDigest: PUBLISHED_DIGEST }],
      perform: async (d: HoldDecision) => {
        performed.push(d)
        return outcomes[Math.min(performed.length - 1, outcomes.length - 1)] as HoldOutcome
      },
      teardown: async () => { teardowns.push(performed.length) },
      sleep: async () => undefined,
    })
    // The apply's handle is the SAME lease; calling it after the hold has
    // disarmed must not disarm a second time.
    applyDisarm()
    return { rec, result, teardowns, performed }
  }

  it('installs ONE handler set across confirmation and intervention', async () => {
    const { rec, performed } = await handoff([NONTERMINAL, TERMINAL])
    // TWO ATTEMPTS HAPPENED, so the handoff really ran.
    expect(performed).toHaveLength(2)
    // AND ONE INSTALLATION for the whole run: the hold re-armed and the
    // reviewed channel replaced the sentence on the existing lease.
    expect(rec.installs).toHaveLength(1)
    expect(rec.sentences.length).toBeGreaterThan(1)
  })

  it('the signal text describes the INTERVENTION, not the old prompt', async () => {
    const { rec } = await handoff([NONTERMINAL, TERMINAL])
    expect(rec.sentences[0]).toMatch(/copy confirmation to proceed/)
    const last = rec.sentences[rec.sentences.length - 1] as string
    expect(last).not.toMatch(/copy confirmation to proceed/)
    expect(last).toMatch(/release-unknown/)
    expect(last).toMatch(/holding it until an operator resolves it/)
  })

  it('disarms ONCE and closes ONCE, only after the terminal record', async () => {
    const { rec, teardowns } = await handoff([NONTERMINAL, TERMINAL])
    expect(rec.disarms).toHaveLength(1)
    expect(rec.closes).toHaveLength(1)
    // AND ONLY AFTER A TERMINAL RESOLUTION: the teardown saw two attempts.
    expect(teardowns).toEqual([2])
    // THE DISARM CAME AFTER THE SECOND ATTEMPT, never during the first.
    expect(rec.disarms[0]).toBeGreaterThanOrEqual(2)
  })

  it('does NOT disarm or close while an attempt is NONTERMINAL', async () => {
    // One nonterminal attempt driven through the real transport, without
    // letting the reviewed unbounded loop run: the properties are about what
    // has NOT happened yet.
    const { channel, rec, observe } = recordingChannel(
      (_a, token) => `CENSUS_ONLY operator ${token}`)
    const say = (l: string): void => { observe(l) }
    channel.arm('Reply with the copy confirmation to proceed.')
    const hold = processHold(say, root, null, channel)
    const armed = hold.arm('the fence is release-unknown and this process is holding it')
    const token = resolutionToken(
      'aabbcc00', '20260930T000000Z', 'o'.repeat(64),
      `${FENCE.supervisorPid}@${FENCE.backendStart}`)
    const decision = await hold.decide(
      'release-unknown', ['CENSUS_ONLY', 'ABANDON'], token)
    expect(decision.action).toBe('CENSUS_ONLY')
    // STILL ONE LEASE, AND NOTHING TERMINAL HAS HAPPENED.
    expect(rec.installs).toHaveLength(1)
    expect(rec.disarms).toEqual([])
    expect(rec.closes).toEqual([])
    expect(typeof armed).toBe('function')
  })

  /**
   * A hold whose MESSAGE UPDATE fails, driven over a caller-owned lease.
   *
   * THE PREVIOUS VERSION OF THIS TEST WAS WRONG. It asserted
   * `rec.disarms).toEqual([])` and called that "the lease was not torn down by
   * the failure" - which blessed a leak: after a terminal record the sessions
   * were closed while the original handler lease stayed armed and the readline
   * owner stayed open forever. Not unwinding a possibly-held fence and never
   * cleaning up are different things.
   */
  const armFails = async (outcomes: readonly HoldOutcome[]): Promise<{
    rec: ChannelLog; teardowns: number[]; performed: HoldDecision[]
  }> => {
    const { channel, rec, observe } = recordingChannel(
      (attempt, token) => `${attempt === 1 ? 'CENSUS_ONLY' : 'ABANDON'} operator ${token}`)
    const say = (l: string): void => { observe(l) }
    // THE CALLER'S OWN LEASE AND CHANNEL, exactly as the apply arms them.
    const leaseDisarm = channel.arm('Reply with the copy confirmation to proceed.')
    const real = processHold(say, root, null, channel)
    const throwing: InterventionHold = {
      arm: () => { throw new Error('the prompt could not be updated') },
      decide: async (st, ac, tok) => await real.decide(st, ac, tok),
    }
    const teardowns: number[] = []
    const performed: HoldDecision[] = []
    let n = 0
    await holdForIntervention({
      root, stamp: '20260930T000000Z',
      newRunId: () => `aabbcc${(n++).toString(16).padStart(2, '0')}`,
      mode: 'apply', outerRunId: 'aabbccdd',
      operationalDigest: 'o'.repeat(64), observationDigest: 'b'.repeat(64),
      fenceState: 'release-unknown',
      supervisorPid: FENCE.supervisorPid, backendStart: FENCE.backendStart,
      reason: 'the copy confirmation was not returned',
      hold: throwing, say,
      priorBundles: [],
      perform: async (d: HoldDecision) => {
        performed.push(d)
        return outcomes[Math.min(performed.length - 1, outcomes.length - 1)] as HoldOutcome
      },
      teardown: async () => { teardowns.push(performed.length) },
      sleep: async () => undefined,
      // CLEANUP AUTHORITY COMES FROM HERE, not from the failed message update.
      cleanup: () => { leaseDisarm(); channel.close() },
    })
    // A SECOND CALL TO ANY CLEANUP IS A NO-OP.
    leaseDisarm()
    return { rec, teardowns, performed }
  }

  it('an arm/update failure does NOT unwind, and still cleans up at the end', async () => {
    const { rec, teardowns, performed } = await armFails([NONTERMINAL, TERMINAL])
    // IT HELD: the arm error did not propagate, and both attempts happened.
    expect(performed).toHaveLength(2)
    // AND AFTER THE TERMINAL RECORD, THE CALLER'S LEASE IS RELEASED EXACTLY
    // ONCE AND THE CHANNEL CLOSED EXACTLY ONCE - which the old assertion
    // `disarms === []` actively prevented anybody from noticing.
    expect(rec.disarms).toHaveLength(1)
    expect(rec.closes).toHaveLength(1)
    expect(teardowns).toEqual([2])
    // STILL ONE INSTALLED HANDLER SET: the failure installed nothing.
    expect(rec.installs).toHaveLength(1)
  })

  it('an arm/update failure cleans up NOTHING while attempts are nonterminal', async () => {
    const { channel, rec, observe } = recordingChannel((_a, token) => `CENSUS_ONLY operator ${token}`)
    const say = (l: string): void => { observe(l) }
    const leaseDisarm = channel.arm('Reply with the copy confirmation to proceed.')
    const real = processHold(say, root, null, channel)
    // One nonterminal attempt through the real transport, with the message
    // update failing - nothing terminal may have happened yet.
    const token = resolutionToken(
      'aabbcc00', '20260930T000000Z', 'o'.repeat(64),
      `${FENCE.supervisorPid}@${FENCE.backendStart}`)
    const decision = await real.decide(
      'release-unknown', ['CENSUS_ONLY', 'ABANDON'], token)
    expect(decision.action).toBe('CENSUS_ONLY')
    expect(rec.disarms).toEqual([])
    expect(rec.closes).toEqual([])
    expect(rec.installs).toHaveLength(1)
    leaseDisarm()
    channel.close()
  })
})

// ---------------------------------------------------------------------------
// K7-B6.3 D — THE REAL CHANNEL'S LEASE, COUNTED IN REAL LISTENERS
// ---------------------------------------------------------------------------

describe('K7-B6.3 D: the REAL operatorChannel installs one handler set', () => {
  let root = ''
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b63-real-'))) })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  })

  /**
   * THE PRODUCTION CHANNEL, NOT A FIXTURE THAT REIMPLEMENTS IT.
   *
   * The handoff tests above use a recording channel whose `arm` behaves like
   * the reviewed one - which means they assert the FIXTURE's behaviour. Taking
   * the lease out of the real `operatorChannel` left every one of them green,
   * so the real listener count is measured here instead.
   */
  it('a second arm adds NO listeners and returns the SAME disarm', () => {
    const sig = HELD_SIGNALS[0] as NodeJS.Signals
    const before = process.listenerCount(sig)
    const c = operatorChannel(() => undefined, root, join(root, 'resolve.txt'))

    const first = c.arm('Reply with the copy confirmation to proceed.')
    const afterFirst = process.listenerCount(sig)
    expect(afterFirst).toBe(before + 1)

    // THE HANDOFF: the hold re-arms the same channel.
    const second = c.arm('the fence is release-unknown and this process is holding it')
    expect(process.listenerCount(sig)).toBe(afterFirst)
    expect(second).toBe(first)

    // ONE DISARM RETURNS THE PROCESS TO EXACTLY WHERE IT STARTED, and calling
    // it again - which both the apply and the hold may do - is a no-op.
    second()
    expect(process.listenerCount(sig)).toBe(before)
    first()
    expect(process.listenerCount(sig)).toBe(before)
    c.close()
  })

  it('every held signal is covered by exactly one handler', () => {
    const before = HELD_SIGNALS.map(s => process.listenerCount(s as NodeJS.Signals))
    const c = operatorChannel(() => undefined, root, join(root, 'resolve.txt'))
    const disarm = c.arm('first')
    c.arm('second')
    c.arm('third')
    HELD_SIGNALS.forEach((s, n) => {
      expect(process.listenerCount(s as NodeJS.Signals), String(s))
        .toBe((before[n] as number) + 1)
    })
    disarm()
    HELD_SIGNALS.forEach((s, n) => {
      expect(process.listenerCount(s as NodeJS.Signals), String(s)).toBe(before[n])
    })
    c.close()
  })

  it('the armed handler prints the CURRENT sentence, not the first one', () => {
    const said: string[] = []
    const sig0 = HELD_SIGNALS[0] as NodeJS.Signals
    const beforeArm = process.listeners(sig0)
    const c = operatorChannel(l => said.push(l), root, join(root, 'resolve.txt'))
    const disarm = c.arm('Reply with the copy confirmation to proceed.')
    c.arm('the fence is release-unknown and this process is holding it')
    const sig = HELD_SIGNALS[0] as NodeJS.Signals
    // ONLY THE HANDLER THIS TEST INSTALLED. Invoking every listener on the
    // signal would also fire whatever the test runner and host process
    // registered - and one of those exits.
    const before = new Set(beforeArm)
    const mine_handlers = process.listeners(sig).filter(h => !before.has(h))
    expect(mine_handlers).toHaveLength(1)
    ;(mine_handlers[0] as (s: NodeJS.Signals) => void)(sig)
    const mine = said.filter(l => l.includes('IGNORED'))
    expect(mine.length).toBeGreaterThan(0)
    // THE MESSAGE WAS REPLACED IN PLACE. A second handler set would have
    // printed the stale confirmation prompt as well.
    expect(mine.join('\n')).toMatch(/release-unknown/)
    expect(mine.join('\n')).not.toMatch(/copy confirmation to proceed/)
    disarm()
    c.close()
  })
})

// ---------------------------------------------------------------------------
// K7-B7 PHASE E — EXACTLY ONE PRODUCTION LIFECYCLE AUTHORITY
// ---------------------------------------------------------------------------

describe('K7-B7 E: one orchestrator, one lifecycle invocation', () => {
  const exe = (rel: string): string =>
    strip(readFileSync(new URL(rel, import.meta.url), 'utf-8'))

  it('the STANDALONE CLI invokes the lifecycle zero times and still refuses', () => {
    const src = exe('../../db/bin/pg-copy.ts')
    // ZERO CALLS. A mention in prose is not a call, which is why this reads
    // executable text only - and a call is what would make a second
    // orchestrator out of a CLI that is supposed to refuse.
    // NOT EVEN THE IDENTIFIER, in executable text: a CLI that imported it
    // would hold the authority whether or not it had called it yet. A mention
    // in prose is not a reference, which is why `strip` runs first.
    expect(src).not.toMatch(/\brunLifecycle\b/)
    expect(src).not.toMatch(/\brunApply\s*\(/)
    // AND THE REFUSAL IS STILL THERE, truthfully.
    expect(src).toContain('the standalone --apply path is not available')
  })

  it('the queue orchestrator holds the ONE default authority, at one site', () => {
    const src = exe('../bin/pg-copy-ops.ts')
    // EXACTLY ONE DEFAULT-AUTHORITY SITE. This is the narrow assertion the
    // reviewed guard asks for: not a whole-repository substring count, but the
    // one place the production lifecycle can be reached from.
    expect(src.match(/deps\.lifecycle\s*\?\?\s*runLifecycle/g)).toHaveLength(1)
    // AND THE APPLY NEVER REACHES PAST THE LIFECYCLE TO THE COPY ITSELF.
    expect(src).not.toMatch(/\brunApply\s*\(/)
  })

  it('no OTHER production entry point invokes the lifecycle', () => {
    // The two reviewed bin directories are the only production entry points.
    // A second orchestrator anywhere in them fails this.
    const bins = [
      '../bin/pg-copy-ops.ts',
      '../bin/pg-copy-export-authority.ts',
      '../../db/bin/pg-copy.ts',
    ]
    // DETECTED BY IDENTIFIER, NOT BY `runLifecycle(`. The orchestrator reaches
    // it through a local alias (`deps.lifecycle ?? runLifecycle`), so the call
    // never spells that name - a caller-shaped regex finds nothing anywhere and
    // would have passed for a repository with ten orchestrators in it.
    const holders = bins.filter(rel => {
      let text: string
      try { text = exe(rel) } catch { return false }
      return /\brunLifecycle\b/.test(text)
    })
    expect(holders).toEqual(['../bin/pg-copy-ops.ts'])
  })

  it('a production apply invokes it EXACTLY once - counted, not grepped', async () => {
    const h = harness()
    await runProductionApply(h.input)
    expect(h.calls.lifecycle).toBe(1)
  })

  it('and the apply cannot bypass the injected seam', async () => {
    // If the orchestration called `runLifecycle` directly instead of the seam,
    // the injected fixture would never be reached and this count would be 0 -
    // while the run itself would try to talk to a real database.
    const h = harness()
    const r = await runProductionApply(h.input)
    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED)
    expect(h.calls.lifecycle).toBe(1)
    expect(h.log.filter(l => l === 'runLifecycle')).toHaveLength(1)
  })

  it('the obsolete --inspect --for=apply mint is still gone', () => {
    const src = exe('../bin/pg-copy-ops.ts')
    // VERIFIED, NOT REIMPLEMENTED. Its refusal has its own test in the modes
    // suite; this only confirms the mint did not come back.
    expect(src).toContain('only --for=rehearse is inspectable')
    expect(src).not.toMatch(/PGCOPY-APPLY-/)
  })
})

// ---------------------------------------------------------------------------
// K7-B7.1 PHASE B — COMPLETE EXISTS ONLY AT THE CLOSURE
// ---------------------------------------------------------------------------

describe('K7-B7.1 B: only a copy closure may say COMPLETE', () => {
  /** Executable text only: prose explaining the word is allowed. */
  const exe = (rel: string): string =>
    strip(readFileSync(new URL(rel, import.meta.url), 'utf-8'))

  it('no production module outside the closure emits or prints COMPLETE', () => {
    const PRODUCTION = [
      '../../db/src/pg-copy/lifecycle.ts',
      '../../db/src/pg-copy/stage2.ts',
      '../../db/src/pg-copy/verify.ts',
      '../../db/src/pg-copy/evidence.ts',
      '../../db/src/pg-copy/export-role.ts',
      '../../db/bin/pg-copy.ts',
    ]
    for (const rel of PRODUCTION) {
      expect(exe(rel), rel).not.toContain("'COMPLETE'")
    }
  })

  it('the orchestrator mentions it ONLY in the closure and its guard', () => {
    const src = exe('../bin/pg-copy-ops.ts')
    // THREE EXECUTABLE SITES, ALL INSIDE THE CLOSURE FAMILY: the chain
    // verifier REFUSING an upstream bundle that claims it, the closure
    // manifest, and the closure's own print.
    const sites = src.match(/'COMPLETE'/g) ?? []
    expect(sites).toHaveLength(3)
    // And each one is where it should be.
    const closure = src.slice(src.indexOf('export async function runCloseCopy'))
    expect(closure.match(/'COMPLETE'/g)).toHaveLength(2)
    const chain = src.slice(src.indexOf('export function verifyCopyChain'),
                            src.indexOf('export async function runVerifyCopyRestoration'))
    expect(chain.match(/'COMPLETE'/g)).toHaveLength(1)
    expect(chain).toContain('which only a closure may')
  })

  it('COMPLETE is not a LifecycleOutcome at all any more', () => {
    const src = exe('../../db/src/pg-copy/lifecycle.ts')
    const t = src.slice(src.indexOf('export type LifecycleOutcome'),
                        src.indexOf('export type RestorationAuthority'))
    expect(t).toContain('COPY_VERIFIED_RESTORED_AWAITING_CLOSURE')
    expect(t).toContain('COPY_VERIFIED_AWAITING_MANUAL_RESTORATION')
    expect(t).toContain('STOPPED')
    expect(t).not.toContain('COMPLETE')
  })

  it('the restoration mode never emits COMPLETE', () => {
    const src = exe('../bin/pg-copy-ops.ts')
    const mode = src.slice(src.indexOf('export async function runVerifyCopyRestoration'),
                           src.indexOf('export async function runCloseCopy'))
    expect(mode).not.toContain("'COMPLETE'")
    // It says what it actually established, and that the copy is still open.
    expect(mode).toContain('COPY_RESTORED')
    expect(mode).toContain('still OPEN')
  })
})

describe('K8-E3 T3: the apply confirmation token is shown before the apply waits', () => {
  /**
   * WHY THIS HARNESS AND NOT `runOpsCli --apply`.
   *
   * The order's preferred route is `runOpsCli` with `deps.operatorChannel` and
   * the real `awaitCopyConfirmation`. Reaching the token print needs a complete
   * reviewed chain first - a rehearsal, a restoration and a review bundle, a
   * Stage-1 bundle, both driver credentials, and the authority and lifecycle
   * fakes - and every `--apply` case that goes through `runOpsCli` elsewhere
   * stops at an earlier refusal instead (see `pg-copy-ops-modes.test.ts`, which
   * refuses on the missing driver credential). Building that chain would mean new
   * fixture machinery outside the allowed paths, so this takes the fallback the
   * order names: the existing harness, with its `confirm` stub removed so the
   * REAL `awaitCopyConfirmation` runs.
   *
   * THE COMPOSITION IS STILL THE PRODUCTION ONE. `runOpsCli` hands the apply its
   * own `say` (pg-copy-ops.ts:5501), and that `say` is the one that calls the
   * sink synchronously, so a `say` wired exactly as `runOpsCli` wires it is what
   * this harness is given below.
   */
  it('streams the token and the CONFIRM prompt before nextLine is read', async () => {
    const h = harness()
    // THE SINK, WIRED AS `runOpsCli` WIRES IT: record, then emit, synchronously.
    const streamed: string[] = []
    const said: string[] = []
    const input = h.input as unknown as {
      say: (l: string) => void
      deps: Record<string, unknown>
      channel: OperatorChannel
    }
    input.say = (l: string): void => { said.push(l); streamed.push(l) }

    // THE REAL CONFIRMATION READER, not the harness's stub.
    delete input.deps.confirm

    let reads = 0
    let seenAtRead: readonly string[] = []
    let tokenOnLine: string | null = null
    input.channel = {
      ...h.channel,
      nextLine: async () => {
        reads += 1
        // RECORDED, NOT ASSERTED HERE: a throw inside this callback would be
        // caught by `awaitCopyConfirmation` and turned into a refusal, hiding a
        // real failure. Everything is checked after the run.
        seenAtRead = [...streamed]
        const line = [...streamed].reverse().find(l => l.startsWith('Reply with: CONFIRM'))
        const m = line === undefined ? null : /(PGCOPY-COPY-[0-9a-f]+)/.exec(line)
        tokenOnLine = m === null ? null : (m[1] as string)
        return `CONFIRM k8-operator ${tokenOnLine ?? 'no-token'}`
      },
    } as OperatorChannel

    await runProductionApply(h.input)

    // THE OPERATOR WAS ASKED EXACTLY ONCE. `awaitCopyConfirmation` returns or
    // throws on the first non-empty reply (pg-copy-ops.ts:1543-1569).
    expect(reads).toBe(1)

    // AND AT THAT MOMENT ALL THREE LINES HAD ALREADY BEEN STREAMED.
    expect(seenAtRead.some(l => /^PGCOPY-COPY-[0-9a-f]+$/.test(l)),
           `token line missing: ${seenAtRead.join(' | ')}`).toBe(true)
    expect(seenAtRead).toContain('THE SOURCE IS FENCED AND THIS PROCESS IS HOLDING IT.')
    expect(seenAtRead.some(l => /^Reply with: CONFIRM <operator-name> PGCOPY-COPY-/.test(l)))
      .toBe(true)

    // THE REPLY WAS BUILT FROM WHAT WAS STREAMED, and it is the printed token.
    expect(tokenOnLine).toMatch(/^PGCOPY-COPY-[0-9a-f]+$/)
    expect(seenAtRead).toContain(tokenOnLine as string)
  })
})
