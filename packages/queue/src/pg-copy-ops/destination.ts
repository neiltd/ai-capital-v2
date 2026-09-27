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
// "Expected absent" is a label launchd does not have, whose evidence fields are
// all null because none of them was measured, and which may never be recorded
// as writing anywhere.
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

import type {
  AdapterContext, DestinationDisposition, InstallationState, ProducerIdentity,
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
  /** The installation state the policy expects. Compared, never inferred. */
  readonly installation: InstallationState
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

/** The installation state a label's inspection establishes. */
export function installationOf(seen: LabelInspection): InstallationState {
  if (seen.presence === 'absent') return 'expected-absent'
  return seen.disabled ? 'installed-disabled' : 'installed-loaded'
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

    // THE POLICY MUST HAVE SAID WHAT WAS FOUND. Installation first, because
    // "this agent is not installed" and "this agent writes nowhere we proved"
    // are different facts and only the first can be declared in advance.
    if (installation !== entry.installation) {
      throw new DestinationRefused(
        'a reviewed label is not in its declared installation state', label)
    }

    if (installation === 'expected-absent') {
      if (entry.expected !== 'expected-absent') {
        throw new DestinationRefused(
          'an absent label may not be declared a writer to any database', label)
      }
      // EVERY EVIDENCE FIELD NULL. Nothing was measured, so nothing is said.
      out.push(Object.freeze({
        label,
        plistPath: null, plistSha256: null, plistDeviceInode: null,
        servedCheckout: null,
        installation,
        credentialPath: null, credentialDeviceInode: null,
        databaseHost: null, databasePort: null, databaseName: null,
        disposition: 'expected-absent' as const,
      }))
      continue
    }

    // A PRESENT LABEL MAY NOT BE DECLARED ABSENT EITHER, and `installation`
    // already caught that; this is the destination half of the same rule.
    if (entry.expected === 'expected-absent') {
      throw new DestinationRefused(
        'a present label may not be declared absent', label)
    }

    let disposition: DestinationDisposition = 'destination-unproved'
    let credentialPath: string | null = null
    let credentialDeviceInode: string | null = null
    let sanitized: SanitizedDestination | null = null
    try {
      // THE PLIST `inspectLabel` ALREADY OPENED, HASHED AND PARSED. Re-reading
      // the path here would be a second open of a name, and the digest
      // recorded above would stop describing the document classified below.
      const parsed = seen.plist
      if (parsed === null) {
        throw new DestinationRefused('a loaded label produced no parsed plist', label)
      }
      assertNoInlineCredential(parsed)
      credentialPath = credentialPathOf(parsed)
      if (credentialPath === null) {
        // No PostgreSQL route at all. Its disposition is whatever the reviewed
        // policy declared, and it is compared below rather than assumed here.
        disposition = entry.expected
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

    out.push(Object.freeze({
      label,
      plistPath: seen.plistPath,
      plistSha256: seen.plistSha256,
      plistDeviceInode: seen.plistDeviceInode,
      servedCheckout: seen.servedCheckout ?? null,
      installation,
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
