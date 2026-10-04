// READ-ONLY LAUNCHD INSPECTION FOR THE COPY FENCE.
//
// THERE IS NO MUTATING VERB IN THIS MODULE, and that is the point rather than
// an accident of what was needed. The verbs that would start, stop, load or
// unload an agent do not appear, so a reader establishes "this cannot change
// anything" by reading one file rather than by tracing call sites. The first
// rehearsal is deliberately manual-stop: a person stops the producers, and this
// proves what they did.
//
// THE BINARY IS A CONSTANT, NOT AN ARGUMENT. An earlier revision took the
// launchctl path from the command line so a suite could point it at a shell
// script. That is a production hole dressed as a test seam: anyone who can pass
// an argument can decide which program answers "is the fence quiescent". What
// is injectable instead is the COMMAND RUNNER - a test supplies an object that
// answers, and production gets the reviewed absolute binary and nothing else.
//
// ABSENCE HAS EXACTLY ONE SPELLING. `launchctl print` exits 113 with "Could not
// find service" when the label is not loaded. Every OTHER nonzero exit - a
// permission failure, a malformed reply, a binary that could not be run - is a
// REFUSAL, not an absence. Treating them alike is how "I was not allowed to
// look" becomes "there is nothing there", which is the exact inversion a fence
// cannot survive.
//
// AND "LOADED" IS NOT "STOPPED". A scheduled agent that prints while not
// running is loaded, and launchd will fire it on its own schedule - during the
// fence window, which is precisely when it matters. Manual-stop quiescence
// therefore requires the label to be ABSENT or DISABLED; "present but currently
// idle" does not pass.
//
// ABORT REALLY TERMINATES. `spawnSync` cannot be cancelled at all and is not
// used. On abort the child gets SIGTERM, a reviewed grace period, then SIGKILL,
// and the promise settles only when the process is actually gone - otherwise an
// abandoned inspection could still be running after the deadline said it was
// not.

import { spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'

import type {
  AdapterContext, ProducerQuiescenceMeasurement, ProducerState,
} from '@common/db/pg-copy'

import { openReviewedPlist, type OpenedPlist } from './secure-file.js'

/** The only binaries this module runs, and all three are read-only invocations. */
export const LAUNCHCTL = '/bin/launchctl'
export const PLUTIL = '/usr/bin/plutil'
/** `ps` lists processes. There is no flag to it that changes one. */
export const PS = '/bin/ps'

/** Every launchctl subcommand this module is permitted to use. */
export const READ_ONLY_LAUNCHCTL_VERBS: readonly string[] =
  Object.freeze(['print', 'list', 'print-disabled'])

/** How long a terminated child is given to exit before SIGKILL. */
export const TERMINATION_GRACE_MS = 2_000

/**
 * The ONE result that means "launchd has no such service".
 *
 * Both halves are required. The exit status alone could be produced by a future
 * launchctl for another reason; the message alone appears in prose nobody
 * promised to keep. Requiring both makes a change in either one a refusal that
 * someone has to look at, rather than a silent reclassification of every
 * loaded agent as absent.
 */
export const SERVICE_NOT_FOUND_EXIT = 113
export const SERVICE_NOT_FOUND_TEXT = 'Could not find service'

export class LaunchdInspectionRefused extends Error {
  constructor(readonly reason: string, readonly at: string | null = null) {
    super(`${reason}${at === null ? '' : ` (at ${at})`}`)
    this.name = 'LaunchdInspectionRefused'
  }
}

export interface CommandResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run one bounded, read-only command and abandon it properly on abort.
 *
 * Nothing the child printed on stderr is propagated into an error: launchctl
 * and plutil both echo paths, and a path is the one thing a refusal here does
 * not need to carry.
 */
export async function runBounded(
  file: string, args: readonly string[], ctx: AdapterContext,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const onAbort = (): void => {
      // SIGTERM, a reviewed grace, then SIGKILL. The promise is NOT settled
      // here: it settles on `close`, so an abandoned child is really gone
      // before this function's caller believes it is.
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, TERMINATION_GRACE_MS)
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf-8') })
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf-8') })
    child.on('error', () => {
      ctx.signal.removeEventListener('abort', onAbort)
      if (killTimer !== null) clearTimeout(killTimer)
      reject(new LaunchdInspectionRefused('the inspection command could not be run'))
    })
    child.on('close', (code) => {
      ctx.signal.removeEventListener('abort', onAbort)
      if (killTimer !== null) clearTimeout(killTimer)
      resolve({ code, stdout: out, stderr: err })
    })
  })
}

