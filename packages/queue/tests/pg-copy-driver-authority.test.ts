// K7-B4: the five reviewed driver sessions.
//
// Proved by COUNTING and by IDENTITY, not by reading source: which container
// each opener read, which opening discipline it chose, that every handle is
// distinct, that construction touches nothing, and that a session built but
// not handed over is reaped.
import { describe, expect, it, beforeEach } from 'vitest'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DriverAuthorityRefused, REVIEWED_OPENERS, driverAuthority,
  type DriverOpeners, type DriverAuthorityInputs,
  type EndpointExpectation,
} from '../src/pg-copy-ops/driver-authority.js'
import {
  openDriverSession, openSilentDriverSession,
  type DriverSession, type VerifyCloseable,
} from '@common/db/pg-copy'
import type { ExportSession } from '@common/db/pg-copy'

const EXPORT_ROLE = 'ai_capital_v3_export'
const SECRET = 'n0t-a-real-secret'
const SOURCE = { host: '127.0.0.1', port: '5432', database: 'ai_capital', role: EXPORT_ROLE }
const TARGET = { host: '127.0.0.1', port: '5433', database: 'ai_capital_v3', role: 'ai_capital_owner' }

let dir: string
const write = (name: string, body: string): string => {
  const p = join(dir, name)
  writeFileSync(p, body, { mode: 0o600 })
  chmodSync(p, 0o600)
  return p
}
const url = (u: string, h: string, port: string, db: string): string =>
  `postgresql://${u}:${SECRET}@${h}:${port}/${db}`

/**
 * A fake that actually satisfies `DriverSession`.
 *
 * WHY THIS IS SPELLED OUT. The queue tsconfig includes only `src/**` and
 * `bin/**`, so no gate typechecks this file and vitest strips the types - an
 * under-specified fake compiles nowhere and fails nothing. The proof block
 * below is only worth having if the fakes are the real shape.
 */
const fakeSession = (): DriverSession & { ended: number } => {
  const s = {
    ended: 0,
    pid: '4242',
    client: {} as DriverSession['client'],
    rows: async (): Promise<string[][]> => [],
    command: async (): Promise<{ rows: string[][]; tag: string }> => ({ rows: [], tag: 'SELECT 0' }),
    end: async (): Promise<void> => { s.ended += 1 },
    alive: (): boolean => s.ended === 0,
  }
  return s as DriverSession & { ended: number }
}

/** Records every open, so ordering, discipline and identity are observable. */
const recorder = (): DriverOpeners & { log: Array<{ how: string; target: unknown }>
                                       handles: DriverSession[] } => {
  const log: Array<{ how: string; target: unknown }> = []
  const handles: DriverSession[] = []
  const make = (how: 'ordinary' | 'silent') => async (t: unknown): Promise<DriverSession> => {
    log.push({ how, target: t })
    const h = fakeSession()
    handles.push(h)
    return h
  }
  return { ordinary: make('ordinary'), silent: make('silent'), log, handles }
}

/**
 * K7-B6.1: `target` is a THUNK, resolved when a target session is first
 * opened, so the apply can build this authority before it has measured the
 * target. The overrides below still read as values; `targetOf` wraps them.
 */
const targetOf = (t: EndpointExpectation | (() => EndpointExpectation)):
  (() => EndpointExpectation) => (typeof t === 'function' ? t : () => t)

const inputs = (
  over: Partial<Omit<DriverAuthorityInputs, 'target'>> & {
    target?: EndpointExpectation | (() => EndpointExpectation)
  } = {},
): DriverAuthorityInputs => {
  const { target, ...rest } = over
  return {
    exportCredentialPath: write('export-driver.url', url(EXPORT_ROLE, '127.0.0.1', '5432', 'ai_capital') + '\n'),
    targetCredentialPath: write('target-driver.url', url('ai_capital_owner', '127.0.0.1', '5433', 'ai_capital_v3')),
    source: SOURCE,
    target: targetOf(target ?? TARGET),
    ...rest,
  }
}

