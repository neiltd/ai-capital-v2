// THE CONFIRMATION TOKEN — what an operator is actually agreeing to.
//
// WHY A TOKEN AND NOT A YES/NO PROMPT. `--apply` alone would mean "do the thing
// you described a moment ago", and the operator has no way to know whether the
// thing described a moment ago is the thing about to happen. Between the
// inspection and the apply a source can be repointed, a bundle replaced, a
// different target named on the command line, or the implementation itself
// changed. A yes/no answer carries none of that; a token derived from all of it
// carries all of it, and the apply refuses unless the token it is handed
// matches the one it computes for itself from the state it is actually looking
// at RIGHT NOW.
//
// SO THE TOKEN IS A DIGEST, NOT A NONCE. Nothing is stored between the two
// runs. Inspect prints the digest of the binding; apply recomputes the binding
// from live values and compares. A stale token cannot match, because something
// in the binding has moved; a token from a DIFFERENT run cannot match either,
// because the bundle, the source and the target are all in it. There is no
// registry to keep in sync and nothing to expire.
//
// EVERY FIELD IS PUBLIC. A digest, a database name, a role name, a git head, a
// socket directory - not one of them is a credential, and the token is meant to
// be pasted into a terminal and read out over a call. That is a property worth
// keeping deliberately: a confirmation the operator cannot safely quote is a
// confirmation they will work around.

import { canonicalJson, sha256Hex, type Canonical } from './schema-contract.js'

/** The prefix an operator sees, so a bare digest is never mistaken for one. */
export const CONFIRMATION_PREFIX = 'PGCOPY-APPLY-'
export const CONFIRMATION_PATTERN = /^PGCOPY-APPLY-[0-9a-f]{64}$/

/** Bumped if the BINDING changes shape, so an old token cannot match a new one. */
export const CONFIRMATION_VERSION = 1

export class ConfirmationRefused extends Error {
  constructor(readonly reason: ConfirmationReason) {
    super(reason)
    this.name = 'ConfirmationRefused'
  }
}

export type ConfirmationReason =
  | 'a confirmation binding field is missing or not in the reviewed form'
  | 'the confirmation does not match this run'
  | 'the confirmation is not in the reviewed form'

const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/
const SYSID = /^[1-9][0-9]{0,19}$/
const IDENT = /^[a-z_][a-z0-9_]*$/
const BOUNDED = /^[A-Za-z0-9/][A-Za-z0-9 ._:@/-]{0,119}$/
const PORT = /^[1-9][0-9]{0,4}$/

/**
 * Everything the operator is agreeing to, named.
 *
 * Grouped by the question each group answers: WHICH EVIDENCE, WHICH SOURCE,
 * WHICH CONTENT, WHICH PROVENANCE, WHICH TARGET, WHICH CODE.
 */
export interface ConfirmationBinding {
  // WHICH EVIDENCE. The bundle by name, and its DIGEST file by digest - so a
  // bundle swapped for another, or edited in place, cannot carry the token.
  readonly bundleName: string
  readonly digestFileDigest: string

  // WHICH SOURCE. Identity as the source itself reported it.
  readonly sourceDatabase: string
  readonly sourceSystemIdentifier: string
  readonly sourceRole: string

  // WHICH CONTENT. The schema and the bytes, each by its own digest.
  readonly sourceContractDigest: string
  readonly contentRootDigest: string
  /** The ordered 21-table set, folded - so a reordering changes the token. */
  readonly copySetDigest: string

  // WHICH PROVENANCE.
  readonly provenanceHead: string
  readonly ingestionGitlink: string

  // WHICH TARGET. Stated by the operator and proved before the copy begins.
  readonly expectedTargetContractDigest: string
  readonly targetDatabase: string
  readonly targetSystemIdentifier: string
  readonly targetPort: string
  readonly targetEndpoint: string
  readonly targetRole: string

  // WHICH CODE.
  readonly implementationHead: string
}

