// THE THREE BINDINGS AND THEIR MODE-BOUND TOKENS.
//
// What is proved here: every listed field affects its digest, an ordered set is
// ordered, a rehearsal token fails the apply SYNTAX before any comparison, and
// nothing that could carry a credential can reach an operational binding.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  APPLY_PREFIX, BindingRefused, COPY_BINDING_SHAPE_VERSION, REHEARSE_PREFIX, TOKEN_PATTERN,
  assertConfirmationMatches, assertOperationalBindingUnchanged, confirmationToken,
  copyBindingDigest, copyBindingDocument, executionBindingDocument, operationalBindingDigest,
  operationalBindingDocument, modeObservationDigest, modeObservationDocument,
  stableInstallationOf, INSTALLATION_STATES,
  type CopyBinding, type ExecutionBinding, type OperationalAdapterBinding,
  type ProducerIdentity,
} from '../src/pg-copy/bindings.js'
import { REVIEWED_CONTRACT_DIGEST, canonicalJson, sha256Hex } from '../src/pg-copy/schema-contract.js'
import { REVIEWED_PRODUCERS, REVIEWED_QUEUES } from '../src/pg-copy/lifecycle.js'

const hex = (s: string): string => sha256Hex(`binding-fixture|${s}`)

const COPY = (over: Partial<CopyBinding> = {}): CopyBinding => ({
  bindingShapeVersion: COPY_BINDING_SHAPE_VERSION,
  bundleName: 'source-manifest-20260925T091500Z-a1b2c3d4',
  digestFileDigest: hex('digest-file'),
  sourceDatabase: 'ai_capital',
  sourceSystemIdentifier: '7689229024919775042',
  sourceExportRole: 'ai_capital_v3_export',
  sourceContractDigest: hex('source-contract'),
  contentRootDigest: hex('root'),
  copySetDigest: hex('copy-set'),
  provenanceHead: 'a'.repeat(40),
  ingestionGitlink: 'b'.repeat(40),
  reviewedTargetContractDigest: REVIEWED_CONTRACT_DIGEST,
  targetDatabase: 'ai_capital_v3',
  targetSystemIdentifier: '7689229024919775999',
  targetPort: '5433',
  targetRequestedEndpoint: '/Users/x/ai-capital-v3-run',
  targetServerAddress: null,
  targetUnixTransport: true,
  targetRole: 'ai_capital_migrator',
  targetSessionUser: 'ai_capital_migrator',
  ...over,
})

const producer = (label: string, over: Partial<ProducerIdentity> = {}): ProducerIdentity => ({
  label,
  plistPath: `/Users/x/Library/LaunchAgents/${label}.plist`,
  plistSha256: hex(label),
  plistDeviceInode: '16777234:54321',
  servedCheckout: '/Users/x/checkout',
  installation: 'installed-loaded',
  stableInstallation: 'installed',
  credentialPath: '/Users/x/.secrets/pipeline.url',
  credentialDeviceInode: '16777234:12345',
  databaseHost: '/tmp/socket',
  databasePort: '5432',
  databaseName: 'ai_capital',
  disposition: 'writes-copy-source',
  ...over,
})

const OPS = (over: Partial<OperationalAdapterBinding> = {}): OperationalAdapterBinding => ({
  sourceEndpoint: '/tmp/socket',
  sourceDatabase: 'ai_capital',
  sourceSystemIdentifier: '7689229024919775042',
  producers: REVIEWED_PRODUCERS.map(l => producer(l)),
  queues: REVIEWED_QUEUES,
  blockingStates: ['active', 'wait', 'delayed', 'prioritized', 'waiting-children'],
  pausedIsBlocking: true,
  producerAuthority: 'manual-stop',
  structuredWorkerInstallation: 'expected-absent',
  producerProcessPolicy: REVIEWED_PRODUCERS.map(
    l => ({ label: l, pattern: `pattern-for-${l}` })),
  redisHost: 'localhost',
  redisPort: '6379',
  redisDatabase: '0',
  evidenceRoot: '/Users/x/evidence',
  evidenceRootDeviceInode: '16777234:999',
  postRestorationPolicyPath: '/Users/x/policy/post-restoration.json',
  postRestorationPolicySha256: hex('policy'),
  implementationHead: 'c'.repeat(40),
  ...over,
})