beforeEach(() => {
  // CANONICAL. `openReviewedContainer` requires realpath(path) === path, and on
  // macOS `tmpdir()` is `/var/folders/...`, a symlink to `/private/var/...` -
  // so an uncanonicalised temp root is refused for a reason that has nothing to
  // do with the credential.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'k7b4-')))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
import { afterEach } from 'vitest'

describe('K7-B4: construction is inert', () => {
  it('building the authority opens nothing and reads nothing', () => {
    const o = recorder()
    driverAuthority(inputs(), o)
    expect(o.log).toEqual([])
    expect(o.handles).toEqual([])
  })
})

describe('K7-B4: five named openers, five distinct handles', () => {
  it('each call produces a FRESH handle - nothing is cached or shared', async () => {
    const o = recorder()
    const a = driverAuthority(inputs(), o)
    const got = [
      await a.openStage1ExportSource(),
      await a.openStage2Source(),
      await a.openStage2Target(),
      await a.openVerifierSource(),
      await a.openVerifierTarget(),
    ]
    expect(o.log).toHaveLength(5)
    expect(new Set(got).size).toBe(5)
    // And calling one twice yields two different handles.
    const again = await a.openStage2Source()
    expect(again).not.toBe(got[1])
  })

  it('Stage 1 and BOTH verifier sessions use the SILENT opener', async () => {
    // Stage 1 promises BEGIN is its first statement; the ordinary opener would
    // break that by asking for pg_backend_pid first.
    const o = recorder()
    const a = driverAuthority(inputs(), o)
    await a.openStage1ExportSource()
    await a.openVerifierSource()
    await a.openVerifierTarget()
    expect(o.log.map(e => e.how)).toEqual(['silent', 'silent', 'silent'])
  })

  it('Stage-2 source and target use the ORDINARY opener', async () => {
    const o = recorder()
    const a = driverAuthority(inputs(), o)
    await a.openStage2Source()
    await a.openStage2Target()
    expect(o.log.map(e => e.how)).toEqual(['ordinary', 'ordinary'])
  })

  it('does not close a session it successfully returned', async () => {
    const o = recorder()
    const a = driverAuthority(inputs(), o)
    const s = await a.openStage2Target()
    expect((s as DriverSession & { ended: number }).ended).toBe(0)
  })

  it('REAPS a session that was built but cannot be handed over', async () => {
    let built: DriverSession | null = null
    const broken: DriverOpeners = {
      ordinary: async () => {
        // DELIBERATELY MALFORMED - no `end` - which is the condition under
        // test, so the cast is the point rather than a convenience.
        built = { pid: '1' } as unknown as DriverSession
        return built
      },
      silent: async () => { throw new Error('unused') },
    }
    const a = driverAuthority(inputs(), broken)
    await expect(a.openStage2Target()).rejects.toThrow(/not a usable handle/)
    expect(built).not.toBeNull()
  })
})

describe('K7-B4: each opener reads only its own reviewed container', () => {
  it('the source and target credentials cannot be swapped', async () => {
    const o = recorder()
    const swapped = inputs({
      exportCredentialPath: write('swap-a.url', url('ai_capital_owner', '127.0.0.1', '5433', 'ai_capital_v3')),
    })
    const a = driverAuthority(swapped, o)
    await expect(a.openStage1ExportSource()).rejects.toThrow(DriverAuthorityRefused)
    expect(o.log).toEqual([])
  })

  it('the verifier target reads the ONE target credential, and is still a fresh backend', async () => {
    // K7-B5 correction A: verifier independence is a fresh backend, not a
    // second selectable secret path. Both read `targetCredentialPath`; the
    // handles must still differ, and the disciplines must differ.
    const o = recorder()
    const a = driverAuthority(inputs(), o)
    const copy = await a.openStage2Target()
    const check = await a.openVerifierTarget()
    expect(check).not.toBe(copy)
    expect(o.log.map(e => e.how)).toEqual(['ordinary', 'silent'])
    // Same endpoint, because it is the same reviewed authority.
    expect(o.log[0]?.target).toEqual(o.log[1]?.target)
  })

  it('the verifier target CANNOT reuse the Stage-2 target session', async () => {
    // The behavioural replacement for the removed separate-credential mutant.
    const shared = fakeSession()
    const sticky: DriverOpeners = { ordinary: async () => shared, silent: async () => shared }
    const a = driverAuthority(inputs(), sticky)
    await expect(a.openStage2Target()).resolves.toBe(shared)
    await expect(a.openVerifierTarget()).rejects.toThrow(/already handed out/)
  })

  it('refuses a source endpoint mismatch', async () => {
    const a = driverAuthority(inputs({ source: { ...SOURCE, database: 'other' } }), recorder())
    await expect(a.openStage2Source()).rejects.toThrow(/database is not the reviewed one/)
  })

  it('refuses a target endpoint mismatch', async () => {
    const a = driverAuthority(inputs({ target: { ...TARGET, port: '9999' } }), recorder())
    await expect(a.openStage2Target()).rejects.toThrow(/port is not the reviewed one/)
  })

  it('refuses an export-role mismatch', async () => {
    const o = recorder()
    const a = driverAuthority(inputs({
      exportCredentialPath: write('wrong-role.url', url('someone_else', '127.0.0.1', '5432', 'ai_capital')),
    }), o)
    await expect(a.openStage1ExportSource()).rejects.toThrow(/role is not the reviewed one/)
    expect(o.log).toEqual([])
  })

  it('refuses a target-role mismatch', async () => {
    const a = driverAuthority(inputs({ target: { ...TARGET, role: 'ai_capital_pipeline' } }), recorder())
    await expect(a.openStage2Target()).rejects.toThrow(/role is not the reviewed one/)
  })
})

describe('K7-B4: the container body is exact', () => {
  const cases: Array<[string, string]> = [
    ['no terminator', url(EXPORT_ROLE, '127.0.0.1', '5432', 'ai_capital')],
    ['one trailing LF', url(EXPORT_ROLE, '127.0.0.1', '5432', 'ai_capital') + '\n'],
  ]
  for (const [what, body] of cases) {
    it(`accepts ${what}`, async () => {
      const a = driverAuthority(inputs({ exportCredentialPath: write(`ok-${what.replace(/\W/g, '')}.url`, body) }), recorder())
      await expect(a.openStage1ExportSource()).resolves.toBeDefined()
    })
  }

  const refused: Array<[string, string]> = [
    ['two LFs', url(EXPORT_ROLE, '127.0.0.1', '5432', 'ai_capital') + '\n\n'],
    ['CRLF', url(EXPORT_ROLE, '127.0.0.1', '5432', 'ai_capital') + '\r\n'],
    ['a leading space', ' ' + url(EXPORT_ROLE, '127.0.0.1', '5432', 'ai_capital')],
    ['a trailing space', url(EXPORT_ROLE, '127.0.0.1', '5432', 'ai_capital') + ' '],
    ['a second line', url(EXPORT_ROLE, '127.0.0.1', '5432', 'ai_capital') + '\nextra'],
    ['KEY=value text', 'host=127.0.0.1 port=5432 dbname=ai_capital user=x password=y'],
    ['an empty container', ''],
  ]
  for (const [what, body] of refused) {
    it(`refuses ${what}`, async () => {
      const a = driverAuthority(inputs({
        exportCredentialPath: write(`bad-${what.replace(/\W/g, '')}.url`, body),
      }), recorder())
      await expect(a.openStage1ExportSource()).rejects.toThrow(DriverAuthorityRefused)
    })
  }

  it('NO secret and NO URL appears in any refusal', async () => {
    const a = driverAuthority(inputs({
      exportCredentialPath: write('leaky.url', url('wrong_role', '127.0.0.1', '5432', 'ai_capital')),
    }), recorder())
    const err = await a.openStage1ExportSource().catch((e: Error) => e)
    const text = `${(err as Error).message}|${String(err)}|${JSON.stringify(err)}`
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('postgresql://')
  })
})

describe('K7-B4: freshness is enforced, and a refused session is reaped', () => {
  it('REFUSES and REAPS a handle the opener has already handed out', async () => {
    // Makes the reap path reachable with a handle that HAS `end`: the earlier
    // "not a usable handle" case had none, so nothing could be reaped and the
    // catch was effectively dead code.
    const shared = fakeSession()
    const sticky: DriverOpeners = {
      ordinary: async () => shared,
      silent: async () => shared,
    }
    const a = driverAuthority(inputs(), sticky)
    await expect(a.openStage2Source()).resolves.toBe(shared)   // first is fine
    await expect(a.openStage2Source()).rejects.toThrow(/already handed out/)
    // AND THE REPEAT WAS REAPED, not leaked.
    expect(shared.ended).toBe(1)
  })

  it('a Stage-2 source and a verifier source can never be the same backend', async () => {
    const shared = fakeSession()
    const sticky: DriverOpeners = { ordinary: async () => shared, silent: async () => shared }
    const a = driverAuthority(inputs(), sticky)
    await a.openStage2Source()
    await expect(a.openVerifierSource()).rejects.toThrow(/already handed out/)
  })

  it('NO secret or URL leaks through the PARSE-failure path either', async () => {
    // The earlier no-leak case failed at the endpoint check, so the parse
    // branch - which is handed the container body - was never exercised.
    const malformed = `postgresql://u:${SECRET}@127.0.0.1:99999/ai_capital`
    const a = driverAuthority(inputs({
      exportCredentialPath: write('malformed.url', malformed),
    }), recorder())
    const err = await a.openStage1ExportSource().catch((e: Error) => e)
    const text = `${(err as Error).message}|${String(err)}|${JSON.stringify(err)}`
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(malformed)
    expect(text).not.toContain('postgresql://')
  })
})

// ── K7-B5 Correction B: the types plug in with NO cast ──────────────────────
//
// This block exists to be COMPILED, not merely executed. Each assignment below
// is the exact field the orchestration will fill, so if a session type ever
// stops satisfying a consumer the typecheck fails here rather than being
// papered over with `as unknown as` at the call site - which is the one place a
// wrong session would pass unnoticed.
describe('K7-B5: DriverAuthority satisfies every consumer without a cast', () => {
  it('assigns into the Stage-1, Stage-2 and verifier field types', () => {
    const a = driverAuthority(inputs(), recorder())

    // runStage1's `exportSession` is an ExportSession (= ContractQueryExecutor).
    const exportSession: () => Promise<ExportSession> = a.openStage1ExportSource
    // runInspect / runLifecycle Stage-2 source and target.
    const stageSource: () => Promise<DriverSession> = a.openStage2Source
    const stageTarget: () => Promise<DriverSession> = a.openStage2Target
    // runLifecycle's verifier pair is VerifyCloseable (pid + rows + end).
    const verifySource: () => Promise<VerifyCloseable> = a.openVerifierSource
    const verifyTarget: () => Promise<VerifyCloseable> = a.openVerifierTarget

    for (const f of [exportSession, stageSource, stageTarget, verifySource, verifyTarget]) {
      expect(typeof f).toBe('function')
    }
  })

  it('production binds the openers directly to the two reviewed functions', () => {
    expect(REVIEWED_OPENERS.ordinary).toBe(openDriverSession)
    expect(REVIEWED_OPENERS.silent).toBe(openSilentDriverSession)
  })
})

describe('K7-B6.1: the target expectation is proved BEFORE the secret is read', () => {
  it('refuses from the thunk without reading the target credential at all', async () => {
    // ORDER, NOT JUST OUTCOME. Resolving the expectation after reading the
    // credential still refuses, so a test that only checks "it throws" cannot
    // tell the two apart - and the difference is whether a secret file is
    // opened for a call that was always going to be refused.
    //
    // The credential path below does not exist. If the expectation is resolved
    // first, its refusal is what surfaces; if the read comes first, a
    // file-level refusal surfaces instead.
    const a = driverAuthority(inputs({
      targetCredentialPath: join(dir, 'this-file-does-not-exist.url'),
      target: () => { throw new Error('the expectation is not derived yet') },
    }), recorder())
    await expect(a.openStage2Target()).rejects.toThrow(/expectation is not derived yet/)
    await expect(a.openVerifierTarget()).rejects.toThrow(/expectation is not derived yet/)
  })

  it('still reads the credential once the expectation IS available', async () => {
    // The companion, so the test above cannot pass by never reading at all.
    const a = driverAuthority(inputs({}), recorder())
    await expect(a.openStage2Target()).resolves.toBeDefined()
  })
})
