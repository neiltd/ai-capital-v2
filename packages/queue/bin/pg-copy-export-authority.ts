#!/usr/bin/env tsx
/**
 * THE TEMPORARY EXPORT AUTHORITY, created and removed under evidence.
 *
 *   --create    create the reviewed role, publish its two credentials, prove both
 *   --prove     verify a create bundle and re-prove the role and containers
 *   --teardown  drop the role and remove its credentials, when authorized
 *
 * WHY A SEPARATE CLI. The copy's operations and the authority that lets it read
 * the source have different lifetimes: the role exists before any copy and must
 * be removable after one, and a mode that could do both would make "is the role
 * still there" a question about which flags were passed. Three argv-only modes,
 * no environment gate, no test-only branch.
 *
 * WHAT NEVER ENTERS THIS PROCESS. The administrator's passfile is opened once,
 * proved, and inherited by psql as descriptor 3 with `PGPASSFILE=/dev/fd/3`;
 * its bytes are never read here. The new role's secret exists in memory for the
 * length of one invocation, reaches PostgreSQL only as a SCRAM verifier on the
 * child's stdin, and reaches disk only inside the two 0600 credential files.
 * Neither ever appears in argv, the ambient environment, output or evidence.
 */
import { createHash } from 'node:crypto'
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, rmdirSync, statSync, unlinkSync, type Stats,
} from 'node:fs'

const { O_RDONLY, O_NOFOLLOW } = constants
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DIGEST_FILE, EXPORT_ROLE_NAME, EXPORT_SCHEMAS, EXPORT_TABLES,
  LEDGER_COLUMNS, LEDGER_RELATION,
  COMMIT_DISPOSITION_FILE, CredentialPublishedButUnverified, PRISTINE_RELEASE_FILE,
  buildExportCredentialTcpUrl, buildExportPgpassLine, credentialReceipt,
  createExportRoleSql, deriveScramSha256Verifier, dropExportRoleSql,
  publishReviewedCredential, type PublishOps,
  generateExportSecret, publishEvidence,
  verifyPublishedEvidence,
  type BatchOutcome, type PublishedEvidence,
} from '@common/db/pg-copy'
import {
  assertEvidenceRoot, evidenceNames, openPsqlBackend, pathIsPresent, runExportRoleBatch,
} from '@common/db/pg-copy'
import {
  openReviewedFileDescriptor, type HeldDescriptor,
} from '../src/pg-copy-ops/secure-file.js'
// THE REVIEWED CHAIN VERIFIERS, REUSED RATHER THAN DUPLICATED. A second copy
// of this logic is a second place for the copy chain's rules to drift.
import {
  assertClosureMatchesChain, assertRestorationMatchesChain,
  stage1AuthorityOf, verifyCopyChain, verifyCopyRestorationLink,
  verifyPublishedStage1, verifyReferencedBundle,
} from './pg-copy-ops.js'

/** A refusal. Never carries a secret, a URL, a passfile byte or an errno. */
export class AuthorityRefused extends Error {
  constructor(readonly reason: string, readonly at: string | null = null) {
    super(`${reason}${at === null ? '' : ` (at ${at})`}`)
    this.name = 'AuthorityRefused'
  }
}

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_REFUSED = 2
export const EXIT_RETAINED_UNKNOWN = 3

export const MODES: readonly string[] = Object.freeze(['--create', '--prove', '--teardown'])

export const OPTIONS: readonly string[] = Object.freeze([
  // WHERE, not what. Every fact about the role and the containers is measured.
  '--evidence-root', '--credential-container', '--admin-passfile', '--psql',
  '--host', '--port', '--database', '--admin-user',
  '--run-id', '--stamp',
  // The create bundle a --prove or --teardown is about.
  '--create-bundle',
  // The reviewed terminal disposition a teardown must state, AND THE EVIDENCE
  // that establishes it. The flag selects a branch; these prove it.
  '--disposition', '--copy-closure-bundle', '--copy-restoration-bundle',
  '--source-manifest-bundle', '--commit-disposition-bundle', '--pristine-release-bundle',
  // The four upstream bundles the copy-closed branch re-verifies.
  '--copy-lifecycle-bundle', '--release-gate-bundle', '--verification-bundle',
])

/** The reviewed container shape. One run, one directory, never adopted. */
/**
 * THE PRODUCTION CREDENTIAL ROOT. MODULE-PRIVATE, DELIBERATELY.
 *
 * K7-B7.2.7: this was exported, so the production capability could be imported
 * by any module - including every test - and the containment argument rested on
 * scanning source text for its name. Text scanning cannot see through a
 * template interpolation or an alias, so the capability is simply not
 * obtainable now: it is not exported from this module and appears in no barrel.
 * Its only reference outside its own declaration is `PRODUCTION_POLICY`'s
 * `secretRoot`, and that closed reference set is asserted from the AST.
 */
const CONTAINER_ROOT = '/Users/thanapold/ai-capital-secrets'
export const CONTAINER_PATTERN =
  /^\/Users\/thanapold\/ai-capital-secrets\/s4f-k7-export-[0-9a-f]{8}$/

/**
 * THE DIRECTORY EXISTS AND THIS RUN MADE IT, AND NOTHING ELSE IS ESTABLISHED.
 *
 * K7-B7.2.6: provenance used to be guessed AFTER the fact - `runCreate` caught
 * every `createContainer` failure and `lstat`ed the candidate path, treating a
 * present path as "created by this run". That is false for the case that
 * matters most: `mkdir` failing with EEXIST means the path was ALREADY THERE,
 * so the run created nothing and has no business reporting it as retained or
 * removing it. An EACCES on the candidate afterwards establishes nothing at all.
 *
 * So provenance is recorded where it is known: this error can only be thrown
 * from inside `createContainer`, AFTER `mkdirSync` has returned successfully.
 * It carries bounded reviewed facts - which verification step disproved, and
 * the path this run made - and never an errno, an exception string or a secret.
 */
export class ContainerCreatedButUnverified extends Error {
  readonly path: string
  readonly step: 'stat' | 'type' | 'mode' | 'owner' | 'realpath'
  constructor(path: string, step: 'stat' | 'type' | 'mode' | 'owner' | 'realpath') {
    super('the credential container was created but could not be verified')
    this.name = 'ContainerCreatedButUnverified'
    this.path = path
    this.step = step
  }
}

/** The reviewed basename rule, independent of which root it sits under. */
export const CONTAINER_BASENAME = /^s4f-k7-export-([0-9a-f]{8})$/

/**
 * WHERE THE AUTHORITY MAY TOUCH THE FILESYSTEM, AND THROUGH WHAT.
 *
 * K7-B7.2.3: there was no such object. `createContainer` read the production
 * root from a module constant and called the real `mkdir`, so the ONLY thing
 * standing between a test and the production credential root was the test's
 * own promise not to get that far - and in B7.2.2 a parallel run got that far
 * and wrote two credential files there.
 *
 * A POLICY IS NOT A SWITCH. It is never read from argv, the environment,
 * NODE_ENV or any ambient state. And since K7-B7.2.4 it is not a DEFAULT
 * either: every filesystem-touching function requires one, so a caller that
 * omits it does not get production - it does not compile. The single place
 * that names production is the process entry point.
 *
 * AND IT FAILS CLOSED IN BOTH DIRECTIONS. Every path is validated against THIS
 * policy's root, so production rules refuse a temporary path before any
 * `mkdir` rather than redirecting the write into the production root.
 */
export interface AuthorityPolicy {
  /** The one directory every container must sit DIRECTLY under. */
  readonly secretRoot: string
  /** Filesystem operations. Real ones in production. */
  readonly fs: AuthorityFsOps
  /**
   * THE CREDENTIAL IDENTITY PROOF, which deliberately has no read capability.
   * A separate capability set because it must stay unable to read a secret.
   */
  readonly prove: ProveOps
}

export interface AuthorityFsOps {
  readonly mkdirSync: (p: string, o: { mode: number }) => void
  readonly lstatSync: (p: string) => Stats
  readonly statSync: (p: string) => Stats
  readonly realpathSync: (p: string) => string
  readonly rmdirSync: (p: string) => void
  readonly unlinkSync: (p: string) => void
}

export const REAL_AUTHORITY_FS: AuthorityFsOps = Object.freeze({
  mkdirSync: (p: string, o: { mode: number }) => { mkdirSync(p, o) },
  lstatSync: (p: string) => lstatSync(p),
  statSync: (p: string) => statSync(p),
  realpathSync: (p: string) => realpathSync(p),
  rmdirSync: (p: string) => { rmdirSync(p) },
  unlinkSync: (p: string) => { unlinkSync(p) },
})

/** The container rule for one policy: directly under its root, reviewed name. */
export function assertPolicyContainer(path: string, policy: AuthorityPolicy): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new AuthorityRefused('the credential container path is not canonical')
  }
  const m = CONTAINER_BASENAME.exec(basename(path))
  if (m === null || dirname(path) !== policy.secretRoot) {
    throw new AuthorityRefused('the credential container is not a reviewed container path')
  }
  return m[1] as string
}
export const DRIVER_FILE = 'export-driver.url'
export const PGPASS_FILE = 'export.pgpass'
export const CREATE_PREFIX = 'export-authority-create'
export const TEARDOWN_PREFIX = 'export-authority-teardown'
export const CREATE_FILE = 'export-authority.json'
export const TEARDOWN_FILE = 'export-authority-teardown.json'

/** The two reviewed terminal dispositions a teardown may be authorized by. */
export const DISPOSITIONS: readonly string[] =
  Object.freeze(['no-target-commit', 'copy-closed'])

/**
 * EXACTLY WHAT EACH MODE USES, AND NOTHING ELSE.
 *
 * K7-B7.2.4: there was ONE global allowlist, so an option a mode never reads
 * was accepted and silently ignored. `--prove` took `--host/--port/--database`
 * and then used the verified create record instead: safe routing, but an
 * operator contract that lets a command appear to prove a caller-selected
 * endpoint it never consults. A supplied option a mode does not use is now a
 * refusal, before any file, passfile, bundle or evidence is touched.
 */
export const MODE_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '--create': Object.freeze([
    '--run-id', '--stamp', '--evidence-root', '--credential-container',
    '--admin-passfile', '--psql', '--host', '--port', '--database', '--admin-user',
  ]),
  // ITS ENDPOINT AND IDENTITY COME ONLY FROM THE VERIFIED CREATE BUNDLE.
  '--prove': Object.freeze([
    '--create-bundle', '--admin-passfile', '--psql', '--admin-user',
  ]),
  '--teardown': Object.freeze([
    '--run-id', '--stamp', '--evidence-root', '--create-bundle',
    '--admin-passfile', '--psql', '--host', '--port', '--database', '--admin-user',
    '--disposition',
    // The disposition-proof bundles; which ones are permitted depends on the
    // disposition itself, which is narrowed below.
    '--copy-closure-bundle', '--copy-restoration-bundle', '--source-manifest-bundle',
    '--commit-disposition-bundle', '--pristine-release-bundle',
    '--copy-lifecycle-bundle', '--release-gate-bundle', '--verification-bundle',
  ]),
})

/** D.3: and which proof bundles each reviewed disposition actually reads. */
export const DISPOSITION_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'no-target-commit': Object.freeze([
    '--source-manifest-bundle', '--commit-disposition-bundle', '--pristine-release-bundle',
  ]),
  'copy-closed': Object.freeze([
    '--copy-closure-bundle', '--copy-restoration-bundle', '--source-manifest-bundle',
    '--copy-lifecycle-bundle', '--release-gate-bundle', '--verification-bundle',
  ]),
})

export interface Parsed {
  readonly mode: string
  readonly values: Readonly<Record<string, string>>
}

export function parseArgs(argv: readonly string[]): Parsed {
  const values: Record<string, string> = {}
  const modes: string[] = []
  for (const arg of argv) {
    if (MODES.includes(arg)) { modes.push(arg); continue }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    if (!OPTIONS.includes(name)) throw new AuthorityRefused('unknown option', name)
    if (eq === -1) throw new AuthorityRefused('an option carries no value', name)
    if (values[name] !== undefined) throw new AuthorityRefused('an option is repeated', name)
    values[name] = arg.slice(eq + 1)
  }
  if (modes.length !== 1) throw new AuthorityRefused('exactly one mode is required')
  const mode = modes[0] as string
  // THE MODE'S OWN SET, CHECKED BEFORE ANYTHING IS OPENED.
  const permitted = MODE_OPTIONS[mode] as readonly string[]
  for (const name of Object.keys(values)) {
    if (!permitted.includes(name)) {
      throw new AuthorityRefused('this mode does not take that option', name)
    }
  }
  // AND, FOR A TEARDOWN, THE DISPOSITION ITSELF AND THE BUNDLES IT READS.
  const disposition = values['--disposition']
  if (mode === '--teardown' && disposition !== undefined) {
    // E: AN UNREVIEWED VALUE IS REFUSED HERE, BEFORE ANY BUNDLE IS READ.
    //
    // K7-B7.2.5: `--disposition=garbage` parsed cleanly because the narrowing
    // only applied to RECOGNISED values, and `runTeardown` then read and
    // verified the create bundle before rejecting it. The CLI contract says
    // invalid input is refused before any file, passfile, bundle or evidence
    // access, so it is refused in the parser.
    if (!DISPOSITIONS.includes(disposition)) {
      throw new AuthorityRefused(
        'the disposition is not a reviewed terminal disposition', '--disposition')
    }
    const forDisposition = DISPOSITION_OPTIONS[disposition]
    if (forDisposition !== undefined) {
      const allBundles = Object.values(DISPOSITION_OPTIONS).flat()
      for (const name of Object.keys(values)) {
        if (allBundles.includes(name) && !forDisposition.includes(name)) {
          throw new AuthorityRefused('this disposition does not take that option', name)
        }
      }
    }
  }
  return { mode, values: Object.freeze({ ...values }) }
}

/** An 8-hex run identity and a basic-format UTC stamp, both from argv. */
export const RUN_ID = /^[0-9a-f]{8}$/
export const EVIDENCE_STAMP = /^\d{8}T\d{6}Z$/

/**
 * A REAL INSTANT, NOT A SHAPE.
 *
 * K7-B7.2.4: the stamp was only regex-checked, so `20260230T250000Z` - a 30th
 * of February at 25:00 - was accepted and became a directory name and a
 * document field. The components are parsed and round-tripped through UTC, so
 * only an instant that exists is accepted; a real leap day is.
 */
export function isRealUtcInstant(stamp: string): boolean {
  if (!EVIDENCE_STAMP.test(stamp)) return false
  const n = (from: number, to: number): number => Number(stamp.slice(from, to))
  const [y, mo, d, h, mi, sec] =
    [n(0, 4), n(4, 6), n(6, 8), n(9, 11), n(11, 13), n(13, 15)]
  const at = new Date(Date.UTC(y as number, (mo as number) - 1, d as number,
                               h as number, mi as number, sec as number))
  // ROUND-TRIP EQUALITY: `Date.UTC` silently rolls an impossible component
  // over into the next month, hour or day, and the roll shows up here.
  return at.getUTCFullYear() === y && at.getUTCMonth() + 1 === mo &&
    at.getUTCDate() === d && at.getUTCHours() === h &&
    at.getUTCMinutes() === mi && at.getUTCSeconds() === sec
}

