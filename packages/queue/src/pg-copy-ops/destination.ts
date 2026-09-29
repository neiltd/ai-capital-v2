// WHERE EACH REVIEWED PRODUCER ACTUALLY WRITES.
//
// An earlier census classified producers by whether they HAVE a database
// credential. That answers the wrong question. What matters is which DATABASE
// the credential names: an agent holding a credential for some other database
// is not a writer to the copy source, and an agent nobody checked might be one.
//
// THE FOUR ANSWERS ARE CLOSED, and two of them are not destinations.
// "Destination unproved" is where a plist that cannot be read, a container that
// fails its checks, and a URL that will not parse all land, and it STOPS
// inspection, rehearsal and apply - a producer whose destination nobody
// established is a producer whose stopping nobody can justify either way.
// "Expected absent" is a label launchd does not have AND whose reviewed plist is
// not installed, whose evidence fields are all null because none of them was
// measured, and which may never be recorded as writing anywhere.
//
// AN UNLOADED LABEL WITH AN INSTALLED PLIST IS NOT THAT CASE. It classifies like
// any other installed agent - its plist is measured, its credential container is
// opened once, and its endpoint is compared with the copy source - because all
// of those things exist. Treating it as expected-absent is what dropped the
// four cutover agents' identities out of the binding entirely.
//
// ONE OPEN PER CREDENTIAL. The identity and the endpoint come from the SAME
// `OpenedContainer`. An earlier revision opened the file once for its
// `device:inode` and again to classify it, and between those two opens the name
// can be repointed: the recorded identity would then belong to one file and the
// recorded destination to another, which is exactly the substitution the
// identity exists to detect.
//
// NOTHING SECRET SURVIVES THIS MODULE. The URL is parsed in memory, classified,
// and dropped. What is published is the container's identity - path and
// device:inode - and the sanitized host, port and database. There is no "just
// the hash" concession: a digest of a credential is still an oracle for it.

import {
  stableInstallationOf,
  type AdapterContext, type DestinationDisposition, type InstallationState,
  type ProducerIdentity, type StableInstallation,
} from '@common/db/pg-copy'

import {
  inspectLabel, readDisabled, servedCheckoutOf, credentialPathOf,
  type LabelInspection, type LaunchdOptions,
} from './launchd.js'
import { openReviewedContainer, type OpenedContainer } from './secure-file.js'

export class DestinationRefused extends Error {
  constructor(readonly reason: string, readonly at: string | null = null) {
    super(`${reason}${at === null ? '' : ` (at ${at})`}`)
    this.name = 'DestinationRefused'
  }
}

/** A plist may never carry a database URL, a password or any userinfo. */
export const INLINE_URL = /postgres(ql)?:\/\//i
export const FORBIDDEN_ENV_KEY = /^(DATABASE_URL|[A-Za-z_]*_DATABASE_URL|PG[A-Za-z0-9_]*)$/i

/** The reviewed copy source, sanitized. What a destination is compared against. */
export interface ReviewedSourceEndpoint {
  readonly host: string
  readonly port: string
  readonly database: string
}

/** What the reviewed policy says about a label. */
export interface DestinationPolicyEntry {
  readonly label: string
  readonly expected: DestinationDisposition
  /**
   * The STABLE installation topology the policy expects. Compared, never inferred.
   *
   * DELIBERATELY NOT THE LAUNCHD STATE. The destination policy answers "is this
   * agent installed, and where does it write" - questions whose answers hold
   * across a restoration. Whether an installed agent is currently loaded,
   * disabled or unloaded is phase-specific, and the quiescence and
   * post-restoration policies own it: the rehearsal needs every producer STOPPED,
   * the restoration needs them BACK, and one document cannot require both.
   *
   * This was the whole blocker. A destination policy that named
   * `installed-unloaded` refused after the operator restored the agents, and one
   * that named `installed-loaded` refused before - with the binding digest moving
   * either way, so no single policy let a proved rehearsal reach its own review.
   */
  readonly installation: StableInstallation
}

