// K7-B: the ordinary copy confirmation, which is NOT an intervention.
//
// A production apply prints a PGCOPY-COPY token while it is holding the source
// fence and waits for the operator to paste it back. That question shares the
// hold's TRANSPORT - one readline interface, a resolution file under this run's
// evidence root, signal handlers that decline to exit - and shares none of its
// GRAMMAR: there is no RELEASE, no ABANDON and no intervention bundle, because
// approving a copy is not an intervention.
import { describe, expect, it, vi } from 'vitest'
import {
  mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  COPY_CONFIRM_ACTION, HELD_SIGNALS, ResolutionPending, awaitCopyConfirmation,
  operatorChannel, type OperatorChannel,
} from '../bin/pg-copy-ops.js'

const TOKEN = `PGCOPY-COPY-${'a'.repeat(64)}`
const OPS_TOKEN = `PGCOPY-APPLY-${'a'.repeat(64)}`
const noSleep = async (): Promise<void> => undefined

/** A channel whose lines are scripted, so no test touches a real terminal. */
const scripted = (...lines: string[]): OperatorChannel & { reads: number } => {
  let i = 0
  const c = {
    reads: 0,
    preflight: () => undefined,
    arm: () => () => undefined,
    nextLine: async (): Promise<string> => {
      c.reads += 1
      const l = lines[i]
      i += 1
      if (l === undefined) throw new Error('the test script ran out of lines')
      return l
    },
    close: () => undefined,
  }
  return c
}