const EXEC = (over: Partial<ExecutionBinding> = {}): ExecutionBinding => ({
  copyBindingDigest: null,
  operationalAdapterBindingDigest: operationalBindingDigest(OPS()),
  modeObservationDigest: modeObservationDigest(
    REVIEWED_PRODUCERS.map(label => ({ label, installation: 'installed-unloaded' as const }))),
  mode: 'rehearse',
  runId: 'a1b2c3d4',
  stamp: '20260925T091500Z',
  modeAuthorizationDigest: hex('authorization'),
  ...over,
})

describe('CopyBinding', () => {
  it('is deterministic and EVERY field changes it', () => {
    const base = copyBindingDigest(COPY())
    expect(base).toBe(copyBindingDigest(COPY()))
    const variants: Array<Partial<CopyBinding>> = [
      { bundleName: 'source-manifest-20260925T091500Z-ffffffff' },
      { digestFileDigest: hex('other') },
      { sourceDatabase: 'other_db' },
      { sourceSystemIdentifier: '7689229024919775043' },
      { sourceExportRole: 'other_role' },
      { sourceContractDigest: hex('other') },
      { contentRootDigest: hex('other') },
      { copySetDigest: hex('other') },
      { provenanceHead: 'd'.repeat(40) },
      { ingestionGitlink: 'e'.repeat(40) },
      { reviewedTargetContractDigest: hex('other') },
      { targetDatabase: 'other_target' },
      { targetSystemIdentifier: '1' },
      { targetPort: '5432' },
      { targetRequestedEndpoint: '/somewhere/else' },
      { targetServerAddress: '127.0.0.1', targetUnixTransport: false },
      { targetSessionUser: 'someone_else' },
      { targetRole: 'postgres' },
    ]
    const seen = new Set([base])
    for (const v of variants) seen.add(copyBindingDigest(COPY(v)))
    expect(seen.size).toBe(variants.length + 1)
  })

  it('refuses a malformed field rather than hashing it', () => {
    for (const v of [{ bundleName: 'nope' }, { digestFileDigest: 'short' },
                     { sourceDatabase: 'Bad Name' }, { targetPort: '0' },
                     { targetRequestedEndpoint: 'postgres://host/db' },
                     { sourceSystemIdentifier: '0' }] as Array<Partial<CopyBinding>>) {
      expect(() => copyBindingDigest(COPY(v)), JSON.stringify(v)).toThrow(BindingRefused)
    }
  })
})

