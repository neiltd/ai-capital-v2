// THE THREE THINGS AN OPERATOR IS AGREEING TO, AND WHY THEY ARE THREE.
//
// A single binding could not do this job. The prerequisite rehearsal proves the
// PRODUCTION ADAPTERS - the labels, their plists, where each one's credential
// actually points, the queues, the Redis endpoint, the evidence root - and it
// must stay valid while the thing being copied changes, because a real copy
// runs against a Stage-1 bundle that did not exist when the rehearsal ran. A
// binding that folded both together would be invalidated by the very act it
// exists to authorise.
//
// So:
//
//   CopyBinding                 WHAT is being copied. Recomputed fresh for every
//                               apply, and never bound by a rehearsal.
//   OperationalAdapterBinding   THE WORLD it is being copied in. Stable across
//                               rehearsal and apply; a rehearsal review proves
//                               equality of THIS and nothing else.
//   ExecutionBinding            ONE INVOCATION: the two digests above, the mode,
//                               the run and the authority for that mode.
//
// EVERY FIELD AFFECTS ITS DIGEST. That is asserted by tests that vary one field
// at a time, because a binding with a decorative field is a binding that lies
// about what it covers.
//
// TOKENS CARRY THEIR MODE IN THEIR SYNTAX, not merely in the bytes they hash.
// `PGCOPY-REHEARSE-…` fails the apply PATTERN before any comparison happens, so
// a rehearsal token pasted into an apply cannot even reach the digest check -
// which is the difference between a refusal an operator understands and a
// mismatch that reads like a stale token.

import { canonicalJson, sha256Hex, type Canonical } from './schema-contract.js'

export type CopyMode = 'rehearse' | 'apply'

export const REHEARSE_PREFIX = 'PGCOPY-REHEARSE-'
export const APPLY_PREFIX = 'PGCOPY-APPLY-'

export const TOKEN_PREFIX: Readonly<Record<CopyMode, string>> = Object.freeze({
  rehearse: REHEARSE_PREFIX,
  apply: APPLY_PREFIX,
})

export const TOKEN_PATTERN: Readonly<Record<CopyMode, RegExp>> = Object.freeze({
  rehearse: /^PGCOPY-REHEARSE-[0-9a-f]{64}$/,
  apply: /^PGCOPY-APPLY-[0-9a-f]{64}$/,
})

/** Bumped when any binding changes shape, so an old token cannot match a new one. */
/**
 * 2 since S4F-D5-K5.3, which moved the TRANSIENT launchd load state out of the
 * operational binding document and replaced it with the STABLE topology. A
 * document at version 1 and one at version 2 describe the same world with
 * different fields, so the digest must not be comparable across the change.
 */
export const BINDING_VERSION = 2

export class BindingRefused extends Error {
  constructor(readonly reason: BindingReason, readonly at: string | null = null) {
    super(`${reason}${at === null ? '' : ` (at ${at})`}`)
    this.name = 'BindingRefused'
  }
}

export type BindingReason =
  | 'a binding field is missing or not in the reviewed form'
  | 'the confirmation is not in the reviewed form for this mode'
  | 'the confirmation does not match this run'
  | 'the operational adapter binding does not match the reviewed rehearsal'

const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/
const SYSID = /^[1-9][0-9]{0,19}$/
const IDENT = /^[a-z_][a-z0-9_]*$/
const PORT = /^[1-9][0-9]{0,4}$/
const BOUNDED = /^[A-Za-z0-9/][A-Za-z0-9 ._:@/-]{0,119}$/
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/
const ABS_PATH = /^\/[^\0]{1,1023}$/
const DEV_INODE = /^\d{1,20}:\d{1,20}$/
const URL_SCHEME = /:\/\//

function need(ok: boolean, at: string): void {
  if (!ok) throw new BindingRefused('a binding field is missing or not in the reviewed form', at)
}

// ---------------------------------------------------------------------------
// A. CopyBinding — WHAT is being copied
// ---------------------------------------------------------------------------

