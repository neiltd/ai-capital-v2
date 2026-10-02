// K8-B: the target has ONE authentication authority.
//
// NOTHING HERE TOUCHES A DATABASE, A SERVICE OR A PRODUCTION SECRET. Every
// credential is synthetic and high-entropy, every directory is a private
// mkdtemp root, and the only child process any fixture spawns is a harmless
// local reader that echoes back what it found on descriptor 3.
//
// SECRETS NEVER REACH A DIAGNOSTIC. Assertions compare booleans and lengths, or
// redacted projections; a failing expectation cannot print the synthetic
// password, CRED_URL or pgpass record.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync, closeSync, fstatSync, linkSync, lstatSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  TARGET_COPY_LOGIN_ROLE, TARGET_COPY_TRANSPORT,
  pgpassRecordFor, parseDriverCredentialUrl,
} from '@common/db/pg-copy'
import {
  REAL_TARGET_IDENTITY_OPS, SCRATCH_ATTEMPTS, TargetIdentityRefused,
  anonymousPassfileFd, openTargetIdentitySession, provedTargetCredential,
  type TargetIdentityOps,
} from '../src/pg-copy-ops/target-identity.js'
import type { Stats } from 'node:fs'
import {
  OPTIONS, measuredCopyBinding, parseArgs, productionDeps, runOpsCli,
  type FenceLike,
} from '../bin/pg-copy-ops.js'
import {
  applyScope, base, deps, provenance, ready, stage1Bundle, strip,
} from './support/ops-world.js'

/** High-entropy synthetic secret containing BOTH pgpass metacharacters. */
const PASSWORD = 'Zx9\\:q7W\\\\e2:R4t\\Y6u8I0o1P3a5S7d9F1g3H5j7K'
const SOCKET_DIR = '/private/tmp/k8b1-synthetic-socket'
const PORT = '5433'
const DATABASE = 'ai_capital_v3'
/** The ONE login the copy may authenticate as. Pinned in the db package. */
const USER = TARGET_COPY_LOGIN_ROLE
/**
 * THE REVIEWED SOCKET URL SHAPE, exactly as `provision.sh:472` writes it.
 *
 * `SOCKET_DIR` is DATA ONLY - never created, opened, stat-ed or connected to.
 * The copy target is reachable over the private Unix socket because
 * `ops/clusters/ai-capital-v3/pg_hba.conf` has no `host` rule for the migrator.
 */
const CRED_URL = `postgresql://${USER}:${encodeURIComponent(PASSWORD)}` +
  `@/${DATABASE}?host=${encodeURIComponent(SOCKET_DIR)}&port=${PORT}`
/** A TCP URL for the copy login - refused: that transport has no HBA rule. */
const TCP_MIGRATOR_URL =
  `postgresql://${USER}:${encodeURIComponent(PASSWORD)}@127.0.0.1:${PORT}/${DATABASE}`
/** A pipeline.url-shaped credential - refused: wrong principal for the copy. */
const PIPELINE_URL = `postgresql://ai_capital_pipeline:${encodeURIComponent(PASSWORD)}` +
  `@127.0.0.1:${PORT}/${DATABASE}`

/** Never print a secret: compare a one-way shape instead. */
const shape = (s: string): string => `len=${String(s.length)}`

/** One reviewed-shape socket URL, with any single field varied. */
const socketUrl2 = (
  over: { user?: string; dir?: string; port?: string; database?: string } = {},
): string => {
  const u = over.user ?? USER
  const d = over.database ?? DATABASE
  const h = encodeURIComponent(over.dir ?? SOCKET_DIR)
  const pt = over.port ?? PORT
  return `postgresql://${u}:x@/${d}?host=${h}&port=${pt}`
}

describe('K8-B: one target credential, proved before anything opens', () => {
  let root = ''
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'k8b-target-')))
    execFileSync('/bin/chmod', ['700', root])
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const container = (text: string, name = 'target.url'): string => {
    const p = join(root, name)
    writeFileSync(p, text, { mode: 0o600 })
    return p
  }
  const expected = { host: SOCKET_DIR, port: PORT, database: DATABASE }

  const socketUrl = (
    over: { user?: string; dir?: string; port?: string; database?: string } = {},
  ): string => {
    const u = over.user ?? USER
    const d = over.database ?? DATABASE
    const h = encodeURIComponent(over.dir ?? SOCKET_DIR)
    const pt = over.port ?? PORT
    return `postgresql://${u}:x@/${d}?host=${h}&port=${pt}`
  }

  it('accepts the reviewed SOCKET form and tolerates exactly one trailing LF', () => {
    for (const text of [CRED_URL, `${CRED_URL}\n`]) {
      const parsed = provedTargetCredential(container(text), expected)
      expect(parsed.form).toBe(TARGET_COPY_TRANSPORT)
      expect(parsed.form).toBe('socket')
      expect(parsed.user).toBe(USER)
      // THE PERCENT-ENCODED HOST DECODES TO THE ABSOLUTE SOCKET DIRECTORY.
      expect(parsed.host).toBe(SOCKET_DIR)
      expect(parsed.host.startsWith('/')).toBe(true)
      expect(parsed.port).toBe(Number(PORT))
      expect(parsed.database).toBe(DATABASE)
      expect(shape(parsed.password)).toBe(shape(PASSWORD))
    }
  })

  it('REFUSES a second line or a CR', () => {
    for (const text of [`${CRED_URL}\n${CRED_URL}\n`, `${CRED_URL}\r\n`, `${CRED_URL}\n\n`]) {
      expect(() => provedTargetCredential(container(text), expected))
        .toThrow(/not a single line|refused/)
    }
  })

  it('REFUSES a TCP credential for the copy login: that transport has no HBA rule', () => {
    // `pg_hba.conf` reaches `ai_capital_migrator` over `local` only, so a TCP
    // migrator credential could not authenticate. Accepting it would switch
    // transports silently and fail later, with a fence already held.
    expect(() => provedTargetCredential(container(TCP_MIGRATOR_URL), expected))
      .toThrow(/not the reviewed private-socket form/)
  })

  it('REFUSES a credential naming another socket directory, port or database', () => {
    const cases: Array<[string, RegExp]> = [
      [socketUrl({ dir: '/private/tmp/k8b1-other-socket' }), /another host/],
      [socketUrl({ port: '5544' }), /another port/],
      [socketUrl({ database: 'other_db' }), /another database/],
    ]
    for (const [url, why] of cases) {
      expect(() => provedTargetCredential(container(url), expected), url.slice(0, 24))
        .toThrow(why)
    }
  })

  it('the endpoint proof happens BEFORE any backend is constructed', async () => {
    let opened = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      openBackend: (async () => { opened += 1; throw new Error('must not open') }) as never,
    }
    await expect(openTargetIdentitySession({
      credentialPath: container(socketUrl({ dir: '/private/tmp/k8b1-elsewhere' })),
      expected, psqlPath: '/usr/bin/psql',
    }, ops)).rejects.toThrow(/another host/)
    expect(opened).toBe(0)
    // AND NO SCRATCH ENTRY WAS LEFT BEHIND.
    expect(readdirSync(root).filter(n => n.startsWith('.pgpass-scratch-'))).toEqual([])
  })

  it('refuses a non-canonical credential path without reading anything', () => {
    let reads = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      readContainer: (p: string) => { reads += 1; return { text: readFileSync(p, 'utf-8') } },
    }
    expect(() => provedTargetCredential(`${root}/./target.url`, expected, ops))
      .toThrow(/not canonical/)
    expect(reads).toBe(0)
  })
})