/**
 * THE RUN IDENTITY COMES FROM THE OPERATOR, NOT FROM INSIDE.
 *
 * K7-B7.2.3: `--run-id` and `--stamp` were accepted by the parser and then
 * IGNORED - both modes minted their own from `deps.newRunId`/`deps.stamp`. A
 * real `--create` was therefore impossible: the operator must pass
 * `--credential-container=<root>/s4f-k7-export-<run id>`, and the function
 * then required that basename to equal a run id it had generated internally
 * and never disclosed. Every test hid the defect by injecting both seams, so
 * nothing failed.
 *
 * THESE ARE THE VALUES EVERYTHING ELSE IS BUILT FROM: the container basename,
 * the evidence preflight names, both evidence documents and the published
 * bundle names. Nothing is minted.
 */
export function runIdentityOf(
  v: Readonly<Record<string, string>>,
): { runId: string; stamp: string } {
  const runId = required(v, '--run-id')
  if (!RUN_ID.test(runId)) {
    throw new AuthorityRefused('the run identity is not eight lowercase hex digits')
  }
  const stamp = required(v, '--stamp')
  if (!isRealUtcInstant(stamp)) {
    throw new AuthorityRefused('the stamp is not a basic-format UTC instant')
  }
  return { runId, stamp }
}

export function required(v: Readonly<Record<string, string>>, name: string): string {
  const got = v[name]
  if (got === undefined || got === '') {
    throw new AuthorityRefused('a required option is missing', name)
  }
  return got
}

// ---------------------------------------------------------------------------
// THE CONTAINER AND ITS TWO FILES
// ---------------------------------------------------------------------------

/** Non-secret identity of one published credential file. */
export interface FileReceipt {
  readonly name: string
  readonly deviceInode: string
  readonly uid: number
  readonly mode: string
  readonly links: number
}

export interface ContainerReceipt {
  readonly path: string
  readonly deviceInode: string
  readonly uid: number
  readonly mode: string
}

/** Everything a test may replace. No argv flag and no environment reaches these. */
export interface AuthorityDeps {
  /**
   * WHERE THIS RUN MAY TOUCH THE FILESYSTEM. REQUIRED, never defaulted.
   *
   * K7-B7.2.4 removed the implicit production fallback: there is no value of
   * this field that means "decide for me". A caller states the policy it is
   * acting under, and the only caller that states production is the process
   * entry point. It is not reachable from argv or the environment.
   */
  readonly policy: AuthorityPolicy
  /** Runs one psql batch. Receives the inherited descriptor, never a path. */
  readonly batch?: (
    psqlPath: string, args: readonly string[], sql: string, passfileFd: number,
  ) => Promise<BatchOutcome>
  /** Opens and proves the administrator passfile. Returns a held descriptor. */
  readonly openAdminPassfile?: (path: string) => HeldDescriptor
  /** Reads back role attributes and grants, for the independent proof. */
  readonly proveRole?: (i: RoleProofInputs) => Promise<RoleFacts>
  readonly secret?: () => string
  /**
   * THE TEARDOWN PREFLIGHT, which must complete BEFORE any mutating batch.
   *
   * A seam, not a flag: a refusal here has to happen while the authority still
   * exists, because a refusal after `DROP ROLE` would already have destroyed it.
   */
  readonly preflight?: (
    c: ContainerReceipt, f: readonly FileReceipt[], policy: AuthorityPolicy,
  ) => void
  /**
   * THE CONTAINER REMOVAL AND ITS PROOF, for the no-role cleanup.
   *
   * Seams, not flags: the reviewed container lives under a fixed absolute root
   * no test may create, so both outcomes - removed and proved absent, or still
   * standing and therefore retained - are observable only through these.
   */
  readonly rmdirContainer?: (p: string) => void
  readonly lstatContainer?: (p: string) => Stats
  /**
   * THE EVIDENCE PUBLICATION ITSELF.
   *
   * A seam, not a flag: a failure here happens after the destructive work, and
   * the only way to observe that state without destroying anything real is to
   * inject it.
   */
  readonly publish?: (i: Parameters<typeof publishEvidence>[0]) => PublishedEvidence
  /** The pre-mutation publication preflight. Injected only to observe it. */
  readonly preflightPublication?: (i: {
    root: string; prefix: string; stamp: string; runId: string
  }) => unknown
}

export interface RoleProofInputs {
  readonly psqlPath: string
  readonly host: string
  readonly port: string
  readonly database: string
  readonly adminUser: string
  readonly passfileFd: number
}

/** What an independent read-back established about the role. */
export interface RoleFacts {
  /**
   * THE CLUSTER, NOT THE ENDPOINT. A decimal string, never a number: this is a
   * 64-bit identity and `Number` rounds above 2^53, which would make two
   * different clusters compare equal.
   */
  readonly systemIdentifier: string
  readonly present: boolean
  readonly canLogin: boolean
  readonly superuser: boolean
  readonly createRole: boolean
  readonly createDb: boolean
  readonly replication: boolean
  readonly bypassRls: boolean
  readonly memberships: readonly string[]
  readonly schemaUsage: readonly string[]
  readonly tableSelect: readonly string[]
  readonly ledgerColumns: readonly string[]
  readonly writeGrants: readonly string[]
  readonly routineGrants: readonly string[]
  readonly sequenceGrants: readonly string[]
}

/** A 64-bit decimal cluster identity, as text. Never parsed into a number. */
export const SYSTEM_IDENTIFIER = /^[1-9][0-9]{0,19}$/

/**
 * THE ONE CLUSTER COMPARISON, SHARED BY EVERY CALLER THAT NEEDS IT.
 *
 * Host, port and database are routing coordinates. A cluster can be dropped
 * and rebuilt behind the same three, and the identically named role on the new
 * one was never granted this authority - so a create bundle must not be able
 * to authorize dropping it. `system_identifier` is the durable identity.
 *
 * A LIVE IDENTIFIER THAT COULD NOT BE PROVED IS NOT A MATCH. It is refused
 * rather than skipped, because "I could not establish which cluster this is"
 * is exactly the state a destructive act may not proceed from.
 */
export function assertSameCluster(live: string, recorded: string): void {
  if (!SYSTEM_IDENTIFIER.test(live)) {
    throw new AuthorityRefused('the live cluster identity could not be proved')
  }
  if (!SYSTEM_IDENTIFIER.test(recorded)) {
    throw new AuthorityRefused('the recorded cluster identity is not a reviewed identity')
  }
  if (live !== recorded) {
    throw new AuthorityRefused('the live cluster is not the one the create record describes')
  }
}

const deviceInodeOf = (st: { dev: number; ino: number }): string =>
  `${String(st.dev)}:${String(st.ino)}`

/**
 * CREATE THE CONTAINER, AND NEVER ADOPT ONE.
 *
 * `mkdir` with mode 0700 fails with EEXIST if anything is already at the path -
 * a directory, a file or a symlink - which is the no-clobber property. An
 * existing path is refused and left exactly as it was: this invocation did not
 * create it, so it has no authority to inspect, repair or remove it.
 */