/**
 * THE COPY BINDING'S SHAPE, VERSIONED.
 *
 * Bumped when the MEANING of a field changes, not merely when one is added.
 * Version 1 carried a single `targetEndpoint` that was whatever the caller had
 * typed on the command line; version 2 replaces it with three unambiguous
 * facts - the selector that was validated and connected with, the address the
 * server reports for itself, and whether the session arrived over a Unix
 * socket. A token from the old shape cannot match the new one, which is the
 * point: they describe different things under the same name.
 */
export const COPY_BINDING_SHAPE_VERSION = 2

export interface CopyBinding {
  readonly bindingShapeVersion: number
  readonly bundleName: string
  readonly digestFileDigest: string
  readonly sourceDatabase: string
  readonly sourceSystemIdentifier: string
  /** The EFFECTIVE role the export ran as, read from the Stage-1 manifest. */
  readonly sourceExportRole: string
  readonly sourceContractDigest: string
  readonly contentRootDigest: string
  readonly copySetDigest: string
  readonly provenanceHead: string
  readonly ingestionGitlink: string
  readonly reviewedTargetContractDigest: string
  readonly targetDatabase: string
  readonly targetSystemIdentifier: string
  readonly targetPort: string
  /**
   * THE SELECTOR, NOT A MEASUREMENT. The validated host or socket directory
   * this session was opened with - a fact about this invocation.
   */
  readonly targetRequestedEndpoint: string
  /**
   * `inet_server_addr()`, or null for a Unix socket. What the SERVER says.
   *
   * An earlier shape conflated this with the selector above and, worse, filled
   * it from `unix_socket_directories` - the server's configured LIST, which
   * names no session's actual path and needs `pg_read_all_settings` to read.
   */
  readonly targetServerAddress: string | null
  readonly targetUnixTransport: boolean
  /** The EFFECTIVE role the target session is running as. */
  readonly targetRole: string
  /** The AUTHENTICATED role. Differs from the above after `SET ROLE`. */
  readonly targetSessionUser: string
}

/**
 * The ordered copy set, folded into one value. A REORDER CHANGES IT.
 *
 * Order is part of what is agreed to: the copy walks the tables in this
 * sequence, and a set that folded order-independently would give the same
 * token to two different copies.
 */
export function copySetDigest(tables: readonly string[]): string {
  return sha256Hex(`pgcopy1|copyset|n=${tables.length}|${tables.join('|')}`)
}

export function copyBindingDocument(b: CopyBinding): Canonical {
  need(/^source-manifest-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(b.bundleName), 'bundleName')
  for (const [k, v] of [
    ['digestFileDigest', b.digestFileDigest], ['sourceContractDigest', b.sourceContractDigest],
    ['contentRootDigest', b.contentRootDigest], ['copySetDigest', b.copySetDigest],
    ['reviewedTargetContractDigest', b.reviewedTargetContractDigest],
  ] as const) need(HEX64.test(v), k)
  for (const [k, v] of [
    ['provenanceHead', b.provenanceHead], ['ingestionGitlink', b.ingestionGitlink],
  ] as const) need(HEX40.test(v), k)
  for (const [k, v] of [
    ['sourceSystemIdentifier', b.sourceSystemIdentifier],
    ['targetSystemIdentifier', b.targetSystemIdentifier],
  ] as const) need(SYSID.test(v) && BigInt(v) < 18446744073709551616n, k)
  for (const [k, v] of [
    ['sourceDatabase', b.sourceDatabase], ['sourceExportRole', b.sourceExportRole],
    ['targetDatabase', b.targetDatabase], ['targetRole', b.targetRole],
    ['targetSessionUser', b.targetSessionUser],
  ] as const) need(IDENT.test(v), k)
  need(PORT.test(b.targetPort), 'targetPort')
  need(b.bindingShapeVersion === COPY_BINDING_SHAPE_VERSION, 'bindingShapeVersion')
  need(BOUNDED.test(b.targetRequestedEndpoint) &&
       !URL_SCHEME.test(b.targetRequestedEndpoint), 'targetRequestedEndpoint')
  need(typeof b.targetUnixTransport === 'boolean', 'targetUnixTransport')
  // A UNIX SESSION HAS NO SERVER ADDRESS AND A TCP ONE MUST HAVE ONE. A
  // binding claiming both, or neither, describes no session that can exist.
  need(b.targetUnixTransport === (b.targetServerAddress === null), 'targetServerAddress')
  if (b.targetServerAddress !== null) {
    need(BOUNDED.test(b.targetServerAddress) && !URL_SCHEME.test(b.targetServerAddress),
         'targetServerAddress')
  }
  return {
    binding_version: BINDING_VERSION,
    binding_shape_version: b.bindingShapeVersion,
    evidence: { bundle_name: b.bundleName, digest_file_digest: b.digestFileDigest },
    source: {
      database: b.sourceDatabase,
      system_identifier: b.sourceSystemIdentifier,
      export_role: b.sourceExportRole,
      contract_digest: b.sourceContractDigest,
    },
    content: { root_digest: b.contentRootDigest, copy_set_digest: b.copySetDigest },
    provenance: { head: b.provenanceHead, ingestion_gitlink: b.ingestionGitlink },
    expected_target: {
      contract_digest: b.reviewedTargetContractDigest,
      database: b.targetDatabase,
      system_identifier: b.targetSystemIdentifier,
      port: b.targetPort,
      // THREE FACTS, NAMED SEPARATELY. What was asked for, what the server
      // says it is, and how the session got there.
      requested_endpoint: b.targetRequestedEndpoint,
      server_address: b.targetServerAddress,
      unix_transport: b.targetUnixTransport,
      role: b.targetRole,
      session_user: b.targetSessionUser,
    },
  }
}

