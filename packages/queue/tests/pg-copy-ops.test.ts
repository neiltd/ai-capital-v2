// THE PRODUCTION OPERATIONAL ADAPTERS — offline, and touching nothing live.
//
// No launchctl is run against a real service, no Redis is connected, no
// credential of the running system is read. The launchd adapter is pointed at a
// fake `launchctl` on disk; the BullMQ adapter is given a factory that yields
// recording doubles; every credential container is one this suite created.

import { execFileSync } from 'node:child_process'
import {
  chmodSync, closeSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

import { REVIEWED_PRODUCERS } from '@common/db/pg-copy'
import { afterEach, describe, expect, it } from 'vitest'

/** Executable text only: a module that NAMES a verb in prose has not used it. */
const strip = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')

import {
  BLOCKING_STATES, PAUSED_IS_BLOCKING, QueueInspectionRefused, bullmqQueueAdapter,
  sampleReviewedQueues,
} from '../src/pg-copy-ops/bullmq.js'
import {
  DestinationRefused, assertNoInlineCredential, classifyContainer, proveDestinations,
} from '../src/pg-copy-ops/destination.js'
import {
  LaunchdInspectionRefused, PRODUCER_PROCESS_PATTERNS, READ_ONLY_LAUNCHCTL_VERBS,
  SERVICE_NOT_FOUND_EXIT,
  SERVICE_NOT_FOUND_TEXT, credentialPathOf, inspectLabel, launchdQuiescenceAdapter,
  runBounded, servedCheckoutOf, type CommandRunner,
} from '../src/pg-copy-ops/launchd.js'
import {
  SecureFileRefused, openReviewedContainer, openReviewedFileDescriptor, openReviewedPlist,
} from '../src/pg-copy-ops/secure-file.js'
import {
  RedisConfigRefused, resolveRedis, resolveExplicitRedis,
} from '../src/pg-copy-ops/redis-config.js'
import {
  EXIT_FAILED, EXIT_REFUSED, OPTIONS, OpsRefused, PRODUCER_AUTHORITY, parseArgs, runOpsCli,
  type OpsDeps,
} from '../bin/pg-copy-ops.js'
import { PsqlBackendRefused } from '@common/db/pg-copy'

const ROOTS: string[] = []
const root = (): string => {
  // THE CANONICAL PATH. `openReviewedContainer` refuses a name that resolves
  // somewhere else, and on macOS `tmpdir()` is `/var/folders/...` whose `/var`
  // is a symlink to `/private/var`. Resolving it HERE is the honest fix: the
  // caller is the one holding the record of which file was meant, so the
  // caller is the one that must name it canonically.
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'pgcopy-ops-')))
  ROOTS.push(d)
  return d
}

/**
 * A command runner this suite owns. Nothing here reaches the real launchctl.
 *
 * `plutil` is run for REAL, on the bytes the adapter hands it - parsing is the
 * one thing a fake would make meaningless. Everything else is answered from
 * a table the test controls.
 */
const fakeCommands = (
  answers: Record<string, { code: number; stdout?: string; stderr?: string }>,
): CommandRunner => ({
  openPlist: openReviewedPlist,
  run: async (file, args) => {
    if (file.endsWith('plutil')) {
      // The bytes travel as the last argument in the injected form.
      const text = args[args.length - 1] as string
      // BYTES ON STDIN, so this stub leaves nothing behind. It used to mkdtemp a
      // directory per call and never remove it — the same leak ops-world.ts
      // carried, and between them the machine had accumulated 820,101 orphaned
      // temp directories (about 4 GiB) by the time it was measured.
      try {
        const out = execFileSync('/usr/bin/plutil',
          ['-convert', 'json', '-o', '-', '-'], { encoding: 'utf-8', input: text })
        return { code: 0, stdout: out, stderr: '' }
      } catch {
        return { code: 1, stdout: '', stderr: '' }
      }
    }
    if (file.endsWith('/ps')) {
      // NO REVIEWED PRODUCER PROCESS unless a test says otherwise. The census
      // is real; what it is looking at is this suite's own table.
      const a = answers.ps ?? { code: 0, stdout: '  1 /sbin/launchd\n' }
      return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }
    }
    const key = `${args[0]} ${args[1] ?? ''}`.trim()
    const a = answers[key] ?? answers[args[0] as string] ??
      { code: SERVICE_NOT_FOUND_EXIT, stderr: `${SERVICE_NOT_FOUND_TEXT}\n` }
    return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }
  },
})

/** A reviewed policy entry for a label that is installed and loaded. */
const LOADED = (label: string, expected: string): {
  label: string; expected: never; installation: never
} => ({ label, expected: expected as never, installation: 'installed' as never })

/** The reply `launchctl print` gives for a loaded label. */
const printed = (plist: string, over: {
  state?: string; pid?: string; lastExit?: string
} = {}): string =>
  `\tpath = ${plist}\n\tstate = ${over.state ?? 'running'}\n` +
  `${over.pid === undefined ? '' : `\tpid = ${over.pid}\n`}` +
  `\tlast exit code = ${over.lastExit ?? '0'}\n`
afterEach(() => {
  for (const r of ROOTS.splice(0)) rmSync(r, { recursive: true, force: true })
})

const ctx = (): { signal: AbortSignal } => ({ signal: new AbortController().signal })

const surfaces = (e: unknown): string => {
  const err = e as Error & Record<string, unknown>
  let json = ''
  try { json = JSON.stringify(err, Object.getOwnPropertyNames(err)) } catch { json = '' }
  return [String(err.message), String(err.stack ?? ''), json,
          inspect(err, { depth: 6 })].join('\n')
}

/** A credential container this suite owns, with the reviewed 0600 identity. */
function container(dir: string, name: string, body: string, mode = 0o600): string {
  const p = join(dir, name)
  writeFileSync(p, body)
  chmodSync(p, mode)
  return p
}

// ---------------------------------------------------------------------------