export function createContainer(
  path: string, policy: AuthorityPolicy,
): ContainerReceipt {
  // THE PATH IS JUDGED AGAINST THIS POLICY'S ROOT, so production rules refuse
  // a temporary path outright instead of writing somewhere else.
  assertPolicyContainer(path, policy)
  // THE FIXED PARENT ROOT, PROVED. `stat` followed a symlink and asked
  // nothing about the mode, so a secrets root that was a link into a
  // world-writable directory satisfied it.
  const parent = dirname(path)
  const pst = policy.fs.lstatSync(parent)
  if (!pst.isDirectory() || pst.isSymbolicLink()) {
    throw new AuthorityRefused('the secrets root is not a directory')
  }
  if ((pst.mode & 0o777) !== 0o700) {
    throw new AuthorityRefused('the secrets root is not mode 0700')
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  if (uid !== -1 && pst.uid !== uid) {
    throw new AuthorityRefused('the secrets root is owned by another user')
  }
  if (policy.fs.realpathSync(parent) !== parent) {
    throw new AuthorityRefused('the secrets root is not its own realpath')
  }
  try {
    policy.fs.mkdirSync(path, { mode: 0o700 })
  } catch {
    // EEXIST AND EVERY OTHER FAILURE READ THE SAME WAY HERE: this run did not
    // create the path, so it may not touch it - and it does not look at it
    // either. No `lstat`, no `stat`, no adoption, no repair, no removal.
    throw new AuthorityRefused('the credential container could not be created by this run')
  }

  // FROM HERE THE DIRECTORY EXISTS AND THIS RUN MADE IT.
  //
  // Every failure below is therefore the TYPED post-mkdir state, never an
  // ordinary refusal: the caller has to account for an object that is now
  // there. There is still no receipt, so there is no removal authority either.
  const st = (() => {
    try {
      return policy.fs.statSync(path)
    } catch {
      throw new ContainerCreatedButUnverified(path, 'stat')
    }
  })()
  if (!st.isDirectory()) throw new ContainerCreatedButUnverified(path, 'type')
  if ((st.mode & 0o777) !== 0o700) throw new ContainerCreatedButUnverified(path, 'mode')
  if (uid !== -1 && st.uid !== uid) throw new ContainerCreatedButUnverified(path, 'owner')
  const canonical = (() => {
    try {
      return policy.fs.realpathSync(path)
    } catch {
      throw new ContainerCreatedButUnverified(path, 'realpath')
    }
  })()
  if (canonical !== path) throw new ContainerCreatedButUnverified(path, 'realpath')
  return Object.freeze({
    path,
    deviceInode: deviceInodeOf(st),
    uid: st.uid,
    mode: (st.mode & 0o777).toString(8),
  })
}

/**
 * PUBLISH ONE CREDENTIAL THROUGH THE REVIEWED PRIMITIVE, and receipt it.
 *
 * THE CLI NO LONGER HAS A PUBLISHER OF ITS OWN. The one it had opened the FINAL
 * name directly, swallowed a failed parent-directory fsync, and had no
 * published-but-unverified state at all - so a credential that existed but
 * could not be verified was reported as though nothing had been written.
 *
 * `publishExportCredential` does the reviewed thing instead: a same-parent
 * 0600 temporary file, fsync, a no-clobber `link` to the final name, BOTH
 * parent fsyncs, `lstat` verification of inode/type/mode/links/owner, and
 * `CredentialPublishedButUnverified` carrying the exact phase it stopped at -
 * never unlinking a published name. This wrapper adds only the non-secret
 * receipt the record has to carry.
 */
export function publishCredential(
  container: string, name: string, bytes: string,
  ops?: PublishOps,
): FileReceipt {
  const finalPath = publishReviewedCredential(container, name, bytes, ops)
  if (finalPath !== join(container, name)) {
    throw new AuthorityRefused('the credential was published under another name', name)
  }
  // ONCE THE FINAL NAME EXISTS, EVERY LATER FAILURE IS PUBLISHED-BUT-UNVERIFIED.
  //
  // K7-B7.2.1: a `credentialReceipt` failure threw an ordinary refusal, so the
  // create path entered its generic cleanup with NO receipt for a final name
  // that really existed - and therefore nothing to retain or name.
  try {
    return credentialReceipt(container, name, ops)
  } catch {
    throw new CredentialPublishedButUnverified(finalPath, join(container, name), 'receipt')
  }
}

/**
 * THE CAPABILITIES A CREDENTIAL PROOF NEEDS. Note what is ABSENT.
 *
 * No `readSync` and no `readFileSync`, and that is the contract rather than a
 * comment about one: a proof threaded only these cannot read a credential's
 * bytes even by accident. The bytes are the secret, so a proof that read them
 * would be a credential oracle that leaves no trace of having looked.
 */
export interface ProveOps {
  /** Numeric flags ONLY, so `O_NOFOLLOW` is expressible. */
  readonly openSync: (p: string, flags: number) => number
  readonly fstatSync: (fd: number) => Stats
  readonly lstatSync: (p: string) => Stats
  readonly closeSync: (fd: number) => void
}

export const REAL_PROVE_OPS: ProveOps = Object.freeze({
  openSync: (p: string, flags: number) => openSync(p, flags),
  fstatSync: (fd: number) => fstatSync(fd),
  lstatSync: (p: string) => lstatSync(p),
  closeSync,
})

/** THE DEFAULT, AND THE ONLY ONE PRODUCTION USES. */
/**
 * THE ONE PRODUCTION CAPABILITY, AND IT LEAVES THIS MODULE NOWHERE.
 *
 * K7-B7.2.7: also module-private now. Its single reference outside this
 * declaration is the process composition call under the direct-entry guard, so
 * no reusable or test-callable API can be handed production by accident, by
 * alias, or by an interpolation that a text scanner would have blanked.
 */
const PRODUCTION_POLICY: AuthorityPolicy = Object.freeze({
  secretRoot: CONTAINER_ROOT,
  fs: REAL_AUTHORITY_FS,
  prove: REAL_PROVE_OPS,
})

/** Strict `device:inode`. Two decimal integers and nothing else. */
const DEVICE_INODE = /^\d{1,20}:\d{1,20}$/

/**
 * RE-PROVE ONE PUBLISHED CREDENTIAL. NO FOLLOW, AND NO READ.
 *
 * WHAT WAS WRONG. This said it performed an "O_NOFOLLOW equivalent" and then
 * called `openSync(path, 'r')` with no `lstat` anywhere - which follows
 * symlinks. A symlink planted at the recorded name, pointing at the recorded
 * inode, satisfied every check: same device:inode, same mode, same owner. An
 * attacker who can write the container could therefore substitute the path a
 * later teardown would unlink.
 *
 * The open is now numeric `O_RDONLY | O_NOFOLLOW`, which fails outright on a
 * symlink, and `lstat` on the name is compared too - so a substitution is
 * refused at the name AND at the descriptor. Still no read capability.
 */
export function proveCredential(
  container: string, r: FileReceipt, ops: ProveOps,
): void {
  if (!DEVICE_INODE.test(r.deviceInode)) {
    throw new AuthorityRefused('a credential receipt carries no reviewed device:inode', r.name)
  }
  const path = join(container, r.name)
  if (path !== resolve(path) || dirname(path) !== container) {
    throw new AuthorityRefused('a credential name is not a plain basename', r.name)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  let fd: number | null = null
  try {
    // 1. THE NAME ITSELF, UNFOLLOWED. A symlink is refused here even if the
    //    open below would have reached a file with the right identity.
    const ls = ops.lstatSync(path)
    if (!ls.isFile() || ls.isSymbolicLink()) {
      throw new AuthorityRefused('a credential is not a regular file', r.name)
    }
    // 2. AND THE OPEN REFUSES A SYMLINK TOO, by the kernel rather than by us.
    fd = ops.openSync(path, O_RDONLY | O_NOFOLLOW)
    const st = ops.fstatSync(fd)
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new AuthorityRefused('a credential is not a regular file', r.name)
    }
    // 3. THE SAME OBJECT, at the name and at the descriptor.
    const seen = `${String(st.dev)}:${String(st.ino)}`
    if (seen !== r.deviceInode || `${String(ls.dev)}:${String(ls.ino)}` !== r.deviceInode) {
      throw new AuthorityRefused('a credential is not the object that was published', r.name)
    }
    if ((st.mode & 0o777).toString(8) !== r.mode || (st.mode & 0o777) !== 0o600) {
      throw new AuthorityRefused('a credential is not the mode it was published at', r.name)
    }
    if (st.nlink !== r.links || st.nlink !== 1) {
      throw new AuthorityRefused('a credential link count changed', r.name)
    }
    if (st.uid !== r.uid || (uid !== -1 && st.uid !== uid)) {
      throw new AuthorityRefused('a credential owner changed', r.name)
    }
    // AND NOTHING IS READ: `ProveOps` has no capability that could.
  } catch (e) {
    if (e instanceof AuthorityRefused) throw e
    throw new AuthorityRefused('a credential could not be examined', r.name)
  } finally {
    if (fd !== null) ops.closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// THE PRIVILEGED CHANNEL
// ---------------------------------------------------------------------------

/** The reviewed psql argv. SQL travels on stdin; nothing is named on the line. */
export function adminArgs(i: {
  host: string; port: string; database: string; adminUser: string
}): readonly string[] {
  return Object.freeze([
    // NEVER PROMPT ON THE PRIVILEGED CHANNEL. `--no-password` means a batch that
    // cannot authenticate fails immediately instead of asking for a password on
    // the controlling terminal - and this channel creates and drops a role, so a
    // half-finished privileged batch waiting on a question nobody is watching is
    // the worst place to block.
    //
    // THE PASSFILE STILL SUPPLIES IT. Only the PROMPT is suppressed: psql(1) says
    // the attempt fails just when no password is available "from other sources
    // such as a .pgpass file". `DEFAULT_BATCH` (below) hands `runExportRoleBatch`
    // the inherited descriptor, which sets `PGPASSFILE=/dev/fd/3` in the child's
    // environment (export-role.ts:757-763) - exactly such a source.
    '--no-psqlrc', '--no-password', '--quiet', '--no-align', '--tuples-only',
    `--host=${i.host}`, `--port=${i.port}`,
    `--dbname=${i.database}`, `--username=${i.adminUser}`,
  ])
}

/**
 * RUN ONE PRIVILEGED BATCH WITH THE PASSFILE INHERITED, NOT NAMED.
 *
 * THE ORDERING IS THE POINT, and it is why this is a function rather than two
 * lines at each call site:
 *
 *   1. open and prove the administrator passfile once;
 *   2. START the batch - `spawn` dups the descriptor into the child
 *      synchronously, so by the time it returns the child's copy is its own;
 *   3. CLOSE the parent's copy immediately, before awaiting anything;
 *   4. await the batch.
 *
 * Holding the parent's descriptor across the await would keep a reviewed
 * credential open in this process for the whole statement; closing it before
 * the spawn would hand the child nothing. The `finally` closes it on a
 * synchronous failure too, so no path leaks it.
 */
export type ReleaseState = 'proved' | 'unproved'

/**
 * WHAT A GUARDED OPERATION ACTUALLY PRODUCED, AND WHETHER THE PARENT COPY OF
 * THE ADMINISTRATOR PASSFILE WAS PROVED RELEASED.
 *
 * K7-B7.2.4: `withAdminPassfile` returned `{ result, closedBeforeAwait }` and
 * THREW on a failing operation - so every caller but one destructured `result`
 * and dropped the release fact on the floor, and a rejected operation took the
 * release fact with it. The teardown could therefore reach `DROP ROLE` and
 * credential removal after the descriptor release had become unproved.
 *
 * A DISCRIMINATED OUTCOME MAKES THAT UNREPRESENTABLE: there is no shape that
 * carries a usable result without also carrying the release state, and the
 * failure case carries it too.
 */
export type Guarded<T> =
  | { readonly state: 'ok'; readonly release: ReleaseState; readonly result: T }
  | { readonly state: 'failed'; readonly release: ReleaseState; readonly failure: unknown }
  /**
   * THE DESCRIPTOR WAS NEVER OPENED, so there is no release to report.
   *
   * K7-B7.2.5: an open failure threw out of this helper, so a caller that had
   * already created a container saw a generic refusal and never classified the
   * state it had left behind. It is NOT `release: 'unproved'` either - no
   * descriptor existed to release, and conflating the two would make a caller
   * reason about a close that never happened.
   */
  | { readonly state: 'not-started'; readonly failure: unknown }

export async function withAdminPassfile<T>(
  passfilePath: string,
  open: (p: string) => HeldDescriptor,
  use: (fd: number) => Promise<T>,
): Promise<Guarded<T>> {
  if (!isAbsolute(passfilePath)) {
    throw new AuthorityRefused('the administrator passfile must be an absolute path')
  }
  // BEFORE AN FD EXISTS THERE IS NOTHING TO RELEASE, and nothing has been
  // mutated by this helper - so the failure is reported as its own state rather
  // than thrown at a caller that may have state of its own to account for.
  let held: HeldDescriptor
  try {
    held = open(passfilePath)
  } catch (e) {
    return { state: 'not-started', failure: e }
  }

  let started: Promise<T>
  // A SEPARATE DISCRIMINANT, NEVER THE THROWN VALUE.
  //
  // K7-B7.2.5: this used `syncFailure: unknown = null` as both the sentinel and
  // the captured failure, so a synchronous `throw null` - or `throw undefined` -
  // was indistinguishable from success and returned an `ok` result whose value
  // was `undefined`.
  let threw = false
  let syncFailure: unknown
  try {
    // STARTED, NOT AWAITED. The promise exists and the child has the
    // descriptor; nothing has been waited on yet.
    started = use(held.fd)
  } catch (e) {
    // A SYNCHRONOUS THROW STILL HAS TO REPORT THE RELEASE. The close is
    // attempted, its outcome is recorded, and the ORIGINAL failure is the one
    // that travels - a failing close may not replace it.
    threw = true
    syncFailure = e
    started = Promise.resolve(undefined as unknown as T)
  }
  let release: ReleaseState = 'unproved'
  try {
    held.close()
    release = 'proved'
  } catch {
    // A CLOSE THAT FAILS IS REPORTED, NEVER GUESSED AT - and never allowed to
    // hide why the operation itself failed.
    release = 'unproved'
  }
  if (threw) {
    return { state: 'failed', release, failure: syncFailure }
  }
  try {
    return { state: 'ok', release, result: await started }
  } catch (e) {
    // AND A REJECTION DOES NOT ERASE THE RELEASE RESULT.
    return { state: 'failed', release, failure: e }
  }
}

/**
 * THE VALUE, ONLY WHEN BOTH THE OPERATION AND THE RELEASE ARE PROVED.
 *
 * For the call sites where an unproved release must refuse BEFORE anything is
 * mutated. Callers that have to retain rather than refuse read the outcome
 * directly instead.
 */
export function requireReleased<T>(g: Guarded<T>, what: string): T {
  if (g.state === 'not-started') {
    // NOTHING WAS OPENED AND NOTHING RAN. For a read-only precondition that is
    // simply a refusal; a caller with state of its own must branch on this
    // state itself rather than call this function.
    if (g.failure instanceof AuthorityRefused) throw g.failure
    throw new AuthorityRefused(`the administrator passfile could not be opened for the ${what}`)
  }
  if (g.state === 'failed') {
    if (g.failure instanceof AuthorityRefused) throw g.failure
    throw new AuthorityRefused(`the ${what} did not complete`)
  }
  if (g.release !== 'proved') {
    throw new AuthorityRefused(`the administrator descriptor release is unproved after the ${what}`)
  }
  return g.result
}

/**
 * THE ONE DEFAULT BATCH, named once.
 *
 * `undefined` for the pathname argument is the point: this CLI hands
 * `runExportRoleBatch` the INHERITED DESCRIPTOR, which the child receives at
 * slot 3 as `/dev/fd/3`. Two copies of this expression let a change to one of
 * them pass while the other still looked right.
 */
export const DEFAULT_BATCH: NonNullable<AuthorityDeps['batch']> =
  async (p, a, sql, fd) => await runExportRoleBatch(p, a, sql, undefined, fd)

/** The one reviewed read-back. Parses only the fields the proof compares. */
export const PROVE_ROLE_SQL = [
  `SELECT 'attr', r.rolcanlogin, r.rolsuper, r.rolcreaterole, r.rolcreatedb,`,
  `       r.rolreplication, r.rolbypassrls`,
  `  FROM pg_catalog.pg_roles r WHERE r.rolname = '${EXPORT_ROLE_NAME}';`,
  `SELECT 'member', b.rolname FROM pg_catalog.pg_auth_members m`,
  `  JOIN pg_catalog.pg_roles b ON b.oid = m.roleid`,
  `  JOIN pg_catalog.pg_roles r ON r.oid = m.member`,
  ` WHERE r.rolname = '${EXPORT_ROLE_NAME}';`,
  `SELECT 'schema', n.nspname FROM pg_catalog.pg_namespace n`,
  ` WHERE pg_catalog.has_schema_privilege('${EXPORT_ROLE_NAME}', n.nspname, 'USAGE')`,
  `   AND n.nspname NOT LIKE 'pg\\\\_%' AND n.nspname <> 'information_schema';`,
  `SELECT 'select', c.relnamespace::regnamespace || '.' || c.relname`,
  `  FROM pg_catalog.pg_class c WHERE c.relkind IN ('r','p','v','m')`,
  `   AND pg_catalog.has_table_privilege('${EXPORT_ROLE_NAME}', c.oid, 'SELECT');`,
  `SELECT 'write', c.relnamespace::regnamespace || '.' || c.relname`,
  `  FROM pg_catalog.pg_class c WHERE c.relkind IN ('r','p')`,
  `   AND pg_catalog.has_table_privilege('${EXPORT_ROLE_NAME}', c.oid,`,
  `       'INSERT,UPDATE,DELETE,TRUNCATE');`,
  `SELECT 'sequence', c.relnamespace::regnamespace || '.' || c.relname`,
  `  FROM pg_catalog.pg_class c WHERE c.relkind = 'S'`,
  `   AND pg_catalog.has_sequence_privilege('${EXPORT_ROLE_NAME}', c.oid, 'SELECT,USAGE,UPDATE');`,
  // THE LEDGER IS COLUMN-GRANTED, NOT TABLE-GRANTED. `has_table_privilege`
  // is false for it, which is correct and is why it needs its own query.
  `SELECT 'ledger', a.attname FROM pg_catalog.pg_attribute a`,
  ` WHERE a.attrelid = '${LEDGER_RELATION}'::regclass AND a.attnum > 0`,
  `   AND NOT a.attisdropped`,
  `   AND pg_catalog.has_column_privilege('${EXPORT_ROLE_NAME}', a.attrelid, a.attname, 'SELECT');`,
  // THE CLUSTER'S DURABLE IDENTITY, under its own tag.
  //
  // `::pg_catalog.text` DELIBERATELY. `system_identifier` is a 64-bit value;
  // carrying it as a number would round it, and this is an identity that is
  // compared for equality.
  `SELECT 'system', (pg_catalog.pg_control_system()).system_identifier::pg_catalog.text;`,
  `SELECT 'routine', p.pronamespace::regnamespace || '.' || p.proname`,
  `  FROM pg_catalog.pg_proc p`,
  ` WHERE pg_catalog.has_function_privilege('${EXPORT_ROLE_NAME}', p.oid, 'EXECUTE')`,
  `   AND p.pronamespace::regnamespace::text NOT IN ('pg_catalog','information_schema');`,
].join('\n')

// ---------------------------------------------------------------------------
// THE EVIDENCE DOCUMENTS
// ---------------------------------------------------------------------------

/**
 * WHAT A CREATE RECORD SAYS, AND WHAT IT MAY NOT.
 *
 * Path and container identity, device:inode, owner, mode, link count, the role
 * and the non-secret endpoint. NOT the URL, the passfile line, the secret, the
 * SCRAM verifier, any digest derived from them, or a raw error - a
 * credential-derived hash is a credential oracle, and an errno string is where
 * paths and bytes leak.
 */
export function createDocument(i: {
  runId: string; stamp: string; outcome: string
  container: ContainerReceipt; files: readonly FileReceipt[]
  endpoint: { host: string; port: string; database: string }
  role: RoleFacts | null
  note: string | null
}): Record<string, unknown> {
  return {
    export_authority_version: 1,
    complete: true,
    record: CREATE_PREFIX,
    outcome: i.outcome,
    run: { id: i.runId, stamp: i.stamp },
    role: {
      name: EXPORT_ROLE_NAME,
      proved: i.role === null ? null : {
        present: i.role.present,
        can_login: i.role.canLogin,
        superuser: i.role.superuser,
        create_role: i.role.createRole,
        create_db: i.role.createDb,
        replication: i.role.replication,
        bypass_rls: i.role.bypassRls,
        memberships: [...i.role.memberships],
        schema_usage: [...i.role.schemaUsage],
        table_select: [...i.role.tableSelect],
        ledger_columns: [...i.role.ledgerColumns],
        write_grants: [...i.role.writeGrants],
        routine_grants: [...i.role.routineGrants],
        sequence_grants: [...i.role.sequenceGrants],
      },
    },
    endpoint: { host: i.endpoint.host, port: i.endpoint.port, database: i.endpoint.database },
    // THE PROVED SOURCE IDENTITY. The endpoint says where this was reached;
    // this says WHICH CLUSTER answered, and it is what a later teardown must
    // find still there before it may drop anything.
    source: { system_identifier: i.role === null ? null : i.role.systemIdentifier },
    container: {
      path: i.container.path,
      device_inode: i.container.deviceInode,
      uid: i.container.uid,
      mode: i.container.mode,
    },
    credentials: i.files.map(f => ({
      name: f.name, device_inode: f.deviceInode, uid: f.uid, mode: f.mode, links: f.links,
    })),
    note: i.note,
  }
}

export function teardownDocument(i: {
  runId: string; stamp: string; outcome: string
  createBundle: { name: string; digest_file_digest: string }
  disposition: string
  /**
   * EVERY BUNDLE THAT AUTHORIZED THE DESTRUCTION, in the order the
   * authorization produced them.
   *
   * K7-B7.2.2: only `copy_closure` was recorded, and it is NULL for
   * `no-target-commit` - so the record of a successful no-target teardown
   * named none of the three bundles that authorized it. The evidence that
   * justified an irreversible act has to outlive the act.
   */
  links: readonly { name: string; digest_file_digest: string }[]
  closure: { name: string; digest_file_digest: string } | null
  roleAbsent: boolean
  removed: readonly string[]
  retained: readonly string[]
  containerRemoved: boolean
  note: string | null
}): Record<string, unknown> {
  return {
    export_authority_version: 1,
    complete: true,
    record: TEARDOWN_PREFIX,
    outcome: i.outcome,
    run: { id: i.runId, stamp: i.stamp },
    role: { name: EXPORT_ROLE_NAME, absent: i.roleAbsent },
    authorized_by: {
      disposition: i.disposition,
      // BASENAME PLUS DIGEST, NOTHING ELSE. No absolute path, and no value
      // derived from a secret, may enter this record.
      links: i.links.map(l => ({ name: l.name, digest_file_digest: l.digest_file_digest })),
      // A REDUNDANT CONVENIENCE, DERIVED FROM THE SET ABOVE AND CONSISTENT
      // WITH IT - never a substitute for it. A closure that is not one of the
      // authorizing links is a contradiction, not a convenience.
      copy_closure: (() => {
        if (i.closure === null) return null
        const found = i.links.find(l => l.name === i.closure?.name)
        if (found === undefined ||
            found.digest_file_digest !== i.closure.digest_file_digest) {
          throw new AuthorityRefused(
            'the recorded closure is not one of the authorizing links')
        }
        return { name: i.closure.name, digest_file_digest: i.closure.digest_file_digest }
      })(),
    },
    create_bundle: i.createBundle,
    // NON-SECRET RESIDUE METADATA ONLY: which reviewed names are gone and
    // which remain. Never a byte, never a URL, never a path outside the
    // container this run was given.
    removed: [...i.removed],
    retained: [...i.retained],
    container_removed: i.containerRemoved,
    note: i.note,
  }
}

// ---------------------------------------------------------------------------
// THE THREE MODES
// ---------------------------------------------------------------------------

export interface CliResult {
  readonly exitCode: number
  readonly lines: readonly string[]
}

/** Parse the reviewed read-back into facts. Tolerates nothing it did not ask for. */
export function parseRoleFacts(rows: readonly string[]): RoleFacts {
  const bool = (v: string | undefined): boolean => v === 't' || v === 'true'
  const tagged = (tag: string): string[] => rows
    .map(l => l.split('|').map(x => x.trim()))
    .filter(p => p[0] === tag)
    .map(p => p[1] ?? '')
    .filter(x => x.length > 0)
  const attr = rows.map(l => l.split('|').map(x => x.trim())).find(p => p[0] === 'attr')
  const system = tagged('system')
  return Object.freeze({
    // PARSED, NOT COERCED. An absent or malformed identifier is the empty
    // string, which no comparison and no record will accept.
    systemIdentifier: system.length === 1 && SYSTEM_IDENTIFIER.test(system[0] as string)
      ? system[0] as string
      : '',
    present: attr !== undefined,
    canLogin: bool(attr?.[1]),
    superuser: bool(attr?.[2]),
    createRole: bool(attr?.[3]),
    createDb: bool(attr?.[4]),
    replication: bool(attr?.[5]),
    bypassRls: bool(attr?.[6]),
    memberships: Object.freeze(tagged('member')),
    schemaUsage: Object.freeze(tagged('schema')),
    tableSelect: Object.freeze(tagged('select')),
    ledgerColumns: Object.freeze(tagged('ledger')),
    writeGrants: Object.freeze(tagged('write')),
    routineGrants: Object.freeze(tagged('routine')),
    sequenceGrants: Object.freeze(tagged('sequence')),
  })
}

/** The exact reviewed authority, compared field by field. */
export function assertReviewedAuthority(f: RoleFacts): void {
  if (!f.present) throw new AuthorityRefused('the export role is absent')
  if (!f.canLogin) throw new AuthorityRefused('the export role cannot log in')
  for (const [name, got] of [
    ['superuser', f.superuser], ['role creation', f.createRole],
    ['database creation', f.createDb], ['replication', f.replication],
    ['RLS bypass', f.bypassRls],
  ] as const) {
    if (got) throw new AuthorityRefused(`the export role has ${name}`)
  }
  if (f.memberships.length !== 0) {
    throw new AuthorityRefused('the export role is a member of another role')
  }
  for (const [what, got] of [
    ['write', f.writeGrants], ['routine', f.routineGrants], ['sequence', f.sequenceGrants],
  ] as const) {
    if (got.length !== 0) throw new AuthorityRefused(`the export role holds a ${what} grant`)
  }
  // EXACTLY THE REVIEWED READ SURFACE: nothing missing, nothing extra.
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && [...a].sort().every((x, n) => x === [...b].sort()[n])
  if (!same(f.schemaUsage, EXPORT_SCHEMAS)) {
    throw new AuthorityRefused('the export role does not hold exactly the reviewed schema usage')
  }
  // EXACTLY THE REVIEWED COPY TABLES - and NOT the ledger, which is granted
  // per column. Expecting table-level SELECT on the ledger would have demanded
  // a privilege the reviewed authority deliberately does not grant.
  if (!same(f.tableSelect, EXPORT_TABLES)) {
    throw new AuthorityRefused('the export role does not hold exactly the reviewed table selects')
  }
  if (!same(f.ledgerColumns, LEDGER_COLUMNS)) {
    throw new AuthorityRefused(
      'the export role does not hold exactly the reviewed ledger columns')
  }
}

const say = (lines: string[]) => (l: string): void => { lines.push(l) }

/**
 * --create: the role, its two credentials, and one record of both.
 *
 * ORDER MATTERS AND IS STATE-BASED. Everything that can be refused without
 * mutating anything is refused first; the container is created before the role
 * so a run that cannot even make a directory has not made a role; and every
 * failure after that point is classified by WHAT EXISTS, not by catching
 * broadly and cleaning up.
 */
export async function runCreate(
  v: Readonly<Record<string, string>>, deps: AuthorityDeps,
): Promise<CliResult> {
  const lines: string[] = []
  const out = say(lines)
  const policy = deps.policy
  // THE OPERATOR'S OWN RUN IDENTITY, VALIDATED FIRST.
  const { runId, stamp } = runIdentityOf(v)
  const batch = deps.batch ?? DEFAULT_BATCH
  const openAdmin = deps.openAdminPassfile ?? openReviewedFileDescriptor

  // 1. EVERY ARGUMENT, AND EVERY FINAL NAME, BEFORE ANY MUTATION.
  const evidenceRoot = required(v, '--evidence-root')
  const container = required(v, '--credential-container')
  const passfile = required(v, '--admin-passfile')
  const psqlPath = required(v, '--psql')
  const host = required(v, '--host')
  const port = required(v, '--port')
  const database = required(v, '--database')
  const adminUser = required(v, '--admin-user')
  // THE CONTAINER IS THIS POLICY'S, AND IT NAMES THE RUN THE OPERATOR CHOSE.
  if (assertPolicyContainer(container, policy) !== runId) {
    throw new AuthorityRefused('the credential container does not name this run')
  }
  // THE PUBLICATION THIS RUN WILL HAVE TO MAKE, PROVED POSSIBLE FIRST.
  //
  // K7-B7.2.2: this was a bare `statSync`, which FOLLOWS a symlinked root and
  // asked nothing about ownership or about whether the names this run is about
  // to mint are already occupied. A create that cannot publish its record must
  // not first create a role and two credentials nobody has a record of.
  ;(deps.preflightPublication ?? evidencePublicationPreflight)({
    root: evidenceRoot, prefix: CREATE_PREFIX, stamp, runId,
  })

  // AND WHICH CLUSTER THIS AUTHORITY WILL BELONG TO.
  //
  // READ-ONLY, AND BEFORE THE CONTAINER OR THE ROLE EXISTS. The identity is
  // what a later teardown must find still there, and what this run's own
  // rollback compares against: a role that is absent on a DIFFERENT cluster is
  // not this role's absence.
  const proveLive = deps.proveRole ?? defaultProveRole
  // AND THE RELEASE OF THE PARENT PASSFILE COPY IS LOAD-BEARING HERE.
  //
  // K7-B7.2.4: this read-back discarded it, so a run whose administrator
  // descriptor was never proved released went on to create a container, a
  // secret and a role. Nothing has been mutated yet, so an unproved release is
  // a refusal rather than a retained state.
  const entry = requireReleased(
    await withAdminPassfile(passfile, openAdmin, async fd => await proveLive({
      psqlPath, host, port, database, adminUser, passfileFd: fd,
    })),
    'entry role proof')
  const proved = { systemIdentifier: entry.systemIdentifier }
  if (!SYSTEM_IDENTIFIER.test(proved.systemIdentifier)) {
    throw new AuthorityRefused('the live cluster identity could not be proved')
  }
  // AND THE ROLE MUST NOT ALREADY EXIST.
  //
  // K7-B7.2.3: nothing asked. A run against a cluster that already had the
  // export role made a container and a secret, then issued a CREATE that could
  // only fail - and the failure path then reasoned about a role it had not
  // created. Absence is proved first, and a role that is present is refused
  // before the container, the secret, the batch, either credential or any
  // evidence exists.
  if (entry.present) {
    throw new AuthorityRefused('the export role already exists on this cluster')
  }

  // 2. THE CONTAINER. No-clobber, and never adopted.
  //
  // EVERYTHING FROM HERE IS CLASSIFIED BY WHAT EXISTS.
  //
  // K7-B7.2.5: `createContainer` can fail AFTER its `mkdir` succeeded - its own
  // verification of type, mode, owner or realpath may throw or disprove - and
  // that threw out of this function as an ordinary refusal, so a run reported
  // nothing while a container stood. A `mkdir` that succeeded is a fact about
  // the world and is never described as "nothing was created".
  let receipt: ContainerReceipt
  try {
    receipt = createContainer(container, policy)
  } catch (e) {
    // PROVENANCE COMES FROM THE CREATION BOUNDARY, NOT FROM A LATER LOOK.
    //
    // K7-B7.2.6: this used to `lstat` the candidate path after ANY failure and
    // call a present path "created but unverified". An EEXIST refusal means the
    // path was already there - this run created nothing - and an EACCES on the
    // candidate establishes neither existence nor ownership. Both were being
    // reported as this run's own retained object, which also made them look
    // eligible for cleanup. Only the typed failure, which `createContainer` can
    // raise solely after `mkdirSync` returned, means "this run made it".
    if (!(e instanceof ContainerCreatedButUnverified)) {
      // AND NOTHING IS LOOKED AT, ADOPTED, REPAIRED OR REMOVED.
      throw e
    }
    // NO RECEIPT, SO NO REMOVAL AUTHORITY: the object is named and kept.
    const decided = retainedUnknown({
      container, published: [],
      phase: `container-created-but-unverified:${e.step}`,
      alsoRetained: [],
    })
    for (const l of decided.lines) out(l)
    return { exitCode: decided.exitCode, lines }
  }
  out(`container ${receipt.path} ${receipt.deviceInode}`)

  /**
   * C.3/C.4: THE ONLY CLEANUP AVAILABLE BEFORE A CREATE WAS ATTEMPTED.
   *
   * The container is this run's, it is empty, and no statement has run - so it
   * may go, but only after its identity is re-proved. A proved removal is a
   * clean refusal; an unproved one names the retained container and exits 3.
   */
  const undoEmptyContainer = (why: string): CliResult => {
    const gone = removeOwnedEmptyContainer(receipt, policy, removalSeams(deps))
    if (gone.removed) {
      out(`REFUSED: ${why}; the empty container this run made is removed.`)
      return { exitCode: EXIT_REFUSED, lines }
    }
    const decided = retainedUnknown({
      container, published: [], phase: `container-retained:${why}:${gone.reason}`,
      alsoRetained: [],
    })
    for (const l of decided.lines) out(l)
    return { exitCode: decided.exitCode, lines }
  }

  // 3. ONE SECRET, ONE VERIFIER, IN MEMORY. Neither is ever printed, recorded
  //    or passed as an argument.
  //
  //    C.3: A FAILURE HERE IS AFTER THE CONTAINER AND BEFORE ANY STATEMENT.
  let verifier: string
  let secret: string
  try {
    secret = (deps.secret ?? generateExportSecret)()
    verifier = deriveScramSha256Verifier(secret)
  } catch {
    // NO SECRET LEAVES THIS BLOCK, not even in a reason.
    return undoEmptyContainer('no credential secret could be established')
  }

  // 4. THE ROLE, TRANSACTIONALLY. The verifier travels on the child's stdin
  //    and the administrator's passfile is inherited at descriptor 3.
  const args = adminArgs({ host, port, database, adminUser })

  // THE OUTCOME OF A STATEMENT IS NOT THE STATE OF THE CATALOGUE.
  //
  // K7-B7.2.3: `created` was a boolean inferred from `BatchOutcome.ok`, and
  // every path that inferred "the role does not exist" from it was wrong in a
  // way that removed this run's container while leaving the role behind:
  //
  //   - the CREATE commits and the parent descriptor close then fails;
  //   - the batch promise rejects AFTER the server committed;
  //   - a nonzero exit is taken as proof of absence.
  //
  // So nothing is inferred. The report is recorded as a REPORT, and what the
  // catalogue holds is measured by an independent read-back before any
  // container cleanup can happen.
  const created = await withAdminPassfile(
    passfile, openAdmin,
    async fd => await batch(psqlPath, args, createExportRoleSql(database, verifier), fd))
  if (created.state === 'not-started') {
    // C.4: NO DESCRIPTOR, SO `use` NEVER RAN AND NO CREATE WAS ATTEMPTED. This
    // is the same identity-safe empty-container cleanup as a secret failure -
    // and it is NOT the retained/unknown state that a started statement earns.
    return undoEmptyContainer('the administrator passfile could not be opened')
  }
  // THE STATEMENT MAY STILL HAVE COMMITTED. A failure is an unknown outcome,
  // never an absence - and never an errno in the output.
  const report: 'ok' | 'not-ok' | 'unknown' = created.state === 'failed'
    ? 'unknown'
    : created.result.ok ? 'ok' : 'not-ok'
  const releaseProved = created.release === 'proved'

  // C.5: AN UNPROVED DESCRIPTOR RELEASE IS NOT A CLEAN REFUSAL.
  //
  // The administrator's passfile descriptor may still be held by something
  // that outlives this call, and the role may exist. Nothing is removed and
  // nothing is described as untouched.
  if (!releaseProved) {
    const decided = retainedUnknown({
      container, published: [],
      phase: `role-creation-outcome-unknown:descriptor-release-unproved:${report}`,
      alsoRetained: [],
    })
    for (const l of decided.lines) out(l)
    return { exitCode: decided.exitCode, lines }
  }

  if (report !== 'ok') {
    // C.4: WHAT THE CATALOGUE HOLDS, MEASURED - NOT INFERRED FROM THE REPORT.
    let seen: { absent: boolean; systemIdentifier: string; release: ReleaseState } | null = null
    try {
      seen = await proveRoleAbsent({
        deps, psqlPath, host, port, database, adminUser, passfile, openAdmin,
      })
    } catch {
      seen = null
    }
    const sameCluster = seen !== null &&
      SYSTEM_IDENTIFIER.test(seen.systemIdentifier) &&
      seen.systemIdentifier === proved.systemIdentifier
    // AND AN ANSWER COLLECTED UNDER AN UNPROVED RELEASE IS NOT A PROOF.
    const vouched = seen !== null && seen.release === 'proved'
    if (seen !== null && seen.absent && sameCluster && vouched) {
      // PROVED ABSENT, ON THE RECORDED CLUSTER. This run may remove its own
      // empty container, and only through the fail-closed removal proof.
      // D.2: THROUGH THE IDENTITY-PROVING HELPER, never a bare rmdir.
      const gone = removeOwnedEmptyContainer(receipt, policy, removalSeams(deps))
      if (gone.removed) {
        out('REFUSED: the export role was proved absent on the recorded cluster, ' +
            'and the container this run made is removed.')
        return { exitCode: EXIT_REFUSED, lines }
      }
      const decided = retainedUnknown({
        container, published: [],
        phase: `container-retained-role-proved-absent:${gone.reason}`,
        alsoRetained: [],
      })
      for (const l of decided.lines) out(l)
      return { exitCode: decided.exitCode, lines }
    }
    // ROLE PRESENT, WRONG CLUSTER, MALFORMED PROOF, A PROOF REFUSAL OR A PROOF
    // FAILURE: the role may exist, so NOTHING is removed and the outcome is
    // reported as unknown rather than as "no role was created".
    const why = seen === null
      ? 'absence-unproved'
      : !vouched ? 'absence-release-unproved'
      : !sameCluster ? 'absence-on-another-cluster' : 'role-present'
    const decided = retainedUnknown({
      container, published: [],
      phase: `role-creation-outcome-unknown:${why}`, alsoRetained: [],
    })
    for (const l of decided.lines) out(l)
    return { exitCode: decided.exitCode, lines }
  }

  // C.3 + C.6: A SUCCESS REPORT IS NOT PROOF, AND THE PROOF COMES BEFORE THE
  //            CREDENTIALS.
  //
  // The role's exact reviewed authority and the cluster are proved here, so a
  // malformed or over-privileged role cannot cause two credentials to be
  // published merely so that they can then be retained.
  let authority: RoleFacts
  try {
    const facts = await withAdminPassfile(passfile, openAdmin, async fd => await proveLive({
      psqlPath, host, port, database, adminUser, passfileFd: fd,
    }))
    // B.4: AN UNPROVED RELEASE IS NOT A PROVED AUTHORITY. The role exists, so
    // this is a retained/unknown state and NO credential is published.
    authority = requireReleased(facts, 'post-create authority proof')
    assertReviewedAuthority(authority)
    assertSameCluster(authority.systemIdentifier, proved.systemIdentifier)
  } catch (e) {
    // THE ROLE MAY EXIST AND IS NOT WHAT WAS ASKED FOR. Nothing is removed,
    // nothing is published, and the state is named.
    const decided = retainedUnknown({
      container, published: [],
      phase: e instanceof AuthorityRefused
        ? `post-role:${e.reason}`
        : 'post-role:unknown',
      alsoRetained: [],
    })
    for (const l of decided.lines) out(l)
    return { exitCode: decided.exitCode, lines }
  }

  // 5. BOTH CREDENTIALS, FROM THE SAME SECRET.
  const endpoint = { host, port: Number(port), database }
  // 5. BOTH CREDENTIALS, PUBLISHED ONE AT A TIME.
  //
  // APPENDED IMMEDIATELY, NOT ASSIGNED AS AN ARRAY. `files = [a(), b()]`
  // assigns NOTHING when `b()` throws - so a run whose first credential had
  // reached its final name reported `published: []`, and the cleanup that
  // followed believed there was nothing to retain or remove.
  const files: FileReceipt[] = []
  try {
    files.push(publishCredential(
      container, DRIVER_FILE, `${buildExportCredentialTcpUrl(endpoint, secret)}\n`))
    files.push(publishCredential(
      container, PGPASS_FILE, buildExportPgpassLine(endpoint, secret)))
  } catch (e) {
    // PUBLISHED-BUT-UNVERIFIED IS NOT NOTHING-PUBLISHED. The reviewed publisher
    // distinguishes them, and a final name that may exist is never removed on
    // the strength of a guess.
    if (e instanceof CredentialPublishedButUnverified) {
      // BOTH NAMES, WHEN BOTH MAY EXIST. `unlink-temp` and every later phase
      // deliberately leave the temporary link in place as well, and naming
      // only the final one hid half of what an operator has to look at.
      const decided = retainedUnknown({
        container, published: files, phase: `credential-${e.phase}`,
        alsoRetained: [basename(e.finalPath), basename(e.temporaryPath)],
      })
      for (const l of decided.lines) out(l)
      return { exitCode: decided.exitCode, lines }
    }
    const decided = await handleCredentialFailure({
      container, containerReceipt: receipt, published: files, policy,
      drop: async () => await dropRole({ psqlPath, args, database, passfile, openAdmin, batch }),
      proveAbsent: async () => {
        const seen = await proveRoleAbsent({
          deps, psqlPath, host, port, database, adminUser, passfile, openAdmin,
        })
        // ABSENT, AND ON THE CLUSTER THIS RUN CREATED THE ROLE ON - and the
        // release state travels with the answer rather than being flattened.
        return {
          absent: seen.absent && seen.systemIdentifier === proved.systemIdentifier,
          release: seen.release,
        }
      },
    })
    for (const l of decided.lines) out(l)
    return { exitCode: decided.exitCode, lines }
  }

  // 6. EVERY FAILURE FROM HERE RETAINS. The role exists and both credentials
  //    exist, so a proof that refuses, a read-back that throws, an authority
  //    that does not match, or an evidence publication whose state is unknown
  //    all leave the world alone and say so. None of them is a refusal.
  try {
    for (const f of files) proveCredential(container, f, policy.prove)
    return publishCreateRecord({
      evidenceRoot, stamp, runId, receipt, files,
      endpoint: { host, port, database }, role: authority, out, lines,
      publish: deps.publish,
    })
  } catch (e) {
    const decided = retainedUnknown({
      container, published: files,
      phase: e instanceof AuthorityRefused ? `post-role:${e.reason}` : 'post-role:unknown',
      alsoRetained: [],
    })
    for (const l of decided.lines) out(l)
    return { exitCode: decided.exitCode, lines }
  }
}

/** Publish the create record, classifying an unknown publication truthfully. */
function publishCreateRecord(i: {
  evidenceRoot: string; stamp: string; runId: string
  receipt: ContainerReceipt; files: readonly FileReceipt[]
  endpoint: { host: string; port: string; database: string }
  role: RoleFacts
  out: (l: string) => void; lines: string[]
  publish?: (i: Parameters<typeof publishEvidence>[0]) => PublishedEvidence
}): CliResult {
  let published
  try {
    published = (i.publish ?? publishEvidence)({
      root: i.evidenceRoot, prefix: CREATE_PREFIX, stamp: i.stamp, runId: i.runId,
      artifacts: [{
        path: 'role.json',
        bytes: Buffer.from(`${JSON.stringify({ role: EXPORT_ROLE_NAME })}\n`, 'utf-8'),
      }],
      manifest: {
        path: CREATE_FILE,
        bytes: Buffer.from(`${JSON.stringify(createDocument({
          runId: i.runId, stamp: i.stamp, outcome: 'CREATED_AND_PROVED',
          container: i.receipt, files: i.files, endpoint: i.endpoint,
          role: i.role, note: null,
        }))}\n`, 'utf-8'),
      },
    })
    verifyPublishedEvidence(published.finalPath)
  } catch {
    // THE EVIDENCE MAY OR MAY NOT EXIST. Either way the role and both
    // credentials do, so nothing is cleaned up and the state is reported.
    const decided = retainedUnknown({
      container: i.receipt.path, published: i.files,
      phase: 'create-evidence-unknown', alsoRetained: [],
    })
    for (const l of decided.lines) i.out(l)
    return { exitCode: decided.exitCode, lines: i.lines }
  }
  i.out(`export authority published ${basename(published.finalPath)}`)
  i.out('CREATED_AND_PROVED')
  return { exitCode: EXIT_OK, lines: i.lines }
}

/**
 * EVERYTHING STAYS, AND IS NAMED. The one result for a state nobody proved.
 *
 * No chmod, no unlink, no rmdir, no retry. Only reviewed basenames and the
 * reviewed container path reach the output - never a secret, a URL, a
 * verifier, a credential-derived digest or an errno.
 */
export function retainedUnknown(i: {
  container: string
  published: readonly FileReceipt[]
  phase: string
  alsoRetained: readonly string[]
}): { exitCode: number; lines: readonly string[]; retained: readonly string[] } {
  const retained = [
    ...new Set([...i.published.map(f => f.name), ...i.alsoRetained]),
  ].sort()
  return {
    exitCode: EXIT_RETAINED_UNKNOWN,
    lines: [
      `RETAINED: the export authority was not removed (${i.phase}).`,
      `RETAINED container ${i.container}`,
      ...(retained.length === 0 ? [] : [`RETAINED: ${retained.join(', ')}`]),
    ],
    retained,
  }
}

/**
 * THE ROLE EXISTS AND NO CREDENTIAL REACHED A FINAL NAME IT CAN KEEP.
 *
 * EXTRACTED SO IT CAN BE PROVED. Inline, this decision sat behind a container
 * path under a fixed absolute root a test must not create, so a mutant that
 * replaced the drop with `true` - claiming the role was removed when nothing
 * had been attempted - survived every runnable test.
 *
 * THE RULE: drop the role, remove ONLY objects this invocation proved it
 * created, and report what is actually retained. A drop that cannot be proved
 * leaves everything in place and says so; nothing is chmod'd, retried or
 * forced, and an occupied pre-existing path is never touched.
 */
/**
 * REMOVE THE CONTAINER THIS RUN MADE, AND PROVE THE OUTCOME.
 *
 * K7-B7.2.1: the create path swallowed the `rmdir` failure and then announced
 * that no role and no credential were created by this run - which is false
 * while the container is still standing. Removal is REPORTED only when the
 * directory is afterwards proved absent; otherwise the caller names it and
 * exits as a retained state.
 *
 * The two seams exist so both outcomes can be observed without creating
 * anything under the reviewed absolute credential root.
 */
export function proveContainerRemoved(
  container: string,
  // `lstat`, NOT `stat`: a symlink standing where the container was must be
  // seen as an object that is STILL THERE, not followed to wherever it points
  // and judged by that. BOTH ARE REQUIRED: K7-B7.2.4 removed the global
  // defaults so that no removal can escape the policy it was asked for.
  ops: { readonly rmdir: (p: string) => void; readonly lstat: (p: string) => Stats },
): boolean {
  const { rmdir, lstat } = ops
  try {
    rmdir(container)
  } catch {
    // NOT PROOF EITHER WAY. A failure may still have removed it, and a success
    // says nothing about what is at the name now.
  }
  try {
    lstat(container)
    // SOMETHING IS THERE. Directory, regular file, symlink, FIFO, socket or
    // device - the question is whether the name is clear, and it is not. The
    // object is left exactly as it is: nothing here chmods, unlinks, follows,
    // retries or recurses.
    return false
  } catch (e) {
    // ENOENT, AND ONLY ENOENT, IS ABSENCE.
    //
    // K7-B7.2.2: this returned `true` for EVERY failure, so EPERM, EACCES, EIO
    // or EINTR - "I could not look" - was reported to the operator as "this
    // run left nothing behind". That is the one answer that must never be
    // guessed, because it is what suppresses the retained-state exit.
    return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT'
  }
}

export async function handleCredentialFailure(i: {
  container: string
  /** The policy every proof and every removal in this cleanup comes from. */
  policy: AuthorityPolicy
  /** The container's own receipt, for the no-follow identity re-proof. */
  containerReceipt: ContainerReceipt
  published: readonly FileReceipt[]
  /** The per-credential identity proof. Injected only so a test can observe it. */
  prove?: (container: string, r: FileReceipt) => void
  /** The container identity proof. Same seam, same reason. */
  proveDir?: (c: ContainerReceipt) => void
  /**
   * The drop's own report, AND whether this process can vouch for the call.
   *
   * `not-started` means no descriptor was opened, so no DROP was attempted.
   */
  drop: () => Promise<{ reported: boolean; release: ReleaseState | 'not-started' }>
  /** An INDEPENDENT read-back, with the release state it was collected under. */
  proveAbsent: () => Promise<{ absent: boolean; release: ReleaseState }>
  unlink?: (p: string) => void
  rmdir?: (p: string) => void
}): Promise<{ exitCode: number; lines: readonly string[]; retained: readonly string[] }> {
  // FROM THE POLICY, NOT FROM THE PROCESS. See teardownRemoval.
  const unlink = i.unlink ?? i.policy.fs.unlinkSync
  const rmdir = i.rmdir ?? i.policy.fs.rmdirSync

  // 1. ASK FOR THE DROP.
  //
  //    B.9: AN UNPROVED DESCRIPTOR RELEASE IS NOT A CLEAN `false`. The drop may
  //    have happened; what this process cannot do is vouch for the call. That
  //    uncertainty is named in the phase rather than collapsed into "retained".
  // C.6: AND A DROP THAT THROWS, OR NEVER STARTED, IS CAUGHT HERE.
  //
  // K7-B7.2.5: an exception from the drop attempt escaped this function, so a
  // run that already had a role and possibly a credential fell through to the
  // top-level generic refusal - which reads as "nothing happened".
  let drop: { reported: boolean; release: ReleaseState | 'not-started' }
  try {
    drop = await i.drop()
  } catch {
    drop = { reported: false, release: 'not-started' }
  }
  const dropped = drop.reported && drop.release === 'proved'

  // 2. AND PROVE IT, INDEPENDENTLY. A DROP batch that exited zero is the
  //    statement's own report, not a fact about the catalogue.
  let absent = false
  let why = drop.release === 'proved'
    ? 'role-drop-unproved'
    : drop.release === 'not-started'
      ? 'role-drop-not-attempted'
      : 'role-drop-release-unproved'
  if (dropped) {
    why = 'role-absence-unproved'
    try {
      const seen = await i.proveAbsent()
      absent = seen.absent && seen.release === 'proved'
      if (!absent && seen.release !== 'proved') why = 'role-absence-release-unproved'
    } catch { absent = false }
  }

  // 3. NOTHING IS REMOVED UNTIL ABSENCE IS PROVED.
  //
  //    THE RULE IS ABSOLUTE, AND IT WAS BROKEN. The removal loop used to run
  //    whatever `drop()` returned - so a failed drop still deleted both
  //    credentials and left a role that could no longer be reached. The
  //    credential is the ONLY usable way back to that role; destroying it
  //    while the role may exist is the worst outcome available here.
  if (!dropped || !absent) {
    const decided = retainedUnknown({
      container: i.container, published: i.published,
      phase: why,
      alsoRetained: [],
    })
    return { ...decided, lines: [
      `REFUSED: the credentials were not published; the role was RETAINED.`,
      ...decided.lines,
    ] }
  }

  // 4. ONLY NOW, AND THROUGH THE SAME REMOVAL PRIMITIVE THE TEARDOWN USES.
  //
  //    K7-B7.2.1: this was a second, weaker loop that unlinked the recorded
  //    NAMES directly - with no no-follow identity proof - so a credential
  //    substituted after absence was proved would have been deleted. One
  //    primitive, one rule.
  const out = teardownRemoval({
    container: i.containerReceipt, files: i.published, policy: i.policy,
    dropped: true, roleAbsent: true,
    ...(i.prove === undefined ? {} : { prove: i.prove }),
    ...(i.proveDir === undefined ? {} : { proveDir: i.proveDir }),
    unlink: p => { unlink(p) }, rmdir: p => { rmdir(p) },
  })
  const retained = [...out.retained]
  if (retained.length > 0 || !out.containerRemoved) {
    if (!retained.includes(basename(i.container))) retained.push(basename(i.container))
  }
  return {
    exitCode: retained.length === 0 ? EXIT_REFUSED : EXIT_RETAINED_UNKNOWN,
    lines: [
      'REFUSED: the credentials were not published; the role was dropped and proved absent.',
      ...(retained.length === 0 ? [] : [`RETAINED: ${retained.join(', ')}`]),
    ],
    retained,
  }
}

/**
 * REFUSE A PUBLICATION THAT IS ALREADY KNOWN TO FAIL - BEFORE MUTATING ANYTHING.
 *
 * K7-B7.2.2: `runTeardown` validated and published its evidence only AFTER
 * `DROP ROLE` and the credential/container removal, so a root that was not a
 * mode-0700 owned directory, or a final name that was already occupied,
 * destroyed the authority and only then discovered it could not record what it
 * had done. That is avoidable destruction, and it contradicted the preflight
 * rule this file already applies to the container and credentials.
 *
 * WHAT THIS IS NOT. It does not replace `publishEvidence`'s own checks, and it
 * does not pretend to remove the race: the root can still be swapped between
 * this proof and the publication. A failure that arises only afterwards still
 * reaches the truthful publication-UNKNOWN exit, and still retries nothing.
 */
export function evidencePublicationPreflight(i: {
  root: string; prefix: string; stamp: string; runId: string
}): { root: string; finalName: string; temporaryName: string } {
  // THE SHARED ROOT SEMANTICS, not a local `statSync`: canonical, a real
  // non-symlink directory, owned by this process, exactly mode 0700.
  let root: string
  try {
    root = assertEvidenceRoot(i.root)
  } catch {
    // BOUNDED. The evidence module's reason is reviewed prose, but it is not
    // this interface's vocabulary and may name a path; the option is enough.
    throw new AuthorityRefused('the evidence root is not a reviewed evidence root')
  }
  let names: { finalName: string; temporaryName: string }
  try {
    names = evidenceNames(i.prefix, i.stamp, i.runId)
  } catch {
    throw new AuthorityRefused('the evidence name is not in the reviewed form')
  }
  // BOTH NAMES, ENOENT-ONLY. A dangling symlink is PRESENT - publishing onto
  // it would write through the link - and any examination error refuses.
  for (const [what, name] of [
    ['final', names.finalName], ['temporary', names.temporaryName],
  ] as const) {
    let present: boolean
    try {
      present = pathIsPresent(join(root, name))
    } catch {
      throw new AuthorityRefused(`the ${what} evidence name could not be examined`)
    }
    if (present) {
      throw new AuthorityRefused(`a path is already present at the ${what} evidence name`)
    }
  }
  return { root, finalName: names.finalName, temporaryName: names.temporaryName }
}

/**
 * REMOVE A CONTAINER THIS RUN OWNS, AFTER RE-PROVING IT IS STILL THAT OBJECT.
 *
 * K7-B7.2.5: the create path called `proveContainerRemoved` directly, so unlike
 * the teardown it never re-proved the receipt first - and an empty directory
 * substituted at the same name, with a different device:inode, would have been
 * removed. Identity comes first, then the policy-backed `rmdir`, then the
 * ENOENT-only proof; if the identity fails, NOTHING is removed.
 */
export function removeOwnedEmptyContainer(
  receipt: ContainerReceipt, policy: AuthorityPolicy,
  seams: { rmdir: (p: string) => void; lstat: (p: string) => Stats },
): { removed: boolean; reason: 'removed' | 'identity-unproved' | 'removal-unproved' } {
  try {
    proveContainer(receipt, policy)
  } catch {
    return { removed: false, reason: 'identity-unproved' }
  }
  return proveContainerRemoved(receipt.path, seams)
    ? { removed: true, reason: 'removed' }
    : { removed: false, reason: 'removal-unproved' }
}

/** The container-removal seams a caller may inject, and nothing else. */
export function removalSeams(deps: AuthorityDeps): {
  rmdir: (p: string) => void; lstat: (p: string) => Stats
} {
  // FROM THE POLICY UNLESS A TEST IS OBSERVING ONE OF THEM. There is no
  // process-global fallback here any more: K7-B7.2.4 removed the last path by
  // which a removal under a test policy could reach the real filesystem.
  return {
    rmdir: deps.rmdirContainer ?? deps.policy.fs.rmdirSync,
    lstat: deps.lstatContainer ?? deps.policy.fs.lstatSync,
  }
}

/** An INDEPENDENT read-back that answers only "is the role gone". */
export async function proveRoleAbsent(i: {
  deps: AuthorityDeps
  psqlPath: string; host: string; port: string; database: string; adminUser: string
  passfile: string
  openAdmin: (p: string) => HeldDescriptor
}): Promise<{ absent: boolean; systemIdentifier: string; release: ReleaseState }> {
  const proveRole = i.deps.proveRole ?? defaultProveRole
  const facts = await withAdminPassfile(i.passfile, i.openAdmin, async fd => await proveRole({
    psqlPath: i.psqlPath, host: i.host, port: i.port, database: i.database,
    adminUser: i.adminUser, passfileFd: fd,
  }))
  // THE IDENTITY IT OBSERVED TRAVELS WITH THE ANSWER.
  //
  // K7-B7.2.2: this returned a bare boolean, so "the role is not here" was
  // accepted as "the recorded authority is gone" - and those are different
  // statements when the cluster behind the endpoint is not the recorded one.
  // An absence on another cluster proves nothing about this authority.
  //
  // K7-B7.2.4: AND THE RELEASE TRAVELS WITH IT TOO. An answer collected while
  // the parent descriptor copy was never proved released is not an absence
  // proof, so the caller is given the fact rather than a flattened boolean.
  if (facts.state !== 'ok') {
    if (facts.failure instanceof AuthorityRefused) throw facts.failure
    throw new AuthorityRefused(facts.state === 'not-started'
      ? 'the administrator passfile could not be opened for the absence read-back'
      : 'the role absence read-back did not complete')
  }
  return {
    absent: !facts.result.present,
    systemIdentifier: facts.result.systemIdentifier,
    release: facts.release,
  }
}

/**
 * ASK FOR THE DROP, AND REPORT WHAT IS ACTUALLY KNOWN ABOUT IT.
 *
 * K7-B7.2.4: this returned `result.ok` and swallowed everything else, so a
 * batch whose administrator descriptor release was never proved reported a
 * clean `true` - and the caller then removed credentials on the strength of
 * it. `reported` is the statement's own word; `release` says whether this
 * process can even vouch for the call that carried it.
 */
export async function dropRole(i: {
  psqlPath: string; args: readonly string[]; database: string; passfile: string
  openAdmin: (p: string) => HeldDescriptor
  batch: NonNullable<AuthorityDeps['batch']>
}): Promise<{ reported: boolean; release: ReleaseState | 'not-started' }> {
  const g = await withAdminPassfile(
    i.passfile, i.openAdmin,
    async fd => await i.batch(i.psqlPath, i.args, dropExportRoleSql(i.database), fd))
  if (g.state === 'not-started') {
    // NO DESCRIPTOR, NO STATEMENT. The DROP was never attempted, which is a
    // different fact from "attempted and unvouched for".
    return { reported: false, release: 'not-started' }
  }
  return { reported: g.state === 'ok' && g.result.ok, release: g.release }
}

/**
 * THE REAL READ-BACK, over a rows-returning session.
 *
 * NOT `runExportRoleBatch`. That function deliberately returns only an exit
 * code, because the batches it runs carry a SCRAM verifier and psql echoes a
 * failing statement - so it has nowhere to put output even when the caller
 * wants some. This proof sends no secret at all, so it uses the reviewed
 * backend, which returns rows and takes the same inherited descriptor.
 */
const defaultProveRole = async (i: RoleProofInputs): Promise<RoleFacts> => {
  const backend = await openPsqlBackend({
    psqlPath: i.psqlPath,
    host: i.host,
    port: Number(i.port),
    database: i.database,
    user: i.adminUser,
    passfileFd: i.passfileFd,
  })
  try {
    const rows = await backend.rows(PROVE_ROLE_SQL)
    return parseRoleFacts(rows.map(r => r.join('|')))
  } finally {
    await backend.close()
  }
}

/** Verify a create bundle from disk and return its document. */
/**
 * WHAT A TEARDOWN MAY REMOVE, AND WHEN.
 *
 * EXTRACTED SO IT CAN BE PROVED. Inline, this sat behind a container path under
 * a fixed absolute root a test must not create, so a mutant that deleted both
 * credentials while role absence was UNPROVED survived every runnable test.
 *
 * THE GATE IS ABSOLUTE - the same defect as in the create path: both files
 * were unlinked whether `roleAbsent` was true or false, so a drop that
 * silently failed took away the only credential that could still reach the
 * role it belonged to.
 */
export function teardownRemoval(i: {
  container: ContainerReceipt
  files: readonly FileReceipt[]
  dropped: boolean
  roleAbsent: boolean
  /**
   * THE POLICY THIS REMOVAL ACTS UNDER. Every proof and every mutation comes
   * from it.
   *
   * K7-B7.2.4: the proofs were policy-aware while `unlink`, `rmdir` and the
   * final `lstat` fell back to the process-global filesystem - so a run under a
   * test policy still removed through the real global calls. One boundary, or
   * none.
   */
  policy: AuthorityPolicy
  prove?: (container: string, r: FileReceipt) => void
  proveDir?: (c: ContainerReceipt) => void
  unlink?: (p: string) => void
  rmdir?: (p: string) => void
  /** The no-follow look the ENOENT-only removal proof takes. */
  lstat?: (p: string) => Stats
}): { removed: readonly string[]; retained: readonly string[]; containerRemoved: boolean } {
  const prove = i.prove ?? ((c: string, r: FileReceipt) => {
    proveCredential(c, r, i.policy.prove)
  })
  const proveDir = i.proveDir ?? ((c: ContainerReceipt) => { proveContainer(c, i.policy) })
  const unlink = i.unlink ?? i.policy.fs.unlinkSync
  const rmdir = i.rmdir ?? i.policy.fs.rmdirSync
  const lstat = i.lstat ?? i.policy.fs.lstatSync
  const removed: string[] = []
  const retained: string[] = []

  if (!i.dropped || !i.roleAbsent) {
    for (const f of i.files) retained.push(f.name)
    return { removed, retained, containerRemoved: false }
  }

  for (const f of i.files) {
    try {
      prove(i.container.path, f)
      unlink(join(i.container.path, f.name))
      removed.push(f.name)
    } catch {
      retained.push(f.name)
    }
  }
  let containerRemoved = false
  if (retained.length === 0) {
    try {
      proveDir(i.container)
    } catch {
      return { removed, retained, containerRemoved: false }
    }
    // THROUGH THE SAME FAIL-CLOSED PRIMITIVE THE CREATE PATH USES.
    //
    // K7-B7.2.3: this set `containerRemoved = true` the moment `rmdir`
    // RETURNED, so a silent or no-op removal reported a removal that never
    // happened - exactly the trust in a call's return that
    // `proveContainerRemoved` was corrected to refuse. ENOENT is the only
    // proof, and there is one rule rather than two.
    containerRemoved = proveContainerRemoved(i.container.path, { rmdir, lstat })
  }
  return { removed, retained, containerRemoved }
}

/** Prove the container and both credentials are the recorded objects. */
export function teardownPreflight(
  container: ContainerReceipt, files: readonly FileReceipt[],
  policy: AuthorityPolicy,
): void {
  proveContainer(container, policy)
  for (const f of files) proveCredential(container.path, f, policy.prove)
}

export function readCreateBundle(dir: string): {
  doc: Record<string, unknown>; name: string; digestFileDigest: string
} {
  const files = verifyPublishedEvidence(dir)
  if (!files.includes(CREATE_FILE)) {
    throw new AuthorityRefused('the create bundle has no manifest', CREATE_FILE)
  }
  const doc = JSON.parse(readFileSync(join(dir, CREATE_FILE), 'utf-8')) as Record<string, unknown>
  if (doc.record !== CREATE_PREFIX) {
    throw new AuthorityRefused('the named bundle is not an export-authority record')
  }
  if (doc.complete !== true) throw new AuthorityRefused('the create bundle is not complete')
  if (doc.outcome !== 'CREATED_AND_PROVED') {
    throw new AuthorityRefused('the create bundle does not record a proved creation')
  }
  const named = /^export-authority-create-(\d{8}T\d{6}Z)-([0-9a-f]{8})$/.exec(basename(dir))
  if (named === null) {
    throw new AuthorityRefused('the create bundle is not in the reviewed name form')
  }
  // THE DOCUMENT MUST DESCRIBE THE RUN ITS DIRECTORY IS NAMED FOR.
  //
  // K7-B7.2.1: only the basename PATTERN was checked, so a republished bundle
  // could be named for run A while describing run B - and a teardown decides
  // what to DELETE from this document.
  const run = doc.run
  if (typeof run !== 'object' || run === null) {
    throw new AuthorityRefused('the create bundle records no run identity')
  }
  const r = run as Record<string, unknown>
  if (r.stamp !== named[1]) {
    throw new AuthorityRefused('the create bundle describes a different run instant')
  }
  if (r.id !== named[2]) {
    throw new AuthorityRefused('the create bundle describes a different run identity')
  }
  return {
    doc,
    name: basename(dir),
    digestFileDigest: createHash('sha256')
      .update(readFileSync(join(dir, DIGEST_FILE))).digest('hex'),
  }
}

/** A string field, or a refusal. Never `String(someObject)`. */
const field = (v: unknown, what: string, re: RegExp): string => {
  if (typeof v !== 'string' || !re.test(v)) {
    throw new AuthorityRefused(`the create bundle records no reviewed ${what}`)
  }
  return v
}

/** A finite integer field, or a refusal. Never `Number(someObject)`. */
const intField = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new AuthorityRefused(`the create bundle records no reviewed ${what}`)
  }
  return v
}

const BOUNDED_HOST = /^[A-Za-z0-9._-]{1,253}$/
const BOUNDED_PORT = /^[1-9][0-9]{0,4}$/
const BOUNDED_IDENT = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * READ THE CREATE RECORD STRICTLY, before anything is mutated.
 *
 * WHAT WAS WRONG. Every field went through `String()` or `Number()`, so an
 * object, an array or `null` became a plausible-looking value: `String({})`
 * is `'[object Object]'` and `Number(undefined)` is `NaN`, and both sailed
 * through. A republished bundle with a recomputed DIGEST and malformed
 * semantic fields was therefore accepted - and this record is what a teardown
 * decides what to DELETE from.
 *
 * The names are also pinned: exactly the two reviewed basenames, once each.
 * Two entries called the same thing, a traversal name, or an extra file would
 * have been read as "two credentials" by a length check alone.
 */
export function receiptsOf(
  doc: Record<string, unknown>, policy: AuthorityPolicy,
): {
  container: ContainerReceipt
  files: readonly FileReceipt[]
  systemIdentifier: string
  endpoint: { host: string; port: string; database: string }
} {
  const c = doc.container
  const creds = doc.credentials
  if (typeof c !== 'object' || c === null || Array.isArray(c)) {
    throw new AuthorityRefused('the create bundle records no container')
  }
  if (!Array.isArray(creds) || creds.length !== 2) {
    throw new AuthorityRefused('the create bundle does not record exactly two credentials')
  }
  const cr = c as Record<string, unknown>
  const recordedPath = field(cr.path, 'container path', /^\/[^\0]{1,512}$/)
  assertPolicyContainer(recordedPath, policy)
  const container: ContainerReceipt = Object.freeze({
    path: recordedPath,
    deviceInode: field(cr.device_inode, 'container device:inode', DEVICE_INODE),
    uid: intField(cr.uid, 'container owner'),
    mode: field(cr.mode, 'container mode', /^700$/),
  })

  const seen = new Set<string>()
  const files = creds.map(raw => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new AuthorityRefused('a credential record is not an object')
    }
    const f = raw as Record<string, unknown>
    const name = field(f.name, 'credential name', /^[A-Za-z0-9._-]{1,64}$/)
    // EXACTLY THE TWO REVIEWED NAMES, ONCE EACH. A traversal name cannot even
    // match the pattern above, and a duplicate is refused here.
    if (name !== DRIVER_FILE && name !== PGPASS_FILE) {
      throw new AuthorityRefused('a credential is not a reviewed credential name', name)
    }
    if (seen.has(name)) {
      throw new AuthorityRefused('a credential name is recorded twice', name)
    }
    seen.add(name)
    return Object.freeze({
      name,
      deviceInode: field(f.device_inode, 'credential device:inode', DEVICE_INODE),
      uid: intField(f.uid, 'credential owner'),
      mode: field(f.mode, 'credential mode', /^600$/),
      links: intField(f.links, 'credential link count'),
    })
  })
  if (files.some(f => f.links !== 1)) {
    throw new AuthorityRefused('a credential is recorded with more than one link')
  }
  if (seen.size !== 2) {
    throw new AuthorityRefused('the create bundle does not record both reviewed credentials')
  }

  // AND THE CONTAINER MUST NAME THE RUN THE BUNDLE BELONGS TO.
  const run = doc.run
  if (typeof run !== 'object' || run === null) {
    throw new AuthorityRefused('the create bundle records no run identity')
  }
  const runId = field((run as Record<string, unknown>).id, 'run identity', /^[0-9a-f]{8}$/)
  field((run as Record<string, unknown>).stamp, 'run stamp', /^\d{8}T\d{6}Z$/)
  if (basename(container.path) !== `s4f-k7-export-${runId}`) {
    throw new AuthorityRefused('the recorded container does not name this run')
  }

  const ep = doc.endpoint
  if (typeof ep !== 'object' || ep === null || Array.isArray(ep)) {
    throw new AuthorityRefused('the create bundle records no endpoint')
  }
  const e = ep as Record<string, unknown>
  // THE CLUSTER IDENTITY IS REQUIRED, AND READ STRICTLY.
  //
  // A record with no identifier cannot say which cluster it was written about,
  // and a numeric one has already been through `Number` - above 2^53 that is a
  // different value than the one the cluster reported. Both are refused rather
  // than coerced.
  const src = doc.source
  if (typeof src !== 'object' || src === null || Array.isArray(src)) {
    throw new AuthorityRefused('the create bundle records no source identity')
  }
  const systemIdentifier = field(
    (src as Record<string, unknown>).system_identifier,
    'source system identifier', SYSTEM_IDENTIFIER)
  return {
    container,
    files: Object.freeze(files),
    systemIdentifier,
    endpoint: {
      host: field(e.host, 'endpoint host', BOUNDED_HOST),
      port: field(e.port, 'endpoint port', BOUNDED_PORT),
      database: field(e.database, 'endpoint database', BOUNDED_IDENT),
    },
  }
}