/**
 * How this module reaches the world. Injected so a suite answers instead.
 *
 * A test supplies its own `run`; it never supplies a PATH, so there is no
 * argument anywhere that decides which program is consulted in production.
 */
export interface CommandRunner {
  run(file: string, args: readonly string[], ctx: AdapterContext): Promise<CommandResult>
  /** How a plist's bytes are obtained. Injected for the same reason. */
  openPlist(path: string): OpenedPlist
}

export const REAL_COMMANDS: CommandRunner = Object.freeze({
  run: runBounded,
  openPlist: openReviewedPlist,
})

/**
 * WHAT LAUNCHCTL SAYS, AND NOTHING MORE.
 *
 * Deliberately still two-valued after `installed-unloaded` was added. This type
 * answers one question - does launchd hold this label - and an installed plist
 * does not change that answer. Widening it would have made every reader of
 * `presence` responsible for remembering that one of its values no longer meant
 * "launchd is not running this", which is precisely the conflation the new
 * installation state exists to undo. The plist is reported alongside, in
 * `installedUnloaded`, so the two facts stay separable.
 */
export type LabelPresence = 'absent' | 'loaded'

/**
 * THE ONE FILENAME A REVIEWED AGENT'S PLIST MAY HAVE.
 *
 * `<agents-dir>/<label>.plist`, and nothing else is looked at. The directory is
 * NOT scanned: a scan would let an unrelated file whose name happened to match
 * some pattern become the evidence for a reviewed agent, and it would make the
 * set of files consulted depend on directory contents rather than on the
 * reviewed label list. An alternate path is not accepted either - there is no
 * argument, plist key or environment variable that redirects this - because the
 * whole value of the check is that the file it measures is the file launchd
 * would load.
 */
export function reviewedPlistPath(label: string, agentsDir: string): string {
  if (!agentsDir.startsWith('/')) {
    throw new LaunchdInspectionRefused('the reviewed agents directory is not absolute')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label) || label.includes('..')) {
    throw new LaunchdInspectionRefused('the label is not a reviewed label name', label)
  }
  return join(agentsDir, `${label}.plist`)
}

/**
 * Is the exact reviewed plist there, and is it SAFE to treat as evidence?
 *
 * Three outcomes, and the middle one is the point:
 *
 *   'absent'   - nothing at that name at all, not even a dangling symlink. This
 *                is the only shape that may become `expected-absent`.
 *   'present'  - a regular file that passed every reviewed safety check.
 *   a throw    - anything else. A symlink (the file launchd loads would then be
 *                chosen by whoever controls the link), a DANGLING symlink (which
 *                `existsSync` reports as absent and which would therefore have
 *                been misread as "not installed"), a file this user does not
 *                own, a group- or world-writable mode, a link count above one, a
 *                file that cannot be read, or a file that changed under the
 *                descriptor. None of those is an absence and none is a safe
 *                measurement, so neither answer may be given for them.
 */
export type ReviewedPlistProbe =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly opened: OpenedPlist }