describe('K8-B: the pgpass record is exact, escaped and wildcard-free', () => {
  const parsed = parseDriverCredentialUrl(CRED_URL)

  it('escapes backslash and colon in EVERY field and ends with one LF', () => {
    const rec = pgpassRecordFor(parsed)
    expect(rec.endsWith('\n')).toBe(true)
    expect(rec.slice(0, -1).includes('\n')).toBe(false)
    // FIVE FIELDS: an unescaped colon is the separator, so splitting on
    // unescaped colons must yield exactly five.
    const fields: string[] = []
    let cur = ''
    for (let i = 0; i < rec.length - 1; i += 1) {
      const c = rec[i] as string
      if (c === '\\') { cur += c + (rec[i + 1] as string); i += 1; continue }
      if (c === ':') { fields.push(cur); cur = ''; continue }
      cur += c
    }
    fields.push(cur)
    expect(fields).toHaveLength(5)
    // AND EACH FIELD UNESCAPES BACK TO THE ORIGINAL VALUE.
    const unescape = (f: string): string => f.replace(/\\(.)/g, '$1')
    expect(unescape(fields[0] as string)).toBe(SOCKET_DIR)
    expect(unescape(fields[1] as string)).toBe(PORT)
    expect(unescape(fields[2] as string)).toBe(DATABASE)
    expect(unescape(fields[3] as string)).toBe(USER)
    expect(shape(unescape(fields[4] as string))).toBe(shape(PASSWORD))
    expect(unescape(fields[4] as string) === PASSWORD).toBe(true)
  })

  it('emits NO wildcard field', () => {
    const rec = pgpassRecordFor(parsed)
    for (const f of rec.slice(0, -1).split(/(?<!\\):/)) {
      expect(f === '*', 'a wildcard field would match endpoints nobody reviewed').toBe(false)
    }
    expect(rec.includes(':*:')).toBe(false)
    expect(rec.startsWith('*')).toBe(false)
  })

  it('a colon-bearing password cannot split the record', () => {
    // Without escaping this password would add columns; with escaping the
    // record still has exactly five fields, proved above.
    expect(PASSWORD.includes(':')).toBe(true)
    expect(PASSWORD.includes('\\')).toBe(true)
  })
})

describe('K8-B: the descriptor is anonymous before the first secret byte', () => {
  let root = ''
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'k8b-fd-')))
    execFileSync('/bin/chmod', ['700', root])
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const RECORD = `${SOCKET_DIR}:${PORT}:${DATABASE}:${USER}:escaped\\:value\n`

  /** Record the exact call order, without ever recording written bytes. */
  const tracing = (over: Partial<TargetIdentityOps> = {}): {
    ops: TargetIdentityOps; order: string[]; openFds: Set<number>
  } => {
    const order: string[] = []
    const openFds = new Set<number>()
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      openSync: (p, f, m) => {
        const fd = REAL_TARGET_IDENTITY_OPS.openSync(p, f, m)
        order.push('open'); openFds.add(fd); return fd
      },
      fstatSync: (fd: number) => { order.push('fstat'); return fstatSync(fd) },
      lstatSync: (p: string) => { order.push('lstat'); return lstatSync(p) },
      unlinkSync: (p: string) => { order.push('unlink'); REAL_TARGET_IDENTITY_OPS.unlinkSync(p) },
      writeSync: (fd, b, o, l, pos) => {
        order.push(`write@${String(pos)}`)
        return REAL_TARGET_IDENTITY_OPS.writeSync(fd, b, o, l, pos)
      },
      fsyncSync: (fd: number) => { order.push('fsync'); REAL_TARGET_IDENTITY_OPS.fsyncSync(fd) },
      closeSync: (fd: number) => {
        order.push('close'); openFds.delete(fd); REAL_TARGET_IDENTITY_OPS.closeSync(fd)
      },
      ...over,
    }
    return { ops, order, openFds }
  }

  it('UNLINKS before any write, and writes positionally from offset 0', () => {
    const t = tracing()
    const fd = anonymousPassfileFd(root, RECORD, t.ops)
    try {
      // K8-B1.2: THE WHOLE SEQUENCE, EXACTLY. A prefix check plus `toContain`
      // cannot see an `fsync` that ran in the wrong place, which is what let the
      // K8-B1.1 version miss a reordering.
      expect(t.order).toEqual(
        ['open', 'fstat', 'lstat', 'unlink', 'fstat', 'write@0', 'fsync'])
      // AND NO NAMED ENTRY SURVIVES.
      expect(readdirSync(root)).toEqual([])
    } finally { closeSync(fd) }
  })

  it('the inherited descriptor reads from offset 0, and a child sees the record', () => {
    const fd = anonymousPassfileFd(root, RECORD, REAL_TARGET_IDENTITY_OPS)
    try {
      // A HARMLESS LOCAL READER - not psql, not a network client. It reads the
      // descriptor it inherits at slot 3, exactly as psql would read /dev/fd/3.
      const out = execFileSync('/bin/cat', ['/dev/fd/3'], {
        stdio: ['ignore', 'pipe', 'ignore', fd], encoding: 'utf-8',
      })
      expect(out === RECORD).toBe(true)
      expect(out.length).toBe(RECORD.length)
    } finally { closeSync(fd) }
  })

  it('a SHORT write is completed, and the result is still exact', () => {
    let first = true
    const order: string[] = []
    const t = {
      order,
      ops: {
        ...REAL_TARGET_IDENTITY_OPS,
        writeSync: (fd: number, b: Buffer, o: number, l: number, pos: number) => {
          order.push(`write@${String(pos)}`)
          const n = first ? 1 : l
          first = false
          return REAL_TARGET_IDENTITY_OPS.writeSync(fd, b, o, n, pos)
        },
        fsyncSync: (fd: number) => {
          order.push('fsync'); REAL_TARGET_IDENTITY_OPS.fsyncSync(fd)
        },
      } as TargetIdentityOps,
    }
    const fd = anonymousPassfileFd(root, RECORD, t.ops)
    try {
      expect(t.order.filter(o => o.startsWith('write')).length).toBeGreaterThan(1)
      expect(t.order).toContain('write@0')
      expect(t.order).toContain('write@1')
      // EXACTLY ONE FSYNC, AND IT IS LAST. Not one per write, and not before them.
      expect(t.order.filter(o => o === 'fsync')).toEqual(['fsync'])
      expect(t.order.lastIndexOf('fsync')).toBe(t.order.length - 1)
      expect(t.order.indexOf('fsync')).toBeGreaterThan(
        t.order.map(o => o.startsWith('write')).lastIndexOf(true))
      const out = execFileSync('/bin/cat', ['/dev/fd/3'], {
        stdio: ['ignore', 'pipe', 'ignore', fd], encoding: 'utf-8',
      })
      expect(out === RECORD).toBe(true)
    } finally { closeSync(fd) }
  })

  it('an UNLINK failure writes zero secret bytes and leaves no open fd', () => {
    const t = tracing({ unlinkSync: () => { throw new Error('EPERM') } })
    expect(() => anonymousPassfileFd(root, RECORD, t.ops))
      .toThrow(/could not be unlinked/)
    // NO WRITE AT ALL, and the descriptor we owned is closed.
    expect(t.order.some(o => o.startsWith('write'))).toBe(false)
    expect(t.order).toContain('close')
    expect(t.openFds.size).toBe(0)
    // The scratch entry is still there, but it is EMPTY - no secret reached it.
    const left = readdirSync(root).filter(n => n.startsWith('.pgpass-scratch-'))
    expect(left).toHaveLength(1)
    expect(readFileSync(join(root, left[0] as string), 'utf-8')).toBe('')
  })

  for (const [what, over, why] of [
    // K8-B1.1: an initial `fstat` throw is CLASSIFIED, not propagated raw - there
    // is no receipt, so the module reports the identity/cleanup state truthfully
    // instead of leaking an OS message. The fd closure this loop checks is
    // unchanged.
    ['fstat', { fstatSync: (() => { throw new Error('EIO') }) as never },
     /could not be identified/],
    // K8-B1.2: write and fsync failures are CLASSIFIED too. K8-B1.1 rethrew them
    // unchanged, so a real Node error put `ENOSPC: no space left on device,
    // write` in this module's refusal - and this loop pinned that leak in place.
    ['write', {
      writeSync: (() => {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'),
                            { code: 'ENOSPC', errno: -28, syscall: 'write' })
      }) as never,
    }, /the scratch write failed and no named file remains/],
    ['fsync', {
      fsyncSync: (() => {
        throw Object.assign(new Error('EIO: i\/o error, fsync'),
                            { code: 'EIO', errno: -5, syscall: 'fsync' })
      }) as never,
    }, /the scratch fsync failed and no named file remains/],
  ] as const) {
    it(`a ${what} failure closes every owned fd and leaves no secret-bearing file`, () => {
      const t = tracing(over as Partial<TargetIdentityOps>)
      expect(() => anonymousPassfileFd(root, RECORD, t.ops)).toThrow(why)
      expect(t.order).toContain('close')
      expect(t.openFds.size).toBe(0)
      for (const n of readdirSync(root)) {
        // Any residue is the empty pre-unlink scratch file, never the record.
        expect(readFileSync(join(root, n), 'utf-8').includes(USER)).toBe(false)
      }
    })
  }

  it('a non-regular, multi-link or wrong-mode descriptor is refused', () => {
    const t = tracing({
      fstatSync: (() => ({
        isFile: () => true, nlink: 2, mode: 0o600, uid: process.getuid?.() ?? 0,
      })) as never,
    })
    expect(() => anonymousPassfileFd(root, RECORD, t.ops))
      .toThrow(/not a private regular file/)
    expect(t.openFds.size).toBe(0)
  })

  it('collision retries are bounded, and exhaustion refuses', () => {
    let tries = 0
    const t = tracing({
      openSync: (() => {
        tries += 1
        throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      }) as never,
    })
    expect(() => anonymousPassfileFd(root, RECORD, t.ops))
      .toThrow(/no scratch descriptor could be created/)
    expect(tries).toBe(SCRATCH_ATTEMPTS)
    expect(readdirSync(root)).toEqual([])
  })

  it('a spawn failure still closes the parent descriptor', async () => {
    const t = tracing({
      openBackend: (async () => { throw new Error('spawn refused') }) as never,
    })
    const p = join(root, 'target.url')
    writeFileSync(p, `${CRED_URL}\n`, { mode: 0o600 })
    await expect(openTargetIdentitySession({
      credentialPath: p, expected: { host: SOCKET_DIR, port: PORT, database: DATABASE },
      psqlPath: '/usr/bin/psql',
    }, t.ops)).rejects.toThrow(/spawn refused/)
    expect(t.openFds.size).toBe(0)
    expect(readdirSync(root).filter(n => n.startsWith('.pgpass-scratch-'))).toEqual([])
  })

  it('the secret never reaches argv, the environment, or a thrown message', async () => {
    const seen: { args: readonly string[]; env: Record<string, string> }[] = []
    const t = tracing({
      openBackend: (async (o: { psqlPath: string; passfileFd?: number }) => {
        // What production would hand the child: the fd, never the bytes.
        seen.push({ args: [o.psqlPath], env: { ...process.env } as Record<string, string> })
        throw new Error('stop here')
      }) as never,
    })
    const p = join(root, 'target.url')
    writeFileSync(p, `${CRED_URL}\n`, { mode: 0o600 })
    let message = ''
    try {
      await openTargetIdentitySession({
        credentialPath: p, expected: { host: SOCKET_DIR, port: PORT, database: DATABASE },
        psqlPath: '/usr/bin/psql',
      }, t.ops)
    } catch (e) { message = (e as Error).message }
    const haystack = `${JSON.stringify(seen)}\n${message}\n${process.argv.join(' ')}`
    for (const secret of [PASSWORD, CRED_URL, encodeURIComponent(PASSWORD)]) {
      expect(haystack.includes(secret), 'a secret escaped into argv/env/message').toBe(false)
    }
    expect(haystack.includes(':'), 'non-vacuous: the haystack has content').toBe(true)
  })
})