/**
 * --prove: READ-ONLY. Verifies the record, then re-proves the world against it.
 *
 * IT PUBLISHES NOTHING AND READS NO CREDENTIAL. Identity is what a proof of a
 * secret container can establish: device:inode, owner, mode, link count. The
 * bytes are the secret, so reading or hashing them would turn this mode into a
 * credential oracle that leaves no record of having looked.
 */
export async function runProve(
  v: Readonly<Record<string, string>>, deps: AuthorityDeps,
): Promise<CliResult> {
  const lines: string[] = []
  const out = say(lines)
  const policy = deps.policy
  // IDENTITY AND ENDPOINT COME FROM THE VERIFIED BUNDLE, and `MODE_OPTIONS`
  // now refuses every option this mode does not read - including `--run-id`,
  // `--stamp` and the endpoint - in the parser, before anything is opened. A
  // second check here would be unreachable, so there is not one.
  const { doc, name } = readCreateBundle(required(v, '--create-bundle'))
  const { container, files, endpoint, systemIdentifier } = receiptsOf(doc, policy)

  // THE CONTAINER AND BOTH FILES, by identity - through the same no-follow
  // proofs the teardown preflight uses. `stat` here asked nothing about
  // directory type, symlink status, owner or the reviewed path.
  proveContainer(container, policy)
  for (const f of files) proveCredential(container.path, f, policy.prove)

  // AND THE ROLE, independently.
  const proveRole = deps.proveRole ?? defaultProveRole
  const openAdmin = deps.openAdminPassfile ?? openReviewedFileDescriptor
  const facts = await withAdminPassfile(
    required(v, '--admin-passfile'), openAdmin,
    async fd => await proveRole({
      psqlPath: required(v, '--psql'),
      host: endpoint.host, port: endpoint.port, database: endpoint.database,
      adminUser: required(v, '--admin-user'), passfileFd: fd,
    }))
  // B.5: NO PROVED, AND NO EXIT 0, ON AN UNPROVED RELEASE. This mode exists to
  // state what is established; a proof whose descriptor release cannot be
  // vouched for establishes nothing.
  const observed = requireReleased(facts, 'role proof')
  assertReviewedAuthority(observed)
  // AND THE CLUSTER THAT ANSWERED IS THE ONE THE RECORD WAS WRITTEN ABOUT.
  assertSameCluster(observed.systemIdentifier, systemIdentifier)

  // A BOUNDED RESULT. Names and counts, never a byte.
  out(`create bundle ${name}`)
  out(`cluster ${systemIdentifier}`)
  out(`role ${EXPORT_ROLE_NAME} present login-only`)
  out(`container ${container.path} ${container.deviceInode} mode ${container.mode}`)
  for (const f of files) out(`credential ${f.name} ${f.deviceInode} mode ${f.mode}`)
  out('PROVED')
  return { exitCode: EXIT_OK, lines }
}