export const copyBindingDigest = (b: CopyBinding): string =>
  sha256Hex(canonicalJson(copyBindingDocument(b)))

// ---------------------------------------------------------------------------
// B. OperationalAdapterBinding — THE WORLD it is copied in
// ---------------------------------------------------------------------------

/**
 * What a reviewed producer's credential was proved to point at. A CLOSED set.
 *
 * `expected-absent` IS NOT A DESTINATION, and that is why it is here. A label
 * launchd does not have has no credential to classify, and an earlier revision
 * recorded one anyway - a plist path built from a naming convention, a digest
 * of sixty-four zeroes, a served checkout of `/`, and whichever destination the
 * policy happened to declare. Every one of those is a measurement that was
 * never taken, written into a signed document as though it had been. The state
 * is named instead, its evidence fields are null, and a label in it may never
 * be called a writer to anything.
 */
export type DestinationDisposition =
  | 'writes-copy-source'
  | 'writes-another-reviewed-database'
  | 'destination-unproved'
  | 'expected-absent'

export const DESTINATION_DISPOSITIONS: readonly DestinationDisposition[] =
  Object.freeze(['writes-copy-source', 'writes-another-reviewed-database',
                 'destination-unproved', 'expected-absent'])

/** The two dispositions that assert a producer writes somewhere. */
export const MEASURED_DESTINATIONS: readonly DestinationDisposition[] =
  Object.freeze(['writes-copy-source', 'writes-another-reviewed-database'])

/**
 * Whether a reviewed agent is INSTALLED, which is a different question from
 * where it writes.
 *
 * The structured worker is the case that forced the distinction: its reviewed
 * state is `expected-absent` - it is not installed on this machine at all - and
 * reusing its DATABASE disposition to say so conflated "writes nowhere we
 * proved" with "is not there". The first is a refusal; the second is the
 * reviewed answer.
 *
 * `installed-unloaded` IS THE FOURTH STATE, AND IT WAS A REAL GAP. After a
 * runtime cutover the four reviewed plists sit installed on disk while their
 * labels are booted out. Asking launchctl alone yields "absent", and the
 * earlier three-state vocabulary collapsed that onto `expected-absent` - the
 * state reserved for an agent that is NOT THERE. The consequences were not
 * cosmetic: `expected-absent` nulls every evidence field by contract, so the
 * installed plist's path and digest, the checkout it serves, the credential
 * container it names and the database it would write to all dropped out of the
 * operational binding. A plist could then be replaced between two censuses
 * without moving the confirmation token, because nothing about it was bound.
 *
 * The distinction is therefore: `expected-absent` means launchd has no label
 * AND no reviewed plist exists; `installed-unloaded` means launchd has no label
 * but the exact reviewed plist IS present and was safely measured. Both are
 * quiescent with respect to launchd; only the second has anything to bind.
 */