export function probeReviewedPlist(
  label: string, agentsDir: string, commands: CommandRunner,
): ReviewedPlistProbe {
  const path = reviewedPlistPath(label, agentsDir)

  // LSTAT, NOT STAT AND NOT existsSync. `existsSync` follows links, so a
  // dangling symlink reads as absent - and "absent" is the one answer that
  // downgrades an agent to expected-absent and drops its whole identity from
  // the binding. A link at this name means somebody else decides what launchd
  // loads, and that is a refusal whether the target exists or not.
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ state: 'absent' as const })
    // EACCES, ELOOP, ENOTDIR and anything else mean we could not tell. "I was
    // not allowed to look" is not "there is nothing there".
    throw new LaunchdInspectionRefused(
      'the reviewed plist path could not be examined and its state is unknown', label)
  }
  if (st.isSymbolicLink()) {
    throw new LaunchdInspectionRefused('the reviewed plist path is a symbolic link', label)
  }
  if (!st.isFile()) {
    throw new LaunchdInspectionRefused('the reviewed plist path is not a regular file', label)
  }

  // AND THE SAFETY CHECKS ARE THE SAME ONES A LOADED PLIST GETS. Owner, mode,
  // link count, size, no-follow open, and a re-stat of the descriptor. Sharing
  // `openReviewedPlist` is deliberate: two policies would eventually disagree,
  // and the unloaded path is the one nobody watches.
  let opened: OpenedPlist
  try {
    opened = commands.openPlist(path)
  } catch {
    throw new LaunchdInspectionRefused('the reviewed plist could not be opened safely', label)
  }
  return Object.freeze({ state: 'present' as const, opened })
}

/**
 * What a reviewed label looks like on this machine, right now.
 *
 * EVERY FIELD AN ABSENT LABEL CANNOT HAVE IS NULL. An earlier revision filled
 * them in - a plist path built from a naming convention, a digest of sixty-four
 * zeroes, a served checkout of `/` - and every one of those is a measurement
 * that was never taken, recorded in a binding document as though it had been.
 */
export interface LabelInspection {
  readonly label: string
  readonly presence: LabelPresence
  /**
   * The exact reviewed plist is installed while launchd holds no label.
   *
   * ONLY EVER TRUE WHEN `presence` IS 'absent'. It does not soften absence and
   * it never implies loaded, disabled or running: it says a file is on disk,
   * which is a statement about the filesystem, not about launchd.
   */
  readonly installedUnloaded: boolean
  /** Whether launchd has this label disabled. Read separately from `print`. */
  readonly disabled: boolean
  /** Only ever true for a loaded label. */
  readonly running: boolean
  readonly pid: string | null
  readonly lastExitCode: string | null
  /** The plist launchctl says it loaded, measured rather than assumed. */
  readonly plistPath: string | null
  readonly plistSha256: string | null
  readonly plistDeviceInode: string | null
  readonly servedCheckout: string | null
  readonly credentialPath: string | null
  /**
   * The PARSED plist, from the same bytes that were hashed above.
   *
   * Carried here rather than re-read by each consumer. A second consumer that
   * opened the path again would be parsing a document the recorded digest no
   * longer describes, which is the whole failure this field exists to prevent.
   */
  readonly plist: Record<string, unknown> | null
}

const field = (text: string, name: string): string | null => {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(text)
  return m === null ? null : m[1]
}

/**
 * Parse a plist's BYTES to JSON through `plutil`, which never writes.
 *
 * The bytes travel on stdin (`-` as the input) rather than as a pathname, so
 * what is parsed is exactly what was hashed. A pathname here would be a second
 * open of a name, and the digest would stop describing the parsed document.
 */
export async function parsePlistBytes(
  text: string, commands: CommandRunner, ctx: AdapterContext,
): Promise<Record<string, unknown>> {
  const r = await runWithStdin(PLUTIL, ['-convert', 'json', '-o', '-', '-'], text, commands, ctx)
  if (r.code !== 0) throw new LaunchdInspectionRefused('the plist could not be read')
  try {
    return JSON.parse(r.stdout) as Record<string, unknown>
  } catch {
    throw new LaunchdInspectionRefused('the plist could not be parsed')
  }
}

/** `runBounded`, with bytes on stdin. Kept beside it so both are one read. */
async function runWithStdin(
  file: string, args: readonly string[], stdin: string,
  commands: CommandRunner, ctx: AdapterContext,
): Promise<CommandResult> {
  if (commands !== REAL_COMMANDS) return await commands.run(file, [...args, stdin], ctx)
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const onAbort = (): void => {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, TERMINATION_GRACE_MS)
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf-8') })
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf-8') })
    child.on('error', () => {
      ctx.signal.removeEventListener('abort', onAbort)
      if (killTimer !== null) clearTimeout(killTimer)
      reject(new LaunchdInspectionRefused('the inspection command could not be run'))
    })
    child.on('close', (code) => {
      ctx.signal.removeEventListener('abort', onAbort)
      if (killTimer !== null) clearTimeout(killTimer)
      resolve({ code, stdout: out, stderr: err })
    })
    child.stdin.on('error', () => { /* the close handler reports it */ })
    child.stdin.end(stdin)
  })
}