/** What a reviewed terminal disposition was proved by. */
export interface TeardownAuthorization {
  readonly disposition: string
  readonly links: readonly { name: string; digest_file_digest: string }[]
  readonly closure: { name: string; digest_file_digest: string } | null
}

const linkOf = (dir: string): { name: string; digest_file_digest: string } => ({
  name: basename(dir),
  digest_file_digest: createHash('sha256')
    .update(readFileSync(join(dir, DIGEST_FILE))).digest('hex'),
})

/** Read one verified bundle's manifest, by record tag. */
function readRecord(dir: string, record: string, file: string): Record<string, unknown> {
  const files = verifyPublishedEvidence(dir)
  if (!files.includes(file)) {
    throw new AuthorityRefused('a referenced bundle has no manifest', file)
  }
  const doc = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Record<string, unknown>
  if (doc.record !== record) {
    throw new AuthorityRefused('a referenced bundle is not the expected record', record)
  }
  if (doc.complete !== true) {
    throw new AuthorityRefused('a referenced bundle is not complete', record)
  }
  return doc
}

/**
 * PROVE A TEARDOWN IS AUTHORIZED, from evidence on disk.
 *
 * TWO BRANCHES, BOTH EVIDENCE-BACKED:
 *
 *   no-target-commit  the commit disposition and the pristine-release record
 *                     must both say NOT_COMMITTED_PRISTINE, the release must
 *                     be proved at zero reviewed locks, a retry must be
 *                     permitted, the pristine record's commit_disposition link
 *                     must match the selected disposition bundle by basename
 *                     AND digest, both must name the selected Stage-1 bundle,
 *                     and that Stage-1 bundle's effective and authenticated
 *                     roles must be the export role in the create record's
 *                     own database.
 *
 *   copy-closed       the WHOLE chain `--close-copy` verifies, re-verified
 *                     here: closure, copy restoration and all four upstream
 *                     bundles, every basename+digest link compared, with
 *                     COPY_RESTORED and COMPLETE at their reviewed layers.
 */