describe('OperationalAdapterBinding', () => {
  it('is deterministic and EVERY field changes it', () => {
    const base = operationalBindingDigest(OPS())
    expect(base).toBe(operationalBindingDigest(OPS()))
    const variants: Array<Partial<OperationalAdapterBinding>> = [
      { sourceEndpoint: '/other/socket' },
      { sourceDatabase: 'other_db' },
      { sourceSystemIdentifier: '1' },
      // REVERSED TOGETHER. The process policy is ordered WITH the producers,
      // so reversing one alone is a malformed binding rather than a variant.
      { producers: [...REVIEWED_PRODUCERS].reverse().map(l => producer(l)),
        producerProcessPolicy: [...REVIEWED_PRODUCERS].reverse().map(
          l => ({ label: l, pattern: `pattern-for-${l}` })) },
      { producerProcessPolicy: REVIEWED_PRODUCERS.map(
          l => ({ label: l, pattern: `other-${l}` })) },
      { producers: REVIEWED_PRODUCERS.map((l, n) =>
          producer(l, n === 1 ? { plistSha256: hex('moved') } : {})) },
      { producers: REVIEWED_PRODUCERS.map((l, n) =>
          producer(l, n === 1 ? { plistPath: '/elsewhere.plist' } : {})) },
      { producers: REVIEWED_PRODUCERS.map((l, n) =>
          producer(l, n === 2 ? { servedCheckout: '/other/checkout' } : {})) },
      { producers: REVIEWED_PRODUCERS.map((l, n) =>
          producer(l, n === 2 ? { credentialPath: '/other/cred' } : {})) },
      { producers: REVIEWED_PRODUCERS.map((l, n) =>
          producer(l, n === 2 ? { credentialDeviceInode: '1:2' } : {})) },
      { producers: REVIEWED_PRODUCERS.map((l, n) =>
          producer(l, n === 3 ? { databaseName: 'elsewhere' } : {})) },
      { producers: REVIEWED_PRODUCERS.map((l, n) =>
          producer(l, n === 3 ? { disposition: 'writes-another-reviewed-database' } : {})) },
      { queues: [...REVIEWED_QUEUES].reverse() },
      { blockingStates: ['active', 'wait', 'delayed', 'prioritized'] },
      { pausedIsBlocking: false },
      { producerAuthority: 'stop-and-restore' },
      { structuredWorkerInstallation: 'installed' },
      { redisHost: 'other-host' },
      { redisPort: '6380' },
      { redisDatabase: '1' },
      { evidenceRoot: '/other/evidence' },
      { evidenceRootDeviceInode: '1:2' },
      { postRestorationPolicyPath: '/other/policy.json' },
      { postRestorationPolicySha256: hex('other-policy') },
      { implementationHead: 'f'.repeat(40) },
    ]
    const seen = new Set([base])
    for (const v of variants) seen.add(operationalBindingDigest(OPS(v)))
    expect(seen.size).toBe(variants.length + 1)
  })

  it('is INVARIANT across the one intended transition: installed-unloaded -> installed-loaded', () => {
    // THE DEFECT K5.3 CLOSES. Before this, the observed launchd state sat in the
    // binding document, so bootstrapping a label moved the digest — and
    // runVerifyRestoration then rejected the restored world as a different one
    // from the world the rehearsal was taken against. A proved rehearsal could
    // not reach its own review.
    const unloaded = OPS({ producers: REVIEWED_PRODUCERS.map(
      l => producer(l, { installation: 'installed-unloaded' })) })
    const loaded = OPS({ producers: REVIEWED_PRODUCERS.map(
      l => producer(l, { installation: 'installed-loaded' })) })
    const disabled = OPS({ producers: REVIEWED_PRODUCERS.map(
      l => producer(l, { installation: 'installed-disabled' })) })
    expect(operationalBindingDigest(loaded)).toBe(operationalBindingDigest(unloaded))
    expect(operationalBindingDigest(disabled)).toBe(operationalBindingDigest(unloaded))
  })

  it('carries the STABLE topology and not the observed launchd state', () => {
    const doc = JSON.parse(canonicalJson(operationalBindingDocument(OPS()))) as
      { producers: Record<string, unknown>[] }
    for (const row of doc.producers) {
      expect(row.stable_installation).toBe('installed')
      // The transient field must not appear in the document at all.
      expect(Object.keys(row)).not.toContain('installation')
    }
    expect(canonicalJson(operationalBindingDocument(OPS())))
      .not.toMatch(/installed-loaded|installed-unloaded|installed-disabled/)
  })

  it('STILL refuses a stable topology that disagrees with the observed state', () => {
    expect(() => operationalBindingDocument(OPS({
      producers: REVIEWED_PRODUCERS.map((l, n) => producer(l, n === 0
        ? { installation: 'expected-absent' } : {})),
    }))).toThrow()
    expect(() => operationalBindingDocument(OPS({
      producers: REVIEWED_PRODUCERS.map((l, n) => producer(l, n === 0
        ? { stableInstallation: 'expected-absent' } : {})),
    }))).toThrow()
  })

  it('refuses an ALL-NULL record that still claims a loaded launchd label', () => {
    // THE ONE INPUT THE AGREEMENT CHECK ALONE CATCHES. A record whose stable
    // topology is expected-absent takes the null-evidence path, so the
    // installed-state rules never run; without the observed/stable agreement
    // check, a row could say "nothing is installed and nothing was measured"
    // while also saying "launchd has this label loaded". Every other disagreement
    // is caught by the null-evidence contract or by INSTALLED_STATES, so this is
    // the case that makes that check observable.
    expect(() => operationalBindingDocument(OPS({
      producers: REVIEWED_PRODUCERS.map((l, n) => (n === 0 ? {
        label: l, plistPath: null, plistSha256: null, plistDeviceInode: null,
        servedCheckout: null,
        installation: 'installed-loaded' as const,
        stableInstallation: 'expected-absent' as const,
        credentialPath: null, credentialDeviceInode: null,
        databaseHost: null, databasePort: null, databaseName: null,
        disposition: 'expected-absent' as const,
      } : producer(l))),
    }))).toThrow()
    // NON-VACUITY: the same all-null record with a consistent observed state is
    // a perfectly ordinary expected-absent producer and validates.
    expect(() => operationalBindingDocument(OPS({
      producers: REVIEWED_PRODUCERS.map((l, n) => (n === 0 ? {
        label: l, plistPath: null, plistSha256: null, plistDeviceInode: null,
        servedCheckout: null,
        installation: 'expected-absent' as const,
        stableInstallation: 'expected-absent' as const,
        credentialPath: null, credentialDeviceInode: null,
        databaseHost: null, databasePort: null, databaseName: null,
        disposition: 'expected-absent' as const,
      } : producer(l))),
    }))).not.toThrow()
  })

  it('an installed agent may not be recorded with a null identity', () => {
    expect(() => operationalBindingDocument(OPS({
      producers: REVIEWED_PRODUCERS.map((l, n) => producer(l, n === 0
        ? { credentialPath: null, credentialDeviceInode: null,
            databaseHost: null, databasePort: null, databaseName: null } : {})),
    }))).toThrow()
  })

  it('the OBSERVATION digest moves where the stable digest deliberately does not', () => {
    // Requirement: confirmation integrity must not be weakened by making the
    // stable binding invariant. The observation is pinned in the EXECUTION
    // binding instead, where every mode confirmation carries it — see
    // 'the CONFIRMATION moves when the observation moves' below for the live path.
    const unloaded = REVIEWED_PRODUCERS.map(
      label => ({ label, installation: 'installed-unloaded' as const }))
    const loaded = REVIEWED_PRODUCERS.map(
      label => ({ label, installation: 'installed-loaded' as const }))
    expect(modeObservationDigest(loaded)).not.toBe(modeObservationDigest(unloaded))
    expect(modeObservationDigest(unloaded)).toBe(modeObservationDigest([...unloaded]))
    // ORDERED: a reordered census is a different observation.
    expect(modeObservationDigest([...unloaded].reverse()))
      .not.toBe(modeObservationDigest(unloaded))
  })

  it('the observation document refuses a duplicate label, an empty set and an unknown state', () => {
    expect(() => modeObservationDocument([])).toThrow()
    expect(() => modeObservationDocument([
      { label: REVIEWED_PRODUCERS[0] as string, installation: 'installed-loaded' },
      { label: REVIEWED_PRODUCERS[0] as string, installation: 'installed-loaded' },
    ])).toThrow()
    expect(() => modeObservationDocument([
      { label: REVIEWED_PRODUCERS[0] as string, installation: 'installed' as never },
    ])).toThrow()
  })

  it('stableInstallationOf is total over the four observed states', () => {
    expect(INSTALLATION_STATES.map(stableInstallationOf))
      .toEqual(['installed', 'installed', 'installed', 'expected-absent'])
  })

  it('the CONFIRMATION moves when the observation moves, and the stable digest does not', () => {
    // THE HOLE THIS CLOSES. The stable binding is invariant across
    // installed-unloaded -> installed-loaded, by design. Without the observation
    // in the execution binding, an operator could inspect a quiescent world,
    // take the token, watch every producer come back, and paste the same token
    // into a rehearsal. Measured before this change: byte-identical tokens.
    const unloaded = REVIEWED_PRODUCERS.map(
      label => ({ label, installation: 'installed-unloaded' as const }))
    const loaded = REVIEWED_PRODUCERS.map(
      label => ({ label, installation: 'installed-loaded' as const }))
    const a = EXEC({ modeObservationDigest: modeObservationDigest(unloaded) })
    const b = EXEC({ modeObservationDigest: modeObservationDigest(loaded) })

    expect(confirmationToken(a)).not.toBe(confirmationToken(b))
    // AND THE STABLE DIGEST IS UNMOVED, which is the property that lets a
    // rehearsal survive the restoration.
    expect(a.operationalAdapterBindingDigest).toBe(b.operationalAdapterBindingDigest)
  })

  it('ONE changed observed state is enough to move the confirmation', () => {
    const base = REVIEWED_PRODUCERS.map(
      label => ({ label, installation: 'installed-unloaded' as const }))
    const one = base.map((o, n) => n === 0
      ? { ...o, installation: 'installed-loaded' as const } : o)
    expect(confirmationToken(EXEC({ modeObservationDigest: modeObservationDigest(base) })))
      .not.toBe(confirmationToken(EXEC({ modeObservationDigest: modeObservationDigest(one) })))
  })

  it('the observation digest is a REQUIRED field of ExecutionBinding', () => {
    // STRUCTURAL, AND IT HAS TO BE. Making the field optional
    // (`modeObservationDigest?: string`) changes nothing a runtime test can see:
    // every fixture still supplies it, and the validator still throws on
    // undefined. What optionality actually does is let a FUTURE caller omit it
    // and compile — which is the whole hole this field closes. Measured: the
    // mutation survived every behavioural control.
    const src = readFileSync(
      new URL('../src/pg-copy/bindings.ts', import.meta.url), 'utf-8')
    const iface = src.slice(src.indexOf('export interface ExecutionBinding'),
                            src.indexOf('export function executionBindingDocument'))
    expect(iface).toContain('readonly modeObservationDigest: string')
    expect(iface).not.toContain('modeObservationDigest?')
    // Non-vacuity: the slice really is the interface.
    expect(iface).toContain('readonly operationalAdapterBindingDigest: string')
  })

  it('the execution document CARRIES the observation digest and validates it', () => {
    const doc = JSON.parse(canonicalJson(executionBindingDocument(EXEC()))) as
      Record<string, unknown>
    expect(doc.mode_observation_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(doc.binding_version).toBe(3)
    for (const bad of ['', 'nothex', 'a'.repeat(63), 'A'.repeat(64)]) {
      expect(() => executionBindingDocument(EXEC({ modeObservationDigest: bad })), bad).toThrow()
    }
  })

  it('binds the post-restoration policy by PATH AND HASH, not by mention', () => {
    const doc = JSON.parse(canonicalJson(operationalBindingDocument(OPS()))) as
      Record<string, never>
    const policy = doc.post_restoration_policy as Record<string, unknown>
    expect(policy.path).toBe('/Users/x/policy/post-restoration.json')
    expect(policy.sha256).toBe(hex('policy'))
  })

  it('REFUSES anything that could carry a credential', () => {
    // A sanitized field with userinfo punctuation in it is a leak, whatever it
    // is called.
    for (const v of [
      { producers: REVIEWED_PRODUCERS.map((l, n) =>
          producer(l, n === 0 ? { databaseHost: 'user@host' } : {})) },
      { producers: REVIEWED_PRODUCERS.map((l, n) =>
          producer(l, n === 0 ? { databaseHost: 'host:5432' } : {})) },
      { producers: REVIEWED_PRODUCERS.map((l, n) =>
          producer(l, n === 0 ? { databaseName: 'db@x' } : {})) },
      { sourceEndpoint: 'postgres://host/db' },
      { redisHost: 'redis://localhost' },
    ] as Array<Partial<OperationalAdapterBinding>>) {
      expect(() => operationalBindingDigest(OPS(v)), JSON.stringify(v).slice(0, 60))
        .toThrow(BindingRefused)
    }
  })

  it('refuses a duplicated label and an unreviewed disposition', () => {
    expect(() => operationalBindingDigest(OPS({
      producers: [producer('a.b'), producer('a.b')],
    }))).toThrow(BindingRefused)
    expect(() => operationalBindingDigest(OPS({
      producers: [producer('a.b', { disposition: 'nonsense' as never })],
    }))).toThrow(BindingRefused)
  })
})

describe('mode-bound tokens', () => {
  it('a rehearsal token fails the APPLY SYNTAX before any comparison', () => {
    const rehearse = confirmationToken(EXEC({ mode: 'rehearse' }))
    expect(rehearse.startsWith(REHEARSE_PREFIX)).toBe(true)
    expect(TOKEN_PATTERN.apply.test(rehearse)).toBe(false)
    // The refusal names the SYNTAX, not a mismatch: two different problems.
    try {
      assertConfirmationMatches(rehearse, EXEC({ mode: 'apply', copyBindingDigest: hex('c') }),
                                'apply')
      throw new Error('expected a refusal')
    } catch (e) {
      expect((e as BindingRefused).reason)
        .toBe('the confirmation is not in the reviewed form for this mode')
    }
  })

  it('an apply token is accepted only for apply, and only unchanged', () => {
    const b = EXEC({ mode: 'apply', copyBindingDigest: hex('copy') })
    const token = confirmationToken(b)
    expect(token.startsWith(APPLY_PREFIX)).toBe(true)
    expect(() => assertConfirmationMatches(token, b, 'apply')).not.toThrow()
    // A STALE token: the copy binding moved.
    expect(() => assertConfirmationMatches(
      token, { ...b, copyBindingDigest: hex('other') }, 'apply'))
      .toThrow(/does not match this run/)
    // And it is not a rehearsal token.
    expect(TOKEN_PATTERN.rehearse.test(token)).toBe(false)
  })

  it('every execution field changes the token', () => {
    const base = confirmationToken(EXEC())
    const variants: Array<Partial<ExecutionBinding>> = [
      { operationalAdapterBindingDigest: hex('other-ops') },
      { runId: 'ffffffff' },
      { stamp: '20260925T091501Z' },
      { modeAuthorizationDigest: hex('other-auth') },
    ]
    const seen = new Set([base])
    for (const v of variants) seen.add(confirmationToken(EXEC(v)))
    expect(seen.size).toBe(variants.length + 1)
    // Mode changes both the prefix and the digest.
    const applyToken = confirmationToken(EXEC({ mode: 'apply', copyBindingDigest: hex('c') }))
    expect(applyToken.slice(APPLY_PREFIX.length)).not.toBe(base.slice(REHEARSE_PREFIX.length))
  })

  it('an APPLY without a copy binding is refused', () => {
    expect(() => executionBindingDocument(EXEC({ mode: 'apply', copyBindingDigest: null })))
      .toThrow(BindingRefused)
  })
})

describe('the rehearsal review proves the OPERATIONAL binding only', () => {
  it('accepts an unchanged operational world', () => {
    const digest = operationalBindingDigest(OPS())
    expect(() => assertOperationalBindingUnchanged(digest, OPS())).not.toThrow()
  })

  it('refuses a changed one', () => {
    const digest = operationalBindingDigest(OPS())
    expect(() => assertOperationalBindingUnchanged(digest, OPS({ redisPort: '6380' })))
      .toThrow(/does not match the reviewed rehearsal/)
  })

  it('does NOT bind the Stage-1 bundle or the content root', () => {
    // The whole point: a real copy runs against a bundle that did not exist
    // when the rehearsal ran, and requiring those to match would make every
    // rehearsal invalid the moment it became useful.
    const doc = canonicalJson(operationalBindingDocument(OPS()))
    expect(doc).not.toContain('source-manifest-')
    expect(doc).not.toContain(COPY().contentRootDigest)
    expect(doc).not.toContain(COPY().copySetDigest)
    expect(doc).not.toContain('bundle')
  })
})

// ---------------------------------------------------------------------------
// WHAT THE MUTATION MATRIX FOUND MISSING
// ---------------------------------------------------------------------------

describe('the two token syntaxes are disjoint', () => {
  it('the apply pattern rejects a REHEARSE token, and the reverse', () => {
    // M01. The whole point of two prefixes is that a token for the wrong mode
    // fails the SYNTAX - before any digest is computed, and therefore with a
    // refusal an operator can act on rather than a mismatch that reads stale.
    const digest = 'f'.repeat(64)
    expect(TOKEN_PATTERN.apply.test(`${REHEARSE_PREFIX}${digest}`)).toBe(false)
    expect(TOKEN_PATTERN.rehearse.test(`${APPLY_PREFIX}${digest}`)).toBe(false)
    expect(TOKEN_PATTERN.apply.test(`${APPLY_PREFIX}${digest}`)).toBe(true)
    expect(TOKEN_PATTERN.rehearse.test(`${REHEARSE_PREFIX}${digest}`)).toBe(true)
  })

  it('refuses a token whose binding names a different mode than the caller', () => {
    // M03. The supplied token is in the reviewed form for `rehearse` AND the
    // binding computes to it - what is wrong is that the binding says `apply`.
    // Without the `b.mode !== mode` check this passes, and an apply binding is
    // confirmed by a rehearsal's paperwork.
    const applyBinding = EXEC({ mode: 'apply', copyBindingDigest: copyBindingDigest(COPY()) })
    const applyToken = confirmationToken(applyBinding)
    const crossed = applyToken.replace(APPLY_PREFIX, REHEARSE_PREFIX)
    // AND FOR THE RIGHT REASON. Without the `b.mode !== mode` check the digest
    // comparison still refuses - the prefix is inside the compared string - but
    // it refuses with "does not match this run", which sends the operator
    // looking for a stale token when what is actually wrong is that the binding
    // and the mode disagree.
    expect(() => assertConfirmationMatches(crossed, applyBinding, 'rehearse'))
      .toThrow(/not in the reviewed form for this mode/)
  })

  it('the mode is IN the digest, not only in the prefix', () => {
    // M04. If the document omitted `mode`, these two would digest identically
    // and the prefixes would be decoration over one shared secret.
    const rehearse = confirmationToken(EXEC())
    const apply = confirmationToken(
      EXEC({ mode: 'apply', copyBindingDigest: copyBindingDigest(COPY()) }))
    expect(rehearse.slice(REHEARSE_PREFIX.length))
      .not.toBe(apply.slice(APPLY_PREFIX.length))
    // And with the copy binding held equal, the mode alone still separates them.
    const doc = JSON.stringify(executionBindingDocument(EXEC()))
    expect(doc).toContain('"mode":"rehearse"')
  })
})

describe('the operational binding covers what it claims to', () => {
  it('changes when a single producer changes, at every position', () => {
    // M07. A binding whose producer list did not reach the digest would be
    // unchanged by a producer repointed at another database.
    const base = operationalBindingDigest(OPS())
    for (let n = 0; n < REVIEWED_PRODUCERS.length; n += 1) {
      const producers = REVIEWED_PRODUCERS.map((l, k) => k === n
        ? producer(l, { disposition: 'writes-another-reviewed-database',
                        databaseName: 'somewhere_else' })
        : producer(l))
      expect(operationalBindingDigest(OPS({ producers })), String(n)).not.toBe(base)
      // AND THE PROCESS POLICY IS ORDERED WITH THE PRODUCERS. A policy whose
      // entry `n` names a different label than producer `n` is a policy about
      // some other arrangement of the same set.
      expect(() => operationalBindingDigest(OPS({
        producerProcessPolicy: [...OPS().producerProcessPolicy].reverse(),
      }))).toThrow(BindingRefused)
    }
    // AND ORDER IS PART OF IT: the stop sequence is what is being agreed to.
    const reversed = [...REVIEWED_PRODUCERS].reverse()
    expect(operationalBindingDigest(OPS({
      producers: reversed.map(l => producer(l)),
      producerProcessPolicy: reversed.map(l => ({ label: l, pattern: `pattern-for-${l}` })),
    }))).not.toBe(base)
  })

  it('changes when any Redis coordinate changes', () => {
    // M08. Two different Redis instances must not share one binding.
    const base = operationalBindingDigest(OPS())
    for (const over of [{ redisHost: '127.0.0.1' }, { redisPort: '6380' },
                        { redisDatabase: '1' }]) {
      expect(operationalBindingDigest(OPS(over)), JSON.stringify(over)).not.toBe(base)
    }
  })

  it('the comparison refuses a world that has moved, field by field', () => {
    // M09, at the unit level rather than only through the CLI.
    const digest = operationalBindingDigest(OPS())
    expect(() => assertOperationalBindingUnchanged(digest, OPS())).not.toThrow()
    for (const over of [{ redisPort: '6380' }, { producerAuthority: 'launchd-stop' },
                        { pausedIsBlocking: false },
                        { postRestorationPolicySha256: hex('edited') }]) {
      expect(() => assertOperationalBindingUnchanged(digest, OPS(over)),
             JSON.stringify(over)).toThrow(BindingRefused)
    }
  })
})

describe('the copy binding document names three endpoint facts, not one', () => {
  it('carries the requested selector, the server address and the transport', () => {
    // K1.3-D. One `targetEndpoint` conflated what the operator asked for with
    // what the server reports, and was being filled from
    // `unix_socket_directories` - the server's configured LIST, which needs
    // `pg_read_all_settings` and names no session's actual path.
    const doc = JSON.parse(JSON.stringify(copyBindingDocument(COPY()))) as {
      binding_shape_version: number
      expected_target: Record<string, unknown>
    }
    expect(doc.binding_shape_version).toBe(COPY_BINDING_SHAPE_VERSION)
    for (const k of ['requested_endpoint', 'server_address', 'unix_transport',
                     'role', 'session_user']) {
      expect(Object.prototype.hasOwnProperty.call(doc.expected_target, k), k).toBe(true)
    }
    // AND THE OLD CONFLATED NAME IS GONE.
    expect(Object.prototype.hasOwnProperty.call(doc.expected_target, 'endpoint')).toBe(false)
    expect(JSON.stringify(doc)).not.toContain('unix_socket_directories')
  })

  it('refuses a binding whose shape version is not the reviewed one', () => {
    // A token from the old shape must not match the new one: they describe
    // different things under the same field names.
    for (const v of [1, 3, 0, -1]) {
      expect(() => copyBindingDocument(COPY({ bindingShapeVersion: v })), String(v))
        .toThrow(BindingRefused)
    }
    expect(() => copyBindingDocument(COPY())).not.toThrow()
  })

  it('refuses a binding that contradicts itself about its transport', () => {
    // A Unix session has no server address and a TCP one must have one. A
    // binding claiming both, or neither, describes no session that can exist.
    expect(() => copyBindingDocument(COPY({
      targetUnixTransport: true, targetServerAddress: '127.0.0.1',
    }))).toThrow(BindingRefused)
    expect(() => copyBindingDocument(COPY({
      targetUnixTransport: false, targetServerAddress: null,
    }))).toThrow(BindingRefused)
    // AND BOTH COHERENT COMBINATIONS ARE ACCEPTED, with different digests.
    const unix = copyBindingDigest(COPY({
      targetUnixTransport: true, targetServerAddress: null,
    }))
    const tcp = copyBindingDigest(COPY({
      targetUnixTransport: false, targetServerAddress: '127.0.0.1',
    }))
    expect(unix).not.toBe(tcp)
  })
})