export type InstallationState =
  | 'installed-loaded'
  | 'installed-disabled'
  | 'installed-unloaded'
  | 'expected-absent'

export const INSTALLATION_STATES: readonly InstallationState[] =
  Object.freeze(['installed-loaded', 'installed-disabled', 'installed-unloaded',
                 'expected-absent'])

/**
 * The installation states that carry a MEASURED plist, and therefore a complete
 * identity in the binding. Only `expected-absent` is outside this set.
 */
export const INSTALLED_STATES: readonly InstallationState[] =
  Object.freeze(['installed-loaded', 'installed-disabled', 'installed-unloaded'])

/**
 * THE STABLE INSTALLATION TOPOLOGY, which is what the operational binding binds.
 *
 * WHY THIS IS A SEPARATE VOCABULARY. K5.2 put the four-state observation into the
 * binding, and the binding is derived by EVERY CLI mode before dispatch. That
 * made a successful rehearsal impossible to finish:
 *
 *   - the reviewed policy required `installed-unloaded`, which is true before
 *     restoration and false after it;
 *   - leaving the policy alone made `deriveOperationalBinding` refuse before
 *     `--verify-restoration` could run at all;
 *   - changing it to `installed-loaded` changed the binding digest, and
 *     `runVerifyRestoration` then rejected it as a different world from the one
 *     the rehearsal was taken against.
 *
 * So the operator could not get from a proved rehearsal, through the manual
 * restoration the rehearsal exists to exercise, to the review that authorises an
 * apply - without falsifying the measured state or accepting two unrelated
 * binding digests. Neither is acceptable.
 *
 * The resolution is that `loaded`, `disabled` and `unloaded` are OBSERVATIONS
 * ABOUT LAUNCHD, not different installation topologies. What the binding agrees
 * to is whether the agent is installed at all, and - when it is - the full
 * identity of the file that is installed, the checkout it serves, the credential
 * container it names and the endpoint it reaches. None of those changes when an
 * operator bootstraps a label, which is exactly why they are what a binding that
 * must survive the restoration can safely contain.
 *
 * The observation is NOT erased. It is measured freshly at every phase, carried
 * on the same `ProducerIdentity`, published in evidence, compared against the
 * post-restoration policy, and - if a mode wants to pin it - digested separately
 * through `modeObservationDigest`.
 */
export type StableInstallation = 'installed' | 'expected-absent'

export const STABLE_INSTALLATIONS: readonly StableInstallation[] =
  Object.freeze(['installed', 'expected-absent'])

/**
 * The stable topology a transient observation implies.
 *
 * TOTAL OVER THE FOUR OBSERVED STATES, and deliberately not a default: a new
 * observed state added later must be classified here explicitly rather than
 * falling into `installed` because that is the larger bucket.
 */
export function stableInstallationOf(observed: InstallationState): StableInstallation {
  switch (observed) {
    case 'installed-loaded':
    case 'installed-disabled':
    case 'installed-unloaded':
      return 'installed'
    case 'expected-absent':
      return 'expected-absent'
  }
}

/** What an inspected label is, as far as the binding is concerned. NEVER a secret. */
export interface ProducerIdentity {
  readonly label: string
  /**
   * The installed plist, by absolute path and by the SHA-256 of its BYTES.
   *
   * NULL FOR AN ABSENT LABEL, and null is the honest value: there is no file to
   * name and no bytes to hash. A fabricated path and a zero digest would be
   * indistinguishable, in the binding document, from a real measurement.
   */
  readonly plistPath: string | null
  readonly plistSha256: string | null
  readonly plistDeviceInode: string | null
  /** The checkout that plist serves, read FROM the plist and never assumed. */
  readonly servedCheckout: string | null
  /**
   * THE OBSERVED launchd state, measured freshly at each phase.
   *
   * NOT PART OF THE BINDING DOCUMENT. It is the transient half: an operator
   * bootstrapping a label moves it from `installed-unloaded` to
   * `installed-loaded` without changing anything the binding agrees to. It is
   * still recorded here, published in evidence, and compared against the
   * post-restoration policy - `stableInstallation` replaces it in the binding,
   * it does not replace it in the truth.
   */
  readonly installation: InstallationState
  /**
   * THE STABLE TOPOLOGY, which IS what the binding document carries.
   *
   * `installed` when an exact reviewed plist exists and its full identity was
   * measured; `expected-absent` when there is no label and no plist. Invariant
   * with respect to loading, disabling and unloading, so the one intended
   * transition - `installed-unloaded` to `installed-loaded` across a manual
   * restoration - leaves the binding digest untouched.
   */
  readonly stableInstallation: StableInstallation
  /**
   * The credential CONTAINER, by identity only.
   *
   * A path and a `device:inode` say WHICH file was opened and whether it has
   * been replaced. They are not the credential, they do not hash the
   * credential, and no field here can be turned back into one.
   */
  readonly credentialPath: string | null
  readonly credentialDeviceInode: string | null
  /** Sanitized: host or socket directory, port, database. No userinfo, ever. */
  readonly databaseHost: string | null
  readonly databasePort: string | null
  readonly databaseName: string | null
  readonly disposition: DestinationDisposition
}