export function authorizeTeardown(
  disposition: string,
  v: Readonly<Record<string, string>>,
  endpoint: {
    host: string; port: string; database: string
    /** The create record's proved cluster identity. */
    systemIdentifier: string
  },
): TeardownAuthorization {
  if (disposition === 'no-target-commit') {
    const manifestDir = required(v, '--source-manifest-bundle')
    const dispositionDir = required(v, '--commit-disposition-bundle')
    const pristineDir = required(v, '--pristine-release-bundle')

    const stage1 = stage1AuthorityOf(verifyPublishedStage1(manifestDir))
    // THE FILENAMES AND FIELD SHAPES PRODUCTION ACTUALLY PUBLISHES.
    //
    // K7-B7.2.1: this asked for `commit-disposition.json` and `bundle.name`.
    // The lifecycle writes `disposition.json` with a TOP-LEVEL `bundle_name`,
    // so the legitimate no-target-commit path was impossible - and the test
    // that "proved" it worked had invented the schema to match this consumer.
    const dis = readRecord(dispositionDir, 'commit-disposition', COMMIT_DISPOSITION_FILE)
    const pri = readRecord(pristineDir, 'pristine-release', PRISTINE_RELEASE_FILE)

    if (dis.disposition !== 'NOT_COMMITTED_PRISTINE') {
      throw new AuthorityRefused('the commit disposition is not NOT_COMMITTED_PRISTINE')
    }
    if (pri.disposition !== 'NOT_COMMITTED_PRISTINE') {
      throw new AuthorityRefused('the pristine release is not NOT_COMMITTED_PRISTINE')
    }
    if (pri.release_state !== 'released') {
      throw new AuthorityRefused('the pristine release does not record a released fence')
    }
    if (pri.remaining_reviewed_locks !== 0) {
      throw new AuthorityRefused('the pristine release records remaining reviewed locks')
    }
    if (pri.zero_lock_release_proved !== true) {
      throw new AuthorityRefused('the pristine release does not prove a zero-lock release')
    }
    if (pri.retry_permitted !== true) {
      throw new AuthorityRefused('the pristine release does not permit a retry')
    }
    // THE PRISTINE RECORD'S OWN LINK TO THE DISPOSITION, by name AND digest.
    const link = pri.commit_disposition
    const want = linkOf(dispositionDir)
    if (typeof link !== 'object' || link === null) {
      throw new AuthorityRefused('the pristine release links no commit disposition')
    }
    const l = link as Record<string, unknown>
    if (l.name !== want.name) {
      throw new AuthorityRefused('the pristine release links a different commit disposition')
    }
    if (l.digest_file_digest !== want.digest_file_digest) {
      throw new AuthorityRefused('the linked commit disposition no longer has that digest')
    }
    // AND BOTH NAME THE SELECTED STAGE-1 BUNDLE.
    const manifestName = basename(manifestDir)
    if (pri.bundle_name !== manifestName) {
      throw new AuthorityRefused('the pristine release names a different Stage-1 bundle')
    }
    // TOP-LEVEL `bundle_name`, as published.
    if (dis.bundle_name !== manifestName) {
      throw new AuthorityRefused('the commit disposition names a different Stage-1 bundle')
    }
    // AND THE STAGE-1 BUNDLE IS THIS AUTHORITY'S OWN WORK.
    if (stage1.currentUser !== EXPORT_ROLE_NAME || stage1.sessionUser !== EXPORT_ROLE_NAME) {
      throw new AuthorityRefused('the Stage-1 bundle was not exported by the reviewed role')
    }
    if (stage1.database !== endpoint.database) {
      throw new AuthorityRefused('the Stage-1 bundle names a different source database')
    }
    // AND IT WAS TAKEN FROM THIS CLUSTER. The database name is reusable; the
    // cluster identity is not.
    if (stage1.systemIdentifier !== endpoint.systemIdentifier) {
      throw new AuthorityRefused('the Stage-1 bundle names a different source cluster')
    }
    return Object.freeze({
      disposition,
      links: Object.freeze([linkOf(manifestDir), want, linkOf(pristineDir)]),
      closure: null,
    })
  }

  // copy-closed: THE WHOLE CHAIN, NOT ONE SELF-CONSISTENT DOCUMENT.
  const closureDir = required(v, '--copy-closure-bundle')
  const closure = readRecord(closureDir, 'copy-closure', 'copy-closure.json')
  if (closure.outcome !== 'COMPLETE') {
    throw new AuthorityRefused('the copy closure does not record a completed copy')
  }
  // The restoration it names, and the four upstream bundles, all re-verified.
  const restorationDir = required(v, '--copy-restoration-bundle')
  const restoration = verifyReferencedBundle(
    restorationDir, 'copy-restoration', 'copy-restoration.json')
  if ((restoration as { outcome?: unknown }).outcome !== 'COPY_RESTORED') {
    throw new AuthorityRefused('the copy restoration does not record a restored world')
  }
  const restorationLink = verifyCopyRestorationLink(restorationDir)
  // THE FOUR UPSTREAM BUNDLES, through the same verifier the closure used.
  const chain = verifyCopyChain(v)
  // AND THE SEMANTIC COMPARISONS `--close-copy` MAKES, through the ONE shared
  // verifier rather than a second copy of them. Without these, a forged
  // restoration and a forged closure could link to each other - each with a
  // valid internal DIGEST - and authorize teardown beside an unrelated chain.
  try {
    assertRestorationMatchesChain(restoration, chain)
    assertClosureMatchesChain(closure, restorationLink, restoration, chain)
  } catch (e) {
    throw new AuthorityRefused(
      e instanceof Error && 'reason' in e
        ? String((e as { reason: unknown }).reason)
        : 'the copy closure chain does not agree')
  }
  const stage1 = stage1AuthorityOf(verifyPublishedStage1(
    required(v, '--source-manifest-bundle')))
  if (stage1.currentUser !== EXPORT_ROLE_NAME || stage1.sessionUser !== EXPORT_ROLE_NAME) {
    throw new AuthorityRefused('the Stage-1 bundle was not exported by the reviewed role')
  }
  if (stage1.database !== endpoint.database) {
    throw new AuthorityRefused('the Stage-1 bundle names a different source database')
  }
  // THE SAME CLUSTER REQUIREMENT, and it stays consistent with the chain: this
  // Stage-1 bundle is the one the lifecycle, gate and verification were all
  // verified against above.
  if (stage1.systemIdentifier !== endpoint.systemIdentifier) {
    throw new AuthorityRefused('the Stage-1 bundle names a different source cluster')
  }
  return Object.freeze({
    disposition,
    links: Object.freeze([
      linkOf(closureDir), linkOf(restorationDir),
      { name: chain.lifecycle.name, digest_file_digest: chain.lifecycle.digestFileDigest },
      { name: chain.releaseGate.name, digest_file_digest: chain.releaseGate.digestFileDigest },
      { name: chain.verification.name, digest_file_digest: chain.verification.digestFileDigest },
      { name: chain.sourceManifest.name,
        digest_file_digest: chain.sourceManifest.digestFileDigest },
    ]),
    closure: linkOf(closureDir),
  })
}

