// K8-E2: OPERATOR OUTPUT MUST LEAVE THE PROCESS WHEN IT IS SAID.
//
// WHAT WENT WRONG, SO IT CANNOT AGAIN. `runOpsCli`'s `say` only pushed onto an
// array, and `main` wrote that array after `runOpsCli` RETURNED. For a mode that
// finishes, the difference is invisible. For a held fence it is the whole
// problem: the intervention prompt, the reviewed operations and the resolution
// token are said while the process is blocked waiting for a reply, so the
// operator was asked for a token they could not see, about a fence they could
// not confirm was held. `say` now hands each line to a sink synchronously,
// before the next await, and `main` no longer replays `result.lines`.
//
// NOTHING HERE OPENS A DATABASE, A BROKER OR A TERMINAL. Every world is a
// private `mkdtemp` root and every session and adapter is a fake from
// `./support/ops-world.js`. Production secret, evidence and policy paths are
// unreachable from here.
//
// T1, T2 AND T3 ARE NOT HERE, AND THE REASON IS STRUCTURAL.
//
// They need the PRODUCTION `holdForIntervention`, or the apply confirmation,
// driven to the point where it blocks on a reply. That cannot be done inside a
// Vitest worker: `holdForIntervention` is unbounded by design, and as
// `tests/support/contained.ts:105-113` records, a Vitest `testTimeout` REJECTS
// THE TEST AND ABANDONS THE PROMISE - the loop goes on being driven with nothing
// checking a ceiling, and the worker wedges. Reproduced twice while writing
// this file: no output after nine minutes, with `--testTimeout` unable to
// recover it.
//
// The reviewed home for a hold scenario is the contained child harness in
// `pg-copy-ops-modes.test.ts`, which runs one hold per process group under
// external ceilings. What IS proved here, end to end through `main`, is the
// mechanism those cases depend on: a line reaches the writer at the moment it is
// said, before the next await, exactly once, in order.
import { afterEach, describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  EXIT_ACTION_REQUIRED, EXIT_REFUSED, main, runOpsCli, streamWriter, type OpsDeps,
} from '../bin/pg-copy-ops.js'
import {
  ROOTS, ROOT_PREFIX, base, deps, ready, rehearseArgs, supervisorStub, tokenFor,
  type World,
} from './support/ops-world.js'
import { removeProvedRoot, unfreezeProvedRoot } from './support/roots.js'

const worlds: World[] = []

/**
 * ZERO RESIDUE, AFTER A PASS AND AFTER A FAILURE.
 *
 * The same discipline `pg-copy-ops-modes.test.ts` uses: unfreeze only inside a
 * PROVED root - a real directory, directly under the real temporary directory,
 * under the reviewed name, owned by this user - then remove it, then assert
 * nothing with this process's prefix is left. A world that published evidence
 * froze it 0500, so a plain remove cannot descend.
 */
afterEach(() => {
  const violations: string[] = []
  for (const r of ROOTS.splice(0, ROOTS.length)) {
    try { unfreezeProvedRoot(r) } catch (e) {
      violations.push(`refused to clean up ${r}: ${(e as Error).message}`)
      continue
    }
    removeProvedRoot(r)
  }
  worlds.length = 0
  const leftover = readdirSync(realpathSync(tmpdir())).filter(n => n.startsWith(ROOT_PREFIX))
  if (leftover.length > 0) violations.push(`left ${leftover.length} root(s) behind`)
  expect(violations).toEqual([])
})