describe('K8-B: there is exactly ONE selectable target credential', () => {
  it('--target-passfile and --target-user are UNKNOWN options', () => {
    for (const opt of ['--target-passfile=/x/y', '--target-user=someone']) {
      expect(() => parseArgs(['--apply', opt]), opt).toThrow(/unknown option/)
    }
    expect([...OPTIONS]).not.toContain('--target-passfile')
    expect([...OPTIONS]).not.toContain('--target-user')
    expect([...OPTIONS]).toContain('--target-driver-credential')
  })

  it('they are refused BEFORE any dependency, file, service or socket is touched', async () => {
    let touched = 0
    const r = await runOpsCli(['--apply', '--target-passfile=/x/y'], {
      openSourceIdentity: async () => { touched += 1; throw new Error('must not open') },
      openTargetIdentity: async () => { touched += 1; throw new Error('must not open') },
      measureRepository: async () => { touched += 1; throw new Error('must not measure') },
    } as never)
    expect(r.exitCode).not.toBe(0)
    expect(r.lines.join('\n')).toMatch(/unknown option/)
    expect(touched).toBe(0)
  })

  it('production names ONE target credential path and no second selector', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    // The option appears in the allowlist and at exactly the two consumers:
    // the driver authority and the psql identity session.
    expect(src.split("'--target-driver-credential'")).toHaveLength(4)
    expect(src).not.toContain("'--target-passfile'")
    expect(src).not.toContain("'--target-user'")
    // AND NO NEW PERSISTENT PASSFILE PATH WAS INTRODUCED.
    for (const bad of ['target.pgpass', 'target-pgpass', '.pgpass-target']) {
      expect(src, bad).not.toContain(bad)
    }
  })

  it('the identity session and the driver authority share one path and expectation', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    // driverAuthority's target credential
    expect(src).toContain("targetCredentialPath: required(v, '--target-driver-credential')")
    // the psql identity session's credential
    expect(src).toContain("credentialPath: required(v, '--target-driver-credential')")
    // and both endpoints come from the same three selectors
    expect(src.split("required(v, '--target-host')").length).toBeGreaterThanOrEqual(3)
  })

  it('source passfile handling is untouched', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    expect([...OPTIONS]).toContain('--source-passfile')
    expect([...OPTIONS]).toContain('--source-user')
    expect(src).toContain("userOption = '--source-user', passfileOption = '--source-passfile'")
    // The source sessions still go through openProductionSession, unchanged.
    expect(src.split('openProductionSession(v, source)')).toHaveLength(4)
  })
})