export interface OperationalAdapterBinding {
  readonly sourceEndpoint: string
  readonly sourceDatabase: string
  readonly sourceSystemIdentifier: string
  /** ORDERED. A reorder is a different stop sequence and a different binding. */
  readonly producers: readonly ProducerIdentity[]
  readonly queues: readonly string[]
  readonly blockingStates: readonly string[]
  readonly pausedIsBlocking: boolean
  readonly producerAuthority: string
  /**
   * THE PROCESS PATTERN EACH REVIEWED PRODUCER IS RECOGNISED BY.
   *
   * Part of the binding because it is part of what "quiescent" means. Asking
   * launchd whether a label is loaded establishes what LAUNCHD is running; a
   * producer somebody started from a terminal is invisible to that question
   * and entirely visible to the source. The patterns the census matched on are
   * therefore agreed to along with everything else - a changed pattern is a
   * changed definition of quiescence, and the token must move with it.
   */
  readonly producerProcessPolicy: readonly { label: string; pattern: string }[]
  /**
   * The structured worker's STABLE INSTALLATION, not its database destination and
   * not its current launchd state.
   *
   * These are different facts and the binding needs the stable one: whether that
   * agent exists on this machine at all is what decides whether its absence from
   * a quiescence census is expected or alarming, and that answer does not change
   * when other agents are loaded or unloaded around it.
   */
  readonly structuredWorkerInstallation: StableInstallation
  readonly redisHost: string
  readonly redisPort: string
  readonly redisDatabase: string
  readonly evidenceRoot: string
  readonly evidenceRootDeviceInode: string
  readonly postRestorationPolicyPath: string
  readonly postRestorationPolicySha256: string
  readonly implementationHead: string
}