/**
 * The checkout a plist serves, READ FROM THE PLIST.
 *
 * `WorkingDirectory` when it has one; otherwise the deepest ancestor of the
 * first absolute program argument that is not a system path. Never inferred
 * from where this process happens to be running.
 */
export function servedCheckoutOf(parsed: Record<string, unknown>): string | null {
  const wd = parsed.WorkingDirectory
  if (typeof wd === 'string' && wd.startsWith('/')) return wd
  const args = Array.isArray(parsed.ProgramArguments) ? parsed.ProgramArguments : []
  for (const a of args) {
    if (typeof a !== 'string' || !a.startsWith('/')) continue
    if (a.startsWith('/bin/') || a.startsWith('/usr/') || a.startsWith('/opt/')) continue
    const cut = a.lastIndexOf('/scripts/')
    if (cut > 0) return a.slice(0, cut)
    return a.slice(0, a.lastIndexOf('/'))
  }
  return null
}

/** The credential file a plist hands its job, by PATH. Never its contents. */
export function credentialPathOf(parsed: Record<string, unknown>): string | null {
  const env = parsed.EnvironmentVariables
  if (env === null || typeof env !== 'object') return null
  const v = (env as Record<string, unknown>).PIPELINE_CREDENTIAL_FILE
  return typeof v === 'string' && v.startsWith('/') ? v : null
}

export interface LaunchdOptions {
  readonly uid: string
  /**
   * Where installed agents live.
   *
   * AUTHORITATIVE, AND THIS COMMENT USED TO SAY THE OPPOSITE. It previously
   * read "recorded, never used to invent a path", which was true of the
   * three-state vocabulary and is no longer true: detecting an installed but
   * unloaded agent means looking for exactly one filename under this directory,
   * so it IS used to derive a path. That derivation is `reviewedPlistPath`, it
   * is the single exact convention `<agents-dir>/<label>.plist`, the directory
   * is never scanned, and no alternate path is accepted.
   */
  readonly agentsDir: string
  /** Injected for tests; production gets `REAL_COMMANDS`. */
  readonly commands?: CommandRunner
}

/** Is `launchctl print`'s failure the one that means "no such service"? */
export function isServiceNotFound(r: CommandResult): boolean {
  return r.code === SERVICE_NOT_FOUND_EXIT &&
    `${r.stdout}${r.stderr}`.includes(SERVICE_NOT_FOUND_TEXT)
}

/** The labels launchd has disabled in this domain. Read once per census. */
export async function readDisabled(
  o: LaunchdOptions, ctx: AdapterContext,
): Promise<ReadonlySet<string>> {
  const commands = o.commands ?? REAL_COMMANDS
  const r = await commands.run(LAUNCHCTL, ['print-disabled', `gui/${o.uid}`], ctx)
  if (r.code !== 0) {
    throw new LaunchdInspectionRefused('the disabled set could not be read')
  }
  const out = new Set<string>()
  for (const line of r.stdout.split('\n')) {
    // `"com.example.label" => true` - and only `true` means disabled.
    const m = /^\s*"([^"]+)"\s*=>\s*(true|disabled|1)\s*$/.exec(line)
    if (m !== null) out.add(m[1] as string)
  }
  return out
}

/**
 * Inspect one reviewed label. Reads; never changes anything.
 *
 * A LOADED LABEL WHOSE PLIST CANNOT BE MEASURED IS A REFUSAL, not a label with
 * nulls in it: the whole point of reading the plist is to establish where the
 * agent writes, and a label whose destination nobody established is a label
 * whose stopping nobody can justify either way.
 */