describe('K8-E2 T4: main streams each line once, in order, as it is said', () => {
  it('(a) a successful --rehearse writes every said line exactly once, in order', async () => {
    const w = await ready()
    worlds.push(w)
    const token = await tokenFor(w, 'rehearse', deps(w))
    const written: string[] = []
    // WHAT THE RUN SAID, recorded by the FACTORY'S OWN SINK (Phase B.2), so the
    // written sequence can be compared against the said sequence rather than
    // against itself.
    const said: string[] = []
    // HOW MUCH HAD ALREADY BEEN WRITTEN at each supervisor interaction.
    //
    // The probe has to sit on something awaited AFTER a line is said, and in the
    // success path the first line is said late - `release gate published …` at
    // pg-copy-ops.ts:3185 - so an `openProver` probe runs before any output and
    // proves nothing. The supervisor is spoken to repeatedly, including after
    // that line, so the LARGEST reading is what matters: a buffered build can
    // only ever record 0, because nothing is written until the process returns.
    const atSend: number[] = []
    const d: OpsDeps = deps(w, {
      sink: (l: string) => { said.push(l) },
      openSupervisor: async () => {
        const s = supervisorStub()
        return { ...s, send: async (sql: string) => { atSend.push(written.length); return await s.send(sql) } }
      },
    })
    const code = await main(rehearseArgs(w, token), s => { written.push(s) }, () => d)

    expect(code).toBe(EXIT_ACTION_REQUIRED)
    expect(written.length).toBeGreaterThan(0)
    // ONE LINE PER WRITE, each terminated, and no line written twice.
    for (const s of written) expect(s.endsWith('\n')).toBe(true)
    const lines = written.map(s => s.slice(0, -1))
    expect(new Set(lines).size).toBe(lines.length)
    // AND THE WRITTEN SEQUENCE IS THE SAID SEQUENCE, in order, nothing added.
    expect(lines).toEqual(said)
    // AND OUTPUT HAD ALREADY LEFT THE PROCESS BEFORE A LATER AWAIT.
    expect(atSend.length).toBeGreaterThan(0)
    expect(Math.max(...atSend)).toBeGreaterThan(0)
  })

  it('(b) a bounded pre-fence refusal writes its refusal once, exit 2', async () => {
    const w = await ready()
    worlds.push(w)
    const token = await tokenFor(w, 'rehearse', deps(w))
    // A confirmation in the APPLY form: refused by mode before the fence.
    const argv = rehearseArgs(w, token).map(
      a => a.startsWith('--confirm=') ? `--confirm=PGCOPY-APPLY-${'a'.repeat(64)}` : a)
    const written: string[] = []
    const d = deps(w)
    const code = await main(argv, s => { written.push(s) }, () => d)

    expect(code).toBe(EXIT_REFUSED)
    const lines = written.map(s => s.replace(/\n$/, ''))
    expect(lines.filter(l => l.startsWith('REFUSED: '))).toHaveLength(1)
    // THE REASON NAMES THE FORM, from bindings.ts's
    // `the confirmation is not in the reviewed form for this mode`.
    expect(lines.find(l => l.startsWith('REFUSED: ')))
      .toBe('REFUSED: the confirmation is not in the reviewed form for this mode')
    expect(new Set(lines).size).toBe(lines.length)
  })

  it('(c) an argv parse failure writes one REFUSED line through the same writer', async () => {
    const w = await ready()
    worlds.push(w)
    const d = deps(w)
    const written: string[] = []
    // The parse fails before the deps factory matters, and the REFUSED line
    // still goes through the injected writer rather than straight to stdout.
    const code = await main(['--inspect', 'not-an-option'], s => { written.push(s) }, () => d)

    expect(code).toBe(EXIT_REFUSED)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(/^REFUSED: every option must be --name=value/)
    expect(written[0]?.endsWith('\n')).toBe(true)
  })
})