/**
 * RE-PROVE A RECORDED CONTAINER: real directory, not a symlink, this user,
 * exactly 0700, the reviewed path, and the same device:inode.
 *
 * `lstat`, NOT `stat`: a symlink standing where the container was recorded
 * must be refused rather than followed into whatever it points at.
 */
export function proveContainer(
  c: ContainerReceipt, policy: AuthorityPolicy,
): void {
  if (!DEVICE_INODE.test(c.deviceInode)) {
    throw new AuthorityRefused('the container receipt carries no reviewed device:inode')
  }
  assertPolicyContainer(c.path, policy)
  const st = policy.fs.lstatSync(c.path)
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new AuthorityRefused('the recorded container is not a directory')
  }
  if ((st.mode & 0o777) !== 0o700 || (st.mode & 0o777).toString(8) !== c.mode) {
    throw new AuthorityRefused('the recorded container is not mode 0700')
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  if (st.uid !== c.uid || (uid !== -1 && st.uid !== uid)) {
    throw new AuthorityRefused('the recorded container is owned by another user')
  }
  if (`${String(st.dev)}:${String(st.ino)}` !== c.deviceInode) {
    throw new AuthorityRefused('the recorded container is not the directory that was published')
  }
  if (policy.fs.realpathSync(c.path) !== c.path) {
    throw new AuthorityRefused('the recorded container is not its own realpath')
  }
}

