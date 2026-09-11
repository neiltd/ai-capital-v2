/**
 * Collector contract — the seams, the lifecycle, the exit codes, the artifact.
 *
 * NO TEST HERE OPENS A DATABASE CONNECTION. In-process tests hand
 * `runInventory` a fake client; the child-process tests either refuse before a
 * client exists or aim at a Unix socket directory that cannot exist, so the
 * failure is `ENOENT` from the filesystem and no server is ever contacted.
 *
 * Four families of assertion, each load-bearing for a different reason:
 *
 *   REFUSALS BEFORE CONSTRUCTION — checked by counting factory calls, not by
 *   reading a message, because the property that matters is "nothing could have
 *   reached the network" and only the counter witnesses it.
 *
 *   THE SESSION IS PROVED, NOT ASSUMED — read-only, database, `current_user`
 *   and `session_user` each get their own test, because each fails
 *   independently and each failure means something different.
 *
 *   ONE CLEANUP PATH — every connected path attempts exactly one ROLLBACK and
 *   exactly one `end()`, counted before the await so a rejection still counts.
 *
 *   THE EXIT CODE IS PART OF THE INTERFACE — exercised against the REAL
 *   entrypoint in a child process, because a scheduled evidence run is
 *   triaged by its exit status and nothing else.
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COMPLETE_MESSAGE,
  defaultReadRepositoryHead,
  EXIT_COMPLETE,
  EXIT_FAILURE,
  EXIT_REFUSED,
  exitCodeFor,
  FORBIDDEN_CREDENTIAL_VARIABLES,
  InsufficientInspectionAuthority,
  InventoryRefusal,
  isDirectEntrypoint,
  parseArguments,
  runInventory,
  SessionCleanupError,
  UnsafeSessionError,
} from '../bin/db-inventory.js'
import type { ArtifactFs, InventoryClient } from '../bin/db-inventory.js'
import {
  CURRENT_V17_MANIFEST,
  INVENTORY_QUERIES,
  PROBE_QUERIES,
  SERVER_BINDING_QUERY,
  SESSION_IDENTITY_QUERY,
} from '../src/inventory-queries.js'
import type { ServerBindingRow, SessionIdentityRow } from '../src/inventory-queries.js'

const CREDENTIAL = 'VERIFY_INVENTORY_DATABASE_URL'
const URL_VALUE = 'postgres://ai_capital_migrator@localhost:5432/ai_capital'
const BEGIN = 'BEGIN TRANSACTION READ ONLY'
const HEAD = '2b6658a370dc4e65916cbbd2ca1f0ce978181d1c'

const SESSION: SessionIdentityRow = {
  current_database: 'ai_capital',
  current_user: 'ai_capital_migrator',
  session_user: 'ai_capital_migrator',
  transaction_read_only: 'on',
  server_version: '16.4',
  server_version_num: '160004',
}

const SERVER: ServerBindingRow = {
  database_name: 'ai_capital', database_oid: '16401', database_owner: 'thanapold',
  server_version: '16.4', server_version_num: '160004',
  postmaster_start_time: '2026-09-01 03:14:15+00',
  server_port: '5432', cluster_name: '', server_address: null, socket_directories: '/tmp',
}

interface FakeOptions {
  session?: Partial<SessionIdentityRow>
  probeObserved?: Record<string, string | null>
  probeThrows?: string
  probeNoRow?: string
  failOn?: string
  failRollback?: boolean
  failEnd?: boolean
  failConnect?: boolean
  /** Extra rows for a real inventory section, merged into the fixtures. */
  extraRows?: Record<string, unknown[]>
}

interface FakeState {
  statements: string[]
  connects: number
  rollbacks: number
  ends: number
  constructions: number
}

function makeFake(options: FakeOptions = {}) {
  const state: FakeState = { statements: [], connects: 0, rollbacks: 0, ends: 0, constructions: 0 }

  const client: InventoryClient = {
    connect: async () => {
      state.connects += 1
      if (options.failConnect) throw new Error('the fake connection was refused')
    },
    end: async () => {
      state.ends += 1
      if (options.failEnd) throw new Error('the fake connection refused to close')
    },
    query: async (sql: string) => {
      state.statements.push(sql)
      if (sql === 'ROLLBACK') {
        state.rollbacks += 1
        if (options.failRollback) throw new Error('the fake rollback failed')
        return { rows: [] }
      }
      if (sql === SESSION_IDENTITY_QUERY.sql) return { rows: [{ ...SESSION, ...options.session }] }
      if (sql === SERVER_BINDING_QUERY.sql) return { rows: [SERVER] }
      const probe = PROBE_QUERIES.find(p => p.sql === sql)
      if (probe) {
        if (options.probeThrows === probe.id) throw new Error('permission denied for relation')
        if (options.probeNoRow === probe.id) return { rows: [] }
        const overrides = options.probeObserved ?? {}
        const observed = probe.id in overrides ? overrides[probe.id] : 'true'
        return { rows: [{ observed, subject: 'ai_capital_owner', object_description: 'table desk.agent_runs' }] }
      }
      const query = INVENTORY_QUERIES.find(q => q.sql === sql)
      if (query) {
        if (options.failOn === query.id) throw new Error('the fake refused this read')
        return { rows: options.extraRows?.[query.id] ?? fixtureRows(query.id) }
      }
      if (sql === BEGIN) return { rows: [] }
      throw new Error(`the fake received an unexpected statement: ${sql}`)
    },
  }

  const createClient = () => { state.constructions += 1; return client }
  return { state, createClient }
}

function fixtureRows(id: string): unknown[] {
  if (id === 'schema_migrations') {
    return CURRENT_V17_MANIFEST.map(m => ({
      filename: m.filename, sha256: m.sha256, applied_at: '2026-09-09 12:00:00+00',
    }))
  }
  return []
}

/** A private (0700) scratch directory — the mode the collector demands. */
function scratch(mode = 0o700): string {
  const dir = mkdtempSync(join(tmpdir(), 'db-inventory-test-'))
  chmodSync(dir, mode)
  return dir
}

const ENV = { [CREDENTIAL]: URL_VALUE }
const CLOCK = () => new Date('2026-09-10T00:00:00.000Z')
const READ_HEAD = () => HEAD

function baseDeps(fake: ReturnType<typeof makeFake>, over: Record<string, unknown> = {}) {
  return { env: ENV, createClient: fake.createClient, now: CLOCK, readRepositoryHead: READ_HEAD, ...over }
}

async function runOk(options: FakeOptions = {}, depsOver: Record<string, unknown> = {}) {
  const dir = scratch()
  const output = join(dir, 'inventory.json')
  const fake = makeFake(options)
  const outcome = await runInventory(
    ['--mode', 'inventory', '--output', output, '--run-id', 'fixture-run'],
    baseDeps(fake, depsOver),
  )
  return { dir, output, fake, outcome }
}

function argv(dir: string, extra: string[] = []): string[] {
  return ['--mode', 'inventory', '--output', join(dir, 'out.json'), '--run-id', 'fixture-run', ...extra]
}

// ── Refusals, all before a client exists ────────────────────────────────────