export async function inspectLabel(
  label: string, o: LaunchdOptions, ctx: AdapterContext,
  disabled: ReadonlySet<string> | null = null,
): Promise<LabelInspection> {
  const commands = o.commands ?? REAL_COMMANDS
  const printed = await commands.run(LAUNCHCTL, ['print', `gui/${o.uid}/${label}`], ctx)
  const isDisabled = disabled === null ? false : disabled.has(label)

  if (printed.code !== 0) {
    // THE ONE SPELLING OF ABSENCE, and everything else refuses.
    if (!isServiceNotFound(printed)) {
      throw new LaunchdInspectionRefused(
        'the label could not be inspected and its state is unknown', label)
    }
    // LAUNCHD HAS NO LABEL. That is not yet the whole answer: the plist may
    // still be installed, which is exactly the state a runtime cutover leaves
    // behind. Measure it from ONE safe open and bind what it says.
    const probe = probeReviewedPlist(label, o.agentsDir, commands)
    if (probe.state === 'absent') {
      return Object.freeze({
        label,
        presence: 'absent' as const,
        installedUnloaded: false,
        disabled: isDisabled,
        running: false,
        pid: null,
        lastExitCode: null,
        plistPath: null,
        plistSha256: null,
        plistDeviceInode: null,
        servedCheckout: null,
        credentialPath: null,
        plist: null,
      })
    }

    const unloadedParsed = await parsePlistBytes(probe.opened.text, commands, ctx)

    // THE PLIST MUST AGREE THAT IT IS THIS AGENT'S. The path was DERIVED from
    // the label, so unlike the loaded case there is no launchctl statement
    // tying the two together; the document's own `Label` is that statement. A
    // file that claims another label at this name is a misinstallation, and
    // binding it would attribute one agent's destination to another.
    const declaredLabel = unloadedParsed.Label
    if (typeof declaredLabel !== 'string' || declaredLabel !== label) {
      throw new LaunchdInspectionRefused(
        'the installed plist does not declare the reviewed label', label)
    }

    return Object.freeze({
      label,
      presence: 'absent' as const,
      installedUnloaded: true,
      disabled: isDisabled,
      // INSTALLED IS NOT RUNNING. No pid, no exit code, not running - launchd
      // told us it has no such service, and a file on disk cannot contradict it.
      running: false,
      pid: null,
      lastExitCode: null,
      plistPath: probe.opened.identity.path,
      plistSha256: probe.opened.sha256,
      plistDeviceInode: probe.opened.identity.deviceInode,
      servedCheckout: servedCheckoutOf(unloadedParsed),
      credentialPath: credentialPathOf(unloadedParsed),
      plist: Object.freeze(unloadedParsed),
    })
  }

  const path = field(printed.stdout, 'path')
  const state = field(printed.stdout, 'state')
  const pid = field(printed.stdout, 'pid')
  const lastExit = field(printed.stdout, 'last exit code')
  if (path === null) {
    throw new LaunchdInspectionRefused('the label reported no plist path', label)
  }

  // ONE OPEN, ONE HASH, ONE PARSE. The digest is of the bytes that were
  // parsed, so the recorded plist and the measured destination are the same
  // document rather than two reads of one name.
  let opened: OpenedPlist
  try {
    opened = commands.openPlist(path)
  } catch {
    throw new LaunchdInspectionRefused('the plist could not be opened safely', label)
  }
  const parsed = await parsePlistBytes(opened.text, commands, ctx)

  return Object.freeze({
    label,
    presence: 'loaded' as const,
    installedUnloaded: false,
    disabled: isDisabled,
    running: state === 'running' || (pid !== null && /^\d+$/.test(pid)),
    pid: pid !== null && /^\d+$/.test(pid) ? pid : null,
    lastExitCode: lastExit,
    plistPath: opened.identity.path,
    plistSha256: opened.sha256,
    plistDeviceInode: opened.identity.deviceInode,
    servedCheckout: servedCheckoutOf(parsed),
    credentialPath: credentialPathOf(parsed),
    plist: Object.freeze(parsed),
  })
}