export function operationalBindingDocument(b: OperationalAdapterBinding): Canonical {
  need(BOUNDED.test(b.sourceEndpoint) && !URL_SCHEME.test(b.sourceEndpoint), 'sourceEndpoint')
  need(IDENT.test(b.sourceDatabase), 'sourceDatabase')
  need(SYSID.test(b.sourceSystemIdentifier), 'sourceSystemIdentifier')
  need(b.producers.length > 0, 'producers')
  need(b.queues.length > 0, 'queues')
  need(b.blockingStates.length > 0, 'blockingStates')
  need(typeof b.pausedIsBlocking === 'boolean', 'pausedIsBlocking')
  need(LABEL.test(b.producerAuthority), 'producerAuthority')
  need(STABLE_INSTALLATIONS.includes(b.structuredWorkerInstallation),
       'structuredWorkerInstallation')
  need(b.producerProcessPolicy.length === b.producers.length, 'producerProcessPolicy')
  b.producerProcessPolicy.forEach((e, n) => {
    need(LABEL.test(e.label), `producerProcessPolicy[${n}].label`)
    need(e.label === b.producers[n]?.label, `producerProcessPolicy[${n}].label`)
    need(typeof e.pattern === 'string' && e.pattern.length > 0 && e.pattern.length <= 200,
         `producerProcessPolicy[${n}].pattern`)
  })
  need(BOUNDED.test(b.redisHost) && !URL_SCHEME.test(b.redisHost), 'redisHost')
  need(PORT.test(b.redisPort), 'redisPort')
  need(/^\d{1,5}$/.test(b.redisDatabase), 'redisDatabase')
  need(ABS_PATH.test(b.evidenceRoot), 'evidenceRoot')
  need(DEV_INODE.test(b.evidenceRootDeviceInode), 'evidenceRootDeviceInode')
  need(ABS_PATH.test(b.postRestorationPolicyPath), 'postRestorationPolicyPath')
  need(HEX64.test(b.postRestorationPolicySha256), 'postRestorationPolicySha256')
  need(HEX40.test(b.implementationHead), 'implementationHead')

  const seen = new Set<string>()
  const producers = b.producers.map((p, n) => {
    need(LABEL.test(p.label), `producers[${n}].label`)
    need(!seen.has(p.label), `producers[${n}].label duplicated`)
    seen.add(p.label)
    need(INSTALLATION_STATES.includes(p.installation), `producers[${n}].installation`)
    need(STABLE_INSTALLATIONS.includes(p.stableInstallation), `producers[${n}].stableInstallation`)
    need(DESTINATION_DISPOSITIONS.includes(p.disposition), `producers[${n}].disposition`)

    // THE OBSERVED STATE AND THE STABLE TOPOLOGY MUST AGREE. They are two
    // records of one world; a producer that claims to be installed-loaded while
    // its stable topology says expected-absent has had one of the two written by
    // something other than measurement.
    need(stableInstallationOf(p.installation) === p.stableInstallation,
         `producers[${n}].stableInstallation`)

    // AN ABSENT LABEL HAS NOTHING MEASURED AND SAYS SO. Every evidence field
    // must be null together: a half-filled record is a record that claims one
    // measurement was taken and another was not, for a label nobody looked at.
    //
    // KEYED OFF THE STABLE VALUE, because that is what the document carries.
    const absent = p.stableInstallation === 'expected-absent'
    need(absent === (p.disposition === 'expected-absent'), `producers[${n}].disposition`)
    if (absent) {
      for (const [k, v] of [['plistPath', p.plistPath], ['plistSha256', p.plistSha256],
                            ['plistDeviceInode', p.plistDeviceInode],
                            ['servedCheckout', p.servedCheckout],
                            ['credentialPath', p.credentialPath],
                            ['credentialDeviceInode', p.credentialDeviceInode],
                            ['databaseHost', p.databaseHost],
                            ['databasePort', p.databasePort],
                            ['databaseName', p.databaseName]] as const) {
        need(v === null, `producers[${n}].${k}`)
      }
    } else {
      need(p.plistPath !== null && ABS_PATH.test(p.plistPath), `producers[${n}].plistPath`)
      need(p.plistSha256 !== null && HEX64.test(p.plistSha256), `producers[${n}].plistSha256`)
      need(p.plistDeviceInode !== null && DEV_INODE.test(p.plistDeviceInode),
           `producers[${n}].plistDeviceInode`)
      need(p.servedCheckout !== null && ABS_PATH.test(p.servedCheckout),
           `producers[${n}].servedCheckout`)
      // AND A PRESENT LABEL MAY NOT BORROW THE ABSENT STATE'S DISPOSITION.
      need(p.disposition !== 'expected-absent', `producers[${n}].disposition`)
      need(INSTALLED_STATES.includes(p.installation), `producers[${n}].installation`)
      need(p.stableInstallation === 'installed', `producers[${n}].stableInstallation`)

      // AN INSTALLED AGENT BINDS A **COMPLETE** IDENTITY.
      //
      // This is the whole reason the state exists. The defect it closes was not
      // that the binding said the wrong word; it was that the word it said
      // carried a contract of all-nulls, so the installed plist, the checkout it
      // serves, the credential container it names and the endpoint it would
      // write to were absent from the document the confirmation token covers.
      // Requiring every one of them here is what makes a plist swap, a checkout
      // change, a credential-container replacement or an endpoint change move
      // the token instead of passing unnoticed.
      if (p.stableInstallation === 'installed') {
        need(p.credentialPath !== null, `producers[${n}].credentialPath`)
        need(p.credentialDeviceInode !== null, `producers[${n}].credentialDeviceInode`)
        need(p.databaseHost !== null, `producers[${n}].databaseHost`)
        need(p.databasePort !== null, `producers[${n}].databasePort`)
        need(p.databaseName !== null, `producers[${n}].databaseName`)
        // An installed-but-unloaded agent has been measured, so its destination
        // is a measured one. `destination-unproved` may not hide here.
        need(MEASURED_DESTINATIONS.includes(p.disposition), `producers[${n}].disposition`)
      }
    }
    if (p.credentialPath !== null) {
      need(ABS_PATH.test(p.credentialPath), `producers[${n}].credentialPath`)
      need(p.credentialDeviceInode !== null && DEV_INODE.test(p.credentialDeviceInode),
           `producers[${n}].credentialDeviceInode`)
    }
    for (const [k, v] of [['databaseHost', p.databaseHost], ['databasePort', p.databasePort],
                          ['databaseName', p.databaseName]] as const) {
      if (v === null) continue
      need(!URL_SCHEME.test(v) && v.length <= 200, `producers[${n}].${k}`)
      // A userinfo separator in a sanitized field means a credential leaked.
      need(!v.includes('@') && !v.includes(':') , `producers[${n}].${k}`)
    }
    return {
      label: p.label,
      // THE STABLE TOPOLOGY ONLY. The observed launchd state is deliberately NOT
      // serialized here: including it is what made the binding digest move when
      // an operator bootstrapped a label, which is the defect this version fixes.
      // A mode that needs to pin what it observed uses `modeObservationDigest`.
      stable_installation: p.stableInstallation,
      plist: p.plistPath === null ? null
        : { path: p.plistPath, sha256: p.plistSha256, device_inode: p.plistDeviceInode },
      served_checkout: p.servedCheckout,
      credential: p.credentialPath === null ? null
        : { path: p.credentialPath, device_inode: p.credentialDeviceInode },
      database: { host: p.databaseHost, port: p.databasePort, name: p.databaseName },
      disposition: p.disposition,
    }
  })

  return {
    binding_version: BINDING_VERSION,
    source: {
      endpoint: b.sourceEndpoint,
      database: b.sourceDatabase,
      system_identifier: b.sourceSystemIdentifier,
    },
    // ORDERED ARRAYS, not sets: the stop sequence is part of what is agreed to.
    producers,
    queues: [...b.queues],
    blocking_policy: { states: [...b.blockingStates], paused_is_blocking: b.pausedIsBlocking },
    producer_authority: b.producerAuthority,
    structured_worker_installation: b.structuredWorkerInstallation,
    producer_process_policy: b.producerProcessPolicy.map(e => ({ ...e })),
    // SANITIZED ONLY. No userinfo field exists here to be filled in.
    redis: { host: b.redisHost, port: b.redisPort, database: b.redisDatabase },
    evidence_root: { path: b.evidenceRoot, device_inode: b.evidenceRootDeviceInode },
    post_restoration_policy: {
      path: b.postRestorationPolicyPath, sha256: b.postRestorationPolicySha256,
    },
    implementation_head: b.implementationHead,
  }
}