/**
 * --teardown: only from a reviewed terminal disposition, and never on a guess.
 *
 * TWO AUTHORIZATIONS AND NO OTHERS. Either no target commit happened, or the
 * copy has a VERIFIED closure proving it COMPLETE. Everything else - a commit
 * whose outcome is unknown, a publication whose state is unknown, an
 * unresolved intervention, a copy that is merely restored, a chain that does
 * not agree - retains the role and every path, because the authority may still
 * be the only way to establish what happened.
 */
export async function runTeardown(
  v: Readonly<Record<string, string>>, deps: AuthorityDeps,
): Promise<CliResult> {
  const lines: string[] = []
  const out = say(lines)
  const policy = deps.policy
  const { runId, stamp } = runIdentityOf(v)
  const batch = deps.batch ?? DEFAULT_BATCH
  const openAdmin = deps.openAdminPassfile ?? openReviewedFileDescriptor

  const create = readCreateBundle(required(v, '--create-bundle'))
  const { container, files, endpoint, systemIdentifier: recordedSystemIdentifier } =
    receiptsOf(create.doc, policy)
  const disposition = required(v, '--disposition')
  if (!DISPOSITIONS.includes(disposition)) {
    throw new AuthorityRefused('the disposition is not a reviewed terminal disposition')
  }

  // THE CONNECTION IS THE ONE THE CREATE RECORD DESCRIBES.
  //
  // K7-B7.2.1: the DROP and the absence proof were built from independent
  // `--host`/`--port`/`--database` argv values that nothing compared to the
  // create record - so one create bundle could authorize dropping the fixed
  // role name on ANOTHER cluster. Equality is required BEFORE any passfile is
  // opened or any batch runs.
  for (const [opt, recorded, what] of [
    ['--host', endpoint.host, 'host'],
    ['--port', endpoint.port, 'port'],
    ['--database', endpoint.database, 'database'],
  ] as const) {
    if (required(v, opt) !== recorded) {
      throw new AuthorityRefused(
        `the teardown ${what} is not the one the create record describes`)
    }
  }

  // THE AUTHORIZATION, PROVED FROM DISK. A FLAG SELECTS A BRANCH; IT DOES NOT
  // ESTABLISH THE BRANCH'S TRUTH.
  //
  // WHAT WAS WRONG. `--disposition=no-target-commit` was accepted on its own
  // word: a caller holding the administrator passfile could authorize a
  // destructive role drop and credential removal by typing one string. And
  // `copy-closed` read a single `copy-closure.json`, so a forged closure with
  // a recomputed internal DIGEST and no valid upstream chain authorized the
  // same destruction.
  // THE PUBLICATION THIS RUN WILL HAVE TO MAKE, PROVED POSSIBLE FIRST.
  //
  // BEFORE ANY PASSFILE OPEN, BATCH, DROP, UNLINK OR RMDIR. A root that is not
  // a reviewed evidence root, or a final/temporary name that is already
  // occupied, is a publication that is already known to fail - and discovering
  // it after `DROP ROLE` destroys the authority for nothing.
  const evidenceRoot = required(v, '--evidence-root')
  ;(deps.preflightPublication ?? evidencePublicationPreflight)({
    root: evidenceRoot, prefix: TEARDOWN_PREFIX, stamp, runId,
  })

  const authorization = authorizeTeardown(disposition, v, {
    ...endpoint, systemIdentifier: recordedSystemIdentifier,
  })

  // AND THE CLUSTER ITSELF IS THE ONE THE CREATE RECORD WAS WRITTEN ABOUT.
  //
  // READ-ONLY, AND BEFORE ANYTHING IS MUTATED. Host, port and database are
  // routing coordinates: a cluster can be dropped and rebuilt behind them, and
  // a new cluster's identically named role was never granted this authority.
  // `system_identifier` is the durable identity, so it is proved live and
  // compared before the drop - a mismatch, or an identifier the live proof
  // could not establish, invokes zero DROP, unlink or rmdir operations.
  const liveProve = deps.proveRole ?? defaultProveRole
  // B.6: AND THE RELEASE IS LOAD-BEARING. K7-B7.2.4: this discarded it, so a
  // teardown could reach `DROP ROLE` and credential removal after the
  // administrator descriptor release had become unproved. Nothing has been
  // mutated at this point, so it refuses.
  const live = requireReleased(
    await withAdminPassfile(
      required(v, '--admin-passfile'), openAdmin,
      async fd => await liveProve({
        psqlPath: required(v, '--psql'), host: endpoint.host, port: endpoint.port,
        database: endpoint.database, adminUser: required(v, '--admin-user'), passfileFd: fd,
      })),
    'live cluster proof')
  assertSameCluster(live.systemIdentifier, recordedSystemIdentifier)

  // PREFLIGHT, BEFORE ANY MUTATING BATCH IS OPENED.
  //
  // THE ORDER MATTERS. Every one of these can refuse, and a refusal after
  // `DROP ROLE` would already have destroyed the authority. So the container
  // identity and BOTH credential identities are proved first; if any of them
  // is not the object the create record describes, nothing is dropped at all.
  ;(deps.preflight ?? teardownPreflight)(container, files, policy)

  // DROP, THEN PROVE ABSENT.
  const args = adminArgs({
    host: required(v, '--host'), port: required(v, '--port'),
    database: required(v, '--database'), adminUser: required(v, '--admin-user'),
  })
  const drop = await dropRole({
    psqlPath: required(v, '--psql'), args, database: required(v, '--database'),
    passfile: required(v, '--admin-passfile'), openAdmin, batch,
  })
  // B.7: AN UNPROVED RELEASE MAKES THE DROP OUTCOME UNKNOWN. The statement's
  // own report is not a fact about the catalogue, and this process cannot even
  // vouch for the call that carried it - so nothing is removed on its word.
  const dropped = drop.reported && drop.release === 'proved'

  // B.8: AND THE ABSENCE READ-BACK IS SUBJECT TO THE SAME RULE. An answer
  // collected while the descriptor release was unproved is not an absence
  // proof, so every credential and the container are retained.
  let roleAbsent = false
  let absenceNote = drop.release === 'proved'
    ? (drop.reported ? null : 'drop-reported-failure')
    : 'drop-release-unproved'
  if (dropped) {
    try {
      const seen = await proveRoleAbsent({
        deps,
        psqlPath: required(v, '--psql'), host: required(v, '--host'),
        port: required(v, '--port'), database: required(v, '--database'),
        adminUser: required(v, '--admin-user'),
        passfile: required(v, '--admin-passfile'), openAdmin,
      })
      // AN ABSENCE SOMEWHERE ELSE IS NOT THIS ROLE'S ABSENCE, and neither is
      // one observed under an unproved release.
      roleAbsent = seen.absent &&
        seen.systemIdentifier === recordedSystemIdentifier &&
        seen.release === 'proved'
      if (!roleAbsent) {
        absenceNote = seen.release === 'proved'
          ? (seen.absent ? 'absence-on-another-cluster' : 'role-still-present')
          : 'absence-release-unproved'
      }
    } catch { roleAbsent = false; absenceNote = 'absence-unproved' }
  }
  if (absenceNote !== null) out(`role absence UNPROVED (${absenceNote})`)

  const { removed, retained, containerRemoved } = teardownRemoval({
    container, files, dropped, roleAbsent, policy,
  })

  const complete = roleAbsent && retained.length === 0 && containerRemoved
  let published
  try {
    published = (deps.publish ?? publishEvidence)({
    root: evidenceRoot, prefix: TEARDOWN_PREFIX, stamp, runId,
    artifacts: [{ path: 'residue.json',
                  bytes: Buffer.from(`${JSON.stringify({ retained })}\n`, 'utf-8') }],
    manifest: {
      path: TEARDOWN_FILE,
      bytes: Buffer.from(`${JSON.stringify(teardownDocument({
        runId, stamp,
        // A COPY THAT COMPLETED STAYS COMPLETE. An incomplete teardown says so
        // about ITSELF and never rewrites the closure or implies the copy failed.
        outcome: complete ? 'TORN_DOWN' : 'teardown-incomplete',
        createBundle: { name: create.name, digest_file_digest: create.digestFileDigest },
        disposition, links: authorization.links, closure: authorization.closure,
        roleAbsent, removed, retained, containerRemoved,
        note: complete ? null : 'the authority was not fully removed; residue is named above',
      }))}\n`, 'utf-8'),
    },
  })
    verifyPublishedEvidence(published.finalPath)
  } catch {
    // THE DESTRUCTIVE WORK ALREADY HAPPENED, AND ITS RECORD MAY NOT EXIST.
    //
    // K7-B7.2.1: this fell through to a generic REFUSED, which reads as "the
    // teardown did not happen" - the opposite of the truth. NOTHING is retried
    // here: no second DROP, no second removal. Only the reviewed names and a
    // bounded phase are stated.
    out(complete
      ? 'TEARDOWN COMPLETED, and its evidence publication is UNKNOWN.'
      : 'TEARDOWN PARTIALLY COMPLETED, and its evidence publication is UNKNOWN.')
    out(`role absent: ${String(roleAbsent)}`)
    if (removed.length > 0) out(`REMOVED: ${removed.join(', ')}`)
    if (retained.length > 0) out(`RETAINED: ${retained.join(', ')}`)
    out(`evidence name ${TEARDOWN_PREFIX}-${stamp}-${runId} (publication unknown)`)
    return { exitCode: EXIT_RETAINED_UNKNOWN, lines }
  }
  out(`export authority teardown published ${basename(published.finalPath)}`)
  out(complete ? 'TORN_DOWN' : 'teardown-incomplete')
  return { exitCode: complete ? EXIT_OK : EXIT_RETAINED_UNKNOWN, lines }
}

/**
 * THE PROGRAMMATIC BOUNDARY. There is no default dependency object.
 *
 * K7-B7.2.4: `deps: AuthorityDeps = {}` plus `deps.policy ?? PRODUCTION_POLICY`
 * meant production was one omitted argument away from any caller, including
 * every test. Two mutation runs crossed exactly that boundary. A caller must
 * now SAY which policy it is acting under, and the only call site that says
 * production is the process entry point below.
 */
export async function runAuthorityCli(
  argv: readonly string[], deps: AuthorityDeps,
): Promise<CliResult> {
  const lines: string[] = []
  try {
    const { mode, values } = parseArgs(argv)
    if (mode === '--create') return await runCreate(values, deps)
    if (mode === '--prove') return await runProve(values, deps)
    return await runTeardown(values, deps)
  } catch (e) {
    // BOUNDED. A reviewed reason or nothing; never an errno, a path we were not
    // given, a URL or a byte.
    lines.push(`REFUSED: ${e instanceof AuthorityRefused ? e.reason : 'the operation was refused'}`)
    return { exitCode: EXIT_REFUSED, lines }
  }
}

/** True when this module is the process entry point. */
export const isEntryPoint = (url: string, argv1: string | undefined): boolean =>
  argv1 !== undefined && fileURLToPath(url) === resolve(argv1)

// THE SINGLE PRODUCTION COMPOSITION ROOT. Nothing else may name
// PRODUCTION_POLICY in an executable position, which is guarded by test.
if (isEntryPoint(import.meta.url, process.argv[1])) {
  void (async (): Promise<void> => {
    const r = await runAuthorityCli(process.argv.slice(2), { policy: PRODUCTION_POLICY })
    for (const l of r.lines) process.stdout.write(`${l}\n`)
    process.exitCode = r.exitCode
  })()
}