/**
 * Refuse a plist that renders a database URL or any userinfo into itself.
 *
 * `launchctl print` shows an agent's environment to anyone who can run it, so a
 * URL here is a credential published to the whole user session.
 */
export function assertNoInlineCredential(parsed: Record<string, unknown>): void {
  const env = parsed.EnvironmentVariables
  if (env !== null && typeof env === 'object') {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (FORBIDDEN_ENV_KEY.test(k)) {
        throw new DestinationRefused('the plist carries a forbidden database key', k)
      }
      if (typeof v === 'string' && INLINE_URL.test(v)) {
        throw new DestinationRefused('the plist carries an inline database URL', k)
      }
      if (typeof v === 'string' && /:\/\/[^/@\s]*@/.test(v)) {
        throw new DestinationRefused('the plist carries inline userinfo', k)
      }
    }
  }
  const args = Array.isArray(parsed.ProgramArguments) ? parsed.ProgramArguments : []
  for (const a of args) {
    if (typeof a === 'string' && INLINE_URL.test(a)) {
      throw new DestinationRefused('the plist carries an inline database URL', 'ProgramArguments')
    }
  }
}

/** Sanitized destination fields. Never the URL, never userinfo. */
export interface SanitizedDestination {
  readonly host: string
  readonly port: string
  readonly database: string
}

/**
 * Classify an ALREADY-OPENED container and return only where it points.
 *
 * TAKES THE OPENED CONTAINER, NOT A PATH. That signature is the fix: a caller
 * cannot accidentally open the file a second time, because there is nothing
 * here to open it with. The parsed URL never leaves this function -
 * `url.username` and `url.password` are not read, not copied and not compared.
 */