describe('invocation refusals happen before any client is constructed', () => {
  const cases: [string, (dir: string) => string[], RegExp][] = [
    ['a missing --mode',    d => ['--output', join(d, 'x.json'), '--run-id', 'r'],       /--mode is required/],
    ['an unknown --mode',   d => ['--mode', 'enforce', '--output', join(d, 'x.json'), '--run-id', 'r'], /not implemented/],
    ['a missing --output',  () => ['--mode', 'inventory', '--run-id', 'r'],              /--output is required/],
    ['a relative --output', () => ['--mode', 'inventory', '--output', 'out.json', '--run-id', 'r'], /is relative/],
    ['a missing --run-id',  d => ['--mode', 'inventory', '--output', join(d, 'x.json')], /--run-id is required/],
    ['an unknown argument', d => [...argv(d), '--force'],                                /Unknown argument/],
  ]

  for (const [label, build, pattern] of cases) {
    it(`refuses ${label}`, async () => {
      const dir = scratch()
      const fake = makeFake()
      const error = await runInventory(build(dir), baseDeps(fake)).catch((e: Error) => e)
      expect(String(error)).toMatch(pattern)
      expect(error).toBeInstanceOf(InventoryRefusal)
      expect(exitCodeFor(error)).toBe(EXIT_REFUSED)
      expect(fake.state.constructions).toBe(0)
      expect(fake.state.connects).toBe(0)
    })
  }

  it('the run id is never generated — it is mandatory and operator-supplied', () => {
    expect(() => parseArguments(['--mode', 'inventory', '--output', '/tmp/x.json']))
      .toThrow(/never generated/)
    expect(parseArguments(['--mode', 'inventory', '--output', '/tmp/x.json', '--run-id', 'w-42']).runId)
      .toBe('w-42')
  })

  it('rejects a --run-id that is not a plain identifier', () => {
    // A run id reaches the artifact verbatim; a path-shaped one would read as a
    // traversal to anyone consuming the evidence downstream.
    for (const bad of ['a/../b', 'has space', 'semi;colon', '-leading-dash']) {
      expect(() => parseArguments(['--mode', 'inventory', '--output', '/tmp/x.json', '--run-id', bad]),
             `${bad} was accepted`).toThrow(/plain identifier/)
    }
  })

  it('refuses a missing credential, and names only the variable it reads', async () => {
    const dir = scratch()
    const fake = makeFake()
    await expect(runInventory(argv(dir), baseDeps(fake, { env: {} })))
      .rejects.toThrow(new RegExp(`${CREDENTIAL} is not set`))
    expect(fake.state.constructions).toBe(0)
  })

  it('ignores every generic database variable and still refuses', async () => {
    const dir = scratch()
    const fake = makeFake()
    const env: Record<string, string> = {}
    for (const name of FORBIDDEN_CREDENTIAL_VARIABLES) {
      env[name] = 'postgres://someone@localhost:5432/ai_capital'
    }
    await expect(runInventory(argv(dir), baseDeps(fake, { env })))
      .rejects.toThrow(new RegExp(`${CREDENTIAL} is not set`))
    expect(fake.state.constructions).toBe(0)
    expect(readdirSync(dir)).toEqual([])
  })

  it('never puts the credential in a message it raises', async () => {
    const fake = makeFake()
    const secret = 'postgres://ai_capital_migrator:s3cr3t@db.internal:5432/ai_capital'
    const error = await runInventory(
      ['--mode', 'inventory', '--output', 'relative.json', '--run-id', 'r'],
      baseDeps(fake, { env: { [CREDENTIAL]: secret } }),
    ).catch((e: Error) => e)
    expect(String(error)).not.toContain('s3cr3t')
    expect(String(error)).not.toContain(secret)
  })

  it('refuses an output directory that is not exactly 0700', async () => {
    for (const mode of [0o755, 0o750, 0o770, 0o701]) {
      const dir = scratch(mode)
      const fake = makeFake()
      const error = await runInventory(argv(dir), baseDeps(fake)).catch((e: Error) => e)
      expect(String(error), `mode ${mode.toString(8)} was accepted`).toMatch(/must land in a directory/)
      expect(exitCodeFor(error)).toBe(EXIT_REFUSED)
      expect(fake.state.constructions).toBe(0)
      chmodSync(dir, 0o700)
    }
  })

  it('refuses an output directory that does not exist', async () => {
    const fake = makeFake()
    await expect(runInventory(
      ['--mode', 'inventory', '--output', join(scratch(), 'missing', 'out.json'), '--run-id', 'r'],
      baseDeps(fake),
    )).rejects.toThrow(/does not exist/)
    expect(fake.state.constructions).toBe(0)
  })

  it('refuses to silently overwrite an existing artifact', async () => {
    const first = await runOk()
    const fake = makeFake()
    const error = await runInventory(
      ['--mode', 'inventory', '--output', first.output, '--run-id', 'second-run'],
      baseDeps(fake),
    ).catch((e: Error) => e)
    expect(String(error)).toMatch(/already exists/)
    expect(exitCodeFor(error)).toBe(EXIT_REFUSED)
    expect(fake.state.constructions).toBe(0)
    // The first artifact is untouched.
    expect(JSON.parse(readFileSync(first.output, 'utf-8')).binding.run_id).toBe('fixture-run')
  })
})

// ── The module is inert on import ───────────────────────────────────────────