/**
 * Re-measure a label already inspected, and refuse a plist that has moved.
 *
 * Used by the FENCED census, which re-reads everything the pre-fence census
 * read: a plist swapped between the two is a producer that may now point
 * somewhere else, and comparing the digests is what makes that visible.
 */
export async function remeasureLabel(
  seen: LabelInspection, o: LaunchdOptions, ctx: AdapterContext,
  disabled: ReadonlySet<string> | null = null,
): Promise<LabelInspection> {
  const again = await inspectLabel(seen.label, o, ctx, disabled)
  if (again.presence !== seen.presence) {
    throw new LaunchdInspectionRefused('the label changed presence during the census', seen.label)
  }
  // A PLIST THAT APPEARED OR VANISHED IS A CHANGED INSTALLATION, even though
  // launchctl said "absent" both times. Without this, a reviewed plist could be
  // installed or removed inside the fence window and the census would report
  // the same presence on both sides.
  if (again.installedUnloaded !== seen.installedUnloaded) {
    throw new LaunchdInspectionRefused(
      'the installed plist appeared or was removed during the census', seen.label)
  }
  if (again.plistSha256 !== seen.plistSha256 ||
      again.plistPath !== seen.plistPath ||
      again.plistDeviceInode !== seen.plistDeviceInode) {
    throw new LaunchdInspectionRefused('the plist changed during the census', seen.label)
  }
  if (again.servedCheckout !== seen.servedCheckout) {
    throw new LaunchdInspectionRefused('the served checkout changed during the census', seen.label)
  }
  // AND THE CREDENTIAL CONTAINER IT NAMES.
  //
  // MEASURED AND RECORDED AS AN EQUIVALENT GUARD, not as an observable one.
  // `credentialPathOf` is a pure function of the parsed plist, and the parsed
  // plist comes from exactly the bytes whose digest was compared three lines
  // above - so no input can make this comparison fire while that one passes, and
  // a mutation that deletes this check is not detectable by any test. It is kept
  // because this function's field list is what a reader compares against the
  // fenced census's field list, and a missing line there reads as a gap.
  //
  // THE REACHABLE CASE IS ELSEWHERE, and it is covered elsewhere: the container
  // can be REPLACED while the plist still names the same path, which changes its
  // `device:inode` and not this string. That is caught by `compareProducerSets`,
  // which compares `credentialDeviceInode` from a fresh open of the container.
  if (again.credentialPath !== seen.credentialPath) {
    throw new LaunchdInspectionRefused(
      'the credential container changed during the census', seen.label)
  }
  return again
}

/**
 * THE INDEPENDENT PROCESS CENSUS. `launchd` is not the only way to start a job.
 *
 * WHY ASKING LAUNCHD IS NOT ENOUGH. Every reviewed producer is an ordinary
 * command; a person can run it from a terminal, a `caffeinate` wrapper can
 * outlive the job that spawned it, and a service booted out while its process
 * was still running leaves that process behind. In all three cases launchd has
 * nothing to say - the label is absent - and the producer is writing to the
 * source. "Absent" therefore means "launchd is not running it", which is a
 * smaller claim than "it is not running".
 *
 * MATCHED ON THE REVIEWED COMMAND PATTERN, not on a pid. A pid is whatever the
 * kernel handed out this minute; what identifies a producer across a manual
 * start is the program it runs and the checkout it runs in.
 */
export interface ProcessMatch {
  readonly pattern: string
  readonly pids: readonly string[]
}