export function classifyOpened(opened: OpenedContainer): SanitizedDestination {
  const raw = opened.text.endsWith('\n') ? opened.text.slice(0, -1) : opened.text
  if (raw.includes('\n') || raw.includes('\r') || raw.includes('\0')) {
    throw new DestinationRefused('the credential container is not a single URL')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new DestinationRefused('the credential container is not a single URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new DestinationRefused('the credential container is not a postgres URL')
  }
  // A SOCKET DIRECTORY ARRIVES ONE OF TWO WAYS: percent-encoded in the host
  // position (`postgres://u:p@%2Ftmp%2Fs/db`), or as a `host=` parameter with
  // the host position empty (`postgres:///db?host=/tmp/s`). The third spelling
  // an operator might reach for - userinfo with an empty host - is not a URL,
  // and lands in `destination-unproved` rather than being guessed at.
  const host = url.hostname === '' ? decodeURIComponent(url.searchParams.get('host') ?? '')
    : decodeURIComponent(url.hostname)
  const database = url.pathname.length > 1 ? decodeURIComponent(url.pathname.slice(1)) : ''
  return Object.freeze({
    host,
    port: url.port === '' ? '5432' : url.port,
    database,
  })
}

/** Kept for direct testing: opens once and classifies that one open. */
export function classifyContainer(path: string): SanitizedDestination {
  return classifyOpened(openReviewedContainer(path))
}

/**
 * The OBSERVED installation state a label's inspection establishes.
 *
 * ABSENCE FROM LAUNCHD IS TWO DIFFERENT STATES, and collapsing them was the
 * defect K5.2 fixed. `expected-absent` is reserved for an agent that is not
 * installed at all - no label AND no reviewed plist - because that state's
 * contract is that every evidence field is null. An agent whose exact reviewed
 * plist IS installed has a path, bytes, a served checkout, a credential container
 * and an endpoint; calling that `expected-absent` threw all of them away and left
 * a plist that could be replaced without moving the confirmation token.
 *
 * THIS IS THE TRANSIENT ANSWER. `stableInstallationOf` reduces it to the topology
 * the binding agrees to, and both are recorded: the observation is what evidence
 * and the post-restoration policy compare, the topology is what the digest covers.
 */
export function installationOf(seen: LabelInspection): InstallationState {
  if (seen.presence === 'absent') {
    return seen.installedUnloaded ? 'installed-unloaded' : 'expected-absent'
  }
  return seen.disabled ? 'installed-disabled' : 'installed-loaded'
}

/** The STABLE topology a label's inspection establishes. */
export function stableInstallationFor(seen: LabelInspection): StableInstallation {
  return stableInstallationOf(installationOf(seen))
}

/**
 * Prove where every reviewed label writes, and classify each one.
 *
 * AN ABSENT LABEL IS RECORDED AS ABSENT AND NOTHING ELSE. It gets null
 * evidence, the `expected-absent` disposition, and it must have been DECLARED
 * absent - the policy names both the installation state and the destination,
 * and both are compared with what was measured.
 */
export async function proveDestinations(
  labels: readonly string[], source: ReviewedSourceEndpoint,
  policy: readonly DestinationPolicyEntry[], o: LaunchdOptions, ctx: AdapterContext,
): Promise<readonly ProducerIdentity[]> {
  const declared = new Map(policy.map(p => [p.label, p]))
  const disabled = await readDisabled(o, ctx)
  const out: ProducerIdentity[] = []

  for (const label of labels) {
    const entry = declared.get(label)
    if (entry === undefined) {
      throw new DestinationRefused('a reviewed label has no policy entry', label)
    }
    const seen = await inspectLabel(label, o, ctx, disabled)
    const installation = installationOf(seen)
    const stableInstallation = stableInstallationOf(installation)

    // THE POLICY MUST HAVE SAID WHAT WAS FOUND. Topology first, because "this
    // agent is not installed" and "this agent writes nowhere we proved" are
    // different facts and only the first can be declared in advance.
    //
    // COMPARED ON THE STABLE VALUE. Comparing the observed state here is what
    // made the policy unsatisfiable across a restoration: the same reviewed
    // policy has to hold while the producers are stopped for the fence AND after
    // the operator brings them back.
    if (stableInstallation !== entry.installation) {
      throw new DestinationRefused(
        'a reviewed label is not in its declared installation topology', label)
    }

    // ONLY `expected-absent` TAKES THE NULL-EVIDENCE PATH. An installed-unloaded
    // agent falls through to the measurement below, because there is a real file
    // to name, real bytes to hash and a real destination to prove.
    if (stableInstallation === 'expected-absent') {
      if (entry.expected !== 'expected-absent') {
        throw new DestinationRefused(
          'an absent label may not be declared a writer to any database', label)
      }
      // EVERY EVIDENCE FIELD NULL. Nothing was measured, so nothing is said.
      out.push(Object.freeze({
        label,
        plistPath: null, plistSha256: null, plistDeviceInode: null,
        servedCheckout: null,
        installation, stableInstallation,
        credentialPath: null, credentialDeviceInode: null,
        databaseHost: null, databasePort: null, databaseName: null,
        disposition: 'expected-absent' as const,
      }))
      continue
    }

    // AN INSTALLED LABEL MAY NOT BE DECLARED ABSENT EITHER, and `installation`
    // already caught that; this is the destination half of the same rule. It
    // covers installed-unloaded as well: an installed plist is something, and
    // "writes nowhere, nothing measured" is not an answer available to it.
    if (entry.expected === 'expected-absent') {
      throw new DestinationRefused(
        'an installed label may not be declared absent', label)
    }

    let disposition: DestinationDisposition = 'destination-unproved'
    let credentialPath: string | null = null
    let credentialDeviceInode: string | null = null
    let sanitized: SanitizedDestination | null = null
    try {
      // THE PLIST `inspectLabel` ALREADY OPENED, HASHED AND PARSED. Re-reading
      // the path here would be a second open of a name, and the digest
      // recorded above would stop describing the document classified below.
      // This holds for installed-unloaded too: that path is measured from ONE
      // safe open in `probeReviewedPlist`, and this is the same document.
      const parsed = seen.plist
      if (parsed === null) {
        throw new DestinationRefused('an installed label produced no parsed plist', label)
      }
      assertNoInlineCredential(parsed)
      credentialPath = credentialPathOf(parsed)
      if (credentialPath === null) {
        // NO POSTGRESQL ROUTE, MEASURED - not accepted from the policy.
        //
        // This line used to read `disposition = entry.expected`, which made the
        // comparison below compare the policy with itself: whatever the operator
        // declared became what was "measured", so a plist that bound nothing
        // satisfied `writes-copy-source` and the refusal only surfaced later, as a
        // completeness check that could name no container. A measurement that
        // copies the expectation is not a measurement.
        //
        // WHAT THIS STATE ASSERTS, EXACTLY: this plist names no credential
        // container. `assertNoInlineCredential` has already refused an inline URL,
        // inline userinfo or a forbidden database key, so the absence is a real
        // absence and not an unexamined one. It asserts nothing about whether the
        // agent can cause a write - it can, by enqueueing - which is why it stays
        // in the stop order and both censuses.
        disposition = 'no-postgresql-route'
      } else {
        // ONE OPEN. Identity and endpoint from the same descriptor.
        const opened = openReviewedContainer(credentialPath)
        credentialDeviceInode = opened.identity.deviceInode
        sanitized = classifyOpened(opened)
        disposition = sanitized.host === source.host && sanitized.port === source.port &&
                      sanitized.database === source.database
          ? 'writes-copy-source'
          : 'writes-another-reviewed-database'
      }
    } catch (e) {
      if (e instanceof DestinationRefused &&
          (e.reason === 'the plist carries an inline database URL' ||
           e.reason === 'the plist carries inline userinfo' ||
           e.reason === 'the plist carries a forbidden database key')) {
        throw e
      }
      disposition = 'destination-unproved'
    }

    // THE POLICY MUST AGREE WITH WHAT WAS MEASURED. A producer classified
    // outside the fence has to have been declared outside it; it may never be
    // silently excluded by measurement alone.
    if (disposition !== entry.expected) {
      throw new DestinationRefused(
        'a reviewed label does not match its declared disposition', label)
    }
    if (disposition === 'destination-unproved') {
      throw new DestinationRefused('a reviewed label has an unproved destination', label)
    }

    // AND AN INSTALLED AGENT'S RECORD MUST BE COMPLETE **FOR ITS DISPOSITION**.
    // The binding validator requires exactly this shape; refusing here as well
    // means the refusal names the label and happens during the census, rather than
    // surfacing later as a document that will not validate.
    //
    // TWO SHAPES, AND EACH IS CHECKED AGAINST THE OTHER'S MISTAKE. A writer with
    // no container is the defect that stopped K6-A1; a no-route agent that somehow
    // bound one would mean the absence above was not real.
    if (stableInstallation === 'installed') {
      if (disposition === 'no-postgresql-route') {
        if (credentialPath !== null || credentialDeviceInode !== null || sanitized !== null) {
          throw new DestinationRefused(
            'a label with no PostgreSQL route bound a credential container', label)
        }
      } else if (credentialPath === null || credentialDeviceInode === null ||
                 sanitized === null) {
        throw new DestinationRefused(
          'an installed label bound no credential container or endpoint', label)
      }
    }

    out.push(Object.freeze({
      label,
      plistPath: seen.plistPath,
      plistSha256: seen.plistSha256,
      plistDeviceInode: seen.plistDeviceInode,
      servedCheckout: seen.servedCheckout ?? null,
      installation, stableInstallation,
      credentialPath,
      credentialDeviceInode,
      databaseHost: sanitized?.host ?? null,
      databasePort: sanitized?.port ?? null,
      databaseName: sanitized?.database ?? null,
      disposition,
    }))
  }
  return Object.freeze(out)
}

export { servedCheckoutOf }