describe('K8-B1: productionDeps wires the identity session to that one credential', () => {
  let root = ''
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'k8b-wire-')))
    execFileSync('/bin/chmod', ['700', root])
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const argv = (credential: string): Record<string, string> => ({
    '--psql': '/usr/bin/psql',
    '--target-host': SOCKET_DIR,
    '--target-port': PORT,
    '--target-database': DATABASE,
    '--target-driver-credential': credential,
    '--export-driver-credential': join(root, 'export.url'),
    '--source-host': '/tmp/src', '--source-port': '5432', '--source-database': 'ai_capital',
    '--source-user': 'thanapold',
  })
  const source = { host: '/tmp/src', port: '5432', database: 'ai_capital' }

  it('reads the credential named by --target-driver-credential, and no other path', async () => {
    // A DECOY at the path a `--target-passfile` would once have named. The real
    // container disagrees about the socket directory, and only the real
    // container can cause THAT refusal.
    writeFileSync(join(root, 'decoy.pgpass'), 'decoy\n', { mode: 0o600 })
    const cred = join(root, 'target.url')
    writeFileSync(cred, `${socketUrl2({ dir: '/private/tmp/k8b1-wrong-socket' })}\n`,
                  { mode: 0o600 })
    const deps = productionDeps(argv(cred), source)
    await expect((deps.openTargetIdentity as () => Promise<unknown>)())
      .rejects.toThrow(/another host/)
    expect(readFileSync(join(root, 'decoy.pgpass'), 'utf-8')).toBe('decoy\n')
  })

  it('the binding derivation pins the principal with NO optional seam', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8'))
    // K8-B1: the omissible `deps.proveTargetRole` seam is gone, and the check
    // lives in the executable derivation against the reviewed constant.
    expect(src).not.toContain('proveTargetRole')
    expect(src).not.toContain('credentialUser')
    expect(src).not.toContain('onProved')
    expect(src).toContain('target.currentUser !== TARGET_COPY_LOGIN_ROLE')
    expect(src).toContain('target.sessionUser !== TARGET_COPY_LOGIN_ROLE')
    // AND BOTH CHECKS PRECEDE THE PROVENANCE MEASUREMENT AND targetScope.
    const opened = src.indexOf('targetSession = await deps.openTargetIdentity()')
    const cur = src.indexOf('target.currentUser !== TARGET_COPY_LOGIN_ROLE')
    const ses = src.indexOf('target.sessionUser !== TARGET_COPY_LOGIN_ROLE')
    const prov = src.indexOf('const provenance = await (deps.measureRepository')
    const scope = src.indexOf('targetScope = {')
    expect(cur).toBeGreaterThan(opened)
    expect(ses).toBeGreaterThan(cur)
    expect(prov).toBeGreaterThan(ses)
    expect(scope).toBeGreaterThan(prov)
  })

  it('the truthful order is documented: Stage 1, then identity, then targetScope', () => {
    const src = readFileSync(
      new URL('../bin/pg-copy-ops.ts', import.meta.url), 'utf-8')
    // K8-B1: comments used to claim no target session could open before
    // targetScope existed, while the identity session is what CREATES the
    // binding targetScope is derived from.
    expect(src).not.toContain('Until this line no')
    expect(src).not.toContain('no target session may be opened before Stage 1')
    // THE TRUTHFUL ORDER IS SPELLED OUT, and the thunk's refusal names what it
    // actually bars: the LATER Stage-2 and verifier target sessions.
    expect(src).toContain('the target identity session then opens')
    expect(src).toContain('no Stage-2 or verifier target session may open')
  })
})

describe('K8-B1: the child receives the DESCRIPTOR, and nothing carrying the secret', () => {
  let root = ''
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'k8b-child-')))
    execFileSync('/bin/chmod', ['700', root])
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** Capture the ENTIRE options object the backend would be opened with. */
  const captured = async (): Promise<Record<string, unknown>> => {
    const cred = join(root, 'target.url')
    writeFileSync(cred, `${CRED_URL}\n`, { mode: 0o600 })
    let opts: Record<string, unknown> | null = null
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      openBackend: (async (o: Record<string, unknown>) => {
        opts = { ...o }
        throw new Error('captured')
      }) as never,
    }
    await expect(openTargetIdentitySession({
      credentialPath: cred, expected: { host: SOCKET_DIR, port: PORT, database: DATABASE },
      psqlPath: '/usr/bin/psql',
    }, ops)).rejects.toThrow(/captured/)
    expect(opts).not.toBeNull()
    return opts as unknown as Record<string, unknown>
  }

  it('passes passfileFd as a NUMBER and never a passfile PATH', async () => {
    const o = await captured()
    expect(typeof o.passfileFd).toBe('number')
    expect(Number.isInteger(o.passfileFd as number)).toBe(true)
    expect((o.passfileFd as number) >= 0).toBe(true)
    expect('passfile' in o).toBe(false)
  })

  it('the backend coordinates are the PARSED SOCKET directory, port and database', async () => {
    const o = await captured()
    expect(o.host).toBe(SOCKET_DIR)
    expect(o.port).toBe(Number(PORT))
    expect(o.database).toBe(DATABASE)
    // THE USER COMES FROM THE CREDENTIAL, and equals the reviewed copy login.
    expect(o.user).toBe(TARGET_COPY_LOGIN_ROLE)
  })

  it('NO field of the backend options carries the URL, password or record', async () => {
    const o = await captured()
    const serialized = JSON.stringify(o)
    for (const secret of [PASSWORD, CRED_URL, encodeURIComponent(PASSWORD)]) {
      expect(serialized.includes(secret), 'a secret reached the backend options').toBe(false)
      for (const [k, v] of Object.entries(o)) {
        expect(String(v).includes(secret), `options.${k} carries a secret`).toBe(false)
      }
    }
    expect(serialized.length).toBeGreaterThan(40)
  })

  it('the options carry exactly the reviewed keys', async () => {
    const o = await captured()
    expect(Object.keys(o).sort()).toEqual(
      ['database', 'host', 'passfileFd', 'port', 'psqlPath', 'user'])
  })

  it('no named passfile is left anywhere under the credential directory', async () => {
    await captured()
    for (const n of readdirSync(root)) {
      expect(n.includes('pgpass'), `a named passfile survived: ${n}`).toBe(false)
      expect(readFileSync(join(root, n), 'utf-8').includes(PASSWORD)).toBe(false)
    }
    expect(readdirSync(root)).toEqual(['target.url'])
  })
})

describe('K8-B1: the reviewed copy login is pinned independently', () => {
  let root = ''
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'k8b-principal-')))
    execFileSync('/bin/chmod', ['700', root])
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const expected = { host: SOCKET_DIR, port: PORT, database: DATABASE }
  const container = (text: string): string => {
    const p = join(root, 'target.url')
    writeFileSync(p, text, { mode: 0o600 })
    return p
  }

  it('the constant is ai_capital_migrator, and the copy path never spells it itself', () => {
    expect(TARGET_COPY_LOGIN_ROLE).toBe('ai_capital_migrator')
    expect(TARGET_COPY_TRANSPORT).toBe('socket')
    // NOT DUPLICATED IN QUEUE PRODUCTION CODE: both the credential proof and the
    // binding derivation reference the constant, never the literal.
    for (const rel of ['../bin/pg-copy-ops.ts', '../src/pg-copy-ops/target-identity.ts']) {
      const src = strip(readFileSync(new URL(rel, import.meta.url), 'utf-8'))
      expect(src.includes("'ai_capital_migrator'"), rel).toBe(false)
      expect(src.includes('TARGET_COPY_LOGIN_ROLE'), rel).toBe(true)
    }
  })

  for (const who of ['ai_capital_pipeline', 'thanapold', 'ai_capital_owner', 'someone_else']) {
    it(`REFUSES a syntactically valid credential for ${who}, before any scratch or spawn`, async () => {
      let opens = 0
      let spawns = 0
      const ops: TargetIdentityOps = {
        ...REAL_TARGET_IDENTITY_OPS,
        openSync: ((p: string, f: number, m: number) => {
          opens += 1
          return REAL_TARGET_IDENTITY_OPS.openSync(p, f, m)
        }) as never,
        // Even a fake session that would REPORT the reviewed role cannot help:
        // the credential never gets as far as opening one.
        openBackend: (async () => { spawns += 1; throw new Error('must not spawn') }) as never,
      }
      await expect(openTargetIdentitySession({
        credentialPath: container(`${socketUrl2({ user: who })}\n`),
        expected, psqlPath: '/usr/bin/psql',
      }, ops)).rejects.toThrow(/does not name the reviewed copy login/)
      expect(opens).toBe(0)
      expect(spawns).toBe(0)
      expect(readdirSync(root).filter(n => n.startsWith('.pgpass-scratch-'))).toEqual([])
    })
  }

  it('REFUSES a pipeline.url-shaped TCP credential: wrong principal AND wrong transport', () => {
    // `pipeline.url` belongs to the later runtime cutover. It is never a copy
    // credential: `ai_capital_pipeline` holds no role memberships
    // (ops/roles/000_cluster_roles.sql) so it cannot SET ROLE ai_capital_owner.
    expect(() => provedTargetCredential(container(`${PIPELINE_URL}\n`), expected))
      .toThrow(/not the reviewed private-socket form|does not name the reviewed copy login/)
  })

  it('the refusal names no supplied user, URL, password or digest', async () => {
    let message = ''
    try {
      provedTargetCredential(container(`${socketUrl2({ user: 'ai_capital_pipeline' })}\n`),
                             expected)
    } catch (e) { message = (e as Error).message }
    expect(message).toMatch(/does not name the reviewed copy login/)
    for (const leak of ['ai_capital_pipeline', PASSWORD, 'postgresql://', SOCKET_DIR]) {
      expect(message.includes(leak), 'the refusal leaked a supplied value').toBe(false)
    }
  })
})