export const operationalBindingDigest = (b: OperationalAdapterBinding): string =>
  sha256Hex(canonicalJson(operationalBindingDocument(b)))

/**
 * THE TRANSIENT OBSERVATION, PINNED SEPARATELY.
 *
 * Requirement: confirmation integrity must not be weakened by moving the launchd
 * state out of the stable binding. So the observation is not dropped, it is
 * digested on its own. A mode that wants its token to cover "and these are the
 * states I actually saw" mixes this digest in; the STABLE binding digest stays
 * invariant across the loaded/unloaded transition either way.
 *
 * ORDERED, and the order is the reviewed producer order, so a reordered census
 * is a different observation rather than the same one shuffled.
 */
export interface ObservedProducerState {
  readonly label: string
  readonly installation: InstallationState
}

export function modeObservationDocument(
  observed: readonly ObservedProducerState[],
): Canonical {
  need(observed.length > 0, 'observed')
  const seen = new Set<string>()
  return {
    binding_version: BINDING_VERSION,
    observed: observed.map((o, n) => {
      need(LABEL.test(o.label), `observed[${n}].label`)
      need(!seen.has(o.label), `observed[${n}].label duplicated`)
      seen.add(o.label)
      need(INSTALLATION_STATES.includes(o.installation), `observed[${n}].installation`)
      return { label: o.label, installation: o.installation }
    }),
  }
}