/**
 * The command patterns a reviewed producer's process is recognised by.
 *
 * NAMED HERE, not derived from the plist. A manually started producer may have
 * no plist at all - that is the case this census exists for - so the pattern
 * has to be a reviewed constant rather than something read back from the
 * installation whose absence is the problem.
 *
 * `|` SEPARATES ALTERNATIVES, and each alternative is a plain substring test -
 * see `matchesProducerPattern`. It is not a regular expression and it is never
 * handed to another program. An EMPTY alternative is refused rather than
 * ignored, because `''` is a substring of every command line and a stray `|`
 * would silently make a label match every process on the machine.
 *
 * WHY ONE PATTERN PER LABEL WAS NOT ENOUGH. A single substring named the
 * process at the MIDDLE of a chain and missed both ends of it, so a label could
 * read as stopped while its producer was alive:
 *
 *   daily  'daily-queue.sh' names only the submitter wrapper. launchd starts
 *          `/bin/bash .../scripts/daily-scheduler.sh`, which reaches
 *          `daily-queue.sh` at daily-scheduler.sh:492 - so for the whole
 *          eligibility phase before that line, and for every run that exits
 *          without submitting, nothing in the chain carried the pattern.
 *          `daily-scheduler.sh` covers that window. `run-daily.ts` covers the
 *          other end: daily-queue.sh:149 runs the submitter through `npx`, so
 *          the process doing the work is a DESCENDANT (daily-queue.sh:80-81),
 *          and an orphaned one outlives the wrapper that was being matched.
 *
 *   alerts 'run-alerts.sh' names a process that ceases to exist.
 *          run-alerts.sh:36-37 EXECS `npx tsx .../run-stage.ts -- npx tsx
 *          src/cli/cli-alerts.ts`, replacing the only argv that carried the
 *          pattern, and run-stage.ts:120 spawns the real work `detached`. The
 *          matched window is the handful of shell lines before the exec.
 *          `cli-alerts.ts` is in the argv of the launcher AND of the spawned
 *          runtime, because the command after `--` is part of run-stage's own
 *          argv, so one alternative covers the whole post-exec chain.
 *
 * The other three labels need nothing. `watchdog.sh` is a substring of
 * `pipeline-watchdog.sh`, which launchd starts directly and which blocks on
 * every child it makes; `bin/worker.ts` and `bin/structured-worker.ts` name
 * entry points that survive every `npx` handoff in their own chains.
 */
export const PRODUCER_PROCESS_PATTERNS: Readonly<Record<string, string>> = Object.freeze({
  'com.thanapol.ai-capital.daily': 'daily-queue.sh|daily-scheduler.sh|run-daily.ts',
  'com.thanapol.ai-capital.watchdog': 'watchdog.sh',
  'com.thanapol.ai-capital.alerts': 'run-alerts.sh|cli-alerts.ts',
  'com.thanapol.ai-capital.structured-worker': 'bin/structured-worker.ts',
  'com.thanapol.ai-capital.worker': 'bin/worker.ts',
})

/**
 * Does one `ps` command line match one reviewed pattern.
 *
 * EVERY ALTERNATIVE IS CHECKED FOR EMPTINESS BEFORE ANY OF THEM IS TESTED, so a
 * malformed pattern refuses whatever the command happens to contain. The
 * opposite order would let `'a|'` return true for a line containing `a` and
 * only refuse for lines that did not - a validator that fires on some inputs is
 * not a validator.
 *
 * The split happens per call rather than once per census. The function stays
 * pure and self-validating, and the cost is bounded by the length of one `ps`
 * listing.
 */
export function matchesProducerPattern(command: string, pattern: string): boolean {
  const alternatives = pattern.split('|')
  for (const a of alternatives) {
    if (a === '') {
      throw new LaunchdInspectionRefused(
        'a reviewed process pattern has an empty alternative', pattern)
    }
  }
  return alternatives.some(a => command.includes(a))
}

/**
 * Which reviewed producer processes are running, whoever started them.
 *
 * READ-ONLY BY CONSTRUCTION: `ps -Ao pid=,command=` lists, and there is no
 * argument to `ps` that changes a process. The matching is done HERE, on the
 * output, rather than by handing a pattern to `pgrep` - a pattern that reaches
 * another program is a pattern that program interprets.
 */