describe('importing the module does nothing', () => {
  it('has an explicit direct-entrypoint guard', () => {
    const source = readFileSync(new URL('../bin/db-inventory.ts', import.meta.url), 'utf-8')
    expect(source).toContain('if (isDirectEntrypoint(process.argv[1], import.meta.url))')
    expect(source.match(/runInventory\(process\.argv/g) ?? []).toHaveLength(1)
  })

  it('does not consider itself the entrypoint when something else is', () => {
    expect(isDirectEntrypoint(undefined, import.meta.url)).toBe(false)
    expect(isDirectEntrypoint('/usr/local/bin/vitest', import.meta.url)).toBe(false)
  })
})

// ── Session safety, proved from inside the session ──────────────────────────

describe('session safety', () => {
  it('sends BEGIN TRANSACTION READ ONLY as the very first statement', async () => {
    const { fake } = await runOk()
    expect(fake.state.statements[0]).toBe(BEGIN)
    expect(fake.state.connects).toBe(1)
  })

  const unsafe: [string, Partial<SessionIdentityRow>, RegExp][] = [
    ['the session is not actually read-only', { transaction_read_only: 'off' }, /transaction_read_only=off/],
    ['connected to the wrong database', { current_database: 'ai_capital_test' }, /Connected to database "ai_capital_test"/],
    ['session_user is not the migrator', { session_user: 'thanapold', current_user: 'thanapold' }, /session_user is "thanapold"/],
    ['current_user differs — something assumed a role', { current_user: 'ai_capital_owner' }, /current_user is "ai_capital_owner"/],
  ]

  for (const [label, session, pattern] of unsafe) {
    it(`stops when ${label}, and refuses rather than breaks`, async () => {
      const dir = scratch()
      const fake = makeFake({ session })
      const error = await runInventory(argv(dir), baseDeps(fake)).catch((e: Error) => e)
      expect(String(error)).toMatch(pattern)
      expect(error).toBeInstanceOf(UnsafeSessionError)
      expect(exitCodeFor(error)).toBe(EXIT_REFUSED)
      expect(readdirSync(dir)).toEqual([])
      // Still exactly one cleanup, because the session was connected.
      expect(fake.state.rollbacks).toBe(1)
      expect(fake.state.ends).toBe(1)
    })
  }

  it('stops before any inventory query when the session is unsafe', async () => {
    const dir = scratch()
    const fake = makeFake({ session: { transaction_read_only: 'off' } })
    await runInventory(argv(dir), baseDeps(fake)).catch(() => undefined)
    for (const query of INVENTORY_QUERIES) {
      expect(fake.state.statements).not.toContain(query.sql)
    }
  })
})

// ── Capability probes fail closed ───────────────────────────────────────────

describe('cross-role inspection probes', () => {
  for (const probe of PROBE_QUERIES) {
    it(`fails closed when ${probe.id} is denied, before any inventory query`, async () => {
      const dir = scratch()
      const fake = makeFake({ probeThrows: probe.id })
      const error = await runInventory(argv(dir), baseDeps(fake)).catch((e: Error) => e)
      expect(String(error)).toContain('INVENTORY INCOMPLETE — INSUFFICIENT INSPECTION AUTHORITY')
      expect(error).toBeInstanceOf(InsufficientInspectionAuthority)
      expect(exitCodeFor(error)).toBe(EXIT_REFUSED)
      for (const query of INVENTORY_QUERIES) {
        expect(fake.state.statements, `${probe.id} denial did not stop collection`).not.toContain(query.sql)
      }
      expect(readdirSync(dir)).toEqual([])
    })

    it(`fails closed when ${probe.id} finds no non-self subject`, async () => {
      const dir = scratch()
      const fake = makeFake({ probeNoRow: probe.id })
      await expect(runInventory(argv(dir), baseDeps(fake)))
        .rejects.toThrow(/no non-self subject/)
      expect(readdirSync(dir)).toEqual([])
    })

    it(`fails closed when ${probe.id} returns something that is not a boolean`, async () => {
      const dir = scratch()
      const fake = makeFake({ probeObserved: { [probe.id]: null } })
      await expect(runInventory(argv(dir), baseDeps(fake)))
        .rejects.toThrow(/rather than a boolean/)
    })
  }

  it('accepts a truthful `false` — the value is not the claim, evaluability is', async () => {
    const { outcome } = await runOk({ probeObserved: { probe_pg_has_role: 'false' } })
    expect(outcome.message).toBe(COMPLETE_MESSAGE)
  })

  it('runs every probe before the first inventory query', async () => {
    const { fake } = await runOk()
    const firstInventory = fake.state.statements.findIndex(s => s === INVENTORY_QUERIES[0].sql)
    for (const probe of PROBE_QUERIES) {
      const at = fake.state.statements.indexOf(probe.sql)
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(firstInventory)
    }
  })
})

// ── Statement vocabulary ────────────────────────────────────────────────────

describe('statement vocabulary', () => {
  it('sends nothing but SELECT, one BEGIN READ ONLY and one ROLLBACK', async () => {
    const { fake } = await runOk()
    for (const sql of fake.state.statements) {
      const permitted = sql === BEGIN || sql === 'ROLLBACK' || /^SELECT\b/.test(sql)
      expect(permitted, `unexpected statement: ${sql}`).toBe(true)
    }
    expect(fake.state.statements.filter(s => s === BEGIN)).toHaveLength(1)
  })

  it('never issues SET ROLE, SET SESSION AUTHORIZATION, or any write', async () => {
    const { fake } = await runOk()
    const all = fake.state.statements.join('\n')
    expect(all).not.toMatch(/\bSET\s+ROLE\b/i)
    expect(all).not.toMatch(/\bSET\s+SESSION\s+AUTHORIZATION\b/i)
    expect(all).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bGRANT\b|\bREVOKE\b|\bALTER\b|\bCREATE\b|\bDROP\b|\bCOMMIT\b/i)
  })
})

// ── The one cleanup path ────────────────────────────────────────────────────