describe('the launchd adapter is read-only by construction', () => {
  it('names no mutating verb anywhere in its module', async () => {
    const src = strip(await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../src/pg-copy-ops/launchd.ts', import.meta.url), 'utf-8')))
    // A READER ESTABLISHES THIS FROM ONE FILE, not by tracing call sites.
    for (const verb of ['bootout', 'bootstrap', 'kickstart', 'enable', 'disable',
                        'unload', 'load', 'remove']) {
      expect(src, verb).not.toMatch(new RegExp(`['"\\\`\\s]${verb}['"\\\`\\s]`))
    }
    expect(src).not.toContain('spawnSync')
    expect([...READ_ONLY_LAUNCHCTL_VERBS].sort())
      .toEqual(['list', 'print', 'print-disabled'])
  })

  it('abandons a long child on abort, and settles only when it is gone', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const p = runBounded('/bin/sleep', ['30'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 40)
    const r = await p
    // The promise did NOT settle at the abort: it settled on `close`, which is
    // what makes "abandoned" mean "actually gone" rather than "no longer
    // awaited while it keeps running".
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(r.code).toBeNull()
  }, 20_000)

  it('escalates to SIGKILL after a reviewed grace, in code', async () => {
    const src = strip(await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../src/pg-copy-ops/launchd.ts', import.meta.url), 'utf-8')))
    // A `Promise.race` timeout alone would leave an ignored child running.
    //
    // EVERY SPAWN SITE, NOT JUST THE FIRST. There are two - the plain runner
    // and the one that writes bytes on stdin - and an escalation removed from
    // one of them would leave that path's abandoned child alive while the other
    // path's assertion still passed.
    const terms = src.match(/child\.kill\('SIGTERM'\)/g) ?? []
    const kills = src.match(/child\.kill\('SIGKILL'\)/g) ?? []
    const spawns = src.match(/spawn\(/g) ?? []
    expect(spawns.length).toBeGreaterThan(0)
    expect(terms.length).toBe(spawns.length)
    expect(kills.length).toBe(spawns.length)
    expect(src).toContain('TERMINATION_GRACE_MS')
    expect(src.indexOf("child.kill('SIGTERM')"))
      .toBeLessThan(src.indexOf("child.kill('SIGKILL')"))
  })

  it('reads a label through an injected runner and never mutates', async () => {
    const d = root()
    const agents = join(d, 'agents')
    execFileSync('/bin/mkdir', ['-p', agents])
    const plist = join(agents, 'com.test.worker.plist')
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.test.worker</string>
<key>WorkingDirectory</key><string>/Users/x/checkout</string>
<key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string></array>
<key>EnvironmentVariables</key><dict>
<key>PIPELINE_CREDENTIAL_FILE</key><string>/Users/x/.secrets/pipeline.url</string>
</dict></dict></plist>`)
    chmodSync(plist, 0o644)
    const commands = fakeCommands({
      'print gui/501/com.test.worker': { code: 0, stdout: printed(plist, { pid: '4242' }) },
    })
    const i = await inspectLabel('com.test.worker', { uid: '501', agentsDir: agents, commands },
                                 ctx())
    expect(i.presence).toBe('loaded')
    expect(i.running).toBe(true)
    expect(i.pid).toBe('4242')
    expect(i.plistPath).toBe(plist)
    expect(i.plistSha256).toBe(openReviewedPlist(plist).sha256)
    expect(i.servedCheckout).toBe('/Users/x/checkout')
    expect(i.credentialPath).toBe('/Users/x/.secrets/pipeline.url')
    // ONE OPEN, ONE HASH, ONE PARSE: the parsed document comes back with it.
    expect(i.plist).not.toBeNull()
  })

  it('treats ONLY the reviewed not-found reply as absence', async () => {
    // K1.1-M06. A permission failure, a malformed reply and a binary that could
    // not be run are all "I could not look" - and an inspection that called
    // them absence would report a running agent as stopped, which is the exact
    // inversion a fence cannot survive.
    const d = root()
    const cases: Array<[string, { code: number; stdout?: string; stderr?: string }]> = [
      ['permission', { code: 1, stderr: 'Operation not permitted\n' }],
      ['other error', { code: 37, stderr: 'something else\n' }],
      ['right code, wrong text', { code: SERVICE_NOT_FOUND_EXIT, stderr: 'nope\n' }],
      ['right text, wrong code', { code: 5, stderr: `${SERVICE_NOT_FOUND_TEXT}\n` }],
      ['no path in a success', { code: 0, stdout: '\tstate = running\n' }],
    ]
    for (const [label, answer] of cases) {
      const commands = fakeCommands({ 'print gui/501/com.test.x': answer })
      await expect(
        inspectLabel('com.test.x', { uid: '501', agentsDir: d, commands }, ctx()), label)
        .rejects.toThrow(LaunchdInspectionRefused)
    }
    // AND THE ONE SPELLING THAT IS ABSENCE.
    const found = fakeCommands({
      'print gui/501/com.test.x': {
        code: SERVICE_NOT_FOUND_EXIT, stderr: `${SERVICE_NOT_FOUND_TEXT}\n`,
      },
    })
    const seen = await inspectLabel('com.test.x', { uid: '501', agentsDir: d, commands: found },
                                    ctx())
    expect(seen.presence).toBe('absent')
    // AND NOTHING IS FABRICATED FOR IT.
    expect(seen.plistPath).toBeNull()
    expect(seen.plistSha256).toBeNull()
    expect(seen.servedCheckout).toBeNull()
    expect(seen.credentialPath).toBeNull()
    expect(seen.plist).toBeNull()
  })

  it('is stopped only when nothing can start it AND nothing is running it',
    async () => {
      // K1.2-B. `absent || disabled` was wrong twice over.
      //
      // `launchctl disable` says what launchd will do NEXT time; it does not
      // stop what is running. A service disabled mid-run keeps its job, keeps
      // its database connection, and keeps writing to the source.
      //
      // And absence says only that LAUNCHD is not running it. A producer
      // started from a terminal - which is what an operator does when a
      // scheduled run fails - is invisible to launchd and entirely visible to
      // the source.
      const d = root()
      const agents = join(d, 'agents')
      execFileSync('/bin/mkdir', ['-p', agents])
      const label = 'com.thanapol.ai-capital.worker'
      const plist = join(agents, `${label}.plist`)
      // A WELL-FORMED INSTALLATION: the plist declares its own label. It has to,
      // because the `absent` cases below now exercise `installed-unloaded` —
      // launchctl holds no label while this exact file sits in the agents
      // directory, which is the state a runtime cutover leaves behind.
      writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string>
<key>WorkingDirectory</key><string>/Users/x</string></dict></plist>`)
      chmodSync(plist, 0o644)

      const idle = printed(plist, { state: 'not running' })
      const running = printed(plist, { pid: '7' })
      const noProcess = { code: 0, stdout: '  1 /sbin/launchd\n' }
      const manual = { code: 0, stdout: `  1 /sbin/launchd\n 4242 tsx bin/worker.ts\n` }

      const ask = async (
        print: string | null,
        disabledSet: string, ps: { code: number; stdout?: string },
      ): Promise<boolean> => {
        const answers: Record<string, { code: number; stdout?: string; stderr?: string }> = {
          'print-disabled gui/501': { code: 0, stdout: disabledSet },
          ps,
        }
        if (print !== null) {
          answers[`print gui/501/${label}`] = { code: 0, stdout: print }
        }
        const r = await launchdQuiescenceAdapter(
          [label], { uid: '501', agentsDir: agents, commands: fakeCommands(answers) })
          .report(ctx())
        return (r[0] as { stopped: boolean }).stopped
      }

      const DISABLED = `\t"${label}" => true\n`
      // DISABLED BUT RUNNING IS NOT STOPPED. The state word says so.
      expect(await ask(running, DISABLED, noProcess)).toBe(false)
      // DISABLED, NOT RUNNING, BUT A PID IS REPORTED: still not stopped.
      expect(await ask(printed(plist, { state: 'not running', pid: '9' }),
                       DISABLED, noProcess)).toBe(false)
      // DISABLED, NOT RUNNING, NO PID, NO PROCESS: stopped.
      expect(await ask(idle, DISABLED, noProcess)).toBe(true)
      // LOADED AND ENABLED, even while idle: launchd owns its schedule.
      expect(await ask(idle, '', noProcess)).toBe(false)
      // ABSENT WITH NO PROCESS: stopped. The plist IS installed here, so this is
      // the `installed-unloaded` case — launchd will not fire what it does not
      // hold, and an inert file on disk cannot start itself.
      expect(await ask(null, '', noProcess)).toBe(true)
      // INSTALLED-UNLOADED WITH A MATCHING MANUAL PROCESS: NOT stopped. This is
      // the post-cutover shape exactly: plists installed, labels out, and a
      // producer somebody left running is still writing to the source.
      expect(await ask(null, '', manual)).toBe(false)
      // AND DISABLED-AND-IDLE WITH A MANUAL PROCESS is not stopped either.
      expect(await ask(idle, DISABLED, manual)).toBe(false)
    })

  it('reports what it measured, not just a verdict', async () => {
    const d = root()
    const label = 'com.thanapol.ai-capital.alerts'
    const measured = await launchdQuiescenceAdapter([label], {
      uid: '501', agentsDir: d,
      commands: fakeCommands({
        'print-disabled gui/501': { code: 0, stdout: '' },
        ps: { code: 0, stdout: ' 99 /bin/sh scripts/run-alerts.sh\n' },
      }),
    }).measure(ctx())
    const row = measured[0] as { stopped: boolean; processPids: readonly string[]
                                 processPattern: string; presence: string }
    expect(row.presence).toBe('absent')
    expect(row.stopped).toBe(false)
    expect([...row.processPids]).toEqual(['99'])
    // THE WHOLE CONSTANT VALUE, alternations included: `ProcessMatch.pattern`
    // is what reaches evidence and the binding, so it must carry everything
    // the census matched on, not the alternative that happened to hit.
    expect(row.processPattern).toBe('run-alerts.sh|cli-alerts.ts')
  })

  it('refuses a process census it could not take', async () => {
    const d = root()
    await expect(launchdQuiescenceAdapter(['com.thanapol.ai-capital.worker'], {
      uid: '501', agentsDir: d,
      commands: fakeCommands({
        'print-disabled gui/501': { code: 0, stdout: '' },
        ps: { code: 1, stdout: '' },
      }),
    }).report(ctx())).rejects.toThrow(/process census could not be taken/)
  })

  it('derives the served checkout FROM the plist, never from this process', () => {
    expect(servedCheckoutOf({ WorkingDirectory: '/a/b' })).toBe('/a/b')
    expect(servedCheckoutOf({
      ProgramArguments: ['/bin/bash', '/Users/x/tree/scripts/run.sh'],
    })).toBe('/Users/x/tree')
    expect(servedCheckoutOf({ ProgramArguments: ['/usr/bin/caffeinate'] })).toBeNull()
    expect(credentialPathOf({ EnvironmentVariables: { PIPELINE_CREDENTIAL_FILE: '/c' } }))
      .toBe('/c')
    expect(credentialPathOf({})).toBeNull()
  })
})

describe('the credential container', () => {
  it('accepts only a regular, owned, 0600, single-link, resolved file', () => {
    const d = root()
    const good = container(d, 'ok.url', 'postgres:///ai_capital\n')
    expect(openReviewedContainer(good).identity.mode).toBe('600')

    expect(() => openReviewedContainer('relative')).toThrow(/not absolute/)
    const wide = container(d, 'wide.url', 'x', 0o644)
    expect(() => openReviewedContainer(wide)).toThrow(/not mode 0600/)
    const link = join(d, 'link.url')
    symlinkSync(good, link)
    expect(() => openReviewedContainer(link)).toThrow(SecureFileRefused)
  })

  it('records the RESOLVED path, so an ancestor symlink cannot rename the file',
    () => {
      // `/var` is a symlink to `/private/var` on every macOS box, so refusing
      // ancestor symlinks would refuse the platform. They are resolved instead,
      // and what gets recorded is the file that was actually read - not the
      // spelling it was reached by.
      const d = root()
      const p = container(d, 'anc.url', 'postgres:///ai_capital\n')
      expect(openReviewedContainer(p).identity.path).toBe(realpathSync(p))
    })

  it('never returns or reveals the secret it read', () => {
    const d = root()
    const p = container(d, 'secret.url', 'postgres://u:hunter2@/ai_capital\n')
    const opened = openReviewedContainer(p)
    // The identity is path and inode. There is no digest of the contents,
    // because a digest of a credential is still an oracle for it.
    expect(Object.keys(opened.identity).sort())
      .toEqual(['deviceInode', 'links', 'mode', 'path', 'size', 'uid'])
    expect(JSON.stringify(opened.identity)).not.toContain('hunter2')
  })
})

describe('the Redis configuration', () => {
  it('refuses --redis-url entirely', () => {
    expect(OPTIONS).not.toContain('--redis-url')
    expect(() => parseArgs(['--inspect', '--redis-url=redis://x'])).toThrow(/unknown option/)
  })

  it('the explicit form CANNOT express a password', () => {
    const r = resolveExplicitRedis('localhost', '6379', '0')
    expect(r.sanitized).toEqual({ host: 'localhost', port: '6379', database: '0' })
    expect(Object.keys(r.connection).sort()).toEqual(['db', 'host', 'port'])
    expect(() => resolveExplicitRedis('user@host', '6379', '0')).toThrow(RedisConfigRefused)
    expect(() => resolveExplicitRedis('redis://h', '6379', '0')).toThrow(RedisConfigRefused)
  })

  it('a credential container yields ONLY a sanitized endpoint to the outside', () => {
    const d = root()
    const p = container(d, 'redis.url', 'redis://u:s3cret@127.0.0.1:6380/3\n')
    const r = resolveRedis({ credential: p })
    expect(r.sanitized).toEqual({ host: '127.0.0.1', port: '6380', database: '3' })
    expect(JSON.stringify(r.sanitized)).not.toContain('s3cret')
    // The connection keeps what it needs to connect, and it is never published.
    expect(r.connection.password).toBe('s3cret')
  })

  it('the two forms are mutually exclusive, and one is required', () => {
    const d = root()
    const p = container(d, 'r.url', 'redis://localhost:6379/0\n')
    expect(() => resolveRedis({ credential: p, host: 'x' })).toThrow(/mutually exclusive/)
    expect(() => resolveRedis({})).toThrow(/required/)
  })
})

describe('the BullMQ adapter owns every handle it uses', () => {
  const fake = (counts: Record<string, number>, paused = false) => {
    const closed: string[] = []
    const make = (name: string): never => ({
      getJobCounts: async () => counts,
      isPaused: async () => paused,
      close: async () => { closed.push(name) },
    }) as never
    return { make, closed }
  }

  it('never imports a cached or meta-writing handle', async () => {
    const src = strip(await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../src/pg-copy-ops/bullmq.ts', import.meta.url), 'utf-8')))
    // THE IMPORT, NOT THE CALL SITE. Every cached accessor in this package -
    // the process-wide queue handles, the shared connection options - lives in
    // `src/queue.js`, so a module that imports nothing from it cannot reach
    // one, whatever it is later refactored to call. Asserting on the module
    // boundary also keeps this suite out of the package's own
    // construct-a-client meta check, which matches those accessors BY NAME and
    // would otherwise read a test that merely forbids them as a test that uses
    // them.
    for (const specifier of ["'../queue.js'", "'./queue.js'", "'../src/queue.js'"]) {
      expect(src, specifier).not.toContain(specifier)
    }
    // And its own constructor is the read-only one.
    expect(src).toContain('skipMetasUpdate: true')
  })

  it('counts the complete blocking set and never sums history', async () => {
    expect([...BLOCKING_STATES])
      .toEqual(['active', 'wait', 'delayed', 'prioritized', 'waiting-children'])
    expect(PAUSED_IS_BLOCKING).toBe(true)
    const f = fake({ active: 1, wait: 2, delayed: 3, prioritized: 4, 'waiting-children': 5,
                     completed: 1000, failed: 99 })
    const [d] = await sampleReviewedQueues(['q'], { host: 'h', port: 1, db: 0 }, ctx(), f.make)
    expect(d.depth).toBe(15)
    expect(d.completed).toBe(1000)
    expect(d.failed).toBe(99)
  })

  it('closes every owned handle, on success and on refusal', async () => {
    const ok = fake({ active: 0, wait: 0, delayed: 0, prioritized: 0, 'waiting-children': 0 })
    await sampleReviewedQueues(['a', 'b'], { host: 'h', port: 1, db: 0 }, ctx(), ok.make)
    expect(ok.closed).toEqual(['a', 'b'])

    const broken = (name: string): never => ({
      getJobCounts: async () => { throw new Error('redis') },
      isPaused: async () => false,
      close: async () => { closedOnFailure.push(name) },
    }) as never
    const closedOnFailure: string[] = []
    await expect(sampleReviewedQueues(['a'], { host: 'h', port: 1, db: 0 }, ctx(), broken))
      .rejects.toThrow(QueueInspectionRefused)
    expect(closedOnFailure).toEqual(['a'])
  })

  it('REFUSES a paused queue rather than reporting it empty', async () => {
    const f = fake({ active: 0, wait: 0, delayed: 0, prioritized: 0, 'waiting-children': 0 },
                   true)
    await expect(
      bullmqQueueAdapter(['q'], { host: 'h', port: 1, db: 0 }, f.make).sample(ctx()))
      .rejects.toThrow(/paused/)
    expect(f.closed).toEqual(['q'])
  })
})

describe('producer destination proof', () => {
  it('refuses an inline database URL, userinfo or a forbidden key', () => {
    expect(() => assertNoInlineCredential({
      EnvironmentVariables: { DATABASE_URL: 'x' },
    })).toThrow(/forbidden database key/)
    expect(() => assertNoInlineCredential({
      EnvironmentVariables: { SOMETHING: 'postgres://h/db' },
    })).toThrow(/inline database URL/)
    expect(() => assertNoInlineCredential({
      EnvironmentVariables: { OTHER: 'amqp://u:p@h/x' },
    })).toThrow(/inline userinfo/)
    expect(() => assertNoInlineCredential({
      ProgramArguments: ['/bin/x', 'postgresql://h/db'],
    })).toThrow(/inline database URL/)
    expect(() => assertNoInlineCredential({
      EnvironmentVariables: { PIPELINE_CREDENTIAL_FILE: '/ok/path' },
    })).not.toThrow()
  })

  it('classifies by WHERE the credential points, and refuses an unproved one',
    async () => {
      const d = root()
      const agents = join(d, 'agents')
      execFileSync('/bin/mkdir', ['-p', agents])
      // A SOCKET DIRECTORY IN THE HOST POSITION, percent-encoded. `postgres://
      // u:p@/db?host=...` is not a URL at all - userinfo with an empty host is
      // rejected by the parser - so the two forms that DO parse are the two
      // forms that have to be classified.
      const cred = container(d, 'pipeline.url', 'postgres://u:p@%2Ftmp%2Fs/ai_capital\n')
      const plist = join(agents, 'com.test.one.plist')
      writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>WorkingDirectory</key><string>/Users/x/tree</string>
<key>EnvironmentVariables</key><dict>
<key>PIPELINE_CREDENTIAL_FILE</key><string>${cred}</string>
</dict></dict></plist>`)
      const commands = fakeCommands({
        'print gui/501/com.test.one': {
          code: 0, stdout: printed(plist, { state: 'not running' }),
        },
        'print-disabled gui/501': { code: 0, stdout: '' },
      })
      const o = { uid: '501', agentsDir: agents, commands }

      const found = await proveDestinations(
        ['com.test.one'], { host: '/tmp/s', port: '5432', database: 'ai_capital' },
        [LOADED('com.test.one', 'writes-copy-source')], o, ctx())
      expect(found[0].disposition).toBe('writes-copy-source')
      expect(found[0].databaseName).toBe('ai_capital')
      expect(found[0].credentialDeviceInode).toMatch(/^\d+:\d+$/)
      // NOTHING SECRET SURVIVES.
      expect(JSON.stringify(found)).not.toContain('u:p')
      expect(JSON.stringify(found)).not.toContain('postgres://')

      // THE OTHER PARSING FORM, same endpoint, same classification.
      const q = container(d, 'q.url', 'postgres:///ai_capital?host=/tmp/s\n')
      const qplist = join(agents, 'com.test.two.plist')
      writeFileSync(qplist, readFileSync(plist, 'utf-8').replace(cred, q))
      const qcommands = fakeCommands({
        'print gui/501/com.test.two': {
          code: 0, stdout: printed(qplist, { state: 'not running' }),
        },
        'print-disabled gui/501': { code: 0, stdout: '' },
      })
      const two = await proveDestinations(
        ['com.test.two'], { host: '/tmp/s', port: '5432', database: 'ai_capital' },
        [LOADED('com.test.two', 'writes-copy-source')],
        { ...o, commands: qcommands }, ctx())
      expect(two[0].disposition).toBe('writes-copy-source')

      // A DIFFERENT DATABASE is not silently excluded: the policy must say so.
      await expect(proveDestinations(
        ['com.test.one'], { host: '/tmp/s', port: '5432', database: 'somewhere_else' },
        [LOADED('com.test.one', 'writes-copy-source')], o, ctx()))
        .rejects.toThrow(/does not match its declared disposition/)

      // AND AN UNPROVED DESTINATION REFUSES.
      await expect(proveDestinations(
        ['com.test.one'], { host: '/tmp/s', port: '5432', database: 'ai_capital' },
        [LOADED('com.test.one', 'destination-unproved')], o, ctx()))
        .rejects.toThrow(DestinationRefused)
    })

  it('refuses a label with no policy entry', async () => {
    const d = root()
    const commands = fakeCommands({ 'print-disabled gui/501': { code: 0, stdout: '' } })
    const fake = join(d, 'launchctl')
    writeFileSync(fake, '#!/bin/sh\nexit 1\n')
    chmodSync(fake, 0o700)
    await expect(proveDestinations(
      ['com.test.x'], { host: '/s', port: '5432', database: 'db' }, [],
      { uid: '501', agentsDir: d, commands }, ctx()))
      .rejects.toThrow(/no policy entry/)
  })
})

describe('the operations CLI surface', () => {
  it('requires exactly one mode and refuses an unknown option', () => {
    expect(() => parseArgs([])).toThrow(/exactly one mode/)
    expect(() => parseArgs(['--inspect', '--rehearse'])).toThrow(/exactly one mode/)
    expect(() => parseArgs(['--inspect', '--nope=1'])).toThrow(/unknown option/)
    expect(() => parseArgs(['--inspect', '--for'])).toThrow(/--name=value/)
    expect(() => parseArgs(['--inspect', '--for=a', '--for=b'])).toThrow(/supplied twice/)
    expect(parseArgs(['--inspect', '--for=rehearse']).mode).toBe('--inspect')
  })

  it('accepts only manual-stop authority in this milestone', () => {
    expect(PRODUCER_AUTHORITY).toBe('manual-stop')
  })

  it('reaches no live mode through an environment variable', async () => {
    const src = strip(await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8')))
    // Every mode and every authority is argv-only.
    expect(src).not.toMatch(/process\.env\.[A-Z_]+/)
    expect(src).not.toContain('NODE_ENV')
  })

  it('never claims the transactional copy lifecycle was rehearsed', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    expect(src).not.toMatch(/rehearses the copy|copy was rehearsed|rehearsed the copy/i)
    expect(src).toContain('never opens a target')
    expect(src).not.toContain('runApply')
  })
})

// ---------------------------------------------------------------------------
// WHAT THE MUTATION MATRIX FOUND MISSING
// ---------------------------------------------------------------------------

describe('the read-only verb set is closed', () => {
  it('contains only verbs that cannot change launchd state', () => {
    // M22. The list is what a reader checks; a mutating verb added to it would
    // make the module's central claim false while every other test still passed.
    for (const verb of ['bootout', 'bootstrap', 'kickstart', 'enable', 'disable',
                        'unload', 'load', 'remove', 'kill', 'stop', 'start']) {
      expect([...READ_ONLY_LAUNCHCTL_VERBS], verb).not.toContain(verb)
    }
    expect(READ_ONLY_LAUNCHCTL_VERBS.length).toBe(3)
  })

  it('takes a credential path only when the plist gave an ABSOLUTE one', () => {
    // M24. A relative path resolves against whatever directory this process
    // happens to be in, so "the agent's credential" would become "a file in the
    // checkout with the same name" - a different file, read as if it were the
    // agent's.
    expect(credentialPathOf({
      EnvironmentVariables: { PIPELINE_CREDENTIAL_FILE: '/Users/x/.secrets/pipeline.url' },
    })).toBe('/Users/x/.secrets/pipeline.url')
    for (const bad of ['pipeline.url', './pipeline.url', '../pipeline.url', '~/pipeline.url']) {
      expect(credentialPathOf({
        EnvironmentVariables: { PIPELINE_CREDENTIAL_FILE: bad },
      }), bad).toBeNull()
    }
    expect(credentialPathOf({})).toBeNull()
  })
})

describe('the credential container, continued', () => {
  it('refuses a hard link, which has no owner the check could name', () => {
    // M27. A second link is a second name for the same inode, and the reviewed
    // 0600 identity says nothing about who holds the other one.
    const d = root()
    const real = container(d, 'linked.url', 'postgres:///ai_capital\n')
    const second = join(d, 'other.url')
    execFileSync('/bin/ln', [real, second])
    expect(() => openReviewedContainer(real)).toThrow(/more than one link/)
    expect(() => openReviewedContainer(second)).toThrow(/more than one link/)
  })

  it('a classified destination carries the endpoint and nothing else', () => {
    // M35. Adding the raw URL to what leaves `classifyContainer` would put a
    // password into every binding document and every published bundle.
    const d = root()
    const agents = join(d, 'agents')
    execFileSync('/bin/mkdir', ['-p', agents])
    const cred = container(d, 'secret.url', 'postgres://u:hunter2@%2Ftmp%2Fs/ai_capital\n')
    const plist = join(agents, 'com.test.one.plist')
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>WorkingDirectory</key><string>/Users/x/tree</string>
<key>EnvironmentVariables</key><dict>
<key>PIPELINE_CREDENTIAL_FILE</key><string>${cred}</string>
</dict></dict></plist>`)
    const commands = fakeCommands({
      'print gui/501/com.test.one': { code: 0, stdout: printed(plist, { state: 'not running' }) },
      'print-disabled gui/501': { code: 0, stdout: '' },
    })
    return proveDestinations(
      ['com.test.one'], { host: '/tmp/s', port: '5432', database: 'ai_capital' },
      [LOADED('com.test.one', 'writes-copy-source')],
      { uid: '501', agentsDir: agents, commands }, ctx()).then(found => {
      const serialized = JSON.stringify(found)
      expect(serialized).not.toContain('hunter2')
      expect(serialized).not.toContain('postgres:')
      expect(serialized).not.toContain('@')
      expect(found[0].databaseHost).toBe('/tmp/s')
    })
  })
})

describe('an unproved destination stops everything', () => {
  it('refuses even when the policy declared it unproved', async () => {
    // M34. "Nobody established where this writes" is not a disposition a run
    // may proceed under: stopping it cannot be justified, and leaving it
    // running cannot either. Declaring it in the policy records the fact; it
    // does not license the copy.
    const d = root()
    const agents = join(d, 'agents')
    execFileSync('/bin/mkdir', ['-p', agents])
    // A plist that PARSES and names a credential that fails its checks. That
    // reaches the classification path rather than the earlier unreadable-plist
    // guard, so what is under test is the disposition itself.
    const cred = container(d, 'wide.url', 'postgres:///ai_capital\n', 0o644)
    const plist = join(agents, 'com.test.one.plist')
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>WorkingDirectory</key><string>/Users/x/tree</string>
<key>EnvironmentVariables</key><dict>
<key>PIPELINE_CREDENTIAL_FILE</key><string>${cred}</string>
</dict></dict></plist>`)
    const commands = fakeCommands({
      'print gui/501/com.test.one': { code: 0, stdout: printed(plist, { state: 'not running' }) },
      'print-disabled gui/501': { code: 0, stdout: '' },
    })
    await expect(proveDestinations(
      ['com.test.one'], { host: '/tmp/s', port: '5432', database: 'ai_capital' },
      [LOADED('com.test.one', 'destination-unproved')],
      { uid: '501', agentsDir: agents, commands }, ctx()))
      .rejects.toThrow(/unproved destination/)
  })
})

describe('the plist may never publish a credential', () => {
  it('refuses a forbidden key or an inline URL, wherever it appears', () => {
    // M32, at the unit level: `launchctl print` shows an agent's environment to
    // anyone who can run it, so a URL here is a credential published to the
    // whole user session.
    for (const env of [{ DATABASE_URL: 'postgres://u:p@localhost:5432/ai_capital' },
                       { PGPASSWORD: 'hunter2' },
                       { STRUCTURED_DATABASE_URL: 'postgres://u:p@localhost/db' },
                       { SOMETHING: 'postgresql://u:p@localhost/db' },
                       { SOMETHING: 'redis://u:p@localhost:6379' }]) {
      expect(() => assertNoInlineCredential({ EnvironmentVariables: env }),
             JSON.stringify(env)).toThrow(DestinationRefused)
    }
    expect(() => assertNoInlineCredential({
      ProgramArguments: ['/usr/bin/env', 'DATABASE_URL=postgres://u:p@h/db', 'node'],
    })).toThrow(DestinationRefused)
    expect(() => assertNoInlineCredential({
      EnvironmentVariables: { PIPELINE_CREDENTIAL_FILE: '/Users/x/.secrets/pipeline.url' },
    })).not.toThrow()
  })
})

describe('the producer authority is a closed set of one', () => {
  it('accepts manual-stop and nothing else', () => {
    // M45. In this milestone a person stops the agents. A CLI that accepted
    // `launchd-stop` would be claiming an authority it does not implement, and
    // the binding would record that claim as though it had been exercised.
    expect(PRODUCER_AUTHORITY).toBe('manual-stop')
    expect(parseArgs(['--inspect', '--producer-authority=manual-stop'])
      .values['--producer-authority']).toBe('manual-stop')
  })
})

describe('what leaves the classifier', () => {
  it('is the endpoint and NOTHING else', () => {
    // M35. A digest of a credential is still an oracle for it, and the raw URL
    // is the credential. The assertion is on the SHAPE of what is returned,
    // because a field added here reaches every binding document and every
    // published bundle downstream without any of them noticing.
    const d = root()
    const p = container(d, 'secret.url', 'postgres://u:hunter2@%2Ftmp%2Fs/ai_capital\n')
    const out = classifyContainer(p)
    expect(Object.keys(out).sort()).toEqual(['database', 'host', 'port'])
    expect(out).toEqual({ host: '/tmp/s', port: '5432', database: 'ai_capital' })
    expect(JSON.stringify(out)).not.toContain('hunter2')
    expect(JSON.stringify(out)).not.toContain('postgres')
  })

  it('refuses anything that is not one postgres URL', () => {
    const d = root()
    for (const body of ['not a url\n', 'redis://localhost:6379\n', 'https://example/db\n',
                        'postgres:///a\npostgres:///b\n', '']) {
      const p = container(d, `bad-${Math.random().toString(16).slice(2)}.url`, body)
      expect(() => classifyContainer(p), JSON.stringify(body)).toThrow(DestinationRefused)
    }
  })
})

// ---------------------------------------------------------------------------
// K1.1: THE TOCTOU BOUNDARIES
// ---------------------------------------------------------------------------

describe('the bytes come from the descriptor that was checked', () => {
  it('reads the fd, never the pathname, after the open', () => {
    // K1.1-K06. `openChecked` is synchronous end to end, so there is no
    // in-process instant at which a test could swap the file between the
    // `fstat` and the read - which is exactly why the guarantee has to be
    // structural. What a suite CAN establish is that no second open of the
    // NAME exists to be raced: the read takes the descriptor.
    const src = strip(readFileSync(
      new URL('../src/pg-copy-ops/secure-file.ts', import.meta.url), 'utf-8'))
    // `openChecked` ONLY. `proveReviewedFileMetadata` opens a descriptor too,
    // and it is the function that deliberately never reads one.
    const fn = src.slice(src.indexOf('function openChecked'),
                         src.indexOf('export function openReviewedContainer'))
    expect(fn).toContain("readFileSync(fd, 'utf-8')")
    expect(fn).not.toContain('readFileSync(path')
    // AND THE ONLY OPEN IS THE VALIDATED ONE.
    expect((fn.match(/openSync\(/g) ?? []).length).toBe(1)
  })

  it('re-stats the descriptor after the read and compares it', () => {
    // K1.1-K08. A file truncated or extended underneath an open fd keeps its
    // inode, so the size is re-read: a mismatch means what was measured is not
    // what was read.
    const src = strip(readFileSync(
      new URL('../src/pg-copy-ops/secure-file.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('function openChecked'),
                         src.indexOf('export function openReviewedContainer'))
    expect((fn.match(/fstatSync\(/g) ?? []).length).toBe(2)
    expect(fn).toContain('after.ino !== st.ino')
    expect(fn).toContain('after.size !== st.size')
    expect(fn.indexOf("readFileSync(fd, 'utf-8')"))
      .toBeLessThan(fn.indexOf('after.ino !== st.ino'))
    // AND WHAT COMES BACK AGREES WITH ITSELF.
    const d = root()
    const p = container(d, 'agree.url', 'postgres:///ai_capital\n')
    const opened = openReviewedContainer(p)
    expect(opened.identity.size).toBe(Buffer.byteLength(opened.text, 'utf-8'))
  })

  it('REFUSES an ancestor symlink rather than resolving it', () => {
    // K1.1-K07. Resolving it would mean this module read a file at a path the
    // caller never named - and the caller is the one holding the record of
    // which file was meant.
    const d = root()
    const real = join(d, 'real')
    execFileSync('/bin/mkdir', ['-p', real])
    const p = container(real, 'cred.url', 'postgres:///ai_capital\n')
    const link = join(d, 'via')
    symlinkSync(real, link)
    expect(() => openReviewedContainer(p)).not.toThrow()
    expect(() => openReviewedContainer(join(link, 'cred.url')))
      .toThrow(/does not resolve to itself/)
  })

  it('openReviewedFileDescriptor REFUSES an ancestor symlink, independently of openChecked', () => {
    // THE SECOND OPEN BOUNDARY NEEDS ITS OWN CONTROL. The case above exercises
    // `openReviewedContainer`, which goes through `openChecked`; the descriptor
    // path is a separate function with its own copy of the canonical-path rule,
    // and a mutation that removes the rule from only that copy left every
    // assertion here passing. Measured: that is how K07b survived.
    //
    // BEHAVIOURAL, not structural, because an ancestor symlink is deterministic:
    // `realpath` of a path reached through a symlinked directory never equals
    // the caller's own spelling, so no race is needed to provoke it.
    const d = root()
    const real = join(d, 'fd-real')
    execFileSync('/bin/mkdir', ['-p', real])
    const p = container(real, 'fd-cred.url', 'postgres:///ai_capital\n')
    const link = join(d, 'fd-via')
    symlinkSync(real, link)

    // NON-VACUITY: the canonical spelling is accepted, and its descriptor is
    // closed here so the assertion cannot leak one.
    const held = openReviewedFileDescriptor(p)
    expect(held.identity.path).toBe(p)
    closeSync(held.fd)

    // AND THE SYMLINKED ANCESTOR IS REFUSED.
    expect(() => openReviewedFileDescriptor(join(link, 'fd-cred.url')))
      .toThrow(/does not resolve to itself/)
  })

  it('accepts a plist only in the reviewed mode set', () => {
    // K1.1-K09. A plist is not a secret - `launchctl print` shows an agent's
    // environment to the whole session - but it may NOT be group- or
    // world-WRITABLE, because a writable plist is one somebody else chooses
    // the contents of.
    const d = root()
    for (const mode of [0o600, 0o640, 0o644]) {
      const p = container(d, `ok-${mode.toString(8)}.plist`, '<plist/>', mode)
      expect(() => openReviewedPlist(p), mode.toString(8)).not.toThrow()
    }
    for (const mode of [0o660, 0o664, 0o666, 0o777, 0o775]) {
      const p = container(d, `bad-${mode.toString(8)}.plist`, '<plist/>', mode)
      expect(() => openReviewedPlist(p), mode.toString(8))
        .toThrow(/owner alone or by its owner and group/)
    }
    // AND A CREDENTIAL IS STILL 0600 AND NOTHING WIDER.
    expect(() => openReviewedContainer(container(d, 'c.url', 'x', 0o640)))
      .toThrow(/not mode 0600/)
  })
})

describe('a plist is opened, hashed and parsed ONCE', () => {
  it('parses the bytes it hashed, and opens the name only once', async () => {
    // K1.1-K13. Hashing one `readFileSync(path)` and then handing the PATH to
    // `plutil` is two reads of a name: the recorded digest would stop
    // describing the parsed document the moment they differed.
    const d = root()
    const agents = join(d, 'agents')
    execFileSync('/bin/mkdir', ['-p', agents])
    const plist = join(agents, 'com.test.one.plist')
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>WorkingDirectory</key><string>/Users/x</string></dict></plist>`)
    chmodSync(plist, 0o644)

    let opens = 0
    const base = fakeCommands({
      'print gui/501/com.test.one': { code: 0, stdout: printed(plist, { state: 'not running' }) },
      'print-disabled gui/501': { code: 0, stdout: '' },
    })
    const counted: CommandRunner = {
      run: base.run,
      openPlist: (p: string) => { opens += 1; return openReviewedPlist(p) },
    }
    const seen = await inspectLabel('com.test.one',
      { uid: '501', agentsDir: agents, commands: counted }, ctx())
    expect(opens).toBe(1)
    expect(seen.plistSha256).toBe(openReviewedPlist(plist).sha256)
    expect(seen.plist).not.toBeNull()
    // AND THE BYTES TRAVEL TO plutil ON STDIN, never as a pathname.
    const src = strip(readFileSync(
      new URL('../src/pg-copy-ops/launchd.ts', import.meta.url), 'utf-8'))
    expect(src).toContain("parsePlistBytes(opened.text")
    expect(src).not.toContain("'-convert', 'json', '-o', '-', path")
  })
})

describe('the destination census does not fabricate or assume', () => {
  const oneLabel = (d: string, credential: string, installed: boolean): {
    o: { uid: string; agentsDir: string; commands: CommandRunner }
  } => {
    const agents = join(d, 'agents')
    execFileSync('/bin/mkdir', ['-p', agents])
    const plist = join(agents, 'com.test.one.plist')
    if (installed) {
      writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>WorkingDirectory</key><string>/Users/x</string>
<key>EnvironmentVariables</key><dict>
<key>PIPELINE_CREDENTIAL_FILE</key><string>${credential}</string>
</dict></dict></plist>`)
      chmodSync(plist, 0o644)
    }
    const answers: Record<string, { code: number; stdout?: string; stderr?: string }> = {
      'print-disabled gui/501': { code: 0, stdout: '' },
    }
    if (installed) {
      answers['print gui/501/com.test.one'] = {
        code: 0, stdout: printed(plist, { state: 'not running' }),
      }
    }
    return { o: { uid: '501', agentsDir: agents, commands: fakeCommands(answers) } }
  }

  it('refuses an ABSENT label declared as a writer', async () => {
    // K1.1-K15. A label launchd does not have has no credential to classify,
    // and recording one anyway is a measurement that was never taken.
    const d = root()
    const { o } = oneLabel(d, '/dev/null', false)
    await expect(proveDestinations(
      ['com.test.one'], { host: '/tmp/s', port: '5432', database: 'ai_capital' },
      [{ label: 'com.test.one', expected: 'writes-copy-source' as never,
         installation: 'expected-absent' as never }], o, ctx()))
      .rejects.toThrow(/may not be declared a writer/)
  })

  it('refuses a label that is not in its declared installation TOPOLOGY', async () => {
    // K1.1-K16. "This agent is not installed" and "this agent writes nowhere
    // we proved" are different facts, and only the first can be declared.
    // Compared on the stable topology since K5.3: an installed agent declared
    // expected-absent is refused whether its label is loaded or not.
    const d = root()
    const cred = container(d, 'p.url', 'postgres://u:p@%2Ftmp%2Fs/ai_capital\n')
    const { o } = oneLabel(d, cred, true)
    await expect(proveDestinations(
      ['com.test.one'], { host: '/tmp/s', port: '5432', database: 'ai_capital' },
      [{ label: 'com.test.one', expected: 'expected-absent' as never,
         installation: 'expected-absent' as never }], o, ctx()))
      .rejects.toThrow(/not in its declared installation topology/)
  })

  it('records an absent label with NOTHING filled in', async () => {
    const d = root()
    const { o } = oneLabel(d, '/dev/null', false)
    const [row] = await proveDestinations(
      ['com.test.one'], { host: '/tmp/s', port: '5432', database: 'ai_capital' },
      [{ label: 'com.test.one', expected: 'expected-absent' as never,
         installation: 'expected-absent' as never }], o, ctx())
    expect(row.installation).toBe('expected-absent')
    expect(row.disposition).toBe('expected-absent')
    for (const k of ['plistPath', 'plistSha256', 'plistDeviceInode', 'servedCheckout',
                     'credentialPath', 'credentialDeviceInode', 'databaseHost',
                     'databasePort', 'databaseName'] as const) {
      expect(row[k], k).toBeNull()
    }
  })

  it('opens the credential ONCE, for identity and endpoint together', () => {
    // K1.1-K17. Opening it once for its `device:inode` and again to classify
    // it leaves a window in which the name is repointed: the recorded identity
    // would then belong to one file and the recorded destination to another,
    // which is the substitution the identity exists to detect.
    const src = strip(readFileSync(
      new URL('../src/pg-copy-ops/destination.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export async function proveDestinations'))
    expect((fn.match(/openReviewedContainer\(/g) ?? []).length).toBe(1)
    expect(fn).toContain('classifyOpened(opened)')
    expect(fn).not.toContain('classifyContainer(')
    // AND THE CLASSIFIER CANNOT OPEN ANYTHING: it takes an opened container.
    expect(src).toContain('export function classifyOpened(opened: OpenedContainer)')
  })
})

describe('the symlink defences are two, not one', () => {
  it('keeps O_NOFOLLOW as the guard against a swap AFTER the resolve', () => {
    // WHY THIS IS STRUCTURAL. With the canonical-path rule in place, a
    // final-component symlink is already refused BEFORE the open: `realpath` of
    // a symlink never equals the symlink's own path. `O_NOFOLLOW` is therefore
    // unreachable for the case it was originally written for - and it is kept
    // for the one it still covers, which is the window between the `realpath`
    // and the `openSync`. Node has no `openat(2)`, so that window exists; a
    // name turned into a symlink inside it is caught here and nowhere else.
    const src = strip(readFileSync(
      new URL('../src/pg-copy-ops/secure-file.ts', import.meta.url), 'utf-8'))
    expect(src).toContain('constants.O_RDONLY | constants.O_NOFOLLOW')
    expect(src.indexOf('realpathSync(path)')).toBeLessThan(src.indexOf('O_NOFOLLOW'))
  })

  /**
   * THE BODY OF ONE FUNCTION, comments stripped.
   *
   * Sliced from the declaration to the next top-level declaration. Crude on
   * purpose: the alternative is a parser, and what these assertions need is
   * "which open call sits inside which function", which the text answers.
   */
  const bodyOf = (decl: string): string => {
    const src = readFileSync(
      new URL('../src/pg-copy-ops/secure-file.ts', import.meta.url), 'utf-8')
    const i = src.indexOf(decl)
    expect(i, `${decl} not found`).toBeGreaterThanOrEqual(0)
    const rest = src.slice(i + decl.length)
    const m = /\n(?:export )?(?:function|const|interface|type|class) /.exec(rest)
    return strip(decl + (m === null ? rest : rest.slice(0, m.index)))
  }

  // THE INVARIANT IS PER FUNCTION, AND THE TEST ABOVE IS NOT.
  //
  // `expect(src).toContain(...)` is satisfied by ONE occurrence anywhere in the
  // file, and there are two independent no-follow opens: `openChecked`, which
  // reads bytes, and `openReviewedFileDescriptor`, which hands a descriptor to a
  // child. Removing the flag from either one leaves the other's occurrence
  // standing, so the whole-file assertion passes and the defence is gone from
  // half the surface. Measured: that is exactly how mutant M25 survived.
  //
  // WHY STRUCTURAL RATHER THAN BEHAVIOURAL. The property is a TOCTOU window —
  // `realpathSync` proves the name canonical, then `openSync` opens it, and
  // between those two calls another process can replace the regular file with a
  // symlink. Node exposes no `openat(2)`, so the window is real and `O_NOFOLLOW`
  // is what closes it. Provoking it deterministically would mean winning a race
  // against the code under test from another process on every run, on every
  // machine, which is not a reliable unit-test seam; a flaky control on a
  // security boundary is worse than a structural one. So each open boundary is
  // asserted where it lives.
  for (const [label, decl] of [
    ['openChecked', 'function openChecked(path: string, policy: Policy): OpenedContainer {'],
    ['openReviewedFileDescriptor',
     'export function openReviewedFileDescriptor(path: string): HeldDescriptor {'],
  ] as [string, string][]) {
    it(`${label} opens with O_RDONLY | O_NOFOLLOW, independently of the other`, () => {
      const body = bodyOf(decl)

      // NON-VACUITY: the slice really is this function and really does open.
      expect(body, label).toContain('openSync(')
      expect(body, label).toContain('realpathSync(path)')

      // THE FLAG IS HERE, in this function, on its own open.
      expect(body, label).toContain('constants.O_RDONLY | constants.O_NOFOLLOW')

      // AND EVERY open IN THIS FUNCTION CARRIES IT. A second, unflagged open
      // added beside the flagged one would satisfy `toContain` and reopen the
      // window, so the counts are compared rather than the presence.
      const opens = (body.match(/openSync\(/g) ?? []).length
      const noFollow = (body.match(/constants\.O_RDONLY \| constants\.O_NOFOLLOW/g) ?? []).length
      expect(noFollow, `${label}: ${String(opens)} open(s), ${String(noFollow)} flagged`)
        .toBe(opens)

      // AND THE ORDER IS THE POINT: the resolve comes first, the flagged open
      // second, which is what makes the flag the guard for the window between them.
      expect(body.indexOf('realpathSync(path)'), label)
        .toBeLessThan(body.indexOf('O_NOFOLLOW'))
    })
  }

  it('the two no-follow opens are two, and neither stands in for the other', () => {
    const whole = strip(readFileSync(
      new URL('../src/pg-copy-ops/secure-file.ts', import.meta.url), 'utf-8'))
    // EXACTLY TWO, so a future third open cannot be added unnoticed and the two
    // per-function assertions above between them cover every one that exists.
    expect((whole.match(/openSync\(/g) ?? []).length).toBe(2)
    expect((whole.match(/constants\.O_RDONLY \| constants\.O_NOFOLLOW/g) ?? []).length).toBe(2)
  })
})

describe('the process census is disciplined', () => {
  it('never counts this process or its own ps', async () => {
    // K1.2-L12. A census that counted itself would report every run as
    // non-quiescent, which is the failure mode that makes an operator stop
    // reading its output.
    const d = root()
    const self = String(process.pid)
    const label = 'com.thanapol.ai-capital.worker'
    const measured = await launchdQuiescenceAdapter([label], {
      uid: '501', agentsDir: d,
      commands: fakeCommands({
        'print-disabled gui/501': { code: 0, stdout: '' },
        // THIS PROCESS, pretending to be the worker.
        ps: { code: 0, stdout: `${self} tsx bin/worker.ts\n  1 /sbin/launchd\n` },
      }),
    }).measure(ctx())
    const row = measured[0] as { stopped: boolean; processPids: readonly string[] }
    expect([...row.processPids]).toEqual([])
    expect(row.stopped).toBe(true)

    // AND ANOTHER PROCESS WITH THE SAME COMMAND IS COUNTED.
    const other = await launchdQuiescenceAdapter([label], {
      uid: '501', agentsDir: d,
      commands: fakeCommands({
        'print-disabled gui/501': { code: 0, stdout: '' },
        ps: { code: 0, stdout: `${self} tsx bin/worker.ts\n 555 tsx bin/worker.ts\n` },
      }),
    }).measure(ctx())
    expect([...(other[0] as { processPids: readonly string[] }).processPids]).toEqual(['555'])
  })

  it('refuses a reviewed label it has no process pattern for', async () => {
    // K1.2-L13. A label with no pattern is a label whose processes nobody can
    // look for, and an empty pattern would match every line of `ps`.
    const d = root()
    await expect(launchdQuiescenceAdapter(['com.example.not-reviewed'], {
      uid: '501', agentsDir: d,
      commands: fakeCommands({
        'print-disabled gui/501': { code: 0, stdout: '' },
        ps: { code: 0, stdout: '  1 /sbin/launchd\n' },
      }),
    }).report(ctx())).rejects.toThrow(/no process pattern/)
    // AND EVERY REVIEWED LABEL HAS ONE.
    for (const label of REVIEWED_PRODUCERS) {
      expect(PRODUCER_PROCESS_PATTERNS[label], label).toBeDefined()
      expect((PRODUCER_PROCESS_PATTERNS[label] as string).length, label).toBeGreaterThan(0)
    }
    expect(Object.keys(PRODUCER_PROCESS_PATTERNS).sort())
      .toEqual([...REVIEWED_PRODUCERS].sort())
  })

  it('runs ps read-only, with no pattern handed to another program', () => {
    const src = strip(readFileSync(
      new URL('../src/pg-copy-ops/launchd.ts', import.meta.url), 'utf-8'))
    expect(src).toContain("'-Ao', 'pid=,command='")
    // MATCHED HERE, on the output. A pattern handed to `pgrep` is a pattern
    // that program interprets.
    expect(src).not.toContain('pgrep')
    expect(src).not.toContain('pkill')
  })
})

// ---------------------------------------------------------------------------
// K1.5.2.1: A REFUSED DESCRIPTOR IS CLOSED
// ---------------------------------------------------------------------------

describe('a descriptor that fails validation is closed, not leaked', () => {
  /** A reviewed-looking file, and one that will fail a named check. */
  const world = (): { dir: string; good: string; badMode: string } => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fd-leak-')))
    ROOTS.push(dir)
    const good = join(dir, 'good.url')
    writeFileSync(good, 'postgres://u:p@%2Ftmp%2Fs/db\n')
    chmodSync(good, 0o600)
    const badMode = join(dir, 'bad-mode.url')
    writeFileSync(badMode, 'postgres://u:p@%2Ftmp%2Fs/db\n')
    chmodSync(badMode, 0o644)
    return { dir, good, badMode }
  }

  /** How many descriptors this process currently holds. */
  const openDescriptors = (): number => readdirSync('/dev/fd').length

  it('refuses a wrong-mode file without leaking its descriptor', () => {
    // K1.5.2.1-C02. `openReviewedFileDescriptor` opens the file BEFORE it can check
    // it - that is the whole point, since checking a path and then opening it is a
    // race - so every refusal happens with a descriptor already in hand. A refusal
    // that walked away from it would leak one per attempt, and the hold that uses
    // this re-reads a credential on every intervention attempt: an unbounded loop
    // against a bounded table.
    //
    // MEASURED BY COUNTING, because a leak has no other symptom until the table is
    // full. The count is taken around a hundred refusals, which is enough to make a
    // per-refusal leak unmistakable and small enough not to exhaust anything if the
    // guard really is gone.
    const w = world()
    // NON-VACUITY FIRST: a good file really does hand back a usable descriptor, so
    // the refusals below are refusals and not a function that never works.
    const held = openReviewedFileDescriptor(w.good)
    expect(held.fd).toBeGreaterThan(-1)
    expect(held.identity.mode).toBe('600')
    held.close()

    const before = openDescriptors()
    for (let n = 0; n < 100; n += 1) {
      expect(() => openReviewedFileDescriptor(w.badMode)).toThrow(SecureFileRefused)
    }
    const after = openDescriptors()
    // A COUPLE OF DESCRIPTORS OF SLACK for whatever else the runtime opens in the
    // meantime; a leak would be a hundred.
    expect(after - before, `before ${before} after ${after}`).toBeLessThanOrEqual(3)
  })

  it('closes the descriptor for every named refusal, not just one of them', () => {
    // K1.5.2.1-C03. Each check refuses from a different place inside the same
    // `try`, and the guard is in the `finally` that covers all of them.
    const w = world()
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fd-leak-kinds-')))
    ROOTS.push(dir)
    // NOT A REGULAR FILE.
    const notFile = join(dir, 'a-directory')
    mkdirSync(notFile, { mode: 0o700 })
    // MORE THAN ONE LINK.
    const linked = join(dir, 'linked.url')
    writeFileSync(linked, 'x\n')
    chmodSync(linked, 0o600)
    execFileSync('/bin/ln', [linked, join(dir, 'second-name.url')])

    const before = openDescriptors()
    for (let n = 0; n < 40; n += 1) {
      expect(() => openReviewedFileDescriptor(w.badMode)).toThrow(/mode 0600/)
      expect(() => openReviewedFileDescriptor(notFile)).toThrow(SecureFileRefused)
      expect(() => openReviewedFileDescriptor(linked)).toThrow(/more than one link/)
    }
    const after = openDescriptors()
    expect(after - before, `before ${before} after ${after}`).toBeLessThanOrEqual(3)
  })
})

describe('K8-D1: exactly one leading `--` is tolerated', () => {
  // Both pnpm and tsx forward a literal `--` to the script, so the reviewed
  // package-script form arrives with `--` as argv[0]. Refusing it reads as an
  // operator typo when it is a launcher artefact. Tolerating a SEPARATOR is not
  // the same as ignoring a stray token, so everything else still refuses.
  const base = ['--inspect', '--for=rehearse', '--source-host=127.0.0.1']

  it('parses a leading `--` exactly as if it were absent', () => {
    const without = parseArgs(base)
    const with_ = parseArgs(['--', ...base])
    expect(with_.mode).toBe(without.mode)
    expect(with_.values).toEqual(without.values)
    // And the mode is still the one mode.
    expect(with_.mode).toBe('--inspect')
  })

  it('REFUSES a `--` anywhere but the front, and a second one', () => {
    for (const argv of [
      ['--inspect', '--', '--for=rehearse'],          // after the mode
      ['--', '--', ...base],                           // two leading
      [...base, '--'],                                 // trailing
      ['--source-host=127.0.0.1', '--', '--inspect'],  // after an option
    ]) {
      expect(() => parseArgs(argv), argv.join(' ')).toThrow(OpsRefused)
      expect(() => parseArgs(argv), argv.join(' '))
        .toThrow(/every option must be --name=value/)
    }
  })

  it('a leading `--` does not become a mode or an option name', () => {
    const r = parseArgs(['--', '--inspect', '--for=rehearse'])
    expect(Object.keys(r.values)).toEqual(['--for'])
    expect(Object.keys(r.values)).not.toContain('--')
  })
})

describe('K8-D1: a psql refusal is REFUSED, not FAILED', () => {
  /** The smallest deps that reach `measureSourceIdentity` and no further. */
  const depsThrowing = (e: Error): OpsDeps => ({
    newRunId: () => 'aabbccdd',
    stamp: () => '20260930T000000Z',
    openSourceIdentity: async () => { throw e },
  } as unknown as OpsDeps)

  const argv = ['--inspect', '--for=rehearse',
                '--evidence-root=/tmp/k8d1-unused', '--source-host=127.0.0.1']

  it('PsqlBackendRefused gives REFUSED and exit 2', async () => {
    const r = await runOpsCli(argv,
      depsThrowing(new PsqlBackendRefused('the psql session could not be started')))
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.at(-1)).toBe('REFUSED: the psql session could not be started')
    // The message is one of the nine reviewed literals, so nothing else leaks.
    expect(r.lines.join('\n')).not.toMatch(/password|postgresql:\/\/|stderr/i)
  })

  /**
   * ALL NINE `PsqlBackendReason` LITERALS, not a sample.
   *
   * K8-D3: the earlier version drove four and was titled as though it covered
   * every reason. Each one is raisable through the same seam - the fake source
   * session constructs the error - so there is no excuse for a subset.
   */
  const ALL_REASONS = [
    'the psql path must be absolute',
    'the passfile must be an absolute path',
    'the port is not a port number',
    'the psql session has already exited',
    'the psql session timed out on a statement',
    'the psql session could not report its backend pid',
    'the psql session did not report a backend pid',
    'the psql session refused a statement',
    'the psql session could not be started',
  ] as const

  it('ALL NINE reviewed psql reasons give exit 2 and their own message', async () => {
    expect(ALL_REASONS).toHaveLength(9)
    expect(new Set(ALL_REASONS).size).toBe(9)
    for (const reason of ALL_REASONS) {
      const r = await runOpsCli(argv, depsThrowing(new PsqlBackendRefused(reason)))
      expect(r.exitCode, reason).toBe(EXIT_REFUSED)
      expect(r.lines.at(-1), reason).toBe(`REFUSED: ${reason}`)
      // Nothing beyond the literal reaches the output.
      expect(r.lines.join('\n'), reason).not.toMatch(/password|postgresql:\/\/|stderr/i)
    }
  })

  it('the nine literals here are exactly the union the source declares', () => {
    // A guard against the list drifting from `PsqlBackendReason`. Reading the
    // type at runtime is impossible, so the union's own source is the reference.
    const src = readFileSync(
      new URL('../../db/src/pg-copy/psql-backend.ts', import.meta.url), 'utf-8')
    const block = src.slice(src.indexOf('export type PsqlBackendReason ='))
      .slice(0, src.slice(src.indexOf('export type PsqlBackendReason =')).indexOf('\n\n'))
    const declared = [...block.matchAll(/\|\s*'([^']+)'/g)].map(m => m[1] as string)
    expect(declared).toHaveLength(9)
    expect([...declared].sort()).toEqual([...ALL_REASONS].sort())
  })

  it('a GENERIC Error still gives FAILED and exit 1, saying nothing about itself', async () => {
    const r = await runOpsCli(argv, depsThrowing(new Error('ENOENT: boom /secret/path')))
    expect(r.exitCode).toBe(EXIT_FAILED)
    expect(r.lines.at(-1)).toBe('FAILED: the command did not complete')
    // The widening did not turn every error into a printed message.
    expect(r.lines.join('\n')).not.toContain('boom')
    expect(r.lines.join('\n')).not.toContain('/secret/path')
  })
})