describe('K8-B1: both measured role fields are compared with the constant', () => {
  const ROW = ['7689229024919775999', 'ai_capital_v3',
               TARGET_COPY_LOGIN_ROLE, TARGET_COPY_LOGIN_ROLE, '5433', '', 'true']

  /** One measured target identity, with any column replaced. */
  const session = (over: Partial<Record<number, string>> = {}): FenceLike => ({
    pid: '41599',
    rows: async () => [] as string[][],
    alive: () => true,
    send: async () => ({ rows: [ROW.map((v, n) => over[n] ?? v)], error: null }),
    close: async () => undefined,
  })

  const measured = async (over: Partial<Record<number, string>> = {}): Promise<unknown> => {
    const w = await ready()
    const bundleDir = stage1Bundle(w)
    return await measuredCopyBinding(
      parseArgs(base(w, ['--inspect', '--for=rehearse', ...applyScope(bundleDir)])).values,
      deps(w, { openTargetIdentity: async () => session(over) }), '/tmp/s')
  }

  it('a clean measurement is accepted', async () => {
    await expect(measured()).resolves.toBeDefined()
  })

  it('a CURRENT_USER mismatch is refused before provenance or targetScope', async () => {
    let gitRuns = 0
    const w = await ready()
    const bundleDir = stage1Bundle(w)
    await expect(measuredCopyBinding(
      parseArgs(base(w, ['--inspect', '--for=rehearse', ...applyScope(bundleDir)])).values,
      deps(w, {
        openTargetIdentity: async () => session({ 2: 'ai_capital_pipeline' }),
        measureRepository: async () => { gitRuns += 1; return provenance },
      }), '/tmp/s')).rejects.toThrow(/not authenticated as the reviewed copy login/)
    // THE REFUSAL PRECEDES THE PROVENANCE MEASUREMENT.
    expect(gitRuns).toBe(0)
  })

  it('a SESSION_USER mismatch is refused', async () => {
    await expect(measured({ 3: 'ai_capital_pipeline' }))
      .rejects.toThrow(/authenticated as another login/)
  })

  it('both fields AGREEING on the WRONG login is still refused', async () => {
    // K8-B1.1 addendum: the expectation must be the CONSTANT. Comparing the two
    // measured fields against each other, or against the credential, accepts
    // this case - which is the whole defect, since a consistent session proves
    // only that it is consistent.
    await expect(measured({ 2: 'ai_capital_pipeline', 3: 'ai_capital_pipeline' }))
      .rejects.toThrow(/not authenticated as the reviewed copy login/)
    await expect(measured({ 2: 'ai_capital_owner', 3: 'ai_capital_owner' }))
      .rejects.toThrow(/not authenticated as the reviewed copy login/)
  })

  it('CURRENT_USER and SESSION_USER disagreeing is refused either way round', async () => {
    // Assumed-role shape: authenticated as something else, then SET ROLE.
    await expect(measured({ 3: 'thanapold' })).rejects.toThrow(/another login/)
    // And the reverse.
    await expect(measured({ 2: 'thanapold' }))
      .rejects.toThrow(/not authenticated as the reviewed copy login/)
  })
})

