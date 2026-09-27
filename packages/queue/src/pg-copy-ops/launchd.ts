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

/** Loaded, or not there at all. There is no third reading of this question. */
export type LabelPresence = 'absent' | 'loaded'

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
  /** Where installed agents live. Recorded, never used to invent a path. */
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
    return Object.freeze({
      label,
      presence: 'absent' as const,
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
  if (again.plistSha256 !== seen.plistSha256 ||
      again.plistPath !== seen.plistPath ||
      again.plistDeviceInode !== seen.plistDeviceInode) {
    throw new LaunchdInspectionRefused('the plist changed during the census', seen.label)
  }
  if (again.servedCheckout !== seen.servedCheckout) {
    throw new LaunchdInspectionRefused('the served checkout changed during the census', seen.label)
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
 */
export const PRODUCER_PROCESS_PATTERNS: Readonly<Record<string, string>> = Object.freeze({
  'com.thanapol.ai-capital.daily': 'daily-queue.sh',
  'com.thanapol.ai-capital.watchdog': 'watchdog.sh',
  'com.thanapol.ai-capital.alerts': 'run-alerts.sh',
  'com.thanapol.ai-capital.structured-worker': 'bin/structured-worker.ts',
  'com.thanapol.ai-capital.worker': 'bin/worker.ts',
})

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
      if (command.includes(pattern)) pids.push(pid)
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