describe('session cleanup lifecycle', () => {
  it('attempts exactly one ROLLBACK and one end() on the success path', async () => {
    const { fake, outcome } = await runOk()
    expect(fake.state.rollbacks).toBe(1)
    expect(fake.state.ends).toBe(1)
    expect(outcome.rollbackAttempts).toBe(1)
    expect(outcome.endAttempts).toBe(1)
    expect(fake.state.statements.at(-1)).toBe('ROLLBACK')
  })

  it('attempts exactly one ROLLBACK and one end() when a read fails', async () => {
    const dir = scratch()
    const fake = makeFake({ failOn: 'relations' })
    await expect(runInventory(argv(dir), baseDeps(fake))).rejects.toThrow(/the fake refused this read/)
    expect(fake.state.rollbacks).toBe(1)
    expect(fake.state.ends).toBe(1)
  })

  it('a REJECTED rollback still attempts the close — the connection must not leak', async () => {
    const dir = scratch()
    const fake = makeFake({ failRollback: true })
    // Collection itself succeeded; the rollback is what failed.
    await expect(runInventory(argv(dir), baseDeps(fake))).rejects.toThrow(SessionCleanupError)
    expect(fake.state.rollbacks).toBe(1)
    expect(fake.state.ends, 'end() was skipped after the rollback rejected').toBe(1)
  })

  it('records the ROLLBACK attempt in the statement log even when it rejects', async () => {
    const dir = scratch()
    const fake = makeFake({ failRollback: true })
    const error = await runInventory(argv(dir), baseDeps(fake)).catch((e: Error) => e)
    expect(error).toBeInstanceOf(SessionCleanupError)
    expect(fake.state.statements.filter(s => s === 'ROLLBACK')).toHaveLength(1)
  })

  it('a rejected rollback after a successful collection publishes no artifact', async () => {
    const dir = scratch()
    const fake = makeFake({ failRollback: true })
    await expect(runInventory(argv(dir), baseDeps(fake))).rejects.toThrow(/did not close cleanly/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('a rejected end() after a successful collection publishes no artifact', async () => {
    const dir = scratch()
    const fake = makeFake({ failEnd: true })
    const error = await runInventory(argv(dir), baseDeps(fake)).catch((e: Error) => e)
    expect(error).toBeInstanceOf(SessionCleanupError)
    expect(String(error)).toContain('refused to close')
    expect(readdirSync(dir)).toEqual([])
    expect(exitCodeFor(error)).toBe(EXIT_FAILURE)
  })

  it('a primary error plus a rollback failure keeps the primary diagnosis', async () => {
    const dir = scratch()
    const fake = makeFake({ failOn: 'schemas', failRollback: true })
    const error = await runInventory(argv(dir), baseDeps(fake)).catch((e: Error) => e)
    expect(String(error)).toContain('the fake refused this read')
    expect(String(error)).toContain('ROLLBACK failed')
    expect(fake.state.ends).toBe(1)
  })

  it('a primary error plus an end failure keeps the primary diagnosis', async () => {
    const dir = scratch()
    const fake = makeFake({ failOn: 'schemas', failEnd: true })
    const error = await runInventory(argv(dir), baseDeps(fake)).catch((e: Error) => e)
    expect(String(error)).toContain('the fake refused this read')
    expect(String(error)).toContain('closing the connection failed')
  })

  it('a primary error plus BOTH cleanup failures reports all three', async () => {
    const dir = scratch()
    const fake = makeFake({ failOn: 'schemas', failRollback: true, failEnd: true })
    const error = await runInventory(argv(dir), baseDeps(fake)).catch((e: Error) => e)
    expect(String(error)).toContain('the fake refused this read')
    expect(String(error)).toContain('ROLLBACK failed')
    expect(String(error)).toContain('closing the connection failed')
    expect(fake.state.rollbacks).toBe(1)
    expect(fake.state.ends).toBe(1)
    expect(readdirSync(dir)).toEqual([])
  })

  it('a refusal keeps its exit code even when cleanup also fails', async () => {
    const dir = scratch()
    const fake = makeFake({ session: { transaction_read_only: 'off' }, failRollback: true, failEnd: true })
    const error = await runInventory(argv(dir), baseDeps(fake)).catch((e: Error) => e)
    // Cleanup noise must not reclassify a refusal (2) as a breakage (1).
    expect(exitCodeFor(error)).toBe(EXIT_REFUSED)
    expect(String(error)).toContain('cleanup also failed')
  })

  it('attempts no cleanup when the connection was never established', async () => {
    const dir = scratch()
    const fake = makeFake({ failConnect: true })
    await expect(runInventory(argv(dir), baseDeps(fake))).rejects.toThrow(/connection was refused/)
    expect(fake.state.rollbacks).toBe(0)
    expect(fake.state.ends).toBe(0)
  })
})

// ── Artifact publication ────────────────────────────────────────────────────

/** Wrap the real fs, failing exactly one named operation exactly once. */
function failingFs(real: ArtifactFs, operation: keyof ArtifactFs, when: (arg: unknown) => boolean = () => true): ArtifactFs {
  let fired = false
  return new Proxy(real, {
    get(target, prop: string) {
      const value = (target as unknown as Record<string, unknown>)[prop]
      if (prop !== operation) return value
      return (...args: unknown[]) => {
        if (!fired && when(args[0])) {
          fired = true
          throw new Error(`injected ${operation} failure`)
        }
        return (value as (...a: unknown[]) => unknown)(...args)
      }
    },
  }) as ArtifactFs
}

/**
 * The real filesystem, expressed through the injectable interface.
 *
 * It deliberately also exposes `renameSync`, which the collector no longer
 * uses: the mutation control that restores the raceable check-then-rename
 * publication has to be able to compile and run against a real filesystem
 * WITHOUT editing this file, and a mutant that could only be proved by also
 * rewriting the test proves nothing. The cast is what admits the extra member.
 */
async function realFs(): Promise<ArtifactFs> {
  const nodeFs = await import('node:fs')
  return {
    statSync: (p: string) => nodeFs.statSync(p),
    existsSync: (p: string) => nodeFs.existsSync(p),
    openSync: (p: string, f: string, m?: number) => nodeFs.openSync(p, f, m),
    writeSync: (fd: number, b: Uint8Array, o: number, l: number) => nodeFs.writeSync(fd, b, o, l),
    fsyncSync: (fd: number) => nodeFs.fsyncSync(fd),
    closeSync: (fd: number) => nodeFs.closeSync(fd),
    linkSync: (a: string, b: string) => nodeFs.linkSync(a, b),
    unlinkSync: (p: string) => nodeFs.unlinkSync(p),
    renameSync: (a: string, b: string) => nodeFs.renameSync(a, b),
    chmodSync: (p: string, m: number) => nodeFs.chmodSync(p, m),
    rmSync: (p: string, o: { force: boolean }) => nodeFs.rmSync(p, o),
  } as ArtifactFs
}

describe('artifact publication', () => {
  it('writes 0600 into a 0700 directory and leaves no temporary residue', async () => {
    const { dir, output } = await runOk()
    expect(statSync(output).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['inventory.json'])
    // link + unlink leaves the artifact with exactly one name.
    expect(statSync(output).nlink).toBe(1)
  })

  it('creates the temporary file exclusively, in the same directory', async () => {
    const seen: string[] = []
    const base = await realFs()
    const spy: ArtifactFs = { ...base, openSync: (p, f, m) => { seen.push(`${p}|${f}`); return base.openSync(p, f, m) } }
    const { dir, output } = await runOk({}, { fs: spy })
    const temporary = seen.find(entry => entry.includes('.tmp'))
    expect(temporary, 'no temporary file was used').toBeDefined()
    expect(temporary).toContain('|wx')                                // O_EXCL
    expect(dirname((temporary as string).split('|')[0])).toBe(dir)    // same filesystem
    expect(seen.filter(entry => entry === `${dir}|r`).length,
           'the directory was not fsynced twice').toBe(2)
    expect(existsSync(output)).toBe(true)
  })

  it('runs the exact durability sequence: fsync file, link, fsync dir, unlink, fsync dir', async () => {
    const order: string[] = []
    const base = await realFs()
    const spy: ArtifactFs = {
      ...base,
      fsyncSync: fd => { order.push('fsync'); return base.fsyncSync(fd) },
      linkSync: (a, b) => { order.push('link'); return base.linkSync(a, b) },
      unlinkSync: p => { order.push('unlink'); return base.unlinkSync(p) },
    }
    await runOk({}, { fs: spy })
    // Contents durable BEFORE any name points at them; the name durable before
    // the temporary name is dropped; the drop durable too.
    expect(order).toEqual(['fsync', 'link', 'fsync', 'unlink', 'fsync'])
  })

  it('publishes with an atomic create-if-absent link, never a replacing rename', async () => {
    const source = readFileSync(new URL('../bin/db-inventory.ts', import.meta.url), 'utf-8')
    const publish = source.slice(source.indexOf('function publishArtifact'))
    expect(publish).toContain('fs.linkSync(temporary, output)')
    expect(publish, 'rename(2) replaces its destination unconditionally').not.toContain('renameSync')
  })

  // ── Short writes ─────────────────────────────────────────────────────────

  it('loops until every byte is written, and publishes the exact expected bytes', async () => {
    const base = await realFs()
    let calls = 0
    const chunked: ArtifactFs = {
      ...base,
      // write(2) may do less than asked and still report success.
      writeSync: (fd, buffer, offset, length) => {
        calls += 1
        return base.writeSync(fd, buffer, offset, Math.min(7, length))
      },
    }
    const chunkedRun = await runOk({}, { fs: chunked })
    const wholeRun = await runOk()
    expect(calls, 'the payload was written in one call, so the loop was untested')
      .toBeGreaterThan(10)
    expect(readFileSync(chunkedRun.output)).toEqual(readFileSync(wholeRun.output))
    expect(readdirSync(chunkedRun.dir)).toEqual(['inventory.json'])
  })

  it('resumes at BYTE offsets, so a genuinely multibyte payload is not spliced', async () => {
    // A REAL multibyte fact, carried through an existing textual field. Thai is
    // three UTF-8 bytes per character and the em dash is three; the row below
    // has far more bytes than JavaScript string units, so a loop that mistook
    // the byte count returned by write(2) for a character index would resume
    // inside a character and splice the file.
    const THAI_POLICY = 'นโยบายทดสอบ — ห้ามแก้ไข'
    const THAI_EXPRESSION = "(owner = current_user) -- ผู้ถือครองเท่านั้น — immutable"
    expect(Buffer.byteLength(THAI_POLICY, 'utf-8')).toBeGreaterThan(THAI_POLICY.length)

    const extraRows = {
      policies: [{
        schema_name: 'portfolio', table_name: 'positions', policy_name: THAI_POLICY,
        permissive: 'PERMISSIVE', policy_roles: 'ai_capital_agent', command: 'r',
        using_expression: THAI_EXPRESSION, check_expression: null,
      }],
    }

    const base = await realFs()
    let calls = 0
    // Seven-byte writes cannot align with three-byte characters: boundaries
    // land inside them, which is precisely the case being proved safe.
    const chunked: ArtifactFs = {
      ...base,
      writeSync: (fd, buffer, offset, length) =>
        { calls += 1; return base.writeSync(fd, buffer, offset, Math.min(7, length)) },
    }
    const chunkedRun = await runOk({ extraRows }, { fs: chunked })
    const wholeRun = await runOk({ extraRows })

    const bytes = readFileSync(chunkedRun.output)
    expect(calls).toBeGreaterThan(10)

    // The artifact really does carry multibyte data.
    const text = bytes.toString('utf-8')
    expect(bytes.length).toBeGreaterThan(text.length)
    expect(text).toContain(THAI_POLICY)

    // At least one 7-byte write boundary fell INSIDE a multibyte character —
    // a UTF-8 continuation byte (10xxxxxx) sitting at a multiple of 7.
    let split = 0
    for (let i = 7; i < bytes.length; i += 7) {
      if ((bytes[i] & 0xc0) === 0x80) split += 1
    }
    expect(split, 'no chunk boundary landed inside a character; the test is vacuous')
      .toBeGreaterThan(0)

    // Byte-for-byte identical to the same facts written in one go.
    expect(bytes).toEqual(readFileSync(wholeRun.output))

    // And the exact Unicode value survived the round trip.
    const doc = JSON.parse(text) as { objects: { policies: Record<string, string>[] } }
    expect(doc.objects.policies[0].policy_name).toBe(THAI_POLICY)
    expect(doc.objects.policies[0].using_expression).toBe(THAI_EXPRESSION)
    expect(Buffer.from(text, 'utf-8')).toEqual(bytes)
  })

  const badCounts: [string, number][] = [
    ['zero progress', 0],
    ['a negative count', -1],
    ['a count larger than what remained', 1_000_000_000],
    ['a non-integer count', 3.5],
  ]

  for (const [label, count] of badCounts) {
    it(`fails closed on ${label}, leaving the directory empty`, async () => {
      const dir = scratch()
      const base = await realFs()
      const fake = makeFake()
      const broken: ArtifactFs = { ...base, writeSync: () => count }
      await expect(runInventory(argv(dir), baseDeps(fake, { fs: broken })))
        .rejects.toThrow(/possibly truncated artifact/)
      expect(readdirSync(dir), `${label} left residue`).toEqual([])
    })
  }

  // ── Concurrent publication ───────────────────────────────────────────────

  it('consults no existence check between preparing the file and publishing it', async () => {
    // THE WINDOW ITSELF, ASSERTED AWAY. A check-then-act publication is unsafe
    // because something can appear between the check and the act; the fix is
    // not a better check but an act that cannot clobber. This asserts there is
    // no existence check left in that gap at all — the publishing call is
    // `link`, whose create-if-absent is decided by the kernel, atomically.
    //
    // Note what this does NOT claim to be: an in-process behavioural race.
    // `publishArtifact` is entirely synchronous, so within one process a
    // check-then-rename never actually interleaves — only separate processes
    // can lose that race, and this suite may not start a second collector
    // against a database. The order of filesystem calls is the observable that
    // does distinguish the two designs from inside one process.
    const calls: string[] = []
    const base = await realFs()
    const spy: ArtifactFs = {
      ...base,
      chmodSync: (path, mode) => { calls.push('chmod'); return base.chmodSync(path, mode) },
      existsSync: path => { calls.push(`exists:${path}`); return base.existsSync(path) },
      linkSync: (from, to) => { calls.push('link'); return base.linkSync(from, to) },
    }
    await runOk({}, { fs: spy })
    const preparedAt = calls.lastIndexOf('chmod')
    const publishedAt = calls.indexOf('link')
    expect(preparedAt, 'the temporary file was never prepared').toBeGreaterThan(-1)
    expect(publishedAt, 'publication did not go through an atomic create-if-absent link')
      .toBeGreaterThan(preparedAt)
    expect(calls.slice(preparedAt, publishedAt).filter(c => c.startsWith('exists')),
           'an existence check sits in the check-to-publish window').toEqual([])
  })

  it('leaves a concurrently created destination byte-for-byte untouched, and refuses', async () => {
    const dir = scratch()
    const output = join(dir, 'out.json')
    const winner = Buffer.from('{"winner":"another collector"}\n')
    const base = await realFs()
    const fake = makeFake()
    let planted = false
    const racing: ArtifactFs = {
      ...base,
      // THE TOCTOU ITSELF. Every `existsSync(output)` answers truthfully for the
      // instant it was asked — and the destination appears the moment after.
      // Any implementation that decides "safe to publish" from that answer and
      // then replaces the destination destroys the winner; an implementation
      // that publishes with an atomic create-if-absent cannot, because the
      // absence is never something it has to remember.
      existsSync: (path: string) => {
        const answer = base.existsSync(path)
        if (path === output && !planted) {
          planted = true
          writeFileSync(output, winner, { mode: 0o600 })
        }
        return answer
      },
    }
    const error = await runInventory(argv(dir), baseDeps(fake, { fs: racing })).catch((e: Error) => e)
    expect(planted, 'the race window was never entered').toBe(true)
    expect(String(error)).toMatch(/already exists/)
    expect(exitCodeFor(error), 'the loser must classify non-zero').toBe(EXIT_REFUSED)
    expect(exitCodeFor(error)).not.toBe(EXIT_COMPLETE)
    expect(readFileSync(output), "the winner's artifact was modified").toEqual(winner)
    expect(readdirSync(dir), 'the loser left temporary residue').toEqual(['out.json'])
  })

  it('lets exactly one of two real concurrent collectors publish, on one real directory', async () => {
    const dir = scratch()
    const output = join(dir, 'out.json')
    const runners = ['run-a', 'run-b'].map(id => {
      const fake = makeFake()
      return runInventory(['--mode', 'inventory', '--output', output, '--run-id', id], baseDeps(fake))
    })
    const settled = await Promise.allSettled(runners)
    const fulfilled = settled.filter(r => r.status === 'fulfilled')
    const rejected = settled.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(exitCodeFor((rejected[0] as PromiseRejectedResult).reason)).not.toBe(EXIT_COMPLETE)
    // One artifact, no residue, and it belongs to the collector that won.
    expect(readdirSync(dir)).toEqual(['out.json'])
    const published = JSON.parse(readFileSync(output, 'utf-8')) as { binding: { run_id: string } }
    expect(published.binding.run_id)
      .toBe((fulfilled[0] as PromiseFulfilledResult<{ runId: string }>).value.runId)
  })

  // ── Publication failure cleanup ──────────────────────────────────────────

  const publicationFailures: [string, keyof ArtifactFs][] = [
    ['the exclusive create fails', 'openSync'],
    ['the write fails', 'writeSync'],
    ['the file fsync fails', 'fsyncSync'],
    ['the chmod fails', 'chmodSync'],
    ['the link fails', 'linkSync'],
  ]

  for (const [label, operation] of publicationFailures) {
    it(`leaves no artifact and no residue when ${label}`, async () => {
      const dir = scratch()
      const base = await realFs()
      const fake = makeFake()
      const fs = failingFs(base, operation, arg => typeof arg !== 'string' || !arg.endsWith(dir))
      await expect(runInventory(argv(dir), baseDeps(fake, { fs })))
        .rejects.toThrow(new RegExp(`injected ${operation} failure`))
      expect(readdirSync(dir), `${label} left residue`).toEqual([])
    })
  }

  it('removes its own artifact when the directory fsync fails after the link', async () => {
    const dir = scratch()
    const base = await realFs()
    const fake = makeFake()
    let fsyncs = 0
    const fs: ArtifactFs = {
      ...base,
      fsyncSync: fd => {
        fsyncs += 1
        if (fsyncs === 2) throw new Error('injected directory fsync failure')
        return base.fsyncSync(fd)
      },
    }
    await expect(runInventory(argv(dir), baseDeps(fake, { fs })))
      .rejects.toThrow(/injected directory fsync failure/)
    // The link had already happened — but THIS call created it, so removing it
    // is removing our own incomplete publication, never somebody else's.
    expect(readdirSync(dir)).toEqual([])
  })

  it('removes both names when dropping the temporary fails after the link', async () => {
    const dir = scratch()
    const base = await realFs()
    const fake = makeFake()
    const fs: ArtifactFs = { ...base, unlinkSync: () => { throw new Error('injected unlink failure') } }
    await expect(runInventory(argv(dir), baseDeps(fake, { fs })))
      .rejects.toThrow(/injected unlink failure/)
    expect(readdirSync(dir)).toEqual([])
  })

  // ── Content ──────────────────────────────────────────────────────────────

  it('is byte-identical across two runs over the same facts', async () => {
    const first = await runOk()
    const second = await runOk()
    expect(readFileSync(first.output)).toEqual(readFileSync(second.output))
  })

  it('is marked complete and carries exit status 0 only once published', async () => {
    const { output } = await runOk()
    const doc = JSON.parse(readFileSync(output, 'utf-8')) as
      { complete: boolean; mode: string; binding: Record<string, unknown> }
    expect(doc.complete).toBe(true)
    expect(doc.mode).toBe('inventory')
    expect(doc.binding.exit_status).toBe(EXIT_COMPLETE)
  })

  it('binds the artifact to the run, the database, the instance and the source', async () => {
    const { output } = await runOk()
    const binding = (JSON.parse(readFileSync(output, 'utf-8')) as
      { binding: Record<string, unknown> }).binding
    expect(binding.run_id).toBe('fixture-run')
    expect(binding.database_name).toBe('ai_capital')
    expect(binding.database_oid).toBe('16401')
    expect(binding.repository_head).toBe(HEAD)
    expect(binding.collected_at_utc).toBe('2026-09-10T00:00:00.000Z')
    expect(binding.postmaster_start_time).toBe('2026-09-01 03:14:15+00')
    expect(binding.server_port).toBe('5432')
    expect(binding.cluster_name).toBe('')
    expect(binding.manifest_recognition).toBe('CURRENT_V17')
    expect(binding.endpoint).toEqual({
      host: null, socket_directories: '/tmp', port: '5432', database: 'ai_capital',
    })
  })

  it('fails, and publishes nothing, when the repository head cannot be captured', async () => {
    const dir = scratch()
    const fake = makeFake()
    const error = await runInventory(argv(dir), baseDeps(fake, {
      readRepositoryHead: () => { throw new Error('no .git found') },
    })).catch((e: Error) => e)
    expect(String(error)).toContain('no .git found')
    expect(exitCodeFor(error)).toBe(EXIT_FAILURE)
    expect(fake.state.constructions, 'the head is captured before any client exists').toBe(0)
    expect(readdirSync(dir)).toEqual([])
  })

  it('does not exist at all when a query fails', async () => {
    const dir = scratch()
    const fake = makeFake({ failOn: 'roles' })
    await expect(runInventory(argv(dir), baseDeps(fake))).rejects.toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it('never contains the credential', async () => {
    const { output } = await runOk()
    const text = readFileSync(output, 'utf-8')
    expect(text).not.toContain(URL_VALUE)
    expect(text).not.toContain('postgres://')
    expect(text).not.toMatch(/password/i)
  })

  it('contains no PASS, no FAIL and no policy verdict', async () => {
    const { output } = await runOk()
    expect(readFileSync(output, 'utf-8'))
      .not.toMatch(/\bPASS\b|\bFAIL(ED|URE)?\b|\bVIOLATION\b|\bCOMPLIANT\b|\bverdict\b/i)
  })
})

// ── Repository HEAD, including linked worktrees ─────────────────────────────
//
// `git worktree add` is how a reviewer or a CI job checks this repository out
// beside an existing clone, and there `.git` is a FILE, not a directory. The
// binding is mandatory, so a resolver that only understands directories kills
// the run outright in exactly the situation an evidence collection is most
// likely to be taken from a scratch checkout.

const SHA_MAIN = '1111111111111111111111111111111111111111'
const SHA_FEATURE = '2222222222222222222222222222222222222222'
const SHA_DETACHED = '3333333333333333333333333333333333333333'

/** Build a real on-disk fixture; no Git binary, no repository is touched. */
function gitFixture(build: (paths: { root: string; gitDir: string }) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'db-inventory-git-'))
  const gitDir = join(root, '.git')
  mkdirSync(gitDir, { recursive: true })
  build({ root, gitDir })
  return root
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

describe('repository HEAD resolution', () => {
  it('resolves this repository, with no subprocess', () => {
    expect(defaultReadRepositoryHead()).toMatch(/^[0-9a-f]{40}$/)
  })

  it('normal .git directory with a loose ref', () => {
    const root = gitFixture(({ gitDir }) => {
      writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
      writeFile(join(gitDir, 'refs', 'heads', 'main'), `${SHA_MAIN}\n`)
    })
    expect(defaultReadRepositoryHead(root)).toBe(SHA_MAIN)
  })

  it('normal .git directory with a packed ref', () => {
    const root = gitFixture(({ gitDir }) => {
      writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
      writeFile(join(gitDir, 'packed-refs'),
        `# pack-refs with: peeled fully-peeled sorted \n${SHA_MAIN} refs/heads/main\n` +
        `${SHA_FEATURE} refs/tags/v1\n^${SHA_MAIN}\n`)
    })
    expect(defaultReadRepositoryHead(root)).toBe(SHA_MAIN)
  })

  it('normal .git directory, detached HEAD', () => {
    const root = gitFixture(({ gitDir }) => writeFile(join(gitDir, 'HEAD'), `${SHA_DETACHED}\n`))
    expect(defaultReadRepositoryHead(root)).toBe(SHA_DETACHED)
  })

  /** A `git worktree add` layout: `.git` is a file pointing into the original. */
  function worktreeFixture(build: (paths: { common: string; worktreeGitDir: string }) => void): string {
    const original = mkdtempSync(join(tmpdir(), 'db-inventory-git-common-'))
    const common = join(original, '.git')
    const worktreeGitDir = join(common, 'worktrees', 'wt1')
    mkdirSync(worktreeGitDir, { recursive: true })
    const checkout = mkdtempSync(join(tmpdir(), 'db-inventory-git-wt-'))
    writeFile(join(checkout, '.git'), `gitdir: ${worktreeGitDir}\n`)
    writeFile(join(worktreeGitDir, 'commondir'), '../..\n')
    build({ common, worktreeGitDir })
    return checkout
  }

  it('linked worktree with a loose branch ref in the common directory', () => {
    const checkout = worktreeFixture(({ common, worktreeGitDir }) => {
      writeFile(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature\n')
      // The ref lives in the ORIGINAL repository, not in the worktree's own dir.
      writeFile(join(common, 'refs', 'heads', 'feature'), `${SHA_FEATURE}\n`)
    })
    expect(defaultReadRepositoryHead(checkout)).toBe(SHA_FEATURE)
  })

  it('linked worktree with a packed ref in the common directory', () => {
    const checkout = worktreeFixture(({ common, worktreeGitDir }) => {
      writeFile(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature\n')
      writeFile(join(common, 'packed-refs'),
        `# pack-refs with: peeled fully-peeled sorted \n${SHA_FEATURE} refs/heads/feature\n`)
    })
    expect(defaultReadRepositoryHead(checkout)).toBe(SHA_FEATURE)
  })

  it('linked worktree with a detached HEAD', () => {
    const checkout = worktreeFixture(({ worktreeGitDir }) => {
      writeFile(join(worktreeGitDir, 'HEAD'), `${SHA_DETACHED}\n`)
    })
    expect(defaultReadRepositoryHead(checkout)).toBe(SHA_DETACHED)
  })

  const malformed: [string, () => string, RegExp][] = [
    ['a .git file that names no gitdir', () => {
      const root = mkdtempSync(join(tmpdir(), 'db-inventory-git-bad-'))
      writeFile(join(root, '.git'), 'this is not a gitdir pointer\n')
      return root
    }, /does not name a gitdir/],
    ['a gitdir pointing nowhere', () => {
      const root = mkdtempSync(join(tmpdir(), 'db-inventory-git-bad-'))
      writeFile(join(root, '.git'), 'gitdir: /nonexistent/worktrees/wt1\n')
      return root
    }, /which does not exist/],
    ['an empty commondir', () => worktreeFixture(({ worktreeGitDir }) => {
      writeFile(join(worktreeGitDir, 'commondir'), '\n')
      writeFile(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature\n')
    }), /is empty/],
    ['a commondir pointing nowhere', () => worktreeFixture(({ worktreeGitDir }) => {
      writeFile(join(worktreeGitDir, 'commondir'), '../../../nonexistent-common\n')
      writeFile(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature\n')
    }), /which does not exist/],
    ['an unresolvable branch ref', () => worktreeFixture(({ worktreeGitDir }) => {
      writeFile(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/gone\n')
    }), /cannot resolve refs\/heads\/gone/],
    ['a HEAD that is neither a ref nor an object name', () => gitFixture(({ gitDir }) => {
      writeFile(join(gitDir, 'HEAD'), 'not-a-sha\n')
    }), /HEAD is not a Git object name/],
  ]

  for (const [label, build, pattern] of malformed) {
    it(`fails closed on ${label}`, () => {
      expect(() => defaultReadRepositoryHead(build())).toThrow(pattern)
    })
  }

  // ── Ref and object-id validation ───────────────────────────────────────
  //
  // HEAD is a file whose contents decide which path this process opens next and
  // what value it publishes as the binding. Both halves are attacker- or
  // corruption-controlled in exactly the same way, and before this round only
  // the detached case was checked at all.

  const badObjectIds: [string, string][] = [
    ['an abbreviated id', '2b6658a'],
    ['an uppercase id', SHA_MAIN.toUpperCase().replace(/1/g, 'A')],
    ['an empty value', ''],
    ['a non-hex value', 'z'.repeat(40)],
    ['an overlong value', '0'.repeat(41)],
    ['a branch name where an id belongs', 'refs/heads/main'],
    ['an error message', 'fatal: not a git repository'],
  ]

  for (const [label, value] of badObjectIds) {
    it(`rejects ${label} in a loose ref`, () => {
      const root = gitFixture(({ gitDir }) => {
        writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
        writeFile(join(gitDir, 'refs', 'heads', 'main'), `${value}\n`)
      })
      expect(() => defaultReadRepositoryHead(root)).toThrow(/not a Git object name|cannot resolve/)
    })

    it(`rejects ${label} in a detached HEAD`, () => {
      const root = gitFixture(({ gitDir }) => writeFile(join(gitDir, 'HEAD'), `${value}\n`))
      expect(() => defaultReadRepositoryHead(root)).toThrow(/not a Git object name|unusable ref/)
    })
  }

  it('rejects a malformed packed-ref value', () => {
    const root = gitFixture(({ gitDir }) => {
      writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
      writeFile(join(gitDir, 'packed-refs'), `# pack-refs with: peeled \nDEADBEEF refs/heads/main\n`)
    })
    expect(() => defaultReadRepositoryHead(root)).toThrow(/the packed ref refs\/heads\/main is not a Git object name/)
  })

  it('accepts a SHA-256 object name, which Git repositories really have', () => {
    const sha256 = 'a'.repeat(64)
    const root = gitFixture(({ gitDir }) => writeFile(join(gitDir, 'HEAD'), `${sha256}\n`))
    expect(defaultReadRepositoryHead(root)).toBe(sha256)
  })

  const badRefNames: [string, string][] = [
    ['a traversal component', 'refs/../../../../etc/passwd'],
    ['a bare traversal', '../../../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['a backslash', 'refs\\heads\\main'],
    ['a component starting with a dot', 'refs/heads/.hidden'],
    ['an empty component', 'refs//main'],
    ['too few components', 'refs/main'],
    ['something outside refs/', 'objects/info/alternates'],
    ['a forbidden character', 'refs/heads/ma:in'],
    ['a reflog selector', 'refs/heads/main@{1}'],
    ['a lock name', 'refs/heads/main.lock'],
    ['a space', 'refs/heads/ma in'],
    ['an empty ref', ''],
  ]

  for (const [label, ref] of badRefNames) {
    it(`rejects a symbolic ref with ${label}`, () => {
      const root = gitFixture(({ gitDir }) => writeFile(join(gitDir, 'HEAD'), `ref: ${ref}\n`))
      expect(() => defaultReadRepositoryHead(root)).toThrow(/unusable ref/)
    })
  }

  it('never reads outside the Git directory when HEAD names a traversal', () => {
    const readPaths: string[] = []
    const nodeFsPromise = import('node:fs')
    const root = gitFixture(({ gitDir }) => {
      writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/../../../../../../etc/passwd\n')
    })
    return nodeFsPromise.then(nodeFs => {
      const tracing = {
        existsSync: (path: string) => { readPaths.push(path); return nodeFs.existsSync(path) },
        statSync: (path: string) => { readPaths.push(path); return nodeFs.statSync(path) },
        readFileSync: (path: string, encoding: 'utf-8') => {
          readPaths.push(path)
          return nodeFs.readFileSync(path, encoding)
        },
      }
      expect(() => defaultReadRepositoryHead(root, tracing)).toThrow(/traversal component/)
      // The check happens BEFORE the join, so no path derived from the ref was
      // ever stat-ed or opened — only the repository's own .git and HEAD.
      const outside = readPaths.filter(path => !path.startsWith(root))
      expect(outside, `read outside the fixture: ${outside.join(', ')}`).toEqual([])
      expect(readPaths.some(path => path.includes('passwd'))).toBe(false)
    })
  })

  it('a malformed loose ref publishes nothing, before any client exists', async () => {
    const dir = scratch()
    const fake = makeFake()
    const root = gitFixture(({ gitDir }) => {
      writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
      writeFile(join(gitDir, 'refs', 'heads', 'main'), 'not-an-object-id\n')
    })
    const error = await runInventory(argv(dir), baseDeps(fake, {
      readRepositoryHead: () => defaultReadRepositoryHead(root),
    })).catch((e: Error) => e)
    expect(String(error)).toMatch(/not a Git object name/)
    expect(exitCodeFor(error)).toBe(EXIT_FAILURE)
    expect(fake.state.constructions).toBe(0)
    expect(readdirSync(dir)).toEqual([])
  })

  it('malformed worktree metadata publishes nothing', async () => {
    const dir = scratch()
    const fake = makeFake()
    const broken = mkdtempSync(join(tmpdir(), 'db-inventory-git-bad-'))
    writeFile(join(broken, '.git'), 'this is not a gitdir pointer\n')
    const error = await runInventory(argv(dir), baseDeps(fake, {
      readRepositoryHead: () => defaultReadRepositoryHead(broken),
    })).catch((e: Error) => e)
    expect(String(error)).toMatch(/does not name a gitdir/)
    expect(exitCodeFor(error)).toBe(EXIT_FAILURE)
    expect(fake.state.constructions).toBe(0)
    expect(readdirSync(dir)).toEqual([])
  })
})

// ── The closing message and the exit contract ───────────────────────────────

describe('the closing message', () => {
  it('is exactly INVENTORY COMPLETE — NO VERDICT, and never says PASS', async () => {
    const { outcome } = await runOk()
    expect(outcome.message).toBe('INVENTORY COMPLETE — NO VERDICT')
    expect(outcome.message).toBe(COMPLETE_MESSAGE)
    expect(outcome.message).not.toMatch(/PASS/)
  })
})

describe('exit code classification', () => {
  it('maps refusals to 2 and breakages to 1', () => {
    expect(exitCodeFor(new InventoryRefusal('x'))).toBe(EXIT_REFUSED)
    expect(exitCodeFor(new UnsafeSessionError('x'))).toBe(EXIT_REFUSED)
    expect(exitCodeFor(new InsufficientInspectionAuthority('x'))).toBe(EXIT_REFUSED)
    expect(exitCodeFor(new SessionCleanupError([new Error('x')]))).toBe(EXIT_FAILURE)
    expect(exitCodeFor(new Error('anything else'))).toBe(EXIT_FAILURE)
    expect(exitCodeFor('not even an error')).toBe(EXIT_FAILURE)
    expect(EXIT_COMPLETE).toBe(0)
  })
})

// ── The REAL entrypoint, in a child process ─────────────────────────────────
//
// `runInventory` rejecting is not the same claim as "the CLI exits 2". The exit
// status is what a scheduler, a CI step and an operator's `&&` actually see, and
// it is produced by the entrypoint guard, the `.catch` and `process.exit` —
// none of which an in-process test touches.

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = dirname(HERE)
const TSX = join(PACKAGE, 'node_modules', '.bin', 'tsx')
const CLI = join(PACKAGE, 'bin', 'db-inventory.ts')

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(TSX, [CLI, ...args], {
    cwd: PACKAGE,
    encoding: 'utf-8',
    env: {
      // A deliberately bare environment: no database variable of any kind can
      // leak in from the developer's shell.
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: process.env.HOME ?? '/tmp',
      ...env,
    },
  })
}

describe('the real entrypoint, in a child process', () => {
  it('exits 2 on a missing --mode', () => {
    const dir = scratch()
    const result = runCli(['--output', join(dir, 'out.json'), '--run-id', 'r'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toContain('--mode is required')
    expect(readdirSync(dir)).toEqual([])
  })

  it('exits 2 on a relative --output', () => {
    const result = runCli(['--mode', 'inventory', '--output', 'out.json', '--run-id', 'r'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toContain('is relative')
  })

  it('exits 2 on a missing --run-id', () => {
    const dir = scratch()
    const result = runCli(['--mode', 'inventory', '--output', join(dir, 'out.json')])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toContain('--run-id is required')
  })

  it('exits 2 on a missing credential, naming only the variable it reads', () => {
    const dir = scratch()
    const result = runCli(['--mode', 'inventory', '--output', join(dir, 'out.json'), '--run-id', 'r'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toContain(`${CREDENTIAL} is not set`)
    // Naming which OTHER variables were or were not set would print a map of
    // the operator's environment into a log. Remove the one name it may say,
    // then assert none of the forbidden names survives.
    const rest = result.stderr.split(CREDENTIAL).join('')
    for (const forbidden of FORBIDDEN_CREDENTIAL_VARIABLES) {
      expect(rest, `the refusal mentioned ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('exits 2 on an output directory that is not 0700', () => {
    const dir = scratch(0o755)
    const result = runCli(['--mode', 'inventory', '--output', join(dir, 'out.json'), '--run-id', 'r'],
                          { [CREDENTIAL]: URL_VALUE })
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toContain('must land in a directory')
    chmodSync(dir, 0o700)
  })

  it('exits 1 when the connection itself breaks, and publishes nothing', () => {
    const dir = scratch()
    // A Unix socket directory that cannot exist: the failure is ENOENT from the
    // filesystem, so no server — least of all a real one — is ever contacted.
    const result = runCli(
      ['--mode', 'inventory', '--output', join(dir, 'out.json'), '--run-id', 'r'],
      { [CREDENTIAL]: 'postgres://ai_capital_migrator@/ai_capital?host=/nonexistent-socket-dir-inventory-test' },
    )
    expect(result.status).toBe(EXIT_FAILURE)
    expect(result.stderr).toMatch(/ENOENT/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('is inert when imported rather than run', () => {
    const marker = join(scratch(), 'must-not-exist.json')
    const result = spawnSync(TSX, ['-e', `import(${JSON.stringify(CLI)}).then(m => console.log('exports:' + Object.keys(m).length))`], {
      cwd: PACKAGE, encoding: 'utf-8',
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME ?? '/tmp' },
    })
    expect(result.status).toBe(EXIT_COMPLETE)
    expect(result.stdout).toMatch(/exports:\d+/)
    expect(result.stdout).not.toContain(COMPLETE_MESSAGE)
    expect(existsSync(marker)).toBe(false)
  })
})