export async function censusProducerProcesses(
  labels: readonly string[], o: LaunchdOptions, ctx: AdapterContext,
): Promise<Readonly<Record<string, ProcessMatch>>> {
  const commands = o.commands ?? REAL_COMMANDS
  const r = await commands.run(PS, ['-Ao', 'pid=,command='], ctx)
  if (r.code !== 0) {
    throw new LaunchdInspectionRefused('the process census could not be taken')
  }
  const self = String(process.pid)
  const lines = r.stdout.split('\n')
  const out: Record<string, ProcessMatch> = {}
  for (const label of labels) {
    const pattern = PRODUCER_PROCESS_PATTERNS[label]
    if (pattern === undefined) {
      throw new LaunchdInspectionRefused('a reviewed label has no process pattern', label)
    }
    const pids: string[] = []
    for (const line of lines) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (m === null) continue
      const [, pid, command] = m as unknown as [string, string, string]
      // THIS PROCESS AND ITS OWN `ps` ARE NOT PRODUCERS. A census that counted
      // itself would report every run as non-quiescent.
      if (pid === self) continue
      if (matchesProducerPattern(command, pattern)) pids.push(pid)
    }
    out[label] = Object.freeze({ pattern, pids: Object.freeze(pids) })
  }
  return Object.freeze(out)
}

/**
 * What a full quiescence reading establishes about one label.
 *
 * STRUCTURALLY THE SHARED TYPE. `ProducerQuiescenceMeasurement` is declared in
 * `@common/db` because the gate carries it into the evidence; this alias keeps
 * the adapter's own vocabulary while making the two impossible to drift apart -
 * a field dropped here stops compiling there.
 */
export type ProducerQuiescence = ProducerQuiescenceMeasurement & {
  readonly presence: LabelPresence
}

/**
 * The reviewed quiescence adapter: READ-ONLY, and it reports rather than acts.
 *
 * STOPPED IS THREE CONDITIONS, NOT TWO.
 *
 *   absent    - launchd has no such service, AND no process matches the
 *               reviewed pattern; or
 *   disabled  - launchd will not start it, AND it is not running now, AND it
 *               reports no pid, AND no process matches the pattern.
 *
 * WHY `disabled` ALONE WAS WRONG. `launchctl disable` says what launchd will do
 * NEXT time; it does not stop what is running. A service disabled while its job
 * was mid-run keeps that job, keeps its database connection, and keeps writing
 * to the source - and the earlier `absent || disabled` reported it as stopped.
 *
 * WHY ABSENCE ALONE WAS WRONG. A label launchd does not have tells you nothing
 * about a producer somebody started by hand, which is exactly what an operator
 * does when a scheduled run fails and they re-run it from a terminal.
 *
 * AN INSTALLED-UNLOADED AGENT IS QUIESCENT HERE, AND FOR THE ORIGINAL REASON.
 * `presence` is 'absent' because launchd holds no label, so launchd will not
 * fire it; the plist on disk is inert until somebody bootstraps it. What does
 * NOT change is the process half: a matching process still defeats quiescence
 * for an installed-unloaded agent exactly as it does for an absent one, which is
 * the case that matters after a cutover - the plists are installed, the labels
 * are out, and a producer left running by hand is still writing to the source.
 */
export function launchdQuiescenceAdapter(
  labels: readonly string[], o: LaunchdOptions,
): {
  report(ctx: AdapterContext): Promise<readonly ProducerState[]>
  measure(ctx: AdapterContext): Promise<readonly ProducerQuiescence[]>
} {
  const measure = async (ctx: AdapterContext): Promise<readonly ProducerQuiescence[]> => {
    const disabled = await readDisabled(o, ctx)
    const processes = await censusProducerProcesses(labels, o, ctx)
    const out: ProducerQuiescence[] = []
    for (const label of labels) {
      const seen = await inspectLabel(label, o, ctx, disabled)
      const match = processes[label] as ProcessMatch
      const noProcess = match.pids.length === 0
      const stopped = noProcess && (
        seen.presence === 'absent' ||
        (seen.disabled && !seen.running && seen.pid === null))
      out.push(Object.freeze({
        name: label,
        stopped,
        presence: seen.presence,
        disabled: seen.disabled,
        running: seen.running,
        launchdPid: seen.pid,
        processPattern: match.pattern,
        processPids: match.pids,
      }))
    }
    return Object.freeze(out)
  }
  return {
    measure,
    report: async (ctx: AdapterContext) => Object.freeze(
      (await measure(ctx)).map(p => Object.freeze({ name: p.name, stopped: p.stopped }))),
  }
}