describe('K8-E2 T5: no mode emits a line twice', () => {
  it('a successful --rehearse returns exactly what it emitted, once each', async () => {
    // THE RETURNED ARRAY MATTERS TOO, not just the stream. The dispatch used to
    // return `[...lines, ...r.lines]` while every mode wrapper ALSO forwarded to
    // `i.say`, so each line said inside the mode came back twice. The sink is
    // unaffected by that bug, which is exactly why this assertion is separate:
    // without it, restoring the duplication passes every streaming test.
    const w = await ready()
    worlds.push(w)
    const token = await tokenFor(w, 'rehearse', deps(w))
    const sink: string[] = []
    const r = await runOpsCli(rehearseArgs(w, token),
                              deps(w, { sink: (l: string) => { sink.push(l) } }))

    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED)
    expect(sink.length).toBeGreaterThan(0)
    expect(sink).toEqual([...r.lines])
    expect(new Set(r.lines).size).toBe(r.lines.length)
  })

  it('--verify-restoration and --review-rehearsal each say every line once', async () => {
    for (const mode of ['--verify-restoration', '--review-rehearsal'] as const) {
      const w = await ready()
      worlds.push(w)
      const sink: string[] = []
      // These refuse without their bundle options, which is enough: the property
      // under test is the EMISSION, not the outcome.
      const r = await runOpsCli(
        base(w, [mode, `--rehearsal-authorization=${w.authorization}`]),
        deps(w, { sink: (l: string) => { sink.push(l) } }))

      // WHAT WAS EMITTED AND WHAT WAS RETURNED ARE THE SAME SEQUENCE.
      expect(sink, mode).toEqual([...r.lines])
      // AND NO LINE APPEARS TWICE.
      expect(new Set(sink).size, mode).toBe(sink.length)
    }
  })
})

describe('K8-E3 S1: a failing output stream cannot end the process', () => {
  /**
   * THE REGRESSION THIS CLOSES. K8-E2 routed every said line to
   * `process.stdout.write` as it was said, and left the stream unguarded. A
   * terminal hang-up, or a pipe reader exiting, makes the next write emit
   * `'error'` on a stream with no listener - and an unhandled stream error ends
   * the process, taking the fenced psql child with it. The SIGHUP handler's own
   * `IGNORED` line is one of those writes.
   */
  it('swallows a stream error, keeps writing, and attaches exactly one listener', () => {
    const stream = new PassThrough()
    const write = streamWriter(stream)

    // EXACTLY ONE LISTENER, AND IDEMPOTENT. A second writer for the same stream
    // must not stack another.
    expect(stream.listenerCount('error')).toBe(1)
    const again = streamWriter(stream)
    expect(stream.listenerCount('error')).toBe(1)

    // THE ERROR DOES NOT THROW, which is what an unhandled 'error' would do.
    expect(() => stream.emit('error', Object.assign(new Error('write EPIPE'),
      { code: 'EPIPE', errno: -32, syscall: 'write' }))).not.toThrow()

    // AND WRITING AFTERWARDS DOES NOT THROW EITHER.
    expect(() => { write('after the error\n') }).not.toThrow()
    expect(() => { again('and again\n') }).not.toThrow()
  })

  it('catches a synchronous throw from write', () => {
    // Some streams throw from `write` rather than emitting. Both are survivable.
    const throwing = {
      write: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) },
      on: () => undefined,
    }
    const write = streamWriter(throwing)
    expect(() => { write('x\n') }).not.toThrow()
  })
})

describe('K8-E3 S2: a writer that throws does not stop a run', () => {
  it('a --rehearse still completes and publishes with a writer that always throws', async () => {
    const w = await ready()
    worlds.push(w)
    const token = await tokenFor(w, 'rehearse', deps(w))
    const said: string[] = []
    const d = deps(w, { sink: (l: string) => { said.push(l) } })

    let attempts = 0
    const code = await main(rehearseArgs(w, token), () => {
      attempts += 1
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    }, () => d)

    // THE RUN FINISHED NORMALLY. The output is lost; the rehearsal is not.
    expect(code).toBe(EXIT_ACTION_REQUIRED)
    expect(attempts).toBeGreaterThan(0)
    // AND THE RUN STILL SAID EVERYTHING, so `lines` and the factory sink are intact.
    expect(said.length).toBeGreaterThan(0)
    expect(said.some(l => l.startsWith('operational rehearsal published '))).toBe(true)
    // THE SUCCESS BUNDLE IS ON DISK, exactly as in the unbroken-writer case.
    expect(readdirSync(w.evidence).some(n => n.startsWith('operational-rehearsal-'))).toBe(true)
  })
})