export const modeObservationDigest = (observed: readonly ObservedProducerState[]): string =>
  sha256Hex(canonicalJson(modeObservationDocument(observed)))

// ---------------------------------------------------------------------------
// C. ExecutionBinding — ONE invocation
// ---------------------------------------------------------------------------

export interface ExecutionBinding {
  /** Absent for a rehearsal: there is no copy to bind. */
  readonly copyBindingDigest: string | null
  readonly operationalAdapterBindingDigest: string
  readonly mode: CopyMode
  readonly runId: string
  readonly stamp: string
  readonly modeAuthorizationDigest: string
}

export function executionBindingDocument(b: ExecutionBinding): Canonical {
  need(b.mode === 'rehearse' || b.mode === 'apply', 'mode')
  need(b.copyBindingDigest === null || HEX64.test(b.copyBindingDigest), 'copyBindingDigest')
  // An APPLY without a copy binding would bind the operational world and leave
  // the thing being copied unnamed.
  need(b.mode !== 'apply' || b.copyBindingDigest !== null, 'copyBindingDigest')
  need(HEX64.test(b.operationalAdapterBindingDigest), 'operationalAdapterBindingDigest')
  need(HEX64.test(b.modeAuthorizationDigest), 'modeAuthorizationDigest')
  need(/^[0-9a-f]{8}$/.test(b.runId), 'runId')
  need(/^\d{8}T\d{6}Z$/.test(b.stamp), 'stamp')
  return {
    binding_version: BINDING_VERSION,
    copy_binding_digest: b.copyBindingDigest,
    operational_adapter_binding_digest: b.operationalAdapterBindingDigest,
    mode: b.mode,
    run: { id: b.runId, stamp: b.stamp },
    mode_authorization_digest: b.modeAuthorizationDigest,
  }
}

/** The token an operator pastes back. Its MODE is part of its syntax. */
export function confirmationToken(b: ExecutionBinding): string {
  return `${TOKEN_PREFIX[b.mode]}${sha256Hex(canonicalJson(executionBindingDocument(b)))}`
}

/**
 * Compare a supplied confirmation with the one this run computes, FOR THIS MODE.
 *
 * THE SYNTAX CHECK COMES FIRST, and it is the whole point of the two prefixes:
 * a rehearsal token offered to an apply fails `TOKEN_PATTERN.apply` before a
 * digest is computed, so the refusal says "not in the reviewed form for this
 * mode" rather than "does not match this run" - two different problems that
 * would otherwise be indistinguishable to whoever is holding the token.
 *
 * NEVER ECHOES WHAT IT WAS GIVEN, and compares length-independently, so the
 * comparison itself says nothing either.
 */
export function assertConfirmationMatches(
  supplied: string, b: ExecutionBinding, mode: CopyMode,
): void {
  if (typeof supplied !== 'string' || !TOKEN_PATTERN[mode].test(supplied)) {
    throw new BindingRefused('the confirmation is not in the reviewed form for this mode')
  }
  if (b.mode !== mode) {
    throw new BindingRefused('the confirmation is not in the reviewed form for this mode')
  }
  const expected = confirmationToken(b)
  let diff = supplied.length ^ expected.length
  for (let i = 0; i < supplied.length; i += 1) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i % expected.length)
  }
  if (diff !== 0) throw new BindingRefused('the confirmation does not match this run')
}

/**
 * The rehearsal review authorises ONE transition, and proves ONE equality.
 *
 * Operational binding only. The Stage-1 bundle and the content root are
 * deliberately absent from this comparison: a real copy runs against a bundle
 * that did not exist when the rehearsal ran, and requiring those to match would
 * make every rehearsal invalid the moment it became useful.
 */
export function assertOperationalBindingUnchanged(
  reviewedDigest: string, current: OperationalAdapterBinding,
): void {
  if (!HEX64.test(reviewedDigest) || operationalBindingDigest(current) !== reviewedDigest) {
    throw new BindingRefused(
      'the operational adapter binding does not match the reviewed rehearsal')
  }
}