describe('K8-B1: the scratch loop is fail-closed', () => {
  let root = ''
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'k8b-failclosed-')))
    execFileSync('/bin/chmod', ['700', root])
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const RECORD = `${SOCKET_DIR}:${PORT}:${DATABASE}:${USER}:escaped\\:value\n`
  const errno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(code), { code })

  it('an EEXIST collision IS retried, and a later name succeeds', () => {
    let tries = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      openSync: ((p: string, f: number, m: number) => {
        tries += 1
        if (tries < 3) throw errno('EEXIST')
        return REAL_TARGET_IDENTITY_OPS.openSync(p, f, m)
      }) as never,
    }
    const fd = anonymousPassfileFd(root, RECORD, ops)
    try {
      expect(tries).toBe(3)
      expect(readdirSync(root)).toEqual([])
    } finally { closeSync(fd) }
  })

  for (const code of ['EACCES', 'ENOSPC', 'EIO', 'ELOOP', 'EPERM']) {
    it(`a ${code} open failure refuses IMMEDIATELY, after exactly one attempt`, () => {
      let tries = 0
      const ops: TargetIdentityOps = {
        ...REAL_TARGET_IDENTITY_OPS,
        openSync: (() => { tries += 1; throw errno(code) }) as never,
      }
      let message = ''
      try { anonymousPassfileFd(root, RECORD, ops) } catch (e) { message = (e as Error).message }
      expect(message).toMatch(/could not be created/)
      // NOT RETRIED AS THOUGH IT WERE A COLLISION.
      expect(tries).toBe(1)
      // AND THE REASON CARRIES NO PATH AND NO OS MESSAGE.
      expect(message.includes(root)).toBe(false)
      expect(message.includes('.pgpass-scratch-')).toBe(false)
      expect(message.includes(code)).toBe(false)
      expect(readdirSync(root)).toEqual([])
    })
  }

  /** The ONE scratch entry this call made. Exact name, never a glob. */
  const scratchName = (): string => {
    const n = readdirSync(root).filter(x => x.startsWith('.pgpass-scratch-'))
    expect(n).toHaveLength(1)
    return join(root, n[0] as string)
  }

  /**
   * A `Stats` with fields varied, KEEPING the prototype so `isFile()` still
   * answers. No `as never`: a fake receipt is a real `Stats` shape or it is not
   * a receipt at all.
   */
  const withFields = (r: Stats, over: Partial<Stats>): Stats =>
    Object.assign(Object.create(Object.getPrototypeOf(r) as object) as Stats, r, over)

  const NAME_REASON =
    'no unpredictable scratch name could be generated and no scratch file was created'
  const entropyErr = (): Error => Object.assign(
    new Error('EAGAIN: entropy unavailable, getrandom'),
    { code: 'EAGAIN', errno: -35, syscall: 'getrandom' })

  it('a RANDOMBYTES failure is CLASSIFIED and nothing is opened', () => {
    // K8-B1.2 evaluated the candidate name OUTSIDE the per-attempt handler, and
    // the outer handler only begins once a descriptor exists - so this threw the
    // raw OS error straight out of a function whose refusals are bounded. The
    // K8-B1.2 report claimed otherwise, and no test covered it.
    const before = readdirSync(root).sort()
    let opens = 0
    let closes = 0
    let writes = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      randomBytes: () => { throw entropyErr() },
      openSync: (q: string, f: number, m: number) => {
        opens += 1
        return REAL_TARGET_IDENTITY_OPS.openSync(q, f, m)
      },
      closeSync: (fd: number) => { closes += 1; REAL_TARGET_IDENTITY_OPS.closeSync(fd) },
      writeSync: (fd, b, o, l, pos) => {
        writes += 1
        return REAL_TARGET_IDENTITY_OPS.writeSync(fd, b, o, l, pos)
      },
    }
    let caught: unknown = null
    try { anonymousPassfileFd(root, RECORD, ops) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(TargetIdentityRefused)
    const err = caught as TargetIdentityRefused
    expect(err.reason).toBe(NAME_REASON)
    expect(err.message).toBe(`the target identity session is refused: ${NAME_REASON}`)
    // NOTHING OF THE INJECTED FAILURE, AND NOTHING OF THE DIRECTORY.
    for (const leak of ['EAGAIN', 'entropy unavailable', 'getrandom', '-35', root,
                        '.pgpass-scratch-']) {
      expect(err.message.includes(leak), leak).toBe(false)
      expect(err.reason.includes(leak), leak).toBe(false)
    }
    expect('cause' in err && err.cause !== undefined).toBe(false)
    expect(Object.keys(err).filter(k => k !== 'reason' && k !== 'name')).toEqual([])
    // NOT ONE OPEN, NOT ONE CLOSE, NOT ONE WRITE.
    expect(opens).toBe(0)
    expect(closes).toBe(0)
    expect(writes).toBe(0)
    // AND THE PRIVATE DIRECTORY IS EXACTLY AS IT WAS.
    expect(readdirSync(root).sort()).toEqual(before)
  })

  it('a RANDOMBYTES failure AFTER an EEXIST collision is refused, not retried', () => {
    // A name-generation failure is not a collision. There is nothing to retry
    // with, so the attempt it happens on is the last one - even though the
    // previous attempt was a genuine EEXIST that WOULD have been retried.
    let names = 0
    let opens = 0
    let closes = 0
    let writes = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      randomBytes: (n: number) => {
        names += 1
        if (names === 1) return REAL_TARGET_IDENTITY_OPS.randomBytes(n)
        throw entropyErr()
      },
      openSync: () => {
        opens += 1
        throw Object.assign(new Error('EEXIST: file already exists, open'),
                            { code: 'EEXIST', errno: -17, syscall: 'open' })
      },
      closeSync: (fd: number) => { closes += 1; REAL_TARGET_IDENTITY_OPS.closeSync(fd) },
      writeSync: (fd, b, o, l, pos) => {
        writes += 1
        return REAL_TARGET_IDENTITY_OPS.writeSync(fd, b, o, l, pos)
      },
    }
    expect(() => anonymousPassfileFd(root, RECORD, ops))
      .toThrow(/no unpredictable scratch name could be generated and no scratch file was created/)
    // THE COLLISION WAS RETRIED; THE NAME FAILURE WAS NOT.
    expect(names).toBe(2)
    expect(opens).toBe(1)
    expect(closes).toBe(0)
    expect(writes).toBe(0)
    // AND THIS CALL CREATED NOTHING, including at the colliding name.
    expect(readdirSync(root).filter(n => n.startsWith('.pgpass-scratch-'))).toEqual([])
  })

  it('an INITIAL fstat throw writes zero, closes once, and does NOT claim cleanup', () => {
    // K8-B1 closed the fd and the report said the scratch entry was removed.
    // With no receipt there is no identity authorizing removal of that name, so
    // the empty file is LEFT and the refusal says so. The order corrects the
    // claim; this test pins the corrected behaviour against the exact on-disk
    // result.
    let writes = 0
    let closes = 0
    let unlinks = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      fstatSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) },
      unlinkSync: (q: string) => { unlinks += 1; REAL_TARGET_IDENTITY_OPS.unlinkSync(q) },
      writeSync: (fd, b, o, l, pos) => {
        writes += 1
        return REAL_TARGET_IDENTITY_OPS.writeSync(fd, b, o, l, pos)
      },
      closeSync: (fd: number) => { closes += 1; REAL_TARGET_IDENTITY_OPS.closeSync(fd) },
    }
    let message = ''
    try { anonymousPassfileFd(root, RECORD, ops) } catch (e) { message = (e as Error).message }
    expect(message).toMatch(/could not be identified and an empty scratch file may be retained/)
    expect(writes).toBe(0)
    expect(unlinks).toBe(0)
    // EXACTLY ONE CLOSE. K8-B1 closed here and again in the handler.
    expect(closes).toBe(1)
    // THE EXACT ON-DISK RESULT: the empty 0600 entry, retained as reported.
    const left = readdirSync(root)
    expect(left).toHaveLength(1)
    const st = lstatSync(join(root, left[0] as string))
    expect(st.isFile()).toBe(true)
    expect(st.size).toBe(0)
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('an INVALID but IDENTIFIED receipt removes the empty scratch when the NAME matches', () => {
    // Real invalidity, visible to both observations: the mode is changed right
    // after the open, so `fstat` reports a non-0600 file AND `lstat` agrees it
    // is the same object. Removal is then authorized, and only then.
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      openSync: (q: string, f: number, m: number) => {
        const fd = REAL_TARGET_IDENTITY_OPS.openSync(q, f, m)
        chmodSync(q, 0o644)
        return fd
      },
    }
    expect(() => anonymousPassfileFd(root, RECORD, ops))
      .toThrow(/not a private regular file$/)
    expect(readdirSync(root)).toEqual([])
  })

  it('an INVALID receipt whose NAME does not match unlinks NOTHING', () => {
    let unlinks = 0
    let calls = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      fstatSync: (fd: number) => {
        calls += 1
        const real = REAL_TARGET_IDENTITY_OPS.fstatSync(fd)
        // Identified, but as an object with two links and a foreign inode: a
        // possible replacement, so the name is left exactly where it is.
        return withFields(real, { nlink: 2, ino: real.ino + 1 })
      },
      unlinkSync: (q: string) => { unlinks += 1; REAL_TARGET_IDENTITY_OPS.unlinkSync(q) },
    }
    expect(() => anonymousPassfileFd(root, RECORD, ops))
      .toThrow(/not a private regular file and an empty scratch file may be retained/)
    expect(unlinks).toBe(0)
    expect(calls).toBe(1)
    expect(readdirSync(root)).toHaveLength(1)
  })

  it('an unlink failure writes ZERO secret bytes and reports the retained empty file', () => {
    let writes = 0
    let closes = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      unlinkSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) },
      writeSync: (_fd, _b, _o, l) => { writes += 1; return l },
      closeSync: (fd: number) => { closes += 1; REAL_TARGET_IDENTITY_OPS.closeSync(fd) },
    }
    expect(() => anonymousPassfileFd(root, RECORD, ops))
      .toThrow(/could not be unlinked and an empty scratch file is retained/)
    expect(writes).toBe(0)
    // EXACTLY ONE CLOSE on this path. K8-B1 closed the fd here and then let the
    // handler close the same number a second time.
    expect(closes).toBe(1)
    const left = readdirSync(root)
    expect(left).toHaveLength(1)
    // EMPTY, AND NEVER THE RECORD.
    expect(readFileSync(join(root, left[0] as string), 'utf-8')).toBe('')
  })

  it('a REAL replacement at the scratch NAME is never removed by the one retry', () => {
    // THE ACTUAL RACE, built from real files. Between the receipt and the retry
    // an outside actor keeps its own link to our object, unlinks our name, and
    // installs a different file there. The descriptor still proves to be the
    // created object - same inode, one link - so a descriptor-only re-proof
    // would authorize the retry and DELETE SOMEBODY ELSE'S FILE. The pathname
    // comparison is what declines it.
    const keeper = join(root, 'keeper')
    let unlinks = 0
    let writes = 0
    let closes = 0
    let replaced = ''
    // THE REPLACEMENT'S IDENTITY, TAKEN THE MOMENT IT EXISTS. Comparing only
    // mode and bytes afterwards could not tell a surviving file from a deleted
    // one that something recreated, which is what K8-B1.1 actually asserted.
    let madeDev = -1
    let madeIno = -1
    let madeMode = -1
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      unlinkSync: (q: string) => {
        unlinks += 1
        if (unlinks === 1) {
          linkSync(q, keeper)
          unlinkSync(q)
          writeFileSync(q, 'not-ours', { mode: 0o600 })
          const made = lstatSync(q)
          madeDev = made.dev
          madeIno = made.ino
          madeMode = made.mode & 0o777
          replaced = q
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        }
        REAL_TARGET_IDENTITY_OPS.unlinkSync(q)
      },
      // DELEGATED, SO THE ON-DISK CHECKS BELOW CAN ACTUALLY FAIL. A counting stub
      // that writes nothing makes "the surviving link is empty" unfalsifiable.
      writeSync: (fd, b, o, l, pos) => {
        writes += 1
        return REAL_TARGET_IDENTITY_OPS.writeSync(fd, b, o, l, pos)
      },
      closeSync: (fd: number) => { closes += 1; REAL_TARGET_IDENTITY_OPS.closeSync(fd) },
    }
    expect(() => anonymousPassfileFd(root, RECORD, ops)).toThrow(/could not be re-proved/)
    // EXACTLY ONE UNLINK ATTEMPT: the retry was declined by the NAME, not by the fd.
    expect(unlinks).toBe(1)
    expect(writes).toBe(0)
    expect(closes).toBe(1)
    // THE REPLACEMENT IS THE SAME OBJECT: device, inode, mode and bytes.
    const after = lstatSync(replaced)
    expect(after.isFile()).toBe(true)
    expect(after.dev).toBe(madeDev)
    expect(after.ino).toBe(madeIno)
    expect(after.mode & 0o777).toBe(madeMode)
    expect(after.mode & 0o777).toBe(0o600)
    expect(readFileSync(replaced, 'utf-8')).toBe('not-ours')
    // AND NOT ONE SECRET BYTE REACHED EITHER LINK.
    expect(readFileSync(keeper, 'utf-8')).toBe('')
  })

  it('a mutated fstat INODE is a descriptor failure, NOT pathname substitution', () => {
    // K8-B1's test changed the inode behind an open descriptor and called that a
    // substitution. It is not: replacing a name cannot change an open fd's inode,
    // and the on-disk name here is STILL the original object throughout. The test
    // is kept only to pin that distinction, and it is not the substitution proof.
    let unlinks = 0
    let calls = 0
    let nameWas = ''
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      unlinkSync: () => {
        unlinks += 1
        nameWas = scratchName()
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
      fstatSync: (fd: number) => {
        calls += 1
        const real = REAL_TARGET_IDENTITY_OPS.fstatSync(fd)
        return calls === 1 ? real : withFields(real, { ino: real.ino + 1 })
      },
    }
    expect(() => anonymousPassfileFd(root, RECORD, ops)).toThrow(/could not be re-proved/)
    expect(unlinks).toBe(1)
    // THE NAME NEVER CHANGED. Nothing was substituted; only the fd was lied about.
    expect(lstatSync(nameWas).isFile()).toBe(true)
    expect(readFileSync(nameWas, 'utf-8')).toBe('')
  })

  for (const how of ['MISSING', 'UNREADABLE', 'MISMATCHED'] as const) {
    it(`a ${how} pathname before the FIRST unlink causes zero unlinks and zero writes`, () => {
      let unlinks = 0
      let writes = 0
      const ops: TargetIdentityOps = {
        ...REAL_TARGET_IDENTITY_OPS,
        lstatSync: (q: string) => {
          const real = lstatSync(q)
          if (how === 'MISSING') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          if (how === 'UNREADABLE') throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
          return withFields(real, { ino: real.ino + 1 })
        },
        unlinkSync: (q: string) => { unlinks += 1; REAL_TARGET_IDENTITY_OPS.unlinkSync(q) },
        writeSync: (_fd, _b, _o, l) => { writes += 1; return l },
      }
      expect(() => anonymousPassfileFd(root, RECORD, ops))
        .toThrow(/pathname is not the created object and was not unlinked/)
      expect(unlinks).toBe(0)
      expect(writes).toBe(0)
    })
  }

  it('a pathname mismatch on DEVICE ALONE is enough to decline the unlink', () => {
    let unlinks = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      lstatSync: (q: string) => withFields(lstatSync(q), { dev: lstatSync(q).dev + 1 }),
      unlinkSync: (q: string) => { unlinks += 1; REAL_TARGET_IDENTITY_OPS.unlinkSync(q) },
    }
    expect(() => anonymousPassfileFd(root, RECORD, ops))
      .toThrow(/pathname is not the created object/)
    expect(unlinks).toBe(0)
  })

  it('a HARD LINK made before the unlink leaves nlink > 0, refuses, and writes zero', () => {
    // The unlink SUCCEEDS and still proves nothing: another name holds the same
    // object, so the record would have been readable through it.
    const keeper = join(root, 'other-name')
    let writes = 0
    let closes = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      unlinkSync: (q: string) => {
        linkSync(q, keeper)
        REAL_TARGET_IDENTITY_OPS.unlinkSync(q)
      },
      // DELEGATED: if a write ever ran here, the surviving link would hold the
      // record and the two assertions below would fail, which is the point.
      writeSync: (fd, b, o, l, pos) => {
        writes += 1
        return REAL_TARGET_IDENTITY_OPS.writeSync(fd, b, o, l, pos)
      },
      closeSync: (fd: number) => { closes += 1; REAL_TARGET_IDENTITY_OPS.closeSync(fd) },
    }
    expect(() => anonymousPassfileFd(root, RECORD, ops))
      .toThrow(/not anonymous and no bytes were written/)
    expect(writes).toBe(0)
    expect(closes).toBe(1)
    // THE SURVIVING LINK HOLDS NOTHING.
    expect(lstatSync(keeper).size).toBe(0)
    expect(readFileSync(keeper, 'utf-8')).toBe('')
    expect(readdirSync(root)).toEqual(['other-name'])
  })

  it('the substitution coverage is a REAL on-disk replacement, and FAILS CLOSED', () => {
    // THE ONE SOURCE-LEVEL ASSERTION IN THIS SUITE. The presence of a test cannot
    // be proved by running it, and the presence of THIS one is the property
    // K8-B1 got wrong: its substitution test mutated the inode behind an open
    // descriptor, which no replacement can do, so it passed while the defect stood.
    //
    // K8-B1.1's version was no better. It did `indexOf` on a title literal and
    // sliced a fixed 2600 characters, so with the real test deleted the search
    // landed on the guard's OWN string and found all four needles among the
    // guard's own arguments. It could not fail. This one assembles the title from
    // parts, so the `it('<title>'` call string never appears verbatim here,
    // requires exactly one such call in the file, and bounds the slice to that
    // test alone.
    const src = readFileSync(new URL(import.meta.url), 'utf-8')
    const title = 'a REAL replacement at the scratch ' + 'NAME is never removed by the one retry'
    const call = 'it(' + "'" + title + "'"
    // EXACTLY ONE. A renamed or deleted test fails here, and so does a duplicate.
    expect(src.split(call)).toHaveLength(2)
    const from = src.indexOf(call)
    // BOUNDED TO THIS TEST: the next top-level `it(` or `for (` in the describe.
    const rest = src.slice(from + call.length)
    const ends = ['\n  it(', '\n  for ('].map(m => rest.indexOf(m)).filter(n => n >= 0)
    expect(ends.length).toBeGreaterThan(0)
    const body = rest.slice(0, Math.min(...ends))
    // THE REAL FILE OPERATIONS, inside that test and nowhere else.
    for (const needle of [
      'linkSync(q, keeper)',
      'unlinkSync(q)',
      "writeFileSync(q, 'not-ours'",
      'madeDev = made.dev',
      'madeIno = made.ino',
      "readFileSync(replaced, 'utf-8')",
    ]) {
      expect(body.includes(needle), needle).toBe(true)
    }
    // AND NOT THE FICTION: a fabricated `Stats` is not a replacement.
    expect(body.includes('withFields(')).toBe(false)
  })

  /**
   * THE INJECTED FAILURE, AND THE BUFFER IT SAW.
   *
   * The WRITE case has to capture inside its own failing stub: the module's only
   * reference to the record buffer arrives as a `writeSync` argument, and that is
   * the call being made to fail.
   */
  type Inject = (capture: (b: Buffer) => void) => Partial<TargetIdentityOps>
  const writeErr = (): Error => Object.assign(
    new Error('ENOSPC: no space left on device, write'),
    { code: 'ENOSPC', errno: -28, syscall: 'write' })
  const fsyncErr = (): Error => Object.assign(
    new Error('EIO: i/o error, fsync'),
    { code: 'EIO', errno: -5, syscall: 'fsync' })

  for (const [what, inject, reason] of [
    ['WRITE', ((capture) => ({
      writeSync: (_fd: number, b: Buffer) => { capture(b); throw writeErr() },
    })) as Inject, 'the scratch write failed and no named file remains'],
    ['FSYNC', ((capture) => ({
      writeSync: (fd: number, b: Buffer, o: number, l: number, pos: number) => {
        capture(b)
        return REAL_TARGET_IDENTITY_OPS.writeSync(fd, b, o, l, pos)
      },
      fsyncSync: () => { throw fsyncErr() },
    })) as Inject, 'the scratch fsync failed and no named file remains'],
  ] as const) {
    it(`a real ${what} error is CLASSIFIED: no code, no OS message, no cause`, () => {
      // K8-B1.1 rethrew these untouched, so a genuine Node failure left
      // `ENOSPC: no space left on device, write` as this module's reason. The
      // reviewed vocabulary bounds every refusal or it bounds none of them.
      let closes = 0
      let seen: Buffer | null = null
      const ops: TargetIdentityOps = {
        ...REAL_TARGET_IDENTITY_OPS,
        closeSync: (fd: number) => { closes += 1; REAL_TARGET_IDENTITY_OPS.closeSync(fd) },
        // THE ACTUAL BUFFER THE MODULE OWNS, so the zeroing can be checked.
        ...inject((b: Buffer) => { seen = b }),
      }
      let caught: unknown = null
      try { anonymousPassfileFd(root, RECORD, ops) } catch (e) { caught = e }
      // THE REVIEWED TYPE AND THE REVIEWED REASON.
      expect(caught).toBeInstanceOf(TargetIdentityRefused)
      const err = caught as TargetIdentityRefused
      expect(err.reason).toBe(reason)
      expect(err.message).toBe(`the target identity session is refused: ${reason}`)
      // AND NOTHING OF THE INJECTED FAILURE, anywhere on the object.
      for (const leak of ['ENOSPC', 'EIO', 'no space left', 'i/o error',
                          'syscall', '-28', '-5', root, '.pgpass-scratch-']) {
        expect(err.message.includes(leak), leak).toBe(false)
        expect(err.reason.includes(leak), leak).toBe(false)
      }
      // NO `cause`: that is the same leak one property along.
      expect('cause' in err && err.cause !== undefined).toBe(false)
      // NO EXTRA PROPERTY AT ALL beyond the reviewed reason and the class name:
      // no `code`, no `errno`, no `syscall`, no captured original.
      expect(Object.keys(err).filter(k => k !== 'reason' && k !== 'name')).toEqual([])
      expect(closes).toBe(1)
      // THE NAME WAS ALREADY GONE BEFORE THE WRITE, so nothing is left at all.
      expect(readdirSync(root)).toEqual([])
      // AND THE RECORD BUFFER IS ZEROED, by the `finally`, on this path too.
      expect(seen).not.toBeNull()
      const buf = seen as unknown as Buffer
      expect(buf.length).toBeGreaterThan(0)
      expect(buf.every(byte => byte === 0)).toBe(true)
    })
  }

  it('a REAL second link before the receipt is reported as retained elsewhere', () => {
    // THE INVALID-RECEIPT CASE BUILT FROM REAL FILES. A second link exists before
    // the receipt is taken, so `fstat` reports `nlink === 2` and `lstat` agrees it
    // is the same object. Our name may therefore be removed - and the refusal has
    // to say that the OTHER name still holds an empty scratch file, which
    // K8-B1.1's wording did not.
    const keeper = join(root, 'second-link')
    let writes = 0
    let closes = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      openSync: (q: string, f: number, m: number) => {
        const fd = REAL_TARGET_IDENTITY_OPS.openSync(q, f, m)
        // BEFORE THE RECEIPT FSTAT: the object genuinely has two names.
        linkSync(q, keeper)
        return fd
      },
      writeSync: (fd, b, o, l, pos) => {
        writes += 1
        return REAL_TARGET_IDENTITY_OPS.writeSync(fd, b, o, l, pos)
      },
      closeSync: (fd: number) => { closes += 1; REAL_TARGET_IDENTITY_OPS.closeSync(fd) },
    }
    expect(() => anonymousPassfileFd(root, RECORD, ops))
      .toThrow(/another name may still retain an empty scratch file/)
    expect(writes).toBe(0)
    expect(closes).toBe(1)
    // OUR NAME IS GONE; THE OTHER ONE IS NOT, AND HOLDS NOTHING.
    expect(readdirSync(root).filter(n => n.startsWith('.pgpass-scratch-'))).toEqual([])
    expect(readdirSync(root)).toEqual(['second-link'])
    expect(lstatSync(keeper).size).toBe(0)
    expect(readFileSync(keeper, 'utf-8')).toBe('')
  })

  it('an ALWAYS failing unlink with a valid re-proof is attempted EXACTLY twice', () => {
    // K8-B1.1 had no test that counted attempts on a permanently failing unlink,
    // so a loop that retried for ever, or twice more, would have gone unseen.
    let unlinks = 0
    let writes = 0
    let closes = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      unlinkSync: () => {
        unlinks += 1
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
      writeSync: (fd, b, o, l, pos) => {
        writes += 1
        return REAL_TARGET_IDENTITY_OPS.writeSync(fd, b, o, l, pos)
      },
      closeSync: (fd: number) => { closes += 1; REAL_TARGET_IDENTITY_OPS.closeSync(fd) },
    }
    expect(() => anonymousPassfileFd(root, RECORD, ops))
      .toThrow(/could not be unlinked and an empty scratch file is retained/)
    // ONE ATTEMPT, ONE RETRY, AND NO THIRD.
    expect(unlinks).toBe(2)
    expect(writes).toBe(0)
    expect(closes).toBe(1)
    const left = readdirSync(root)
    expect(left).toHaveLength(1)
    expect(readFileSync(join(root, left[0] as string), 'utf-8')).toBe('')
  })

  it('a first unlink failure with a VALID re-proof permits EXACTLY ONE retry', () => {
    let unlinks = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      unlinkSync: (q: string) => {
        unlinks += 1
        if (unlinks === 1) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        REAL_TARGET_IDENTITY_OPS.unlinkSync(q)
      },
    }
    const fd = anonymousPassfileFd(root, RECORD, ops)
    try {
      // ONE FAILURE, ONE RETRY, AND NO MORE.
      expect(unlinks).toBe(2)
      expect(readdirSync(root)).toEqual([])
      expect(fstatSync(fd).nlink).toBe(0)
    } finally { closeSync(fd) }
  })

  it('an fsync failure closes the fd and leaves no named file at all', () => {
    let closes = 0
    const ops: TargetIdentityOps = {
      ...REAL_TARGET_IDENTITY_OPS,
      fsyncSync: () => { throw errno('EIO') },
      closeSync: (fd: number) => { closes += 1; REAL_TARGET_IDENTITY_OPS.closeSync(fd) },
    }
    // K8-B1.2: the bounded reason, not the errno this fixture threw.
    expect(() => anonymousPassfileFd(root, RECORD, ops))
      .toThrow(/the scratch fsync failed and no named file remains/)
    expect(closes).toBe(1)
    // The name was already unlinked before the write, so nothing is left.
    expect(readdirSync(root)).toEqual([])
  })
})