/** The ordered copy set, folded into one value. A reorder changes it. */
export function copySetDigest(tables: readonly string[]): string {
  return sha256Hex(`pgcopy1|copyset|n=${tables.length}|${tables.join('|')}`)
}

function assertField(ok: boolean): void {
  if (!ok) {
    throw new ConfirmationRefused(
      'a confirmation binding field is missing or not in the reviewed form')
  }
}

export function assertBinding(b: ConfirmationBinding): ConfirmationBinding {
  for (const d of [b.digestFileDigest, b.sourceContractDigest, b.contentRootDigest,
                   b.copySetDigest, b.expectedTargetContractDigest]) {
    assertField(typeof d === 'string' && HEX64.test(d))
  }
  for (const h of [b.provenanceHead, b.ingestionGitlink, b.implementationHead]) {
    assertField(typeof h === 'string' && HEX40.test(h))
  }
  for (const s of [b.sourceSystemIdentifier, b.targetSystemIdentifier]) {
    assertField(typeof s === 'string' && SYSID.test(s) && BigInt(s) < 18446744073709551616n)
  }
  for (const n of [b.sourceDatabase, b.targetDatabase, b.sourceRole, b.targetRole]) {
    assertField(typeof n === 'string' && IDENT.test(n))
  }
  assertField(typeof b.targetPort === 'string' && PORT.test(b.targetPort))
  assertField(typeof b.targetEndpoint === 'string' && BOUNDED.test(b.targetEndpoint))
  assertField(typeof b.bundleName === 'string' &&
              /^source-manifest-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(b.bundleName))
  return b
}

/**
 * The binding as a canonical document. Sorted keys, no incidental whitespace.
 *
 * Built through the reviewed `canonicalJson` rather than a local join, so the
 * token cannot change because someone reformatted this file.
 */
export function bindingDocument(b: ConfirmationBinding): Canonical {
  assertBinding(b)
  return {
    confirmation_version: CONFIRMATION_VERSION,
    evidence: { bundle_name: b.bundleName, digest_file_digest: b.digestFileDigest },
    source: {
      database: b.sourceDatabase,
      system_identifier: b.sourceSystemIdentifier,
      role: b.sourceRole,
    },
    content: {
      source_contract_digest: b.sourceContractDigest,
      root_digest: b.contentRootDigest,
      copy_set_digest: b.copySetDigest,
    },
    provenance: { head: b.provenanceHead, ingestion_gitlink: b.ingestionGitlink },
    expected_target: {
      contract_digest: b.expectedTargetContractDigest,
      database: b.targetDatabase,
      system_identifier: b.targetSystemIdentifier,
      port: b.targetPort,
      endpoint: b.targetEndpoint,
      role: b.targetRole,
    },
    implementation_head: b.implementationHead,
  }
}

export function confirmationToken(b: ConfirmationBinding): string {
  return `${CONFIRMATION_PREFIX}${sha256Hex(canonicalJson(bindingDocument(b)))}`
}

/**
 * Compare a supplied confirmation with the one this run computes.
 *
 * NEVER ECHOES WHAT IT WAS GIVEN. A rejected confirmation is reported as a
 * refusal and nothing else: it is operator input, it may have been pasted from
 * anywhere, and a CLI that prints back whatever it was handed is a CLI that can
 * be made to print anything. Compared with a length-independent scan so the
 * comparison itself says nothing either.
 */
export function assertConfirmationMatches(supplied: string, b: ConfirmationBinding): void {
  if (typeof supplied !== 'string' || !CONFIRMATION_PATTERN.test(supplied)) {
    throw new ConfirmationRefused('the confirmation is not in the reviewed form')
  }
  const expected = confirmationToken(b)
  let diff = supplied.length ^ expected.length
  for (let i = 0; i < supplied.length; i += 1) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i % expected.length)
  }
  if (diff !== 0) {
    throw new ConfirmationRefused('the confirmation does not match this run')
  }
}