describe('K7-B: the copy confirmation channel', () => {
  it('accepts CONFIRM <operator> <token> and returns the named operator', async () => {
    const c = scripted(`${COPY_CONFIRM_ACTION} thanapold ${TOKEN}`)
    const r = await awaitCopyConfirmation(c, TOKEN, () => undefined, noSleep)
    expect(r).toEqual({ operator: 'thanapold', token: TOKEN })
  })

  it('NEVER self-accepts: it reads the token from outside the process', async () => {
    // The process computed TOKEN and printed it. If it could satisfy itself,
    // this channel would never be read at all.
    const c = scripted(`${COPY_CONFIRM_ACTION} thanapold ${TOKEN}`)
    await awaitCopyConfirmation(c, TOKEN, () => undefined, noSleep)
    expect(c.reads).toBe(1)
  })

  it('REFUSES an operations PGCOPY-APPLY token offered as copy confirmation', async () => {
    const c = scripted(`${COPY_CONFIRM_ACTION} thanapold ${OPS_TOKEN}`)
    await expect(awaitCopyConfirmation(c, TOKEN, () => undefined, noSleep))
      .rejects.toThrow(/does not carry this run's copy confirmation/)
  })

  it('REFUSES any action word other than CONFIRM, including hold operations', async () => {
    for (const word of ['RELEASE', 'ABANDON', 'APPLY', 'yes']) {
      const c = scripted(`${word} thanapold ${TOKEN}`)
      await expect(awaitCopyConfirmation(c, TOKEN, () => undefined, noSleep))
        .rejects.toThrow(/approved with CONFIRM, and nothing else/)
    }
  })

  it('requires a named operator', async () => {
    const c = scripted(`${COPY_CONFIRM_ACTION} 9-not-a-name ${TOKEN}`)
    await expect(awaitCopyConfirmation(c, TOKEN, () => undefined, noSleep))
      .rejects.toThrow(/needs a named operator/)
  })

  it('NEVER echoes what it was given', async () => {
    // A mistyped reply may be a token for another run, or a paste of something
    // else entirely. The refusal names the problem, not the value.
    const secret = `PGCOPY-COPY-${'9'.repeat(64)}`
    const c = scripted(`${COPY_CONFIRM_ACTION} thanapold ${secret}`)
    const err = await awaitCopyConfirmation(c, TOKEN, () => undefined, noSleep)
      .catch((e: Error) => e)
    expect(String((err as Error).message)).not.toContain(secret)
    expect(String((err as Error).message)).not.toContain('9'.repeat(64))
  })

  it('WAITS on an unanswered channel instead of spinning, and publishes nothing', async () => {
    // Absence is not refusal: a resolution file the operator has not written
    // yet means "not answered", so the channel pauses and looks again. The
    // pause is what makes a missing file cost nothing.
    const sleep = vi.fn(async () => undefined)
    const c = scripted('', '   ', `${COPY_CONFIRM_ACTION} thanapold ${TOKEN}`)
    const r = await awaitCopyConfirmation(c, TOKEN, () => undefined, sleep)
    expect(r.operator).toBe('thanapold')
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(c.reads).toBe(3)
  })
})

describe('K7-B: the transport preflights BEFORE a fence can exist', () => {
  it('refuses a detached run whose resolution file is outside the evidence root', () => {
    const root = mkdtempSync(join(tmpdir(), 'k7b-root-'))
    const other = mkdtempSync(join(tmpdir(), 'k7b-other-'))
    try {
      const c = operatorChannel(() => undefined, root, join(other, 'resolve.txt'))
      expect(() => c.preflight()).toThrow(/not under this run's evidence root/)
      // And the same path INSIDE the root preflights even though the operator
      // has not written it yet - which is the whole point of checking early.
      const ok = operatorChannel(() => undefined, root, join(root, 'resolve.txt'))
      expect(() => ok.preflight()).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('refuses when there is neither a terminal nor a resolution file', () => {
    // vitest runs without a TTY, which is exactly the detached case.
    const root = mkdtempSync(join(tmpdir(), 'k7b-root-'))
    try {
      const c = operatorChannel(() => undefined, root, null)
      expect(() => c.preflight()).toThrow(/stdin AND stdout/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reads a resolution file that IS under the evidence root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'k7b-root-'))
    try {
      const f = join(root, 'resolve.txt')
      writeFileSync(f, `${COPY_CONFIRM_ACTION} thanapold ${TOKEN}\n`, { mode: 0o600 })
      const c = operatorChannel(() => undefined, root, f)
      c.preflight()
      const r = await awaitCopyConfirmation(c, TOKEN, () => undefined, noSleep)
      expect(r.operator).toBe('thanapold')
      c.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('arms every held signal and disarms exactly once', () => {
    const root = mkdtempSync(join(tmpdir(), 'k7b-root-'))
    try {
      const said: string[] = []
      const before = HELD_SIGNALS.map(s => process.listenerCount(s))
      const c = operatorChannel(l => said.push(l), root, join(root, 'r.txt'))
      const disarm = c.arm('Reply with the confirmation.')
      HELD_SIGNALS.forEach((s, i) => {
        expect(process.listenerCount(s)).toBe(before[i]! + 1)
      })
      // A handled signal SAYS something and does not exit.
      process.emit('SIGINT', 'SIGINT')
      expect(said.join('\n')).toMatch(/SIGINT IGNORED: this process is holding a source fence/)
      disarm()
      HELD_SIGNALS.forEach((s, i) => { expect(process.listenerCount(s)).toBe(before[i]!) })
      // Idempotent.
      c.close(); c.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('K7-B: the DETACHED wait is real, not a message match', () => {
  it('WAITS through an absent file and accepts it once the operator writes it', async () => {
    // The whole point: the process is holding a production fence, and the
    // operator has not answered yet. An earlier revision called realpathSync on
    // the final pathname, which throws raw ENOENT, and the wait only recognised
    // an OpsRefused whose TEXT matched - so this case crashed instead of
    // waiting. It is a typed condition now, and this drives the REAL channel.
    const root = mkdtempSync(join(tmpdir(), 'k7b-wait-'))
    try {
      const f = join(root, 'resolve.txt')
      const c = operatorChannel(() => undefined, root, f)
      c.preflight()                       // absent is fine: the parent exists

      // The first read observes PENDING, by type.
      await expect(c.nextLine()).rejects.toBeInstanceOf(ResolutionPending)

      let sleeps = 0
      const sleep = async (): Promise<void> => {
        sleeps += 1
        // The operator answers while the process is paused.
        if (sleeps === 1) {
          writeFileSync(f, `${COPY_CONFIRM_ACTION} thanapold ${TOKEN}\n`, { mode: 0o600 })
        }
      }
      const before = readdirSync(root).length
      const r = await awaitCopyConfirmation(c, TOKEN, () => undefined, sleep)
      expect(r.operator).toBe('thanapold')
      expect(sleeps).toBeGreaterThanOrEqual(1)
      // AND THE WAIT PUBLISHED NOTHING. Only the operator's own file appeared.
      expect(readdirSync(root).sort()).toEqual([basename(f)])
      expect(readdirSync(root).length).toBe(before + 1)
      c.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('REFUSES a symlink standing where the resolution file belongs', async () => {
    // realpath-then-open would have followed this to a file that was never
    // checked against the evidence root. O_NOFOLLOW on the exact name refuses.
    const root = mkdtempSync(join(tmpdir(), 'k7b-link-'))
    const away = mkdtempSync(join(tmpdir(), 'k7b-away-'))
    try {
      const target = join(away, 'elsewhere.txt')
      writeFileSync(target, `${COPY_CONFIRM_ACTION} thanapold ${TOKEN}\n`, { mode: 0o600 })
      const f = join(root, 'resolve.txt')
      symlinkSync(target, f)
      const c = operatorChannel(() => undefined, root, f)
      c.preflight()
      // MUST REJECT. Following the link would RESOLVE and return the target's
      // contents - a perfectly valid confirmation read out of a file that was
      // never checked against the evidence root - so "did it throw" is the
      // property, and it must not be the pending condition either.
      await expect(c.nextLine()).rejects.toThrow()
      await expect(c.nextLine()).rejects.not.toBeInstanceOf(ResolutionPending)
      c.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(away, { recursive: true, force: true })
    }
  })

  it('an unreadable-for-another-reason file is a REFUSAL, never a wait', async () => {
    const root = mkdtempSync(join(tmpdir(), 'k7b-dir-'))
    try {
      // A DIRECTORY where the file belongs: present, so not pending, and not
      // openable as a container either.
      const f = join(root, 'resolve.txt')
      mkdirSync(f)
      const c = operatorChannel(() => undefined, root, f)
      const err = await c.nextLine().catch((e: Error) => e)
      expect(err).not.toBeInstanceOf(ResolutionPending)
      c.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('K7-B: interactive preflight needs BOTH tty sides', () => {
  const withTty = async (
    stdin: boolean, stdout: boolean, run: () => void,
  ): Promise<void> => {
    const di = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const dou = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true })
    try { run() } finally {
      if (di === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY
      else Object.defineProperty(process.stdin, 'isTTY', di)
      if (dou === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
      else Object.defineProperty(process.stdout, 'isTTY', dou)
    }
  }

  it('accepts only when stdin AND stdout are terminals', async () => {
    const root = mkdtempSync(join(tmpdir(), 'k7b-tty-'))
    try {
      const c = operatorChannel(() => undefined, root, null)
      await withTty(true, true, () => { expect(() => c.preflight()).not.toThrow() })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('REFUSES when stdout is not a terminal, even with an interactive stdin', async () => {
    // The token would be printed into a pipe the operator is not watching,
    // while the fence stays held waiting for an answer to an unseen question.
    const root = mkdtempSync(join(tmpdir(), 'k7b-tty-'))
    try {
      const c = operatorChannel(() => undefined, root, null)
      await withTty(true, false, () => {
        expect(() => c.preflight()).toThrow(/stdin AND stdout/)
      })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('REFUSES when stdin is not a terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'k7b-tty-'))
    try {
      const c = operatorChannel(() => undefined, root, null)
      await withTty(false, true, () => {
        expect(() => c.preflight()).toThrow(/stdin AND stdout/)
      })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ── PHASE A: confirmation → refusal → intervention, on ONE channel ──────────
//
// A wrong confirmation is not the end of the run. The fence may still be held,
// so the code attempts the reviewed pre-COMMIT release; when that release
// cannot be PROVED, the only way out is the operator, through the only input
// channel there is. Closing it on the way - which the old arm()/disarm pair
// did - would have left the hold with no reader, and re-opening one would put
// a second consumer on the same stdin.
describe('K7-B: the same channel survives confirmation refusal into intervention', () => {
  const TOK = `PGCOPY-COPY-${'b'.repeat(64)}`
  const HOLD_TOKEN = `PGCOPY-REHEARSE-${'c'.repeat(64)}`

  it('disarms without closing, then resolves the hold on the SAME reader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'k7b-trans-'))
    try {
      const f = join(root, 'resolve.txt')
      const said: string[] = []
      const channel = operatorChannel(l => said.push(l), root, f)
      channel.preflight()

      const before = HELD_SIGNALS.map(sig => process.listenerCount(sig))

      // 1. ARMED BEFORE THE WAIT, because the fence is already held.
      const disarm = channel.arm('Reply with the confirmation.')
      HELD_SIGNALS.forEach((sig, i) => {
        expect(process.listenerCount(sig)).toBe(before[i]! + 1)
      })

      // 2. THE OPERATOR RETURNS THE WRONG TOKEN.
      writeFileSync(f, `${COPY_CONFIRM_ACTION} thanapold PGCOPY-COPY-${'9'.repeat(64)}\n`,
                    { mode: 0o600 })
      await expect(awaitCopyConfirmation(channel, TOK, () => undefined, async () => undefined))
        .rejects.toThrow(/does not carry this run's copy confirmation/)

      // 3. RELEASE COULD NOT BE PROVED, so the run must reach the operator
      //    again. Disarm the confirmation phase WITHOUT closing the channel.
      disarm()
      HELD_SIGNALS.forEach((sig, i) => { expect(process.listenerCount(sig)).toBe(before[i]!) })

      // 4. THE HOLD USES THE SAME CHANNEL. One reader, never re-created.
      const rearm = channel.arm('This process is holding a source fence.')
      writeFileSync(f, `RELEASE thanapold ${HOLD_TOKEN}\n`, { mode: 0o600 })
      const line = await channel.nextLine()
      expect(line.trim()).toBe(`RELEASE thanapold ${HOLD_TOKEN}`)

      // A handled signal still declines to exit while the hold is armed.
      process.emit('SIGTERM', 'SIGTERM')
      expect(said.join('\n')).toMatch(/SIGTERM IGNORED: this process is holding a source fence/)

      // 5. ONLY NOW is the channel closed, exactly once.
      rearm()
      HELD_SIGNALS.forEach((sig, i) => { expect(process.listenerCount(sig)).toBe(before[i]!) })
      channel.close()
      channel.close()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('the confirmation wait leaves NO handler behind after it refuses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'k7b-leak-'))
    try {
      const f = join(root, 'resolve.txt')
      const before = HELD_SIGNALS.map(sig => process.listenerCount(sig))
      const channel = operatorChannel(() => undefined, root, f)
      const disarm = channel.arm('x')
      writeFileSync(f, `NOPE thanapold ${TOK}\n`, { mode: 0o600 })
      await expect(awaitCopyConfirmation(channel, TOK, () => undefined, async () => undefined))
        .rejects.toThrow(/approved with CONFIRM/)
      disarm()
      channel.close()
      HELD_SIGNALS.forEach((sig, i) => { expect(process.listenerCount(sig)).toBe(before[i]!) })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
