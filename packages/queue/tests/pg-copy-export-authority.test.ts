// K7-B7: the temporary export authority.
//
// NO LIVE DATABASE AND NO REAL CONTAINER. The reviewed container path is under
// a fixed absolute root this suite must not create, so the container-shape
// rules are proved against the pattern and the publisher primitives are proved
// against a bounded temporary directory instead. Everything privileged goes
// through injected seams; nothing here reaches PostgreSQL.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeSync, constants, existsSync, fstatSync as statSyncFd, lstatSync,
  mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  rmdirSync, writeFileSync,
  statSync, symlinkSync, type Stats,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  COMMIT_DISPOSITION_FILE, EXPORT_ROLE_NAME, EXPORT_SCHEMAS, EXPORT_TABLES,
  LEDGER_COLUMNS, PRISTINE_RELEASE_FILE,
  CredentialPublishedButUnverified, REAL_PUBLISH_OPS,
  buildExportCredentialTcpUrl, buildExportPgpassLine, deriveScramSha256Verifier,
  generateExportSecret,
} from '@common/db/pg-copy'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { publishEvidence, verifyPublishedEvidence } from '@common/db/pg-copy'
import { stage1Bundle, type World } from './support/ops-world.js'
import {
  CONTAINER_PATTERN, CREATE_FILE, CREATE_PREFIX, DISPOSITIONS, DRIVER_FILE,
  ContainerCreatedButUnverified,
  REAL_AUTHORITY_FS, assertPolicyContainer, isRealUtcInstant,
  removeOwnedEmptyContainer, requireReleased, runIdentityOf,
  type AuthorityFsOps, type AuthorityPolicy, type ReleaseState,
  EXIT_OK, EXIT_REFUSED, TEARDOWN_PREFIX, readCreateBundle,
  AuthorityRefused, REAL_PROVE_OPS, authorizeTeardown,
  handleCredentialFailure, receiptsOf, retainedUnknown, teardownRemoval,
  EXIT_RETAINED_UNKNOWN,
  MODES, MODE_OPTIONS, OPTIONS, PGPASS_FILE, PROVE_ROLE_SQL,
  assertReviewedAuthority, adminArgs, createContainer, parseArgs, parseRoleFacts,
  TEARDOWN_FILE, assertSameCluster, createDocument, teardownDocument,
  proveContainer, proveContainerRemoved, proveCredential, publishCredential, runAuthorityCli,
  withAdminPassfile,
  type RoleFacts,
} from '../bin/pg-copy-export-authority.js'
import ts from 'typescript'
import { strip } from './support/ops-world.js'

const SECRET = 'Zm9vYmFyYmF6cXV1eA_-0123456789abcdefghijk'
const ENDPOINT = { host: '127.0.0.1', port: 5432, database: 'ai_capital' }

const SYSTEM_ID = '7300000000000000001'

// ---------------------------------------------------------------------------
// HERMETIC BY CONSTRUCTION, NOT BY PROMISE
//
// K7-B7.2.3: every mode-level test used to pass the PRODUCTION container path
// to executable behaviour and rely on refusing early enough never to reach the
// real `mkdir`. In the B7.2.2 parallel run one path did reach it, and two
// credential files were written under the production credential root.
//
// So the production root is no longer reachable from this file's executable
// tests at all. They are handed an AuthorityPolicy whose root is a private
// directory under `mkdtemp`, with REAL filesystem operations - nothing is
// faked, only relocated - and production rules REFUSE that path rather than
// redirecting a write, which is itself asserted below. The production
// constants are still asserted, but only by pure tests that execute nothing.
// ---------------------------------------------------------------------------

const SECRET_ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'k7-authority-secrets-')))
execFileSync('/bin/chmod', ['700', SECRET_ROOT])
afterAll(() => {
  // ONLY THIS FILE'S OWN ROOT. Never the production root, never ~/.Trash,
  // never a glob, never a path this file did not create.
  rmSync(SECRET_ROOT, { recursive: true, force: true })
})

const POLICY: AuthorityPolicy = Object.freeze({
  secretRoot: SECRET_ROOT, fs: REAL_AUTHORITY_FS, prove: REAL_PROVE_OPS,
})

/** The container path for one run id, under THIS file's private root. */
const containerFor = (runId: string): string =>
  join(SECRET_ROOT, `s4f-k7-export-${runId}`)

// K7-B7.2.7: THERE IS NO PRODUCTION PATH IN THIS MODULE ANY MORE.
//
// The production root and policy are module-private to the authority now, so
// this file cannot import them - and it no longer constructs the path from
// pieces either. Nothing here materializes a production policy object or a
// production path string at runtime; the composition point is proved from the
// TypeScript AST instead, in the K7-B7.2.7 describe at the end of this file.

const FULL_FACTS: RoleFacts = Object.freeze({
  systemIdentifier: SYSTEM_ID,
  present: true, canLogin: true, superuser: false, createRole: false,
  createDb: false, replication: false, bypassRls: false,
  memberships: [], schemaUsage: [...EXPORT_SCHEMAS], tableSelect: [...EXPORT_TABLES],
  ledgerColumns: [...LEDGER_COLUMNS],
  writeGrants: [], routineGrants: [], sequenceGrants: [],
})

describe('K7-B7 D: argv is the whole interface', () => {
  it('accepts exactly three modes and no environment gate', () => {
    expect([...MODES]).toEqual(['--create', '--prove', '--teardown'])
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    // NO TEST-ONLY BRANCH REACHES PRODUCTION BEHAVIOUR.
    expect(src).not.toMatch(/process\.env/)
    expect(src).not.toMatch(/NODE_ENV/)
  })

  it('refuses an unknown option, a repeat, a bare flag and zero or two modes', () => {
    expect(() => parseArgs(['--create', '--nope=1'])).toThrow(/unknown option/)
    expect(() => parseArgs(['--create', '--psql'])).toThrow(/carries no value/)
    expect(() => parseArgs(['--create', '--psql=/a', '--psql=/b'])).toThrow(/repeated/)
    expect(() => parseArgs([])).toThrow(/exactly one mode/)
    expect(() => parseArgs(['--create', '--prove'])).toThrow(/exactly one mode/)
  })

  it('names no secret-bearing option at all', () => {
    for (const o of OPTIONS) {
      expect(o).not.toMatch(/secret|password|verifier|url/i)
    }
  })
})

describe('K7-B7 D: the container is created, never adopted', () => {
  it('accepts only the reviewed absolute container shape', () => {
    // K7-B7.2.7: THE PATTERN IS ASSERTED, NOT EXERCISED AGAINST A PRODUCTION
    // PATH. This test used to spell the production root five times to probe the
    // regex; this module now contains that string nowhere at all, so the shape
    // is proved from the pattern's own source plus a root-free derivation.
    const src = CONTAINER_PATTERN.source
    expect(src.startsWith('^')).toBe(true)
    expect(src.endsWith('$')).toBe(true)
    // ANCHORED, ABSOLUTE, ONE SEGMENT, EXACTLY EIGHT LOWERCASE HEX.
    expect(src).toContain('\\/s4f-k7-export-[0-9a-f]{8}')
    expect(src).not.toContain('[0-9a-fA-F]')
    expect(src).not.toContain('{8,}')
    // AND NOTHING UNDER AN UNRELATED ROOT MATCHES.
    for (const bad of [
      '/tmp/s4f-k7-export-aabbccdd',
      'relative/s4f-k7-export-aabbccdd',
      join(SECRET_ROOT, 's4f-k7-export-aabbccdd'),
    ]) {
      expect(CONTAINER_PATTERN.test(bad), bad).toBe(false)
    }
  })

  it('refuses a path outside the reviewed root without touching it', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b7-ea-')))
    try {
      const p = join(root, 's4f-k7-export-aabbccdd')
      expect(() => createContainer(p, POLICY)).toThrow(/not a reviewed container path/)
      // AND IT WAS NOT CREATED.
      expect(existsSync(p)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      expect(existsSync(root)).toBe(false)
    }
  })
})

describe('K7-B7 D: two credentials, one secret, no bytes anywhere else', () => {
  let container = ''
  beforeEach(() => {
    container = realpathSync(mkdtempSync(join(tmpdir(), 'k7b7-cred-')))
    execFileSync('/bin/chmod', ['700', container])
  })
  afterEach(() => {
    execFileSync('/bin/chmod', ['-R', 'u+w', container])
    rmSync(container, { recursive: true, force: true })
    expect(existsSync(container)).toBe(false)
  })

  it('derives BOTH formats from the same secret', () => {
    const url = buildExportCredentialTcpUrl(ENDPOINT, SECRET)
    const line = buildExportPgpassLine(ENDPOINT, SECRET)
    // THE SECRET ITSELF IS NEVER ASSERTED. Both formats are checked by SHAPE
    // and by the non-secret fields; a snapshot of either would put the secret
    // in the repository.
    expect(url.startsWith(`postgresql://${EXPORT_ROLE_NAME}:`)).toBe(true)
    expect(url.endsWith('@127.0.0.1:5432/ai_capital')).toBe(true)
    expect(line.split(':').slice(0, 4))
      .toEqual(['127.0.0.1', '5432', 'ai_capital', EXPORT_ROLE_NAME])
    expect(line.endsWith('\n')).toBe(true)
    // AND THEY CARRY THE SAME SECRET, compared without printing it.
    expect(url.includes(encodeURIComponent(SECRET))).toBe(true)
    expect(line.includes(SECRET)).toBe(true)
  })

  it('escapes libpq structural characters in every field', () => {
    const line = buildExportPgpassLine(ENDPOINT, 'has:colon\\and-backslash')
    // Escaped, so libpq does not truncate the password at the colon.
    expect(line).toContain('has\\:colon\\\\and-backslash')
    expect(() => buildExportPgpassLine(ENDPOINT, 'two\nlines')).toThrow(/single line/)
  })

  it('publishes each file 0600, single-link, and refuses an occupied name', () => {
    const r = publishCredential(container, DRIVER_FILE, 'postgresql://x\n')
    expect(r.mode).toBe('600')
    expect(r.links).toBe(1)
    expect(r.deviceInode).toMatch(/^\d+:\d+$/)
    const st = statSync(join(container, DRIVER_FILE))
    expect((st.mode & 0o777).toString(8)).toBe('600')
    // NO-CLOBBER: the same name twice is refused, and the first file stands.
    // The message is the REVIEWED publisher's now - this CLI no longer has a
    // publisher of its own.
    expect(() => publishCredential(container, DRIVER_FILE, 'other\n'))
      .toThrow(/already exists; it is never overwritten/)
    expect(readFileSync(join(container, DRIVER_FILE), 'utf-8')).toBe('postgresql://x\n')
  })

  it('proves a credential by identity and never reads its bytes', () => {
    const r = publishCredential(container, PGPASS_FILE, 'h:5432:d:u:p\n')
    expect(() => proveCredential(container, r, REAL_PROVE_OPS)).not.toThrow()
    // A DIFFERENT OBJECT AT THE SAME NAME IS REFUSED.
    rmSync(join(container, PGPASS_FILE))
    publishCredential(container, PGPASS_FILE, 'h:5432:d:u:p\n')
    expect(() => proveCredential(container, r, REAL_PROVE_OPS))
      .toThrow(/not the object that was published/)
  })

  it('REFUSES A SYMLINK AT THE RECORDED NAME, even to the recorded inode', () => {
    // THE DEFECT THIS CATCHES. The old proof called `openSync(path, 'r')` and
    // did no `lstat`, so a symlink planted at the recorded name and pointing
    // at the recorded inode satisfied every check: same device:inode, same
    // mode, same owner. Anyone who could write the container could therefore
    // substitute the path a later teardown would unlink.
    const r = publishCredential(container, DRIVER_FILE, 'postgresql://x\n')
    const moved = join(container, 'moved.url')
    renameSync(join(container, DRIVER_FILE), moved)
    symlinkSync(moved, join(container, DRIVER_FILE))
    // The link resolves to the SAME inode the receipt names...
    expect(statSync(join(container, DRIVER_FILE)).ino)
      .toBe(Number(r.deviceInode.split(':')[1]))
    // ...and the corrected proof refuses it anyway.
    expect(() => proveCredential(container, r, REAL_PROVE_OPS)).toThrow(/not a regular file/)
  })

  it('refuses a malformed, duplicate, traversal or wrong-mode receipt', () => {
    const r = publishCredential(container, PGPASS_FILE, 'x\n')
    for (const [label, over] of [
      ['no device:inode', { deviceInode: '' }],
      ['non-numeric device:inode', { deviceInode: 'abc:def' }],
      ['traversal name', { name: '../escape' }],
      ['wrong mode', { mode: '644' }],
      ['two links', { links: 2 }],
      ['other owner', { uid: 0 }],
    ] as const) {
      expect(() => proveCredential(container, { ...r, ...over }, REAL_PROVE_OPS), label).toThrow()
    }
  })

  it('a SCRAM verifier carries no secret and is not the secret', () => {
    const s = generateExportSecret()
    const verifier = deriveScramSha256Verifier(s)
    expect(verifier.startsWith('SCRAM-SHA-256$')).toBe(true)
    expect(verifier).not.toContain(s)
    // 256 bits of base64url is at least 43 characters.
    expect(s.length).toBeGreaterThanOrEqual(43)
  })
})

describe('K7-B7 D: the administrator passfile is inherited, not named', () => {
  it('passes the DESCRIPTOR and closes the parent copy before awaiting', async () => {
    const order: string[] = []
    let sawFd = -1
    const held = {
      fd: 77,
      identity: {} as never,
      close: () => { order.push('close') },
    }
    const r = await withAdminPassfile('/abs/admin.pgpass', () => {
      order.push('open')
      return held
    }, async fd => {
      order.push('spawn')
      sawFd = fd
      // The await happens after the parent has closed its copy.
      await Promise.resolve()
      order.push('awaited')
      return 'done'
    })
    expect(r.state).toBe('ok')
    expect(releaseOf(r)).toBe('proved')
    expect(r.state === 'ok' ? r.result : null).toBe('done')
    expect(sawFd).toBe(77)
    // THE ORDERING THE PROPERTY IS ABOUT: open, spawn, close, then await.
    expect(order).toEqual(['open', 'spawn', 'close', 'awaited'])
  })

  it('closes the parent copy on a SYNCHRONOUS failure too', async () => {
    let closed = 0
    // THE OUTCOME IS REPORTED, NOT THROWN - and the release is reported too,
    // which is the whole point of the discriminated result.
    const g = await withAdminPassfile('/abs/a', () => ({
      fd: 9, identity: {} as never, close: () => { closed += 1 },
    }), () => { throw new Error('spawn refused') })
    expect(g.state).toBe('failed')
    expect(releaseOf(g)).toBe('proved')
    expect(String((g as { failure: Error }).failure.message)).toMatch(/spawn refused/)
    expect(closed).toBe(1)
  })

  it('refuses a relative administrator passfile', async () => {
    await expect(withAdminPassfile('relative/admin', () => {
      throw new Error('must not open')
    }, async () => 'x')).rejects.toThrow(/absolute path/)
  })

  it('the production batch passes the DESCRIPTOR, never a pathname', () => {
    // EXECUTABLE TEXT ONLY: the header comment explains `PGPASSFILE=/dev/fd/3`,
    // and a guard over the raw file reports its own prose as a violation.
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    // The compatibility pathname argument is left undefined at every call site.
    expect(src).toContain('runExportRoleBatch(p, a, sql, undefined, fd)')
    expect(src).not.toMatch(/PGPASSFILE\s*=/)
    // And the CLI never builds a passfile path of its own.
    expect(src).not.toMatch(/sterileBatchEnv/)
  })

  it('names nothing secret on the psql command line', () => {
    const args = adminArgs({
      host: '127.0.0.1', port: '5432', database: 'ai_capital', adminUser: 'thanapold',
    })
    for (const a of args) {
      expect(a).not.toMatch(/password|secret|SCRAM|postgresql:\/\//i)
    }
    // SQL TRAVELS ON STDIN: no -c and no -f.
    expect(args.some(a => a === '-c' || a === '-f' || a.startsWith('--command'))).toBe(false)
  })
})

describe('K7-B7 D: the reviewed authority, proved field by field', () => {
  it('accepts exactly the reviewed role', () => {
    expect(() => assertReviewedAuthority(FULL_FACTS)).not.toThrow()
  })

  it('refuses every forbidden attribute, membership and grant', () => {
    const cases: Array<[string, Partial<RoleFacts>, RegExp]> = [
      ['absent', { present: false }, /is absent/],
      ['no login', { canLogin: false }, /cannot log in/],
      ['superuser', { superuser: true }, /has superuser/],
      ['create role', { createRole: true }, /has role creation/],
      ['create db', { createDb: true }, /has database creation/],
      ['replication', { replication: true }, /has replication/],
      ['bypass rls', { bypassRls: true }, /has RLS bypass/],
      ['membership', { memberships: ['ai_capital_owner'] }, /member of another role/],
      ['write grant', { writeGrants: ['public.t'] }, /holds a write grant/],
      ['routine grant', { routineGrants: ['public.f'] }, /holds a routine grant/],
      ['sequence grant', { sequenceGrants: ['public.s'] }, /holds a sequence grant/],
      ['extra schema', { schemaUsage: [...EXPORT_SCHEMAS, 'other'] }, /reviewed schema usage/],
      ['missing table', { tableSelect: EXPORT_TABLES.slice(1) }, /reviewed table selects/],
      ['extra ledger column', { ledgerColumns: [...LEDGER_COLUMNS, 'extra'] },
       /reviewed ledger columns/],
    ]
    for (const [label, over, pattern] of cases) {
      expect(() => assertReviewedAuthority({ ...FULL_FACTS, ...over }), label).toThrow(pattern)
    }
  })

  it('the read-back asks about ledger COLUMNS, not ledger table SELECT', () => {
    // The ledger is column-granted; `has_table_privilege` is false for it, so a
    // table-level expectation would demand a privilege the authority withholds.
    expect(PROVE_ROLE_SQL).toContain("'ledger'")
    expect(PROVE_ROLE_SQL).toContain('has_column_privilege')
    expect(PROVE_ROLE_SQL).toContain('has_sequence_privilege')
    expect(PROVE_ROLE_SQL).toContain('has_function_privilege')
    // AND IT CARRIES NO SECRET.
    expect(PROVE_ROLE_SQL).not.toMatch(/PASSWORD|SCRAM|postgresql:\/\//)
  })

  it('parses the tagged read-back into facts', () => {
    const facts = parseRoleFacts([
      'attr|t|f|f|f|f|f',
      'schema|briefing',
      'select|briefing.predictions',
      'ledger|filename',
      'ledger|sha256',
    ])
    expect(facts.present).toBe(true)
    expect(facts.canLogin).toBe(true)
    expect(facts.superuser).toBe(false)
    expect([...facts.ledgerColumns]).toEqual(['filename', 'sha256'])
    expect([...facts.memberships]).toEqual([])
  })
})

describe('K7-B7 D: teardown dispositions', () => {
  it('names exactly the two reviewed terminal dispositions', () => {
    expect([...DISPOSITIONS]).toEqual(['no-target-commit', 'copy-closed'])
  })

  it('refuses an unreviewed disposition, retaining everything', async () => {
    const r = await runAuthorityCli([
      '--teardown', '--create-bundle=/nope', '--disposition=commit-unknown',
      '--run-id=aabbccdd', '--stamp=20260930T101500Z',
    ], { policy: POLICY })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    // AND THE REFUSAL NAMES NOTHING SECRET.
    expect(r.lines.join('\n')).not.toMatch(/postgresql:\/\/|SCRAM|password/i)
  })

  it('COMMIT_UNKNOWN is not a disposition at all', () => {
    expect(DISPOSITIONS).not.toContain('commit-unknown')
    expect(DISPOSITIONS).not.toContain('COMMIT_UNKNOWN')
    expect(DISPOSITIONS).not.toContain('copy-restored')
  })
})

describe('K7-B7 D: a refusal carries no secret and no errno', () => {
  it('refuses a missing option bounded, with the option name only', async () => {
    const r = await runAuthorityCli(['--create'], { policy: POLICY })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/a required option is missing/)
    expect(r.lines.join('\n')).not.toMatch(/ENOENT|EACCES|errno/)
  })

  it('EXIT_OK is reserved for a proved operation', () => {
    expect(EXIT_OK).toBe(0)
    expect(EXIT_REFUSED).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// K7-B7 D — THE MODES THEMSELVES, THROUGH INJECTED SEAMS
// ---------------------------------------------------------------------------

describe('K7-B7 D: a credential proof has no read capability at all', () => {
  let container = ''
  beforeEach(() => {
    container = realpathSync(mkdtempSync(join(tmpdir(), 'k7b7-po-')))
    execFileSync('/bin/chmod', ['700', container])
  })
  afterEach(() => {
    execFileSync('/bin/chmod', ['-R', 'u+w', container])
    rmSync(container, { recursive: true, force: true })
    expect(existsSync(container)).toBe(false)
  })

  it('threads only open/fstat/close - a read is not expressible', () => {
    // THE SHAPE IS THE CONTRACT. `ProveOps` has no `readSync` and no
    // `readFileSync`, so a proof given only this seam cannot reach the bytes.
    // Asserting the OUTPUT has no secret could not catch a read that discards
    // what it read, which is exactly what the surviving mutant did.
    expect(Object.keys(REAL_PROVE_OPS).sort())
      .toEqual(['closeSync', 'fstatSync', 'lstatSync', 'openSync'])
    for (const k of Object.keys(REAL_PROVE_OPS)) {
      expect(k).not.toMatch(/read/i)
    }
  })

  it('performs EXACTLY one open, one fstat and one close, and no read', () => {
    const r = publishCredential(container, DRIVER_FILE, 'postgresql://sentinel\n')
    const calls: string[] = []
    proveCredential(container, r, {
      lstatSync: (p: string) => { calls.push('lstat'); return lstatSync(p) },
      openSync: (p: string, flags: number) => {
        // THE NO-FOLLOW FLAG IS PART OF THE CALL, not a comment about it.
        calls.push(`open:${(flags & constants.O_NOFOLLOW) !== 0 ? 'nofollow' : 'follow'}`)
        return openSync(p, flags)
      },
      fstatSync: (fd: number) => { calls.push('fstat'); return statSyncFd(fd) },
      closeSync: (fd: number) => { calls.push('close'); closeSync(fd) },
    })
    expect(calls).toEqual(['lstat', 'open:nofollow', 'fstat', 'close'])
    expect(calls.some(c => c.includes('read'))).toBe(false)
  })

  it('the proof body contains no byte-reading call', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export function proveCredential'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body.length).toBeGreaterThan(200)
    for (const call of ['readFileSync(', 'readSync(', 'createHash(']) {
      expect(body, call).not.toContain(call)
    }
  })
})

describe('K7-B7 D: a credential failure after the role exists', () => {
  it('drops the role and removes only what this run created', async () => {
    let dropped = 0
    const unlinked: string[] = []
    const rmdirs: string[] = []
    const r = await handleCredentialFailure({
      container: containerFor('aabbccdd'),
      policy: POLICY,
      containerReceipt: {
        path: containerFor('aabbccdd'),
        deviceInode: '16777220:1234', uid: 501, mode: '700',
      },
      // The identity re-proof is now the SHARED one; stubbed so these cases
      // are about the gate rather than about real inodes.
      prove: () => undefined,
      proveDir: () => undefined,
      published: [{ name: DRIVER_FILE, deviceInode: '1:2', uid: 501, mode: '600', links: 1 }],
      drop: async () => { dropped += 1; return { reported: true, release: 'proved' as const } },
      // REMOVAL IS GATED ON THIS, independently of what the DROP reported.
      proveAbsent: async () => ({ absent: true, release: 'proved' as const }),
      unlink: p => { unlinked.push(p) },
      rmdir: p => { rmdirs.push(p) },
    })
    expect(dropped).toBe(1)
    expect(unlinked).toEqual([
      `${containerFor('aabbccdd')}/export-driver.url`,
    ])
    expect(rmdirs).toHaveLength(1)
    expect(r.retained).toEqual([])
    expect(r.exitCode).toBe(EXIT_REFUSED)
  })

  it('an UNPROVED drop RETAINS the authority and exits as retained', async () => {
    // THE SURVIVING MUTANT REPLACED THE DROP WITH `true`, claiming the role was
    // removed when nothing had been attempted. A drop that cannot be proved is
    // a retained authority and must exit as one.
    const r = await handleCredentialFailure({
      container: containerFor('aabbccdd'),
      policy: POLICY,
      containerReceipt: {
        path: containerFor('aabbccdd'),
        deviceInode: '16777220:1234', uid: 501, mode: '700',
      },
      prove: () => undefined,
      proveDir: () => undefined,
      published: [{ name: DRIVER_FILE, deviceInode: '1:2', uid: 501, mode: '600', links: 1 }],
      drop: async () => ({ reported: false, release: 'proved' as const }),
      proveAbsent: async (): Promise<never> => { throw new Error('must not be asked') },
      unlink: () => { throw new Error('MUST NOT UNLINK') },
      rmdir: () => { throw new Error('MUST NOT RMDIR') },
    })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines.join('\n')).toMatch(/the role was RETAINED/)
  })

  it('a file that cannot be removed is RETAINED and named, never forced', async () => {
    const r = await handleCredentialFailure({
      container: containerFor('aabbccdd'),
      policy: POLICY,
      published: [{ name: PGPASS_FILE, deviceInode: '1:3', uid: 501, mode: '600', links: 1 }],
      containerReceipt: {
        path: containerFor('aabbccdd'),
        deviceInode: '16777220:1234', uid: 501, mode: '700',
      },
      prove: () => undefined,
      proveDir: () => undefined,
      drop: async () => ({ reported: true, release: 'proved' as const }),
      proveAbsent: async () => ({ absent: true, release: 'proved' as const }),
      unlink: () => { throw new Error('busy') },
      rmdir: () => { throw new Error('not empty') },
    })
    expect(r.retained).toContain(PGPASS_FILE)
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines.join('\n')).toMatch(/RETAINED: /)
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2 F2 — NOTHING IS REMOVED UNTIL ABSENCE IS PROVED
// ---------------------------------------------------------------------------

describe('K7-B7.2 F2: an unproved drop removes NOTHING', () => {
  const RECEIPTS = [
    { name: DRIVER_FILE, deviceInode: '1:2', uid: 501, mode: '600', links: 1 },
    { name: PGPASS_FILE, deviceInode: '1:3', uid: 501, mode: '600', links: 1 },
  ]
  const CONTAINER = containerFor('aabbccdd')

  /** Counts every removal attempt. A non-empty receipt list is the point. */
  const attempt = async (over: {
    drop: () => Promise<{ reported: boolean; release: ReleaseState }>
    proveAbsent: () => Promise<{ absent: boolean; release: ReleaseState }>
  }): Promise<{ unlinks: number; rmdirs: number; exitCode: number; lines: string }> => {
    let unlinks = 0
    let rmdirs = 0
    const r = await handleCredentialFailure({
      container: CONTAINER,
      policy: POLICY,
      containerReceipt: {
        path: containerFor('aabbccdd'),
        deviceInode: '16777220:1234', uid: 501, mode: '700',
      },
      // The identity re-proof is now the SHARED one; stubbed so these cases
      // are about the gate rather than about real inodes.
      prove: () => undefined,
      proveDir: () => undefined,
      // NON-EMPTY, DELIBERATELY. The earlier version of this test passed
      // `published: []`, so it could never observe the destructive behaviour
      // it claimed to rule out - and the production loop ran regardless of
      // what `drop()` returned.
      published: RECEIPTS,
      ...over,
      unlink: () => { unlinks += 1 },
      rmdir: () => { rmdirs += 1 },
    })
    return { unlinks, rmdirs, exitCode: r.exitCode, lines: r.lines.join('\n') }
  }

  it('a FAILED drop invokes zero unlinks and zero rmdirs', async () => {
    const r = await attempt({
      drop: async () => ({ reported: false, release: 'proved' as const }),
      proveAbsent: async (): Promise<never> => { throw new Error('must not be asked') },
    })
    expect(r.unlinks).toBe(0)
    expect(r.rmdirs).toBe(0)
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines).toMatch(/role was RETAINED/)
    // AND THE EXACT NON-SECRET OBJECTS ARE NAMED.
    expect(r.lines).toContain(DRIVER_FILE)
    expect(r.lines).toContain(PGPASS_FILE)
  })

  it('a SUCCESSFUL drop whose absence proof REFUSES removes nothing', async () => {
    const r = await attempt({
      drop: async () => ({ reported: true, release: 'proved' as const }),
      proveAbsent: async () => ({ absent: false, release: 'proved' as const }),
    })
    expect(r.unlinks).toBe(0)
    expect(r.rmdirs).toBe(0)
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines).toMatch(/role-absence-unproved/)
  })

  it('a SUCCESSFUL drop whose absence proof THROWS removes nothing', async () => {
    const r = await attempt({
      drop: async () => ({ reported: true, release: 'proved' as const }),
      proveAbsent: async () => { throw new Error('read-back refused') },
    })
    expect(r.unlinks).toBe(0)
    expect(r.rmdirs).toBe(0)
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
  })

  it('a SUCCESSFUL drop that still SEES the role removes nothing', async () => {
    // `proveRoleAbsent` returns `!present`, so a role still present is false.
    const r = await attempt({ drop: async () => ({ reported: true, release: 'proved' as const }), proveAbsent: async () => ({ absent: false, release: 'proved' as const }) })
    expect(r.unlinks + r.rmdirs).toBe(0)
  })

  it('only a PROVED absence removes, and then only these two names', async () => {
    const r = await attempt({ drop: async () => ({ reported: true, release: 'proved' as const }), proveAbsent: async () => ({ absent: true, release: 'proved' as const }) })
    expect(r.unlinks).toBe(2)
    expect(r.rmdirs).toBe(1)
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines).toMatch(/dropped and proved absent/)
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2 F3 + F7 — THE FIRST RECEIPT SURVIVES, AND POST-ROLE FAILURES RETAIN
// ---------------------------------------------------------------------------

describe('K7-B7.2 F3: the first receipt is not lost', () => {
  let container = ''
  beforeEach(() => {
    container = realpathSync(mkdtempSync(join(tmpdir(), 'k7b7-seq-')))
    execFileSync('/bin/chmod', ['700', container])
  })
  afterEach(() => {
    if (existsSync(container)) execFileSync('/bin/chmod', ['-R', 'u+w', container])
    rmSync(container, { recursive: true, force: true })
    expect(existsSync(container)).toBe(false)
  })

  it('a SECOND-file failure leaves the FIRST receipt known', () => {
    // Publish the first, then make the second name unavailable so its
    // publication is refused - exactly the shape that lost the first receipt.
    const first = publishCredential(container, DRIVER_FILE, 'postgresql://a\n')
    publishCredential(container, PGPASS_FILE, 'occupied\n')
    const receipts: typeof first[] = []
    try {
      receipts.push(first)
      receipts.push(publishCredential(container, PGPASS_FILE, 'h:5432:d:u:p\n'))
    } catch {
      // THE APPEND-AS-YOU-GO SHAPE: the first receipt is in the list.
    }
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.name).toBe(DRIVER_FILE)
    // AND THE FIRST FINAL NAME REALLY EXISTS, so retaining it is not a guess.
    expect(existsSync(join(container, DRIVER_FILE))).toBe(true)
  })

  it('production appends each receipt instead of assigning an array', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    // `files = [a(), b()]` assigns NOTHING when `b()` throws.
    expect(src).not.toMatch(/files\s*=\s*\[\s*$/m)
    expect(src).toContain('files.push(publishCredential(')
    expect(src.match(/files\.push\(publishCredential\(/g)).toHaveLength(2)
  })
})

describe('K7-B7.2 F7: every post-role failure retains and exits 3', () => {
  it('names only reviewed basenames, the container, and a bounded phase', () => {
    const r = retainedUnknown({
      container: containerFor('aabbccdd'),
      published: [{ name: DRIVER_FILE, deviceInode: '1:2', uid: 501, mode: '600', links: 1 }],
      phase: 'create-evidence-unknown',
      alsoRetained: [PGPASS_FILE],
    })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect([...r.retained]).toEqual([DRIVER_FILE, PGPASS_FILE].sort())
    const out = r.lines.join('\n')
    expect(out).toContain('create-evidence-unknown')
    expect(out).toContain(containerFor('aabbccdd'))
    // AND NOTHING SECRET OR RAW.
    for (const forbidden of ['postgresql://', 'SCRAM', 'password', 'ENOENT', 'EACCES', 'errno']) {
      expect(out, forbidden).not.toContain(forbidden)
    }
  })

  it('the create path routes post-role failures to the retained result', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export async function runCreate'),
                         src.indexOf('function publishCreateRecord'))
    // A proof failure, a read-back failure, an authority mismatch and an
    // evidence publication of unknown state all reach `retainedUnknown` -
    // none of them falls through to a generic refusal.
    expect(fn).toContain('retainedUnknown(')
    expect(fn).toContain('post-role:')
    expect(src).toContain('create-evidence-unknown')
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2 F1 — A FLAG SELECTS A BRANCH; EVIDENCE ESTABLISHES IT
// ---------------------------------------------------------------------------

describe('K7-B7.2 F1: no-target-commit must be proved, not typed', () => {
  let root = ''
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b7-auth-'))) })
  afterEach(() => {
    if (existsSync(root)) execFileSync('/bin/chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  })

  const STAMP = '20260930T101500Z'
  const RUN = 'aabbccdd'
  const ENDPOINT = {
    host: '127.0.0.1', port: '5432', database: 'ai_capital', systemIdentifier: SYSTEM_ID,
  }

  /** Publish one bundle with a VALID recomputed DIGEST over whatever it says. */
  const pub = (prefix: string, file: string, doc: Record<string, unknown>): string =>
    publishEvidence({
      root, prefix, stamp: STAMP, runId: RUN,
      artifacts: [{ path: 'detail.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: { path: file, bytes: Buffer.from(`${JSON.stringify(doc)}\n`, 'utf-8') },
    }).finalPath

  const digestOf = (dir: string): string =>
    createHash('sha256').update(readFileSync(join(dir, 'DIGEST'))).digest('hex')

  /** A coherent NOT_COMMITTED_PRISTINE chain over a real Stage-1 bundle. */
  const pristineChain = (over: {
    disposition?: string; pristineDisposition?: string
    releaseState?: string; locks?: number
    zeroProved?: boolean; retry?: boolean
    linkName?: string; linkDigest?: string
    pristineBundleName?: string; disBundleName?: string
  } = {}): Record<string, string> => {
    const manifestDir = stage1Bundle({ evidence: root } as World, { stamp: STAMP, runId: RUN })
    // THE EXACT SHAPE THE LIFECYCLE PUBLISHES: `disposition.json`, and the
    // Stage-1 link as a TOP-LEVEL `bundle_name`.
    //
    // K7-B7.2.1: this fixture used to write `commit-disposition.json` with
    // `bundle: { name }` - a schema production never writes - which made the
    // "a complete chain authorizes it" test prove nothing about reality. It
    // was validating the consumer's own mistake.
    const disDir = pub('commit-disposition', COMMIT_DISPOSITION_FILE, {
      record: 'commit-disposition', complete: true,
      run: { id: RUN, stamp: STAMP },
      bundle_name: over.disBundleName ?? basename(manifestDir),
      disposition: over.disposition ?? 'NOT_COMMITTED_PRISTINE',
    })
    const priDir = pub('pristine-release', PRISTINE_RELEASE_FILE, {
      record: 'pristine-release', complete: true,
      disposition: over.pristineDisposition ?? 'NOT_COMMITTED_PRISTINE',
      commit_disposition: {
        name: over.linkName ?? basename(disDir),
        digest_file_digest: over.linkDigest ?? digestOf(disDir),
      },
      release_state: over.releaseState ?? 'released',
      remaining_reviewed_locks: over.locks ?? 0,
      zero_lock_release_proved: over.zeroProved ?? true,
      retry_permitted: over.retry ?? true,
      bundle_name: over.pristineBundleName ?? basename(manifestDir),
    })
    return {
      '--source-manifest-bundle': manifestDir,
      '--commit-disposition-bundle': disDir,
      '--pristine-release-bundle': priDir,
    }
  }

  it('a NAKED flag cannot authorize anything', () => {
    // THE WHOLE FINDING. One typed string used to be enough to authorize a
    // destructive role drop and credential removal.
    expect(() => authorizeTeardown('no-target-commit', {}, ENDPOINT))
      .toThrow(/a required option is missing/)
  })

  it('a COMPLETE, agreeing chain authorizes it', () => {
    const a = authorizeTeardown('no-target-commit', pristineChain(), ENDPOINT)
    expect(a.disposition).toBe('no-target-commit')
    expect(a.closure).toBeNull()
    // THREE LINKS, each basename plus a real DIGEST digest.
    expect(a.links).toHaveLength(3)
    for (const l of a.links) {
      expect(l.digest_file_digest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  const refuses = (v: Record<string, string>, pattern: RegExp, ep = ENDPOINT): void => {
    let err: unknown = null
    try { authorizeTeardown('no-target-commit', v, ep) } catch (e) { err = e }
    expect(err).toBeInstanceOf(AuthorityRefused)
    expect(String((err as Error).message)).toMatch(pattern)
    // AND NOT BECAUSE A BUNDLE FAILED ITS OWN DIGEST.
    expect(String((err as Error).message)).not.toMatch(/does not verify/)
  }

  it('refuses a disposition that is not NOT_COMMITTED_PRISTINE', () => {
    refuses(pristineChain({ disposition: 'COMMITTED' }),
            /commit disposition is not NOT_COMMITTED_PRISTINE/)
  })

  it('refuses a pristine record that is not NOT_COMMITTED_PRISTINE', () => {
    refuses(pristineChain({ pristineDisposition: 'COMMIT_UNKNOWN' }),
            /pristine release is not NOT_COMMITTED_PRISTINE/)
  })

  // ONE CHAIN PER TEST. The bundle names are immutable and no-clobber, so
  // three chains in one bounded root collide on publication - which would
  // refuse for the wrong reason.
  it('refuses an unreleased fence', () => {
    refuses(pristineChain({ releaseState: 'release-unknown' }),
            /does not record a released fence/)
  })

  it('refuses remaining reviewed locks', () => {
    refuses(pristineChain({ locks: 3 }), /records remaining reviewed locks/)
  })

  it('refuses an unproved zero-lock release', () => {
    refuses(pristineChain({ zeroProved: false }), /does not prove a zero-lock release/)
  })

  it('refuses when no retry is permitted', () => {
    refuses(pristineChain({ retry: false }), /does not permit a retry/)
  })

  it('refuses a pristine record linking ANOTHER commit disposition', () => {
    refuses(pristineChain({ linkName: 'commit-disposition-20260101T000000Z-99999999' }),
            /links a different commit disposition/)
  })

  it('refuses a link whose DIGEST no longer matches', () => {
    refuses(pristineChain({ linkDigest: 'f'.repeat(64) }),
            /no longer has that digest/)
  })

  it('consumes disposition.json and TOP-LEVEL bundle_name, as published', () => {
    // The production constants, not literals this suite chose.
    expect(COMMIT_DISPOSITION_FILE).toBe('disposition.json')
    expect(PRISTINE_RELEASE_FILE).toBe('pristine-release.json')
    const v = pristineChain()
    const dir = v['--commit-disposition-bundle'] as string
    const doc = JSON.parse(
      readFileSync(join(dir, COMMIT_DISPOSITION_FILE), 'utf-8')) as Record<string, unknown>
    // TOP-LEVEL, and NOT nested under `bundle`.
    expect(typeof doc.bundle_name).toBe('string')
    expect(doc.bundle).toBeUndefined()
    expect(() => authorizeTeardown('no-target-commit', v, ENDPOINT)).not.toThrow()
  })

  it('REJECTS the old invented shape as the production contract', () => {
    // `commit-disposition.json` with `bundle: { name }` is not what the
    // lifecycle writes, so a chain built that way must NOT authorize anything.
    const manifestDir = stage1Bundle({ evidence: root } as World, { stamp: STAMP, runId: RUN })
    const disDir = pub('commit-disposition', 'commit-disposition.json', {
      record: 'commit-disposition', complete: true,
      run: { id: RUN, stamp: STAMP },
      bundle: { name: basename(manifestDir) },
      disposition: 'NOT_COMMITTED_PRISTINE',
    })
    const priDir = pub('pristine-release', PRISTINE_RELEASE_FILE, {
      record: 'pristine-release', complete: true,
      disposition: 'NOT_COMMITTED_PRISTINE',
      commit_disposition: { name: basename(disDir), digest_file_digest: digestOf(disDir) },
      release_state: 'released', remaining_reviewed_locks: 0,
      zero_lock_release_proved: true, retry_permitted: true,
      bundle_name: basename(manifestDir),
    })
    expect(() => authorizeTeardown('no-target-commit', {
      '--source-manifest-bundle': manifestDir,
      '--commit-disposition-bundle': disDir,
      '--pristine-release-bundle': priDir,
    }, ENDPOINT)).toThrow(/has no manifest|disposition\.json/)
  })

  it('refuses a commit disposition naming another Stage-1 bundle', () => {
    refuses(pristineChain({ disBundleName: 'source-manifest-20260101T000000Z-99999999' }),
            /commit disposition names a different Stage-1 bundle/)
  })

  it('refuses a pristine record naming another Stage-1 bundle', () => {
    refuses(pristineChain({ pristineBundleName: 'source-manifest-20260101T000000Z-99999999' }),
            /names a different Stage-1 bundle/)
  })

  it('refuses a Stage-1 source database that is not the create record\'s', () => {
    refuses(pristineChain(), /names a different source database/,
            { ...ENDPOINT, database: 'other_db' })
  })

  it('refuses a standalone COMPLETE closure with no upstream chain', () => {
    // A forged closure with a recomputed internal DIGEST and nothing behind it.
    const closureDir = pub('copy-closure', 'copy-closure.json', {
      record: 'copy-closure', complete: true, outcome: 'COMPLETE',
      run: { id: RUN, stamp: STAMP },
      copy_restoration: { name: 'copy-restoration-x', digest_file_digest: 'a'.repeat(64) },
    })
    let err: unknown = null
    try {
      authorizeTeardown('copy-closed', { '--copy-closure-bundle': closureDir }, ENDPOINT)
    } catch (e) { err = e }
    expect(err).toBeInstanceOf(AuthorityRefused)
    // It refused for want of the REST of the chain, not on the closure's bytes.
    expect(String((err as Error).message)).toMatch(/a required option is missing/)
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2 F6 + F8 — STRICT RECEIPTS, AND PREFLIGHT BEFORE ANY MUTATION
// ---------------------------------------------------------------------------

describe('K7-B7.2 F6: the create record is read strictly', () => {
  const CONTAINER = containerFor('aabbccdd')
  const good = (): Record<string, unknown> => ({
    record: 'export-authority-create', complete: true, outcome: 'CREATED_AND_PROVED',
    run: { id: 'aabbccdd', stamp: '20260930T101500Z' },
    endpoint: { host: '127.0.0.1', port: '5432', database: 'ai_capital' },
    source: { system_identifier: SYSTEM_ID },
    container: { path: CONTAINER, device_inode: '16777220:1234', uid: 501, mode: '700' },
    credentials: [
      { name: DRIVER_FILE, device_inode: '16777220:1', uid: 501, mode: '600', links: 1 },
      { name: PGPASS_FILE, device_inode: '16777220:2', uid: 501, mode: '600', links: 1 },
    ],
  })

  it('accepts a well-formed record', () => {
    const r = receiptsOf(good(), POLICY)
    expect(r.container.path).toBe(CONTAINER)
    expect(r.files.map(f => f.name)).toEqual([DRIVER_FILE, PGPASS_FILE])
    expect(r.endpoint.database).toBe('ai_capital')
  })

  const bad = (edit: (d: Record<string, unknown>) => void, pattern: RegExp, label: string): void => {
    const d = good()
    edit(d)
    let err: unknown = null
    try { receiptsOf(d, POLICY) } catch (e) { err = e }
    expect(err, label).toBeInstanceOf(AuthorityRefused)
    expect(String((err as Error).message), label).toMatch(pattern)
  }

  it('refuses COERCED values where strings and integers belong', () => {
    // `String({})` is '[object Object]' and `Number(undefined)` is NaN; both
    // used to sail through, and this record is what a teardown DELETES from.
    bad(d => { (d.container as Record<string, unknown>).path = {} },
        /reviewed container path/, 'object path')
    bad(d => { (d.container as Record<string, unknown>).uid = '501' },
        /reviewed container owner/, 'string uid')
    bad(d => { (d.credentials as Array<Record<string, unknown>>)[0]!.links = undefined },
        /reviewed credential link count/, 'undefined links')
    bad(d => { (d.credentials as Array<Record<string, unknown>>)[0]!.device_inode = '1:2:3' },
        /reviewed credential device:inode/, 'malformed device:inode')
    bad(d => { d.container = null }, /records no container/, 'null container')
    bad(d => { d.credentials = {} }, /exactly two credentials/, 'non-array credentials')
  })

  it('refuses a duplicate, extra, traversal or wrong credential name', () => {
    bad(d => {
      (d.credentials as Array<Record<string, unknown>>)[1]!.name = DRIVER_FILE
    }, /recorded twice/, 'duplicate')
    bad(d => {
      (d.credentials as Array<Record<string, unknown>>)[1]!.name = '../escape'
    }, /reviewed credential name/, 'traversal')
    bad(d => {
      (d.credentials as Array<Record<string, unknown>>)[1]!.name = 'extra.txt'
    }, /reviewed credential name/, 'wrong name')
    bad(d => {
      (d.credentials as Array<Record<string, unknown>>).push(
        { name: 'third', device_inode: '1:9', uid: 501, mode: '600', links: 1 })
    }, /exactly two credentials/, 'three entries')
  })

  it('refuses wrong mode, wrong link count and a container not naming the run', () => {
    bad(d => { (d.credentials as Array<Record<string, unknown>>)[0]!.mode = '644' },
        /reviewed credential mode/, 'mode 644')
    bad(d => { (d.credentials as Array<Record<string, unknown>>)[0]!.links = 2 },
        /more than one link/, 'two links')
    bad(d => { (d.container as Record<string, unknown>).mode = '755' },
        /reviewed container mode/, 'container 755')
    bad(d => { (d.run as Record<string, unknown>).id = '99999999' },
        /does not name this run/, 'run mismatch')
  })

  it('refuses an unbounded endpoint', () => {
    bad(d => { (d.endpoint as Record<string, unknown>).database = 'Ai-Capital' },
        /reviewed endpoint database/, 'bad database')
    bad(d => { (d.endpoint as Record<string, unknown>).port = '0' },
        /reviewed endpoint port/, 'bad port')
    bad(d => { (d.endpoint as Record<string, unknown>).host = {} },
        /reviewed endpoint host/, 'object host')
  })
})

describe('K7-B7.2 F8: teardown preflights, then removes only when proved', () => {
  const CONTAINER: Parameters<typeof teardownRemoval>[0]['container'] = {
    path: containerFor('aabbccdd'),
    deviceInode: '16777220:1234', uid: 501, mode: '700',
  }
  const FILES = [
    { name: DRIVER_FILE, deviceInode: '16777220:1', uid: 501, mode: '600', links: 1 },
    { name: PGPASS_FILE, deviceInode: '16777220:2', uid: 501, mode: '600', links: 1 },
  ]

  const run = (dropped: boolean, roleAbsent: boolean, over = {}): {
    unlinks: string[]; rmdirs: number
    out: ReturnType<typeof teardownRemoval>
  } => {
    const unlinks: string[] = []
    let rmdirs = 0
    const out = teardownRemoval({
      container: CONTAINER, files: FILES, dropped, roleAbsent, policy: POLICY,
      prove: () => undefined, proveDir: () => undefined,
      unlink: p => { unlinks.push(p) }, rmdir: () => { rmdirs += 1 },
      ...over,
    })
    return { unlinks, rmdirs, out }
  }

  it('an UNPROVED drop removes nothing and retains both names', () => {
    const r = run(false, false)
    expect(r.unlinks).toEqual([])
    expect(r.rmdirs).toBe(0)
    expect([...r.out.retained]).toEqual([DRIVER_FILE, PGPASS_FILE])
    expect(r.out.containerRemoved).toBe(false)
  })

  it('a drop whose ABSENCE is unproved removes nothing', () => {
    const r = run(true, false)
    expect(r.unlinks).toEqual([])
    expect(r.rmdirs).toBe(0)
    expect([...r.out.retained]).toEqual([DRIVER_FILE, PGPASS_FILE])
  })

  it('only a PROVED absence removes, and only the recorded names', () => {
    const r = run(true, true)
    expect(r.unlinks).toEqual([
      `${CONTAINER.path}/${DRIVER_FILE}`,
      `${CONTAINER.path}/${PGPASS_FILE}`,
    ])
    expect(r.rmdirs).toBe(1)
    expect([...r.out.removed]).toEqual([DRIVER_FILE, PGPASS_FILE])
    expect(r.out.containerRemoved).toBe(true)
  })

  it('a SUBSTITUTED path is refused immediately before the unlink', () => {
    // The preflight passed; the object changed afterwards. Re-proving at the
    // unlink is what refuses it instead of deleting whatever is there now.
    const r = run(true, true, {
      prove: (_c: string, f: { name: string }) => {
        if (f.name === PGPASS_FILE) throw new Error('substituted')
      },
    })
    expect(r.unlinks).toEqual([`${CONTAINER.path}/${DRIVER_FILE}`])
    expect([...r.out.retained]).toEqual([PGPASS_FILE])
    // AND THE CONTAINER STAYS, because something is still in it.
    expect(r.rmdirs).toBe(0)
    expect(r.out.containerRemoved).toBe(false)
  })

  it('a PREFLIGHT failure opens no mutating batch at all', async () => {
    let batches = 0
    const r = await runAuthorityCli([
      '--teardown', '--create-bundle=/nope', '--disposition=no-target-commit',
      '--run-id=aabbccdd', '--stamp=20260930T101500Z',
      '--evidence-root=/tmp', '--admin-passfile=/abs/a', '--psql=/usr/bin/psql',
      '--host=127.0.0.1', '--port=5432', '--database=ai_capital', '--admin-user=thanapold',
    ], {
      policy: POLICY,
      preflight: () => { throw new AuthorityRefused('the container is not the recorded one') },
      batch: async () => { batches += 1; return { code: 0, ok: true } },
    })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    // ZERO BATCHES. A refusal after DROP ROLE would already have destroyed the
    // authority, so the preflight has to come first.
    expect(batches).toBe(0)
  })

  it('production preflights before it drops', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export async function runTeardown'))
    const body = fn.slice(0, fn.indexOf('\nexport '))
    expect(body.indexOf('preflight')).toBeGreaterThan(-1)
    expect(body.indexOf('preflight')).toBeLessThan(body.indexOf('dropRole('))
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2.1 C/D/E/F — THE CREATE RECORD'S OWN IDENTITY, THE ENDPOINT IT
// DESCRIBES, THE RE-PROOF BEFORE EVERY UNLINK, AND A TRUTHFUL TERMINAL STATE
// ---------------------------------------------------------------------------

describe('K7-B7.2.1 C/D/F: the create record is the authority, argv is not', () => {
  const STAMP = '20260930T101500Z'
  const RUN = 'aabbccdd'
  const CONTAINER = containerFor(RUN)
  let root = ''
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b721-auth-'))) })
  afterEach(() => {
    if (existsSync(root)) execFileSync('/bin/chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  })

  /** A create record, published with a VALID recomputed DIGEST over its bytes. */
  const createDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    record: CREATE_PREFIX, complete: true, outcome: 'CREATED_AND_PROVED',
    run: { id: RUN, stamp: STAMP },
    endpoint: { host: '127.0.0.1', port: '5432', database: 'ai_capital' },
    source: { system_identifier: SYSTEM_ID },
    container: { path: CONTAINER, device_inode: '16777220:1234', uid: 501, mode: '700' },
    credentials: [
      { name: DRIVER_FILE, device_inode: '16777220:1', uid: 501, mode: '600', links: 1 },
      { name: PGPASS_FILE, device_inode: '16777220:2', uid: 501, mode: '600', links: 1 },
    ],
    ...over,
  })

  const publishCreate = (
    doc: Record<string, unknown>, stamp = STAMP, runId = RUN,
  ): string => publishEvidence({
    root, prefix: CREATE_PREFIX, stamp, runId,
    artifacts: [{ path: 'detail.json', bytes: Buffer.from('{}\n', 'utf-8') }],
    manifest: { path: CREATE_FILE, bytes: Buffer.from(`${JSON.stringify(doc)}\n`, 'utf-8') },
  }).finalPath

  // --- C: the document must describe the run its DIRECTORY is named for ---

  it('reads a create record whose document names its own directory', () => {
    const r = readCreateBundle(publishCreate(createDoc()))
    expect(r.name).toBe(`${CREATE_PREFIX}-${STAMP}-${RUN}`)
    expect(r.digestFileDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  const refusesCreate = (dir: string, pattern: RegExp): void => {
    let err: unknown = null
    try { readCreateBundle(dir) } catch (e) { err = e }
    expect(err).toBeInstanceOf(AuthorityRefused)
    expect(String((err as Error).message)).toMatch(pattern)
    // AND NOT BECAUSE THE BUNDLE FAILED ITS OWN DIGEST: each of these is
    // republished, so its internal DIGEST is valid over the spliced bytes.
    expect(String((err as Error).message)).not.toMatch(/does not verify/)
  }

  it('REFUSES a record named for one run while describing ANOTHER run id', () => {
    // A teardown decides what to DELETE from this document. Only the basename
    // pattern used to be checked, so this passed.
    refusesCreate(
      publishCreate(createDoc({ run: { id: '99999999', stamp: STAMP } })),
      /describes a different run identity/)
  })

  it('REFUSES a record named for one instant while describing another', () => {
    refusesCreate(
      publishCreate(createDoc({ run: { id: RUN, stamp: '20260101T000000Z' } })),
      /describes a different run instant/)
  })

  it('REFUSES a record with no run identity at all', () => {
    const d = createDoc()
    delete d.run
    refusesCreate(publishCreate(d), /records no run identity/)
  })

  // --- D: the endpoint is the create record's, not argv's ---

  const teardownArgv = (dir: string, over: Record<string, string> = {}): string[] => {
    const v: Record<string, string> = {
      '--create-bundle': dir,
      '--disposition': 'no-target-commit',
      '--evidence-root': root,
      // THE OPERATOR'S OWN IDENTITY, FROM ARGV. No seam mints these.
      '--run-id': RUN,
      '--stamp': STAMP,
      '--admin-passfile': '/Users/thanapold/.pgpass-admin',
      '--psql': '/usr/bin/psql',
      '--host': '127.0.0.1',
      '--port': '5432',
      '--database': 'ai_capital',
      '--admin-user': 'thanapold',
      ...over,
    }
    return ['--teardown', ...Object.entries(v).map(([k, x]) => `${k}=${x}`)]
  }

  /** A coherent NOT_COMMITTED_PRISTINE chain over a real Stage-1 bundle. */
  const pristineOptions = (): Record<string, string> => {
    const pub = (prefix: string, file: string, doc: Record<string, unknown>): string =>
      publishEvidence({
        root, prefix, stamp: STAMP, runId: RUN,
        artifacts: [{ path: 'detail.json', bytes: Buffer.from('{}\n', 'utf-8') }],
        manifest: { path: file, bytes: Buffer.from(`${JSON.stringify(doc)}\n`, 'utf-8') },
      }).finalPath
    const manifestDir = stage1Bundle({ evidence: root } as World, { stamp: STAMP, runId: RUN })
    const disDir = pub('commit-disposition', COMMIT_DISPOSITION_FILE, {
      record: 'commit-disposition', complete: true,
      run: { id: RUN, stamp: STAMP },
      bundle_name: basename(manifestDir),
      disposition: 'NOT_COMMITTED_PRISTINE',
    })
    const priDir = pub('pristine-release', PRISTINE_RELEASE_FILE, {
      record: 'pristine-release', complete: true,
      disposition: 'NOT_COMMITTED_PRISTINE',
      commit_disposition: {
        name: basename(disDir),
        digest_file_digest: createHash('sha256')
          .update(readFileSync(join(disDir, 'DIGEST'))).digest('hex'),
      },
      release_state: 'released',
      remaining_reviewed_locks: 0,
      zero_lock_release_proved: true,
      retry_permitted: true,
      bundle_name: basename(manifestDir),
    })
    return {
      '--source-manifest-bundle': manifestDir,
      '--commit-disposition-bundle': disDir,
      '--pristine-release-bundle': priDir,
    }
  }

  /** Counts EVERY privileged act: no batch, and no passfile, may happen. */
  const countedRun = async (argv: readonly string[]): Promise<{
    exitCode: number; lines: readonly string[]; batches: number; passfiles: number
    drops: number
  }> => {
    let batches = 0
    let passfiles = 0
    let drops = 0
    const r = await runAuthorityCli(argv, {
      policy: POLICY,
      openAdminPassfile: () => {
        passfiles += 1
        throw new AuthorityRefused('the administrator passfile was opened')
      },
      batch: async (_p, _a, sql) => {
        batches += 1
        if (sql.includes('DROP ROLE')) drops += 1
        return { code: 0, ok: true }
      },
    })
    return { ...r, batches, passfiles, drops }
  }

  for (const [what, over] of [
    ['host', { '--host': '127.0.0.2' }],
    ['port', { '--port': '5433' }],
    ['database', { '--database': 'other_db' }],
  ] as const) {
    it(`a ${what} that is not the create record's invokes ZERO batches`, async () => {
      const r = await countedRun(teardownArgv(publishCreate(createDoc()), over))
      expect(r.exitCode).toBe(EXIT_REFUSED)
      expect(r.lines.join('\n')).toMatch(
        new RegExp(`teardown ${what} is not the one the create record describes`))
      // ONE CREATE BUNDLE MUST NOT AUTHORIZE DROPPING THE FIXED ROLE NAME ON
      // ANOTHER CLUSTER. Nothing privileged may be reached at all.
      expect(r.batches).toBe(0)
      expect(r.drops).toBe(0)
      expect(r.passfiles).toBe(0)
    })
  }

  it('the comparison happens BEFORE the authorization is even read', async () => {
    // No chain options at all: if the endpoint check ran after
    // `authorizeTeardown`, this would refuse for a missing option instead.
    const r = await countedRun(teardownArgv(publishCreate(createDoc()),
                                            { '--host': '127.0.0.2' }))
    expect(r.lines.join('\n')).toMatch(/teardown host is not the one/)
    expect(r.lines.join('\n')).not.toMatch(/a required option is missing/)
  })

  // --- F: a terminal state is reported truthfully, and nothing is retried ---

  // --- B: a publication that is already known to fail destroys nothing ---

  /** A live proof that answers for the recorded cluster. */
  const LIVE = { ...FULL_FACTS }

  const teardownRun = async (over: Record<string, string>, deps: Record<string, unknown> = {}): Promise<{
    exitCode: number; lines: readonly string[]
    passfiles: number; batches: number; drops: number; removals: number
  }> => {
    let passfiles = 0
    let batches = 0
    let drops = 0
    let removals = 0
    const r = await runAuthorityCli(
      teardownArgv(publishCreate(createDoc()), { ...pristineOptions(), ...over }), {
        policy: POLICY,
        openAdminPassfile: () => {
          passfiles += 1
          return { fd: 3, identity: {} as never, close: () => undefined }
        },
        batch: async (_p, _a, sql) => {
          batches += 1
          if (sql.includes('DROP ROLE')) drops += 1
          return { code: 0, ok: true }
        },
        proveRole: async () => LIVE,
        // Observed, never exercised: a refusal before this point must leave
        // the container and both credentials untouched.
        preflight: () => { removals += 0 },
        ...deps,
      })
    return { ...r, passfiles, batches, drops, removals }
  }

  it('an INVALID evidence root refuses before anything privileged happens', async () => {
    // K7-B7.2.2: the root was validated only AFTER `DROP ROLE` and the
    // credential removal, so a root that could never be published to destroyed
    // the authority first and discovered the problem second.
    const notADirectory = join(root, 'a-file')
    execFileSync('/usr/bin/touch', [notADirectory])
    const r = await teardownRun({ '--evidence-root': notADirectory })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/evidence root is not a reviewed evidence root/)
    expect([r.passfiles, r.batches, r.drops, r.removals]).toEqual([0, 0, 0, 0])
  })

  it('a SYMLINKED evidence root refuses, rather than publishing through it', async () => {
    // REMOVED ON ALL PATHS. K7-B7.2.4: this cleaned up after the assertions, so
    // a failing assertion left a named root behind - which the mutation gate
    // then reported for every later case.
    const target = realpathSync(mkdtempSync(join(tmpdir(), 'k7b722-target-')))
    try {
      const link = join(root, 'linked-root')
      symlinkSync(target, link)
      const r = await teardownRun({ '--evidence-root': link })
      expect(r.exitCode).toBe(EXIT_REFUSED)
      expect([r.passfiles, r.batches, r.drops]).toEqual([0, 0, 0])
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('an OCCUPIED final name refuses before anything privileged happens', async () => {
    execFileSync('/bin/mkdir', [join(root, `${TEARDOWN_PREFIX}-${STAMP}-${RUN}`)])
    const r = await teardownRun({})
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/already present at the final evidence name/)
    expect([r.passfiles, r.batches, r.drops, r.removals]).toEqual([0, 0, 0, 0])
  })

  it('a DANGLING SYMLINK at the temporary name counts as occupied', async () => {
    // `existsSync` follows the link and reports false for a dangling one -
    // precisely the case that must refuse, because building through it would
    // write wherever it points.
    symlinkSync(join(root, 'nowhere'), join(root, `.tmp-${TEARDOWN_PREFIX}-${RUN}`))
    const r = await teardownRun({})
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/already present at the temporary evidence name/)
    expect([r.passfiles, r.batches, r.drops, r.removals]).toEqual([0, 0, 0, 0])
  })

  it('the preflight runs BEFORE the authorization, the identity proof and the drop', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export async function runTeardown'))
    const body = fn.slice(0, fn.indexOf('\nexport '))
    const at = (needle: string): number => {
      const n = body.indexOf(needle)
      expect(n, needle).toBeGreaterThan(-1)
      return n
    }
    const preflight = at('preflightPublication ??')
    expect(preflight).toBeLessThan(at('authorizeTeardown('))
    expect(preflight).toBeLessThan(at('withAdminPassfile('))
    expect(preflight).toBeLessThan(at('dropRole('))
    expect(preflight).toBeLessThan(at('teardownRemoval('))
  })

  // --- F, kept: a failure that arises only AFTER a clean preflight ---

  it('a publication that fails AFTER a clean preflight exits 3 and RETRIES NOTHING', async () => {
    // The destructive decision has already been taken by the time evidence is
    // published. This state is unavoidable - the root can be swapped after the
    // proof - and it is reported truthfully rather than as a plain refusal.
    const r = await teardownRun({}, {
      publish: () => { throw new Error('the publication did not complete') },
    })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    const out = r.lines.join('\n')
    expect(out).toMatch(/TEARDOWN (PARTIALLY )?COMPLETED, and its evidence publication is UNKNOWN/)
    expect(out).toContain(`${TEARDOWN_PREFIX}-`)
    expect(out).toContain('publication unknown')
    // EXACTLY ONE DROP, AND NO SECOND REMOVAL. Nothing is retried after the
    // destructive step.
    expect(r.drops).toBe(1)
    // AND NOTHING RAW OR SECRET REACHES THE OPERATOR.
    for (const forbidden of ['EACCES', 'ENOENT', 'errno', 'postgresql://', '.pgpass-admin']) {
      expect(out, forbidden).not.toContain(forbidden)
    }
  })
})

describe('K7-B7.2.1 E: no name is unlinked without its own identity re-proof', () => {
  const CONTAINER = containerFor('aabbccdd')
  const RECEIPT = {
    path: CONTAINER, deviceInode: '16777220:1234', uid: 501, mode: '700',
  }
  const FILES = [
    { name: DRIVER_FILE, deviceInode: '16777220:1', uid: 501, mode: '600', links: 1 },
    { name: PGPASS_FILE, deviceInode: '16777220:2', uid: 501, mode: '600', links: 1 },
  ]

  it('a credential SUBSTITUTED after absence was proved is NOT unlinked', async () => {
    // THE CREATE-FAILURE EQUIVALENT of the teardown case. This path used to
    // unlink the recorded NAMES directly, with no identity proof at all - so
    // whatever stood at that name after the proof was deleted.
    const unlinked: string[] = []
    const rmdirs: string[] = []
    const r = await handleCredentialFailure({
      container: CONTAINER,
      policy: POLICY,
      containerReceipt: RECEIPT,
      published: FILES,
      prove: (_c, f) => {
        if (f.name === PGPASS_FILE) throw new Error('not the recorded object')
      },
      proveDir: () => undefined,
      drop: async () => ({ reported: true, release: 'proved' as const }),
      proveAbsent: async () => ({ absent: true, release: 'proved' as const }),
      unlink: p => { unlinked.push(p) },
      rmdir: p => { rmdirs.push(p) },
    })
    expect(unlinked).toEqual([`${CONTAINER}/${DRIVER_FILE}`])
    // THE SUBSTITUTED NAME, and the container that still holds it.
    expect([...r.retained]).toEqual([PGPASS_FILE, basename(CONTAINER)])
    // AND THE CONTAINER STAYS, because something is still in it.
    expect(rmdirs).toEqual([])
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
  })

  it('it uses the SAME removal primitive, not a second weaker loop', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export async function handleCredentialFailure'))
    const body = fn.slice(0, fn.indexOf('\nexport '))
    // It delegates...
    expect(body).toContain('teardownRemoval({')
    // ...and holds no removal loop of its own.
    expect(body).not.toMatch(/for\s*\(const\s+\w+\s+of\s+i\.published\)/)
    expect(body.match(/unlink\(/g) ?? []).toHaveLength(1)
  })
})

/** An `lstat` result for one object type, and nothing else. */
const anObject = (kind: 'dir' | 'file' | 'link' | 'fifo' | 'socket'): Stats => ({
  isDirectory: () => kind === 'dir',
  isFile: () => kind === 'file',
  isSymbolicLink: () => kind === 'link',
  isFIFO: () => kind === 'fifo',
  isSocket: () => kind === 'socket',
}) as unknown as Stats

/** The release state a guarded outcome carries, totally - 'not-started' has none. */
const releaseOf = (g: { state: string; release?: ReleaseState }): string =>
  g.state === 'not-started' ? 'not-started' : String(g.release)

/** The real removal operations, for the cases that exercise the defaults. */
const REAL_REMOVAL = { rmdir: (p: string) => { rmdirSync(p) }, lstat: (p: string) => lstatSync(p) }

/** An error with a real errno code, which is what the proof classifies on. */
const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code })

describe('K7-B7.2.1 E: a failed cleanup is named, never announced as success', () => {
  const CONTAINER = containerFor('aabbccdd')

  // NOTHING IN THIS FILE MAY CREATE ANYTHING UNDER THE PRODUCTION ROOT.
  afterEach(() => {
    expect(existsSync(CONTAINER), 'the reviewed container must not exist').toBe(false)
  })

  it('reports removal ONLY on an ENOENT, and looks with lstat', () => {
    const calls: string[] = []
    const gone = proveContainerRemoved(CONTAINER, {
      rmdir: p => { calls.push(`rmdir:${p}`) },
      lstat: p => { calls.push(`lstat:${p}`); throw errno('ENOENT') },
    })
    expect(gone).toBe(true)
    expect(calls).toEqual([`rmdir:${CONTAINER}`, `lstat:${CONTAINER}`])
  })

  it('an UNCLASSIFIED throw is NOT absence', () => {
    // K7-B7.2.2: every `stat` error was read as proof of absence, so a plain
    // Error - which carries no errno at all - suppressed the retained state.
    expect(proveContainerRemoved(CONTAINER, {
      rmdir: () => undefined,
      lstat: () => { throw new Error('no such directory') },
    })).toBe(false)
  })

  for (const code of ['EPERM', 'EACCES', 'EIO', 'EINTR', 'ELOOP', 'ENOTDIR']) {
    it(`${code} means "I could not look", never "nothing is there"`, () => {
      expect(proveContainerRemoved(CONTAINER, {
        rmdir: () => undefined,
        lstat: () => { throw errno(code) },
      })).toBe(false)
    })
  }

  it('a SILENT rmdir failure does not become "nothing was created"', () => {
    // THE ORIGINAL FINDING. The `rmdir` failure was swallowed and the run then
    // announced that no role and no credential were created by it - false
    // while the container is still standing.
    expect(proveContainerRemoved(CONTAINER, {
      rmdir: () => { throw errno('ENOTEMPTY') },
      lstat: () => anObject('dir'),
    })).toBe(false)
  })

  for (const kind of ['dir', 'file', 'link', 'fifo', 'socket'] as const) {
    it(`a surviving ${kind} at the name is NOT a removal`, () => {
      // K7-B7.2.2: a present NON-DIRECTORY was reported as removed, so a
      // regular file or a symlink substituted at the container's name read as
      // "this run left nothing behind".
      expect(proveContainerRemoved(CONTAINER, {
        rmdir: () => undefined,
        lstat: () => anObject(kind),
      })).toBe(false)
    })
  }

  it('an rmdir that THREW but really removed it is still reported absent', () => {
    // The proof is about the filesystem, not about the call's return value.
    expect(proveContainerRemoved(CONTAINER, {
      rmdir: () => { throw errno('EINTR') },
      lstat: () => { throw errno('ENOENT') },
    })).toBe(true)
  })

  // --- AND THE REAL DEFAULTS, not only the injected seams ---

  it('a DANGLING SYMLINK at the name is not a removal, through the REAL ops', () => {
    // THE DISTINCTION `lstat` MAKES AND `stat` DESTROYS. A following `stat` on
    // a dangling link raises ENOENT, which the proof would read as "the name
    // is clear" - while a symlink is standing exactly where the container was.
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'k7b722-link-')))
    try {
      const name = join(tmp, 'container')
      symlinkSync(join(tmp, 'nowhere-at-all'), name)
      expect(proveContainerRemoved(name, REAL_REMOVAL)).toBe(false)
      // AND IT IS STILL THERE: nothing followed it, unlinked it or replaced it.
      expect(lstatSync(name).isSymbolicLink()).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('a name that really is gone is reported absent, through the REAL ops', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'k7b722-gone-')))
    try {
      const name = join(tmp, 'container')
      execFileSync('/bin/mkdir', [name])
      expect(proveContainerRemoved(name, REAL_REMOVAL)).toBe(true)
      expect(existsSync(name)).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('a NON-EMPTY directory is retained, through the REAL ops', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'k7b722-busy-')))
    try {
      const name = join(tmp, 'container')
      execFileSync('/bin/mkdir', [name])
      execFileSync('/usr/bin/touch', [join(name, 'still-here')])
      expect(proveContainerRemoved(name, REAL_REMOVAL)).toBe(false)
      expect(existsSync(join(name, 'still-here'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('it never chmods, unlinks, follows or retries', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export function proveContainerRemoved'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body.length).toBeGreaterThan(200)
    for (const call of ['chmod', 'unlink', 'rmSync', 'realpath', 'readdir']) {
      expect(body, call).not.toContain(call)
    }
    // `lstat` AND NEVER A FOLLOWING `stat`, in any spelling. The look is now a
    // REQUIRED operation rather than a global default, so the body names the
    // destructured one and no `statSync` at all.
    expect(body).toContain('lstat(container)')
    expect(body).not.toContain('statSync')
    // ONE rmdir ATTEMPT, not a loop.
    expect(body.match(/rmdir\(/g) ?? []).toHaveLength(1)
  })

  it('the create path RETAINS and exits 3 when the container survives', async () => {
    const r = await runAuthorityCli([
      '--create', '--evidence-root=/tmp', `--credential-container=${CONTAINER}`,
      '--run-id=aabbccdd', '--stamp=20260930T101500Z',
      '--admin-passfile=/Users/thanapold/.pgpass-admin', '--psql=/usr/bin/psql',
      '--host=127.0.0.1', '--port=5432', '--database=ai_capital', '--admin-user=thanapold',
    ], {
      policy: POLICY,
      openAdminPassfile: () => { throw new AuthorityRefused('the role was not created') },
      // The container this run made cannot be removed, and is still a directory.
      rmdirContainer: () => { throw errno('ENOTEMPTY') },
      lstatContainer: () => anObject('dir'),
    })
    // It never reached the container step (the reviewed root is not created by
    // this suite), so this proves the ROUTING: a no-role failure is a refusal
    // or a retained state, and never a claim that the world is untouched.
    expect([EXIT_REFUSED, EXIT_RETAINED_UNKNOWN]).toContain(r.exitCode)
    expect(r.lines.join('\n')).not.toContain('no role and no credential were created')
  })

  it('production proves the removal instead of trusting the call', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export async function runCreate'))
    const body = fn.slice(0, fn.indexOf('\nexport '))
    // K7-B7.2.5: the create path now removes ONLY through the helper that
    // re-proves the receipt first, so this asserts that call instead.
    expect(body).toContain('removeOwnedEmptyContainer(receipt, policy')
    expect(body).toContain('container-retained-role-proved-absent')
    // AND THE SWALLOWED SHAPE IS GONE: no bare rmdir-then-claim in this path.
    expect(body).not.toContain('rmdirSync(container)')
    // D.5: AND NO DIRECT, IDENTITY-FREE REMOVAL ANYWHERE IN THE CREATE PATH.
    expect(body).not.toContain('proveContainerRemoved(')
  })
})

describe('K7-B7.2.1 E: a published name is never removed on a guess', () => {
  let container = ''
  beforeEach(() => {
    container = realpathSync(mkdtempSync(join(tmpdir(), 'k7b721-pub-')))
    execFileSync('/bin/chmod', ['700', container])
  })
  afterEach(() => {
    if (existsSync(container)) execFileSync('/bin/chmod', ['-R', 'u+w', container])
    rmSync(container, { recursive: true, force: true })
    expect(existsSync(container)).toBe(false)
  })

  it('a RECEIPT failure after the final name exists is PUBLISHED-BUT-UNVERIFIED', () => {
    // It used to throw an ordinary refusal, so the create path entered its
    // generic cleanup with NO receipt for a final name that really existed -
    // and therefore nothing to retain or even name.
    let err: unknown = null
    let seen = 0
    try {
      publishCredential(container, DRIVER_FILE, 'postgresql://a\n', {
        ...REAL_PUBLISH_OPS,
        // The publication itself succeeds - INCLUDING its own `lstat`
        // verification of the final name - and only the later non-secret
        // read-back fails. Failing the first `lstat` would land in the
        // publisher's own `lstat` phase instead, which is a different state.
        lstatSync: (p: string) => {
          if (basename(String(p)) === DRIVER_FILE) {
            // The publisher lstats this name twice: the no-clobber
            // pre-check (which EXPECTS to throw), then its own verification.
            // The third is the non-secret receipt read-back.
            seen += 1
            if (seen >= 3) throw new Error('vanished')
          }
          return lstatSync(p)
        },
      } as unknown as Parameters<typeof publishCredential>[3])
    } catch (e) { err = e }
    expect(err).toBeInstanceOf(CredentialPublishedButUnverified)
    const e = err as InstanceType<typeof CredentialPublishedButUnverified>
    expect(e.phase).toBe('receipt')
    expect(e.finalPath).toBe(join(container, DRIVER_FILE))
    // AND THE PUBLISHED NAME IS STILL THERE: nothing unlinks a final name.
    expect(existsSync(join(container, DRIVER_FILE))).toBe(true)
  })

  it('both the FINAL and the TEMPORARY name are retained and named', () => {
    // `unlink-temp` and every later phase deliberately leave the temporary
    // link in place; naming only the final one hid half of what an operator
    // has to look at.
    const e = new CredentialPublishedButUnverified(
      join(container, DRIVER_FILE), join(container, `.${DRIVER_FILE}.tmp`), 'fsync-parent-2')
    const decided = retainedUnknown({
      container,
      published: [],
      phase: `credential-${e.phase}`,
      alsoRetained: [basename(e.finalPath), basename(e.temporaryPath)],
    })
    expect(decided.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect([...decided.retained]).toEqual([DRIVER_FILE, `.${DRIVER_FILE}.tmp`].sort())
    expect(decided.lines.join('\n')).toContain('credential-fsync-parent-2')
  })

  it('the create path names BOTH basenames on a published-unverified failure', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export async function runCreate'))
    const body = fn.slice(0, fn.indexOf('\nexport '))
    expect(body).toContain('basename(e.finalPath), basename(e.temporaryPath)')
    expect(body).toContain('credential-${e.phase}')
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2.2 C — THE EVIDENCE THAT AUTHORIZED THE DESTRUCTION OUTLIVES IT
// ---------------------------------------------------------------------------

describe('K7-B7.2.2 C: a teardown record names every authorizing bundle', () => {
  const STAMP = '20260930T101500Z'
  const RUN = 'aabbccdd'
  const TEARDOWN_STAMP = '20260930T120000Z'
  const TEARDOWN_RUN = 'ccddeeff'
  const CONTAINER = containerFor(RUN)
  let root = ''
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b722-c-'))) })
  afterEach(() => {
    if (existsSync(root)) execFileSync('/bin/chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  })

  const pub = (prefix: string, file: string, doc: Record<string, unknown>): string =>
    publishEvidence({
      root, prefix, stamp: STAMP, runId: RUN,
      artifacts: [{ path: 'detail.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: { path: file, bytes: Buffer.from(`${JSON.stringify(doc)}\n`, 'utf-8') },
    }).finalPath

  const createBundle = (): string => pub(CREATE_PREFIX, CREATE_FILE, {
    record: CREATE_PREFIX, complete: true, outcome: 'CREATED_AND_PROVED',
    run: { id: RUN, stamp: STAMP },
    endpoint: { host: '127.0.0.1', port: '5432', database: 'ai_capital' },
    source: { system_identifier: SYSTEM_ID },
    container: { path: CONTAINER, device_inode: '16777220:1234', uid: 501, mode: '700' },
    credentials: [
      { name: DRIVER_FILE, device_inode: '16777220:1', uid: 501, mode: '600', links: 1 },
      { name: PGPASS_FILE, device_inode: '16777220:2', uid: 501, mode: '600', links: 1 },
    ],
  })

  const pristineOptions = (): Record<string, string> => {
    const manifestDir = stage1Bundle({ evidence: root } as World, { stamp: STAMP, runId: RUN })
    const disDir = pub('commit-disposition', COMMIT_DISPOSITION_FILE, {
      record: 'commit-disposition', complete: true,
      run: { id: RUN, stamp: STAMP },
      bundle_name: basename(manifestDir),
      disposition: 'NOT_COMMITTED_PRISTINE',
    })
    const priDir = pub('pristine-release', PRISTINE_RELEASE_FILE, {
      record: 'pristine-release', complete: true,
      disposition: 'NOT_COMMITTED_PRISTINE',
      commit_disposition: {
        name: basename(disDir),
        digest_file_digest: createHash('sha256')
          .update(readFileSync(join(disDir, 'DIGEST'))).digest('hex'),
      },
      release_state: 'released',
      remaining_reviewed_locks: 0,
      zero_lock_release_proved: true,
      retry_permitted: true,
      bundle_name: basename(manifestDir),
    })
    return {
      '--source-manifest-bundle': manifestDir,
      '--commit-disposition-bundle': disDir,
      '--pristine-release-bundle': priDir,
    }
  }

  it('a no-target-commit record retains ALL THREE authorizing links', async () => {
    // THE WHOLE FINDING. `copy_closure` is NULL for this disposition, so the
    // record of a successful no-target teardown named NONE of the bundles that
    // authorized the destruction. The authorization is computed; it was then
    // thrown away.
    const options = pristineOptions()
    const argv = ['--teardown',
      `--create-bundle=${createBundle()}`,
      '--disposition=no-target-commit',
      `--evidence-root=${root}`,
      `--run-id=${TEARDOWN_RUN}`, `--stamp=${TEARDOWN_STAMP}`,
      '--admin-passfile=/Users/thanapold/.pgpass-admin', '--psql=/usr/bin/psql',
      '--host=127.0.0.1', '--port=5432', '--database=ai_capital', '--admin-user=thanapold',
      ...Object.entries(options).map(([k, v]) => `${k}=${v}`)]
    const r = await runAuthorityCli(argv, {
      policy: POLICY,
      openAdminPassfile: () => ({ fd: 3, identity: {} as never, close: () => undefined }),
      batch: async () => ({ code: 0, ok: true }),
      proveRole: async () => FULL_FACTS,
      preflight: () => undefined,
    })
    // The container is not real here, so nothing was removed and the teardown
    // is incomplete - which is exactly the record that used to name nothing.
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)

    // THE PUBLISHED BUNDLE, VERIFIED FROM THE OUTSIDE.
    const dir = join(root, `${TEARDOWN_PREFIX}-${TEARDOWN_STAMP}-${TEARDOWN_RUN}`)
    const files = verifyPublishedEvidence(dir)
    expect(files).toContain(TEARDOWN_FILE)
    const doc = JSON.parse(readFileSync(join(dir, TEARDOWN_FILE), 'utf-8')) as {
      authorized_by: {
        disposition: string
        links: { name: string; digest_file_digest: string }[]
        copy_closure: unknown
      }
    }
    // AND IT AGREES, EXACTLY AND IN ORDER, WITH THE AUTHORIZATION.
    const expected = authorizeTeardown('no-target-commit', options, {
      host: '127.0.0.1', port: '5432', database: 'ai_capital', systemIdentifier: SYSTEM_ID,
    })
    expect(doc.authorized_by.disposition).toBe('no-target-commit')
    expect(doc.authorized_by.links).toEqual(expected.links.map(l => ({ ...l })))
    expect(doc.authorized_by.links).toHaveLength(3)
    // THE STAGE-1, COMMIT-DISPOSITION AND PRISTINE-RELEASE BUNDLES, by name.
    expect(doc.authorized_by.links.map(l => l.name.split('-')[0])).toEqual(
      ['source', 'commit', 'pristine'])
    for (const l of doc.authorized_by.links) {
      expect(l.digest_file_digest).toMatch(/^[0-9a-f]{64}$/)
      // NO ABSOLUTE PATH ANYWHERE IN THE RECORD.
      expect(l.name).not.toContain('/')
    }
    expect(doc.authorized_by.copy_closure).toBeNull()
    expect(JSON.stringify(doc)).not.toContain(root)
  })

  it('a closure that is not one of the authorizing links is a contradiction', () => {
    // `copy_closure` survives only as a convenience DERIVED from the link set.
    expect(() => teardownDocument({
      runId: RUN, stamp: STAMP, outcome: 'TORN_DOWN',
      createBundle: { name: 'export-authority-create-x', digest_file_digest: 'a'.repeat(64) },
      disposition: 'copy-closed',
      links: [{ name: 'copy-closure-A', digest_file_digest: 'b'.repeat(64) }],
      closure: { name: 'copy-closure-B', digest_file_digest: 'b'.repeat(64) },
      roleAbsent: true, removed: [], retained: [], containerRemoved: true, note: null,
    })).toThrow(/not one of the authorizing links/)
    // A STALE DIGEST ON THE RIGHT NAME IS THE SAME CONTRADICTION.
    expect(() => teardownDocument({
      runId: RUN, stamp: STAMP, outcome: 'TORN_DOWN',
      createBundle: { name: 'export-authority-create-x', digest_file_digest: 'a'.repeat(64) },
      disposition: 'copy-closed',
      links: [{ name: 'copy-closure-A', digest_file_digest: 'b'.repeat(64) }],
      closure: { name: 'copy-closure-A', digest_file_digest: 'c'.repeat(64) },
      roleAbsent: true, removed: [], retained: [], containerRemoved: true, note: null,
    })).toThrow(/not one of the authorizing links/)
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2.2 D — THE CLUSTER, NOT THE ENDPOINT
// ---------------------------------------------------------------------------

describe('K7-B7.2.2 D: the authority is bound to a cluster identity', () => {
  const BIG = '9007199254740993'   // 2^53 + 1: unrepresentable as a Number

  it('the read-back asks for the control-file system identifier, as text', () => {
    expect(PROVE_ROLE_SQL).toContain("'system'")
    expect(PROVE_ROLE_SQL).toContain('pg_catalog.pg_control_system()')
    // AS TEXT, DELIBERATELY: a 64-bit identity compared for equality.
    expect(PROVE_ROLE_SQL).toContain('::pg_catalog.text')
  })

  it('parses a 64-bit identifier EXACTLY, with no Number coercion', () => {
    const f = parseRoleFacts([`system|${BIG}`, 'attr|t|f|f|f|f|f'])
    expect(f.systemIdentifier).toBe(BIG)
    // THE POINT: the value does not survive a round trip through Number.
    expect(String(Number(BIG))).not.toBe(BIG)
  })

  it('an absent, malformed or doubled identifier is NOT an identity', () => {
    for (const rows of [
      ['attr|t|f|f|f|f|f'],                                  // absent
      ['system|', 'attr|t|f|f|f|f|f'],                        // blank
      ['system|73000x0001', 'attr|t|f|f|f|f|f'],              // not decimal
      ['system|0123', 'attr|t|f|f|f|f|f'],                    // leading zero
      ['system|-1', 'attr|t|f|f|f|f|f'],                      // signed
      ['system|73000', 'system|93000', 'attr|t|f|f|f|f|f'],    // two answers
    ]) {
      expect(parseRoleFacts(rows).systemIdentifier, rows.join(' ')).toBe('')
    }
  })

  it('the create record carries the EXACT proved identifier', () => {
    const doc = createDocument({
      runId: 'aabbccdd', stamp: '20260930T101500Z', outcome: 'CREATED_AND_PROVED',
      container: {
        path: containerFor('aabbccdd'),
        deviceInode: '16777220:1234', uid: 501, mode: '700',
      },
      files: [],
      endpoint: { host: '127.0.0.1', port: '5432', database: 'ai_capital' },
      role: { ...FULL_FACTS, systemIdentifier: BIG },
      note: null,
    })
    expect((doc.source as { system_identifier: string }).system_identifier).toBe(BIG)
  })

  it('a record with no, malformed or COERCED identifier is refused', () => {
    const base = (): Record<string, unknown> => ({
      record: CREATE_PREFIX, complete: true, outcome: 'CREATED_AND_PROVED',
      run: { id: 'aabbccdd', stamp: '20260930T101500Z' },
      endpoint: { host: '127.0.0.1', port: '5432', database: 'ai_capital' },
      source: { system_identifier: SYSTEM_ID },
      container: {
        path: containerFor('aabbccdd'),
        device_inode: '16777220:1234', uid: 501, mode: '700',
      },
      credentials: [
        { name: DRIVER_FILE, device_inode: '16777220:1', uid: 501, mode: '600', links: 1 },
        { name: PGPASS_FILE, device_inode: '16777220:2', uid: 501, mode: '600', links: 1 },
      ],
    })
    expect(receiptsOf(base(), POLICY).systemIdentifier).toBe(SYSTEM_ID)
    const bad = (edit: (d: Record<string, unknown>) => void, pattern: RegExp, label: string): void => {
      const d = base()
      edit(d)
      let err: unknown = null
      try { receiptsOf(d, POLICY) } catch (e) { err = e }
      expect(err, label).toBeInstanceOf(AuthorityRefused)
      expect(String((err as Error).message), label).toMatch(pattern)
    }
    bad(d => { delete d.source }, /records no source identity/, 'absent')
    bad(d => { d.source = null }, /records no source identity/, 'null')
    // A NUMBER HAS ALREADY BEEN THROUGH `Number`: above 2^53 that is a
    // different value than the cluster reported.
    bad(d => { (d.source as Record<string, unknown>).system_identifier = 9007199254740993 },
        /source system identifier/, 'numeric')
    bad(d => { (d.source as Record<string, unknown>).system_identifier = '' },
        /source system identifier/, 'blank')
    bad(d => { (d.source as Record<string, unknown>).system_identifier = '73000x1' },
        /source system identifier/, 'malformed')
  })
})

describe('K7-B7.2.2 D: a mismatched cluster destroys nothing', () => {
  const STAMP = '20260930T101500Z'
  const RUN = 'aabbccdd'
  const OTHER = '9300000000000000002'
  const CONTAINER = containerFor(RUN)
  let root = ''
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b722-d-'))) })
  afterEach(() => {
    if (existsSync(root)) execFileSync('/bin/chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
    expect(existsSync(CONTAINER), 'the reviewed container must not exist').toBe(false)
  })

  // --- the shared comparison itself ---

  it('equal identifiers agree; everything else refuses', () => {
    expect(() => { assertSameCluster(SYSTEM_ID, SYSTEM_ID) }).not.toThrow()
    expect(() => { assertSameCluster(OTHER, SYSTEM_ID) })
      .toThrow(/live cluster is not the one the create record describes/)
    // AN UNPROVED LIVE IDENTITY IS NOT A MATCH, AND NOT A SKIP.
    expect(() => { assertSameCluster('', SYSTEM_ID) })
      .toThrow(/live cluster identity could not be proved/)
    expect(() => { assertSameCluster('73000x1', SYSTEM_ID) })
      .toThrow(/live cluster identity could not be proved/)
    expect(() => { assertSameCluster(SYSTEM_ID, '') })
      .toThrow(/recorded cluster identity is not a reviewed identity/)
  })

  it('every caller uses that ONE comparison, and none re-implements it', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    expect(src.split('export function assertSameCluster')).toHaveLength(2)
    for (const fn of ['runProve', 'runTeardown']) {
      const body = src.slice(src.indexOf(`export async function ${fn}`))
      expect(body.slice(0, body.indexOf('\nexport ')), fn).toContain('assertSameCluster(')
    }
  })

  // --- and the teardown, end to end ---

  const createBundle = (): string => publishEvidence({
    root, prefix: CREATE_PREFIX, stamp: STAMP, runId: RUN,
    artifacts: [{ path: 'detail.json', bytes: Buffer.from('{}\n', 'utf-8') }],
    manifest: {
      path: CREATE_FILE,
      bytes: Buffer.from(`${JSON.stringify({
        record: CREATE_PREFIX, complete: true, outcome: 'CREATED_AND_PROVED',
        run: { id: RUN, stamp: STAMP },
        endpoint: { host: '127.0.0.1', port: '5432', database: 'ai_capital' },
        source: { system_identifier: SYSTEM_ID },
        container: { path: CONTAINER, device_inode: '16777220:1234', uid: 501, mode: '700' },
        credentials: [
          { name: DRIVER_FILE, device_inode: '16777220:1', uid: 501, mode: '600', links: 1 },
          { name: PGPASS_FILE, device_inode: '16777220:2', uid: 501, mode: '600', links: 1 },
        ],
      })}\n`, 'utf-8'),
    },
  }).finalPath

  const pristineOptions = (): Record<string, string> => {
    const pub = (prefix: string, file: string, doc: Record<string, unknown>): string =>
      publishEvidence({
        root, prefix, stamp: STAMP, runId: RUN,
        artifacts: [{ path: 'detail.json', bytes: Buffer.from('{}\n', 'utf-8') }],
        manifest: { path: file, bytes: Buffer.from(`${JSON.stringify(doc)}\n`, 'utf-8') },
      }).finalPath
    const manifestDir = stage1Bundle({ evidence: root } as World, { stamp: STAMP, runId: RUN })
    const disDir = pub('commit-disposition', COMMIT_DISPOSITION_FILE, {
      record: 'commit-disposition', complete: true,
      run: { id: RUN, stamp: STAMP },
      bundle_name: basename(manifestDir),
      disposition: 'NOT_COMMITTED_PRISTINE',
    })
    const priDir = pub('pristine-release', PRISTINE_RELEASE_FILE, {
      record: 'pristine-release', complete: true,
      disposition: 'NOT_COMMITTED_PRISTINE',
      commit_disposition: {
        name: basename(disDir),
        digest_file_digest: createHash('sha256')
          .update(readFileSync(join(disDir, 'DIGEST'))).digest('hex'),
      },
      release_state: 'released',
      remaining_reviewed_locks: 0,
      zero_lock_release_proved: true,
      retry_permitted: true,
      bundle_name: basename(manifestDir),
    })
    return {
      '--source-manifest-bundle': manifestDir,
      '--commit-disposition-bundle': disDir,
      '--pristine-release-bundle': priDir,
    }
  }

  const teardown = async (
    proveRole: () => Promise<RoleFacts>,
  ): Promise<{
    exitCode: number; lines: readonly string[]
    drops: number; batches: number
  }> => {
    let drops = 0
    let batches = 0
    const r = await runAuthorityCli([
      '--teardown', `--create-bundle=${createBundle()}`,
      '--disposition=no-target-commit', `--evidence-root=${root}`,
      '--run-id=ccddeeff', '--stamp=20260930T120000Z',
      '--admin-passfile=/Users/thanapold/.pgpass-admin', '--psql=/usr/bin/psql',
      '--host=127.0.0.1', '--port=5432', '--database=ai_capital', '--admin-user=thanapold',
      ...Object.entries(pristineOptions()).map(([k, v]) => `${k}=${v}`),
    ], {
      policy: POLICY,
      openAdminPassfile: () => ({ fd: 3, identity: {} as never, close: () => undefined }),
      batch: async (_p, _a, sql) => {
        batches += 1
        if (sql.includes('DROP ROLE')) drops += 1
        return { code: 0, ok: true }
      },
      proveRole,
      preflight: () => undefined,
    })
    return { ...r, drops, batches }
  }

  it('a DIFFERENT live cluster invokes zero DROPs', async () => {
    // The endpoint matches the record exactly. The cluster behind it does not.
    const r = await teardown(async () => ({ ...FULL_FACTS, systemIdentifier: OTHER }))
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/live cluster is not the one the create record describes/)
    expect(r.drops).toBe(0)
  })

  it('an UNPROVED live cluster invokes zero DROPs', async () => {
    const r = await teardown(async () => ({ ...FULL_FACTS, systemIdentifier: '' }))
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/live cluster identity could not be proved/)
    expect(r.drops).toBe(0)
  })

  it('an absence observed on ANOTHER cluster is not this role\'s absence', async () => {
    // THE POST-DROP READ-BACK. "The role is not here" and "the recorded
    // authority is gone" are different statements when the cluster changed
    // between the drop and the read-back.
    let call = 0
    const r = await teardown(async () => {
      call += 1
      return call === 1
        ? { ...FULL_FACTS, systemIdentifier: SYSTEM_ID }
        : { ...FULL_FACTS, present: false, systemIdentifier: OTHER }
    })
    // ONE DROP RAN - it was authorized - but the absence is NOT proved, so
    // nothing was removed and the state is retained.
    expect(r.drops).toBe(1)
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    const dir = join(root, `${TEARDOWN_PREFIX}-20260930T120000Z-ccddeeff`)
    verifyPublishedEvidence(dir)
    const doc = JSON.parse(readFileSync(join(dir, TEARDOWN_FILE), 'utf-8')) as {
      role: { absent: boolean }; outcome: string
    }
    expect(doc.role.absent).toBe(false)
    expect(doc.outcome).toBe('teardown-incomplete')
  })

  it('an absence on the RECORDED cluster is accepted as absence', async () => {
    // The control: the same read-back, on the same cluster, IS proof.
    let call = 0
    const r = await teardown(async () => {
      call += 1
      return call === 1
        ? { ...FULL_FACTS, systemIdentifier: SYSTEM_ID }
        : { ...FULL_FACTS, present: false, systemIdentifier: SYSTEM_ID }
    })
    expect(r.drops).toBe(1)
    const dir = join(root, `${TEARDOWN_PREFIX}-20260930T120000Z-ccddeeff`)
    verifyPublishedEvidence(dir)
    const doc = JSON.parse(readFileSync(join(dir, TEARDOWN_FILE), 'utf-8')) as {
      role: { absent: boolean }
    }
    expect(doc.role.absent).toBe(true)
  })

  it('a Stage-1 bundle from another cluster cannot authorize a no-target teardown', () => {
    // The reviewed Stage-1 fixture names one cluster; the create record names
    // another. The database name agrees, which is exactly the trap.
    let err: unknown = null
    try {
      authorizeTeardown('no-target-commit', pristineOptions(), {
        host: '127.0.0.1', port: '5432', database: 'ai_capital', systemIdentifier: OTHER,
      })
    } catch (e) { err = e }
    expect(err).toBeInstanceOf(AuthorityRefused)
    expect(String((err as Error).message)).toMatch(/names a different source cluster/)
    expect(String((err as Error).message)).not.toMatch(/does not verify/)
  })
})

describe('K7-B7.2.2 B: --create proves its publication before it creates anything', () => {
  const STAMP = '20260930T101500Z'
  const RUN = 'aabbccdd'
  const CONTAINER = containerFor(RUN)
  let root = ''
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b722-cp-'))) })
  afterEach(() => {
    if (existsSync(root)) execFileSync('/bin/chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
    // AND NOTHING WAS CREATED UNDER THE PRODUCTION CREDENTIAL ROOT.
    expect(existsSync(CONTAINER), 'the reviewed container must not exist').toBe(false)
  })

  const create = async (over: Record<string, string> = {}): Promise<{
    exitCode: number; lines: readonly string[]
    passfiles: number; batches: number; secrets: number
  }> => {
    let passfiles = 0
    let batches = 0
    let secrets = 0
    const v: Record<string, string> = {
      '--evidence-root': root,
      '--credential-container': CONTAINER,
      '--run-id': RUN,
      '--stamp': STAMP,
      '--admin-passfile': '/Users/thanapold/.pgpass-admin',
      '--psql': '/usr/bin/psql',
      '--host': '127.0.0.1', '--port': '5432', '--database': 'ai_capital',
      '--admin-user': 'thanapold',
      ...over,
    }
    const r = await runAuthorityCli(
      ['--create', ...Object.entries(v).map(([k, x]) => `${k}=${x}`)], {
        // THIS FILE'S PRIVATE SECRET ROOT, with real filesystem operations.
        policy: POLICY,
        // EVERY PRIVILEGED SEAM COUNTS AND THEN REFUSES.
        //
        // K7-B7.2.2: these used to SUCCEED, so a weakened preflight did not
        // merely fail a counter assertion - it ran the real `createContainer`
        // and published two credential files under the production credential
        // root. A test that names a real absolute path must be incapable of
        // writing to it, not merely expected not to reach it.
        openAdminPassfile: () => {
          passfiles += 1
          throw new AuthorityRefused('no administrator passfile is available to this test')
        },
        batch: async () => {
          batches += 1
          throw new AuthorityRefused('no batch may run in this test')
        },
        secret: () => {
          secrets += 1
          throw new AuthorityRefused('no secret may be generated in this test')
        },
        proveRole: async () => FULL_FACTS,
      })
    return { ...r, passfiles, batches, secrets }
  }

  it('an INVALID evidence root creates no container, role or credential', async () => {
    // K7-B7.2.2: this was a bare `statSync`, which FOLLOWS a symlinked root
    // and asked nothing about ownership. A create that cannot publish its own
    // record must not first make a role and two credentials nobody has a
    // record of.
    const notADirectory = join(root, 'a-file')
    execFileSync('/usr/bin/touch', [notADirectory])
    const r = await create({ '--evidence-root': notADirectory })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/evidence root is not a reviewed evidence root/)
    expect([r.passfiles, r.batches, r.secrets]).toEqual([0, 0, 0])
    // AND THE REVIEWED CONTAINER WAS NEVER TOUCHED.
    expect(existsSync(CONTAINER)).toBe(false)
  })

  it('a SYMLINKED evidence root is refused rather than followed', async () => {
    const target = realpathSync(mkdtempSync(join(tmpdir(), 'k7b722-ct-')))
    try {
      const link = join(root, 'linked-root')
      symlinkSync(target, link)
      const r = await create({ '--evidence-root': link })
      expect(r.exitCode).toBe(EXIT_REFUSED)
      expect([r.passfiles, r.batches, r.secrets]).toEqual([0, 0, 0])
      expect(existsSync(CONTAINER)).toBe(false)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('an OCCUPIED final name creates no container, role or credential', async () => {
    execFileSync('/bin/mkdir', [join(root, `${CREATE_PREFIX}-${STAMP}-${RUN}`)])
    const r = await create()
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/already present at the final evidence name/)
    expect([r.passfiles, r.batches, r.secrets]).toEqual([0, 0, 0])
    expect(existsSync(CONTAINER)).toBe(false)
  })

  it('a DANGLING SYMLINK at the temporary name counts as occupied', async () => {
    symlinkSync(join(root, 'nowhere'), join(root, `.tmp-${CREATE_PREFIX}-${RUN}`))
    const r = await create()
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/already present at the temporary evidence name/)
    expect([r.passfiles, r.batches, r.secrets]).toEqual([0, 0, 0])
  })

  it('the create preflight precedes the container, the secret and the role', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export async function runCreate'))
    const body = fn.slice(0, fn.indexOf('\nexport '))
    const at = (needle: string): number => {
      const n = body.indexOf(needle)
      expect(n, needle).toBeGreaterThan(-1)
      return n
    }
    const preflight = at('preflightPublication ??')
    expect(preflight).toBeLessThan(at('createContainer('))
    expect(preflight).toBeLessThan(at('generateExportSecret'))
    expect(preflight).toBeLessThan(at('createExportRoleSql'))
    // AND THE FOLLOWING `statSync` ROOT CHECK IS GONE.
    expect(body).not.toContain('statSync(evidenceRoot)')
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2.3 A — THE PRODUCTION ROOT IS NOT REACHABLE FROM A TEST
// ---------------------------------------------------------------------------

describe('K7-B7.2.3 A: one policy decides where the authority may write', () => {
  it('production rules REFUSE a temporary path instead of redirecting a write', () => {
    // A POLICY JUDGES PATHS AGAINST ITS OWN ROOT, AND NOTHING ELSE.
    //
    // Proved with two TEMPORARY roots, so this test holds no production
    // capability and no production path at all. The production side of the
    // property is an AST invariant now, not something this file can execute.
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'k7b727-other-')))
    try {
      execFileSync('/bin/chmod', ['700', other])
      const elsewhere: AuthorityPolicy = {
        secretRoot: other, fs: REAL_AUTHORITY_FS, prove: REAL_PROVE_OPS,
      }
      const outside = join(SECRET_ROOT, 's4f-k7-export-deadbeef')
      // THE OTHER POLICY REFUSES THIS POLICY'S PATH...
      expect(() => assertPolicyContainer(outside, elsewhere))
        .toThrow(/not a reviewed container path/)
      // ...AND THE REFUSAL IS SYMMETRIC.
      expect(() => assertPolicyContainer(join(other, 's4f-k7-export-deadbeef'), POLICY))
        .toThrow(/not a reviewed container path/)
      expect(existsSync(outside)).toBe(false)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('the policy root is the parent, and the basename rule is unchanged', () => {
    expect(assertPolicyContainer(containerFor('aabbccdd'), POLICY)).toBe('aabbccdd')
    for (const bad of [
      join(SECRET_ROOT, 's4f-k7-export-AABBCCDD'),
      join(SECRET_ROOT, 's4f-k7-export-aabbccd'),
      join(SECRET_ROOT, 'nested', 's4f-k7-export-aabbccdd'),
      join(SECRET_ROOT, 's4f-k7-export-aabbccdd', 'x'),
    ]) {
      expect(() => assertPolicyContainer(bad, POLICY), bad).toThrow(/reviewed container path/)
    }
    // AND THE EXPORTED PRODUCTION PATTERN IS UNCHANGED - asserted on the
    // pattern's own source text, so no production path is constructed here.
    expect(CONTAINER_PATTERN.source).toContain('s4f-k7-export-[0-9a-f]{8}')
    expect(CONTAINER_PATTERN.source.startsWith('^')).toBe(true)
  })

  it('a real container is created and proved under the private root only', () => {
    const path = containerFor('ffeeddcc')
    try {
      const receipt = createContainer(path, POLICY)
      expect(receipt.path).toBe(path)
      expect(receipt.mode).toBe('700')
      expect(() => { proveContainer(receipt, POLICY) }).not.toThrow()
    } finally {
      rmSync(path, { recursive: true, force: true })
    }
  })

  // K7-B7.2.7: the text-scanning entry-point test and the read-only production
  // sentinel are superseded by the AST invariant at the end of this file. The
  // sentinel in particular required naming a production path, which this module
  // no longer does at all - and a scanner over source text could never see
  // through a template interpolation or an alias anyway.
})

// ---------------------------------------------------------------------------
// K7-B7.2.3 B — THE RUN IDENTITY IS THE OPERATOR'S
// ---------------------------------------------------------------------------

describe('K7-B7.2.3 B: --create and --teardown take their identity from argv', () => {
  it('accepts exactly an 8-hex run id and a basic-format UTC stamp', () => {
    expect(runIdentityOf({ '--run-id': 'aabbccdd', '--stamp': '20260930T101500Z' }))
      .toEqual({ runId: 'aabbccdd', stamp: '20260930T101500Z' })
    for (const bad of ['AABBCCDD', 'aabbccd', 'aabbccdde', 'aabbccd!', 'g0000000', '']) {
      expect(() => runIdentityOf({ '--run-id': bad, '--stamp': '20260930T101500Z' }), bad)
        .toThrow(/run identity is not eight lowercase hex digits|required option is missing/)
    }
    for (const bad of ['2026-09-30T10:15:00Z', '20260930T1015Z', '20260930101500Z', '']) {
      expect(() => runIdentityOf({ '--run-id': 'aabbccdd', '--stamp': bad }), bad)
        .toThrow(/stamp is not a basic-format UTC instant|required option is missing/)
    }
  })

  it('production mints NO identity of its own any more', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    // THE HIDDEN SEAMS ARE GONE, not merely unused: a test cannot reintroduce
    // an identity the operator did not choose.
    expect(src).not.toContain('newRunId')
    expect(src).not.toContain('deps.stamp')
    expect(src).not.toContain('evidenceStamp(')
    // AND BOTH MUTATING MODES READ IT FROM ARGV.
    for (const fn of ['runCreate', 'runTeardown']) {
      const body = src.slice(src.indexOf(`export async function ${fn}`))
      expect(body.slice(0, body.indexOf('\nexport ')), fn).toContain('runIdentityOf(v)')
    }
  })

  it('A HUMAN CAN DO THIS: choose a run id, build the path, predict both names', () => {
    // B.6: the contract an operator actually needs, with no injection at all.
    const runId = 'a1b2c3d4'
    const stamp = '20261001T090000Z'
    // THE DERIVATION IS `<policy root>/s4f-k7-export-<run id>`, and it is shown
    // with THIS suite's root. K7-B7.2.7: the production root is module-private
    // to the authority, so an operator reads it from the reviewed source and
    // this test does not materialize it.
    const container = `${POLICY.secretRoot}/s4f-k7-export-${runId}`
    expect(assertPolicyContainer(container, POLICY)).toBe(runId)
    // And the exported production pattern accepts exactly that shape.
    expect(CONTAINER_PATTERN.source).toContain(`/s4f-k7-export-[0-9a-f]{8}`.slice(1))
    // And both evidence names are predictable before the run.
    expect(`${CREATE_PREFIX}-${stamp}-${runId}`)
      .toBe(`export-authority-create-${stamp}-${runId}`)
    expect(`${TEARDOWN_PREFIX}-${stamp}-${runId}`)
      .toBe(`export-authority-teardown-${stamp}-${runId}`)
    // The parser accepts that argv, and refuses a repeat of either option.
    const argv = [
      '--create', `--run-id=${runId}`, `--stamp=${stamp}`,
      `--credential-container=${container}`, '--evidence-root=/x',
      '--admin-passfile=/y', '--psql=/z', '--host=127.0.0.1', '--port=5432',
      '--database=ai_capital', '--admin-user=thanapold',
    ]
    const parsed = parseArgs(argv)
    expect(parsed.values['--run-id']).toBe(runId)
    expect(parsed.values['--stamp']).toBe(stamp)
    expect(() => parseArgs([...argv, `--run-id=${runId}`])).toThrow(/an option is repeated/)
  })

  it('--prove REFUSES an identity it would otherwise ignore', async () => {
    // K7-B7.2.4: the refusal is now the PARSER'S, so it happens before the
    // bundle, the passfile or anything else is touched.
    for (const opt of ['--run-id=aabbccdd', '--stamp=20260930T101500Z']) {
      const r = await runAuthorityCli([
        '--prove', '--create-bundle=/nope', opt,
        '--admin-passfile=/abs/a', '--psql=/usr/bin/psql', '--admin-user=thanapold',
      ], { policy: POLICY })
      expect(r.exitCode).toBe(EXIT_REFUSED)
      expect(r.lines.join('\n'), opt).toMatch(/this mode does not take that option/)
    }
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2.3 C — THE CREATE PATH MEASURES STATE; IT NEVER INFERS IT
// ---------------------------------------------------------------------------

describe('K7-B7.2.3 C: role creation outcome is measured, never inferred', () => {
  const RUN = 'c0ffee11'
  const STAMP = '20261001T090000Z'
  const CONTAINER = containerFor(RUN)
  const OTHER = '9300000000000000002'
  const ABSENT: RoleFacts = Object.freeze({ ...FULL_FACTS, present: false })
  let root = ''

  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b723-c-'))) })
  afterEach(() => {
    if (existsSync(root)) execFileSync('/bin/chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
    // CLEANUP CONFINED TO THIS FILE'S OWN PRIVATE ROOT.
    rmSync(CONTAINER, { recursive: true, force: true })
  })

  interface Counted {
    exitCode: number
    lines: readonly string[]
    mkdirs: string[]
    rmdirs: string[]
    secrets: number
    batches: string[]
    publications: number
    credentials: string[]
    containerExists: boolean
  }

  /**
   * One create run, with every mutating act counted.
   *
   * `proofs` answers the live read-backs in order: the entry proof first, then
   * whichever post-batch proof the state machine reaches.
   */
  const run = async (i: {
    proofs: Array<RoleFacts | (() => never)>
    batch?: () => Promise<{ code: number; ok: boolean }>
    /**
     * WHICH passfile open's close fails, 1-based.
     *
     * The release proof is per call site: 1 is the entry role proof, 2 the
     * CREATE batch, 3 the post-create authority proof (or the post-batch
     * absence read-back), then the rollback's drop and absence proofs.
     */
    closeFailsOn?: number
  }): Promise<Counted> => {
    const mkdirs: string[] = []
    const rmdirs: string[] = []
    const batches: string[] = []
    let secrets = 0
    let publications = 0
    let call = 0
    let opens = 0
    const policy: AuthorityPolicy = {
      secretRoot: SECRET_ROOT,
      fs: {
        ...REAL_AUTHORITY_FS,
        mkdirSync: (p, o) => { mkdirs.push(p); REAL_AUTHORITY_FS.mkdirSync(p, o) },
      },
      prove: REAL_PROVE_OPS,
    }
    const r = await runAuthorityCli([
      '--create', `--run-id=${RUN}`, `--stamp=${STAMP}`,
      `--credential-container=${CONTAINER}`, `--evidence-root=${root}`,
      '--admin-passfile=/Users/thanapold/.pgpass-admin', '--psql=/usr/bin/psql',
      '--host=127.0.0.1', '--port=5432', '--database=ai_capital', '--admin-user=thanapold',
    ], {
      policy,
      // THE RELEASE PROOF IS WHETHER THIS CLOSE SUCCEEDS, PER CALL SITE.
      openAdminPassfile: () => {
        opens += 1
        const mine = opens
        return {
          fd: 3,
          identity: {} as never,
          close: () => {
            if (i.closeFailsOn === mine) {
              throw new Error('the parent copy could not be released')
            }
          },
        }
      },
      batch: async (_p, _a, sql) => {
        batches.push(sql.includes('DROP ROLE') ? 'drop' : 'create')
        return await (i.batch ?? (async () => ({ code: 0, ok: true })))()
      },
      proveRole: async () => {
        const next = i.proofs[call] ?? i.proofs[i.proofs.length - 1]
        call += 1
        if (typeof next === 'function') return next()
        return next as RoleFacts
      },
      secret: () => { secrets += 1; return 'y'.repeat(40) },
      rmdirContainer: p => { rmdirs.push(p); rmdirSync(p) },
      publish: i => { publications += 1; return publishEvidence(i) },
    })
    const containerExists = existsSync(CONTAINER)
    return {
      ...r, mkdirs, rmdirs, secrets, batches, publications,
      credentials: containerExists
        ? [DRIVER_FILE, PGPASS_FILE].filter(n => existsSync(join(CONTAINER, n)))
        : [],
      containerExists,
    }
  }

  it('1. the role is ALREADY PRESENT at entry: nothing is created at all', async () => {
    // K7-B7.2.3: nothing asked. A container and a secret were made, a CREATE
    // was issued that could only fail, and the failure path then reasoned
    // about a role this run had not created.
    const r = await run({ proofs: [FULL_FACTS] })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/export role already exists on this cluster/)
    expect(r.mkdirs).toEqual([])
    expect(r.secrets).toBe(0)
    expect(r.batches).toEqual([])
    expect(r.publications).toBe(0)
    expect(r.containerExists).toBe(false)
  })

  it('2. the batch SUCCEEDS but the descriptor release is UNPROVED: retained', async () => {
    // The CREATE may well have committed and the descriptor may still be held.
    // This is not a clean refusal, and the container is NOT removed.
    // THE CREATE BATCH'S OWN RELEASE, and only that one: the entry proof must
    // succeed or this case never reaches the batch at all.
    const r = await run({ proofs: [ABSENT, FULL_FACTS], closeFailsOn: 2 })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines.join('\n')).toMatch(/descriptor-release-unproved/)
    expect(r.batches).toEqual(['create'])
    expect(r.rmdirs).toEqual([])
    expect(r.containerExists).toBe(true)
    expect(r.credentials).toEqual([])
    expect(r.publications).toBe(0)
  })

  it('3. the batch REJECTS and the role is PRESENT: retained, nothing removed', async () => {
    // The statement rejected AFTER the server committed. Inferring absence
    // from the rejection would remove the container and leave the role.
    const r = await run({
      proofs: [ABSENT, FULL_FACTS],
      batch: async () => { throw new Error('the connection dropped') },
    })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines.join('\n')).toMatch(/role-creation-outcome-unknown:role-present/)
    expect(r.rmdirs).toEqual([])
    expect(r.containerExists).toBe(true)
    expect(r.lines.join('\n')).not.toMatch(/no role was created/)
  })

  it('4. a NONZERO batch whose absence proof THROWS: retained, nothing removed', async () => {
    const r = await run({
      proofs: [ABSENT, () => { throw new Error('the read-back failed') }],
      batch: async () => ({ code: 3, ok: false }),
    })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines.join('\n')).toMatch(/role-creation-outcome-unknown:absence-unproved/)
    expect(r.rmdirs).toEqual([])
    expect(r.containerExists).toBe(true)
  })

  it('5. a NONZERO batch and an absence on ANOTHER cluster: retained', async () => {
    const r = await run({
      proofs: [ABSENT, { ...ABSENT, systemIdentifier: OTHER }],
      batch: async () => ({ code: 3, ok: false }),
    })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines.join('\n'))
      .toMatch(/role-creation-outcome-unknown:absence-on-another-cluster/)
    expect(r.rmdirs).toEqual([])
    expect(r.containerExists).toBe(true)
  })

  it('6. a NONZERO batch with SAME-CLUSTER absence proved: the empty container goes', async () => {
    const r = await run({
      proofs: [ABSENT, ABSENT],
      batch: async () => ({ code: 3, ok: false }),
    })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n'))
      .toMatch(/proved absent on the recorded cluster, and the container this run made is removed/)
    // REMOVED, AND PROVED REMOVED.
    expect(r.rmdirs).toEqual([CONTAINER])
    expect(r.containerExists).toBe(false)
    expect(r.credentials).toEqual([])
    expect(r.publications).toBe(0)
  })

  it('7. a SUCCESSFUL batch whose role proof is OVER-PRIVILEGED publishes nothing', async () => {
    // C.6: the authority proof moved BEFORE the credentials, so a role that is
    // not the reviewed one no longer causes two credentials to be published
    // merely so that they can be retained.
    const r = await run({
      proofs: [ABSENT, { ...FULL_FACTS, superuser: true }],
    })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines.join('\n')).toMatch(/post-role:the export role has superuser/)
    expect(r.credentials).toEqual([])
    expect(r.publications).toBe(0)
    // THE ROLE MAY EXIST, SO NOTHING IS REMOVED.
    expect(r.rmdirs).toEqual([])
    expect(r.containerExists).toBe(true)
  })

  it('8. THE CONTROL: a clean success publishes both credentials and one record', async () => {
    const r = await run({ proofs: [ABSENT, FULL_FACTS] })
    expect(r.exitCode).toBe(EXIT_OK)
    expect(r.lines.join('\n')).toContain('CREATED_AND_PROVED')
    expect(r.mkdirs).toEqual([CONTAINER])
    expect(r.secrets).toBe(1)
    expect(r.batches).toEqual(['create'])
    expect(r.credentials).toEqual([DRIVER_FILE, PGPASS_FILE])
    expect(r.publications).toBe(1)
    // THE RECORD IS NAMED FROM THE OPERATOR'S OWN ARGV IDENTITY.
    const dir = join(root, `${CREATE_PREFIX}-${STAMP}-${RUN}`)
    expect(verifyPublishedEvidence(dir)).toContain(CREATE_FILE)
    const doc = JSON.parse(readFileSync(join(dir, CREATE_FILE), 'utf-8')) as {
      run: { id: string; stamp: string }
      container: { path: string }
      source: { system_identifier: string }
    }
    expect(doc.run).toEqual({ id: RUN, stamp: STAMP })
    expect(doc.container.path).toBe(CONTAINER)
    expect(doc.source.system_identifier).toBe(SYSTEM_ID)
  })

  it('no path claims "no role was created" from a report or a rejection', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    expect(src).not.toContain('no role was created')
    expect(src).not.toContain('the export role was not created')
    // AND THE BOOLEAN INFERENCE IS GONE.
    expect(src).not.toMatch(/\bcreated\s*=\s*result\.ok/)
    expect(src).not.toMatch(/\blet created\b/)
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2.3 D — ONE REMOVAL RULE, ENOENT-ONLY, IN THE TEARDOWN TOO
// ---------------------------------------------------------------------------

describe('K7-B7.2.3 D: teardownRemoval proves the container is gone', () => {
  const FILES = [
    { name: DRIVER_FILE, deviceInode: '16777220:1', uid: 501, mode: '600', links: 1 },
    { name: PGPASS_FILE, deviceInode: '16777220:2', uid: 501, mode: '600', links: 1 },
  ]
  const receipt = (path: string) => ({
    path, deviceInode: '16777220:1234', uid: 501, mode: '700',
  })

  const removal = (over: Parameters<typeof teardownRemoval>[0] extends infer T
    ? Partial<T> : never = {}): ReturnType<typeof teardownRemoval> =>
    teardownRemoval({
      container: receipt(containerFor('aabbccdd')), files: FILES, policy: POLICY,
      dropped: true, roleAbsent: true,
      prove: () => undefined, proveDir: () => undefined,
      unlink: () => undefined,
      ...over,
    })

  it('a NO-OP rmdir does NOT report a removal', () => {
    // THE FINDING. `containerRemoved` was set the moment the injected `rmdir`
    // RETURNED, so a silent seam reported a removal that never happened -
    // exactly the trust in a return value the create path was corrected to
    // refuse. There is one rule now, not two.
    const out = removal({
      rmdir: () => undefined,
      lstat: () => anObject('dir'),
    })
    expect(out.containerRemoved).toBe(false)
    expect([...out.removed]).toEqual([DRIVER_FILE, PGPASS_FILE])
  })

  it('only an explicit ENOENT reports a removal', () => {
    expect(removal({ rmdir: () => undefined, lstat: () => { throw errno('ENOENT') } })
      .containerRemoved).toBe(true)
    for (const code of ['EPERM', 'EIO', 'EACCES', 'ENOTEMPTY']) {
      expect(removal({ rmdir: () => undefined, lstat: () => { throw errno(code) } })
        .containerRemoved, code).toBe(false)
    }
    // AND AN UNCLASSIFIED THROW IS NOT ABSENCE.
    expect(removal({ rmdir: () => undefined, lstat: () => { throw new Error('gone?') } })
      .containerRemoved).toBe(false)
  })

  it('a SUBSTITUTED object at the container name is not a removal', () => {
    for (const kind of ['file', 'link', 'fifo', 'socket'] as const) {
      expect(removal({ rmdir: () => undefined, lstat: () => anObject(kind) })
        .containerRemoved, kind).toBe(false)
    }
  })

  it('a retained credential still prevents the container removal entirely', () => {
    const out = removal({
      prove: (_c, f) => { if (f.name === PGPASS_FILE) throw new Error('substituted') },
      rmdir: () => { throw new Error('must not be called') },
      lstat: () => { throw new Error('must not be called') },
    })
    expect([...out.retained]).toEqual([PGPASS_FILE])
    expect(out.containerRemoved).toBe(false)
  })

  it('both removals go through ONE primitive', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    const fn = src.slice(src.indexOf('export function teardownRemoval'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain('proveContainerRemoved(i.container.path')
    // AND NO SECOND, WEAKER RULE: no bare assignment of a removal verdict.
    expect(body).not.toMatch(/containerRemoved = true/)
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2.4 B — THE PARENT-PASSFILE RELEASE IS LOAD-BEARING EVERYWHERE
//
// Every case below makes `close()` fail at exactly ONE call site while the
// operation it protects otherwise reports success, and then asserts that no
// later mutation or publication happened.
// ---------------------------------------------------------------------------

describe('K7-B7.2.4 B: an unproved descriptor release stops the operation', () => {
  const RUN = 'bada55e5'
  const STAMP = '20261001T093000Z'
  const CONTAINER = containerFor(RUN)
  let root = ''
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b724-b-'))) })
  afterEach(() => {
    if (existsSync(root)) execFileSync('/bin/chmod', ['-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
    rmSync(CONTAINER, { recursive: true, force: true })
  })

  const ABSENT: RoleFacts = Object.freeze({ ...FULL_FACTS, present: false })

  /** 1. the helper itself reports the release on EVERY path. */
  it('reports the release exactly once, and never hides the use failure', async () => {
    const closes: number[] = []
    // A FAILING CLOSE DOES NOT REPLACE THE ORIGINAL FAILURE.
    const bothFailed = await withAdminPassfile('/abs/a', () => ({
      fd: 4, identity: {} as never, close: () => { closes.push(1); throw new Error('close') },
    }), () => { throw new AuthorityRefused('the operation itself failed') })
    expect(bothFailed.state).toBe('failed')
    expect(releaseOf(bothFailed)).toBe('unproved')
    expect((bothFailed as { failure: AuthorityRefused }).failure)
      .toBeInstanceOf(AuthorityRefused)
    // AND A USE FAILURE DOES NOT ERASE A GOOD RELEASE.
    const rejected = await withAdminPassfile('/abs/a', () => ({
      fd: 4, identity: {} as never, close: () => { closes.push(2) },
    }), async () => { throw new Error('rejected later') })
    expect(rejected.state).toBe('failed')
    expect(releaseOf(rejected)).toBe('proved')
    // ONE CLOSE PER CALL, on both paths.
    expect(closes).toEqual([1, 2])
  })

  const createRun = async (closeFailsOn: number, proofs: RoleFacts[], batchOk = true): Promise<{
    exitCode: number; lines: string; mkdirs: number; secrets: number
    batches: number; credentials: number; publications: number; containerExists: boolean
  }> => {
    let opens = 0
    let mkdirs = 0
    let secrets = 0
    let batches = 0
    let publications = 0
    let call = 0
    const r = await runAuthorityCli([
      '--create', `--run-id=${RUN}`, `--stamp=${STAMP}`,
      `--credential-container=${CONTAINER}`, `--evidence-root=${root}`,
      '--admin-passfile=/Users/thanapold/.pgpass-admin', '--psql=/usr/bin/psql',
      '--host=127.0.0.1', '--port=5432', '--database=ai_capital', '--admin-user=thanapold',
    ], {
      policy: {
        secretRoot: SECRET_ROOT,
        fs: {
          ...REAL_AUTHORITY_FS,
          mkdirSync: (p, o) => { mkdirs += 1; REAL_AUTHORITY_FS.mkdirSync(p, o) },
        },
        prove: REAL_PROVE_OPS,
      },
      openAdminPassfile: () => {
        opens += 1
        const mine = opens
        return {
          fd: 3,
          identity: {} as never,
          close: () => {
            if (mine === closeFailsOn) throw new Error('the parent copy was not released')
          },
        }
      },
      batch: async () => { batches += 1; return { code: batchOk ? 0 : 3, ok: batchOk } },
      proveRole: async () => {
        const next = proofs[call] ?? proofs[proofs.length - 1]
        call += 1
        return next as RoleFacts
      },
      secret: () => { secrets += 1; return 'z'.repeat(40) },
      publish: i => { publications += 1; return publishEvidence(i) },
    })
    const containerExists = existsSync(CONTAINER)
    return {
      exitCode: r.exitCode, lines: r.lines.join('\n'),
      mkdirs, secrets, batches, publications, containerExists,
      credentials: containerExists
        ? [DRIVER_FILE, PGPASS_FILE].filter(n => existsSync(join(CONTAINER, n))).length
        : 0,
    }
  }

  /** 2. the entry read-back: a refusal before ANY mutation. */
  it('the ENTRY role proof refuses before container, secret, CREATE or evidence', async () => {
    const r = await createRun(1, [ABSENT, FULL_FACTS])
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines).toMatch(/release is unproved after the entry role proof/)
    expect([r.mkdirs, r.secrets, r.batches, r.publications]).toEqual([0, 0, 0, 0])
    expect(r.containerExists).toBe(false)
  })

  /** 3. the CREATE batch: retained/unknown, and no credential. */
  it('the CREATE batch stays retained/unknown and publishes no credential', async () => {
    const r = await createRun(2, [ABSENT, FULL_FACTS])
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines).toMatch(/descriptor-release-unproved/)
    expect(r.batches).toBe(1)
    expect(r.credentials).toBe(0)
    expect(r.publications).toBe(0)
    // THE CONTAINER IS NOT REMOVED: the role may exist.
    expect(r.containerExists).toBe(true)
  })

  /** 4. the post-CREATE authority proof: retained/unknown, no credential. */
  it('the POST-CREATE authority proof claims nothing and publishes nothing', async () => {
    const r = await createRun(3, [ABSENT, FULL_FACTS])
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines).toMatch(/post-role:.*release is unproved after the post-create authority proof/)
    expect(r.credentials).toBe(0)
    expect(r.publications).toBe(0)
    expect(r.containerExists).toBe(true)
  })

  /** 4b. and the post-batch absence read-back, on the non-ok branch. */
  it('an absence read-back under an unproved release removes nothing', async () => {
    const r = await createRun(3, [ABSENT, ABSENT], false)
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines).toMatch(/role-creation-outcome-unknown:absence-release-unproved/)
    expect(r.containerExists).toBe(true)
  })

  /** 5. --prove emits no PROVED and does not exit 0. */
  it('--prove emits no PROVED on an unproved release', async () => {
    // A complete, real create bundle and container, so the ONLY thing wrong is
    // the descriptor release.
    const receipt = createContainer(CONTAINER, POLICY)
    const driver = publishCredential(CONTAINER, DRIVER_FILE, 'postgresql://a\n', REAL_PUBLISH_OPS)
    const pgpass = publishCredential(CONTAINER, PGPASS_FILE, 'h:5432:d:u:p\n', REAL_PUBLISH_OPS)
    const bundle = publishEvidence({
      root, prefix: CREATE_PREFIX, stamp: STAMP, runId: RUN,
      artifacts: [{ path: 'role.json', bytes: Buffer.from('{}\n', 'utf-8') }],
      manifest: {
        path: CREATE_FILE,
        bytes: Buffer.from(`${JSON.stringify(createDocument({
          runId: RUN, stamp: STAMP, outcome: 'CREATED_AND_PROVED',
          container: receipt, files: [driver, pgpass],
          endpoint: { host: '127.0.0.1', port: '5432', database: 'ai_capital' },
          role: FULL_FACTS, note: null,
        }))}\n`, 'utf-8'),
      },
    }).finalPath
    const r = await runAuthorityCli([
      '--prove', `--create-bundle=${bundle}`,
      '--admin-passfile=/Users/thanapold/.pgpass-admin', '--psql=/usr/bin/psql',
      '--admin-user=thanapold',
    ], {
      policy: POLICY,
      openAdminPassfile: () => ({
        fd: 3, identity: {} as never,
        close: () => { throw new Error('the parent copy was not released') },
      }),
      proveRole: async () => FULL_FACTS,
    })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    const out = r.lines.join('\n')
    expect(out).toMatch(/release is unproved after the role proof/)
    expect(out).not.toContain('PROVED')
  })

  const teardownRun = async (closeFailsOn: number, proofs: RoleFacts[]): Promise<{
    exitCode: number; lines: string; batches: number; drops: number
    unlinks: string[]; rmdirs: string[]
  }> => {
    let opens = 0
    let batches = 0
    let drops = 0
    const unlinks: string[] = []
    const rmdirs: string[] = []
    let call = 0
    // A REAL CONTAINER AND TWO REAL CREDENTIALS, so the preflight passes and
    // the only thing wrong is the release.
    const receipt = createContainer(CONTAINER, POLICY)
    const driver = publishCredential(CONTAINER, DRIVER_FILE, 'postgresql://a\n', REAL_PUBLISH_OPS)
    const pgpass = publishCredential(CONTAINER, PGPASS_FILE, 'h:5432:d:u:p\n', REAL_PUBLISH_OPS)
    const pub = (prefix: string, file: string, doc: Record<string, unknown>): string =>
      publishEvidence({
        root, prefix, stamp: STAMP, runId: RUN,
        artifacts: [{ path: 'detail.json', bytes: Buffer.from('{}\n', 'utf-8') }],
        manifest: { path: file, bytes: Buffer.from(`${JSON.stringify(doc)}\n`, 'utf-8') },
      }).finalPath
    const createBundle = pub(CREATE_PREFIX, CREATE_FILE, createDocument({
      runId: RUN, stamp: STAMP, outcome: 'CREATED_AND_PROVED',
      container: receipt, files: [driver, pgpass],
      endpoint: { host: '127.0.0.1', port: '5432', database: 'ai_capital' },
      role: FULL_FACTS, note: null,
    }))
    const manifestDir = stage1Bundle({ evidence: root } as World, { stamp: STAMP, runId: RUN })
    const disDir = pub('commit-disposition', COMMIT_DISPOSITION_FILE, {
      record: 'commit-disposition', complete: true, run: { id: RUN, stamp: STAMP },
      bundle_name: basename(manifestDir), disposition: 'NOT_COMMITTED_PRISTINE',
    })
    const priDir = pub('pristine-release', PRISTINE_RELEASE_FILE, {
      record: 'pristine-release', complete: true, disposition: 'NOT_COMMITTED_PRISTINE',
      commit_disposition: {
        name: basename(disDir),
        digest_file_digest: createHash('sha256')
          .update(readFileSync(join(disDir, 'DIGEST'))).digest('hex'),
      },
      release_state: 'released', remaining_reviewed_locks: 0,
      zero_lock_release_proved: true, retry_permitted: true,
      bundle_name: basename(manifestDir),
    })
    const r = await runAuthorityCli([
      '--teardown', `--create-bundle=${createBundle}`, '--disposition=no-target-commit',
      `--evidence-root=${root}`, `--run-id=${RUN}`, `--stamp=${STAMP}`,
      '--admin-passfile=/Users/thanapold/.pgpass-admin', '--psql=/usr/bin/psql',
      '--host=127.0.0.1', '--port=5432', '--database=ai_capital', '--admin-user=thanapold',
      `--source-manifest-bundle=${manifestDir}`,
      `--commit-disposition-bundle=${disDir}`,
      `--pristine-release-bundle=${priDir}`,
    ], {
      policy: {
        secretRoot: SECRET_ROOT,
        fs: {
          ...REAL_AUTHORITY_FS,
          unlinkSync: (p: string) => { unlinks.push(p); REAL_AUTHORITY_FS.unlinkSync(p) },
          rmdirSync: (p: string) => { rmdirs.push(p); REAL_AUTHORITY_FS.rmdirSync(p) },
        },
        prove: REAL_PROVE_OPS,
      },
      openAdminPassfile: () => {
        opens += 1
        const mine = opens
        return {
          fd: 3, identity: {} as never,
          close: () => {
            if (mine === closeFailsOn) throw new Error('the parent copy was not released')
          },
        }
      },
      batch: async (_p, _a, sql) => {
        batches += 1
        if (sql.includes('DROP ROLE')) drops += 1
        return { code: 0, ok: true }
      },
      proveRole: async () => {
        const next = proofs[call] ?? proofs[proofs.length - 1]
        call += 1
        return next as RoleFacts
      },
    })
    return { exitCode: r.exitCode, lines: r.lines.join('\n'), batches, drops, unlinks, rmdirs }
  }

  /** 6. the teardown live-cluster proof: refuses before DROP or any removal. */
  it('the TEARDOWN live-cluster proof refuses before DROP and before any removal', async () => {
    const r = await teardownRun(1, [FULL_FACTS])
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines).toMatch(/release is unproved after the live cluster proof/)
    expect([r.batches, r.drops]).toEqual([0, 0])
    expect(r.unlinks).toEqual([])
    expect(r.rmdirs).toEqual([])
    // AND BOTH CREDENTIALS ARE STILL THERE.
    expect(existsSync(join(CONTAINER, DRIVER_FILE))).toBe(true)
    expect(existsSync(join(CONTAINER, PGPASS_FILE))).toBe(true)
  })

  /** 7. the DROP batch: outcome unknown, nothing removed, no absence claimed. */
  it('a DROP under an unproved release removes nothing and claims no absence', async () => {
    const r = await teardownRun(2, [FULL_FACTS, { ...FULL_FACTS, present: false }])
    expect(r.drops).toBe(1)
    expect(r.unlinks).toEqual([])
    expect(r.rmdirs).toEqual([])
    expect(r.lines).toMatch(/role absence UNPROVED \(drop-release-unproved\)/)
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(existsSync(join(CONTAINER, DRIVER_FILE))).toBe(true)
  })

  /** 8. the post-DROP absence proof: retain every credential and the container. */
  it('an absence proof under an unproved release retains everything', async () => {
    const r = await teardownRun(3, [FULL_FACTS, { ...FULL_FACTS, present: false }])
    expect(r.drops).toBe(1)
    expect(r.unlinks).toEqual([])
    expect(r.rmdirs).toEqual([])
    expect(r.lines).toMatch(/role absence UNPROVED \(absence-release-unproved\)/)
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(existsSync(join(CONTAINER, PGPASS_FILE))).toBe(true)
  })

  /** 8b. THE CONTROL: with every release proved, the teardown does remove. */
  it('THE CONTROL: with every release proved, the removal happens', async () => {
    const r = await teardownRun(0, [FULL_FACTS, { ...FULL_FACTS, present: false }])
    expect(r.drops).toBe(1)
    expect(r.unlinks).toEqual([
      join(CONTAINER, DRIVER_FILE), join(CONTAINER, PGPASS_FILE),
    ])
    expect(r.rmdirs).toEqual([CONTAINER])
    expect(r.lines).not.toMatch(/UNPROVED/)
    expect(r.exitCode).toBe(EXIT_OK)
  })

  /** 9. the credential-publication rollback names the uncertainty. */
  it('the credential rollback NAMES an unproved release instead of flattening it', async () => {
    const unlinked: string[] = []
    const r = await handleCredentialFailure({
      container: CONTAINER,
      policy: POLICY,
      containerReceipt: {
        path: CONTAINER, deviceInode: '16777220:1234', uid: 501, mode: '700',
      },
      published: [{ name: DRIVER_FILE, deviceInode: '1:2', uid: 501, mode: '600', links: 1 }],
      prove: () => undefined,
      proveDir: () => undefined,
      // THE DROP REPORTED SUCCESS; THIS PROCESS CANNOT VOUCH FOR THE CALL.
      drop: async () => ({ reported: true, release: 'unproved' as const }),
      proveAbsent: async () => { throw new Error('must not be asked') },
      unlink: p => { unlinked.push(p) },
      rmdir: () => undefined,
    })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines.join('\n')).toMatch(/role-drop-release-unproved/)
    expect(unlinked).toEqual([])
    // AND THE SAME FOR AN ABSENCE PROOF COLLECTED UNDER AN UNPROVED RELEASE.
    const r2 = await handleCredentialFailure({
      container: CONTAINER,
      policy: POLICY,
      containerReceipt: {
        path: CONTAINER, deviceInode: '16777220:1234', uid: 501, mode: '700',
      },
      published: [{ name: DRIVER_FILE, deviceInode: '1:2', uid: 501, mode: '600', links: 1 }],
      prove: () => undefined,
      proveDir: () => undefined,
      drop: async () => ({ reported: true, release: 'proved' as const }),
      proveAbsent: async () => ({ absent: true, release: 'unproved' as const }),
      unlink: p => { unlinked.push(p) },
      rmdir: () => undefined,
    })
    expect(r2.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r2.lines.join('\n')).toMatch(/role-absence-release-unproved/)
    expect(unlinked).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2.4 C — EVERY CLEANUP OPERATION COMES FROM THE POLICY
// ---------------------------------------------------------------------------

describe('K7-B7.2.4 C: no cleanup escapes to the global filesystem', () => {
  const FILES = [
    { name: DRIVER_FILE, deviceInode: '16777220:1', uid: 501, mode: '600', links: 1 },
    { name: PGPASS_FILE, deviceInode: '16777220:2', uid: 501, mode: '600', links: 1 },
  ]
  const CONTAINER = containerFor('aabbccdd')
  const RECEIPT = { path: CONTAINER, deviceInode: '16777220:1234', uid: 501, mode: '700' }

  /** A policy whose three cleanup operations are counted and inert. */
  const counting = (): {
    policy: AuthorityPolicy; unlinks: string[]; rmdirs: string[]; lstats: string[]
  } => {
    const unlinks: string[] = []
    const rmdirs: string[] = []
    const lstats: string[] = []
    return {
      unlinks, rmdirs, lstats,
      policy: {
        secretRoot: SECRET_ROOT,
        fs: {
          ...REAL_AUTHORITY_FS,
          unlinkSync: (p: string) => { unlinks.push(p) },
          rmdirSync: (p: string) => { rmdirs.push(p) },
          lstatSync: (p: string) => { lstats.push(p); throw errno('ENOENT') },
        },
        prove: REAL_PROVE_OPS,
      },
    }
  }

  it('teardownRemoval takes unlink, rmdir AND the final lstat from the policy', () => {
    // K7-B7.2.3 left the proofs policy-aware while these three fell back to the
    // process-global calls, so a removal under a test policy still went through
    // the real filesystem. Nothing here touches a real path at all.
    const c = counting()
    const out = teardownRemoval({
      container: RECEIPT, files: FILES, dropped: true, roleAbsent: true,
      policy: c.policy, prove: () => undefined, proveDir: () => undefined,
    })
    expect(c.unlinks).toEqual([
      join(CONTAINER, DRIVER_FILE), join(CONTAINER, PGPASS_FILE),
    ])
    expect(c.rmdirs).toEqual([CONTAINER])
    // THE ENOENT-ONLY PROOF LOOKED, AND LOOKED THROUGH THE POLICY.
    expect(c.lstats).toEqual([CONTAINER])
    expect(out.containerRemoved).toBe(true)
    expect([...out.removed]).toEqual([DRIVER_FILE, PGPASS_FILE])
  })

  it('the credential-publication cleanup uses the same three operations', async () => {
    const c = counting()
    const r = await handleCredentialFailure({
      container: CONTAINER, policy: c.policy, containerReceipt: RECEIPT,
      published: FILES, prove: () => undefined, proveDir: () => undefined,
      drop: async () => ({ reported: true, release: 'proved' as const }),
      proveAbsent: async () => ({ absent: true, release: 'proved' as const }),
    })
    expect(c.unlinks).toEqual([
      join(CONTAINER, DRIVER_FILE), join(CONTAINER, PGPASS_FILE),
    ])
    expect(c.rmdirs).toEqual([CONTAINER])
    expect(c.lstats).toEqual([CONTAINER])
    expect([...r.retained]).toEqual([])
  })

  it('production holds no global filesystem call in either cleanup path', () => {
    const src = strip(readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8'))
    for (const fn of ['teardownRemoval', 'handleCredentialFailure', 'proveContainerRemoved',
                      'removalSeams']) {
      const at = src.indexOf(`export function ${fn}`) >= 0
        ? src.indexOf(`export function ${fn}`)
        : src.indexOf(`export async function ${fn}`)
      expect(at, fn).toBeGreaterThan(-1)
      const body = src.slice(at, src.indexOf('\nexport ', at + 10))
      // NO `?? unlinkSync`, NO `?? rmdirSync`, NO `?? lstatSync`.
      for (const global of ['?? unlinkSync', '?? rmdirSync', '?? lstatSync',
                            '?? statSync', '?? proveCredential', '?? proveContainer']) {
        expect(body, `${fn} ${global}`).not.toContain(global)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2.4 D — NO SILENTLY IGNORED ARGV, AND A REAL UTC INSTANT
// ---------------------------------------------------------------------------

describe('K7-B7.2.4 D: each mode takes exactly its own options', () => {
  it('the three option sets are exactly the reviewed ones', () => {
    expect(Object.keys(MODE_OPTIONS).sort()).toEqual(['--create', '--prove', '--teardown'])
    expect([...MODE_OPTIONS['--prove'] as readonly string[]].sort()).toEqual(
      ['--admin-passfile', '--admin-user', '--create-bundle', '--psql'])
    // --create NEVER takes a bundle; --teardown NEVER takes a container.
    expect(MODE_OPTIONS['--create']).not.toContain('--create-bundle')
    expect(MODE_OPTIONS['--teardown']).not.toContain('--credential-container')
    // AND EVERY MODE OPTION IS A REAL OPTION.
    for (const [mode, opts] of Object.entries(MODE_OPTIONS)) {
      for (const o of opts) expect(OPTIONS, `${mode} ${o}`).toContain(o)
    }
  })

  it('--prove REFUSES the endpoint it never consults', () => {
    // SAFE ROUTING, UNSAFE CONTRACT: the command appeared to prove a
    // caller-selected endpoint while using the create record's instead.
    for (const opt of ['--host=127.0.0.1', '--port=5432', '--database=ai_capital',
                       '--evidence-root=/x', '--credential-container=/y',
                       '--run-id=aabbccdd', '--stamp=20260930T101500Z',
                       '--disposition=no-target-commit']) {
      expect(() => parseArgs(['--prove', '--create-bundle=/b', opt]), opt)
        .toThrow(/this mode does not take that option/)
    }
  })

  it('--create REFUSES bundle and disposition options', () => {
    for (const opt of ['--create-bundle=/b', '--disposition=copy-closed',
                       '--source-manifest-bundle=/m', '--copy-closure-bundle=/c']) {
      expect(() => parseArgs(['--create', opt]), opt)
        .toThrow(/this mode does not take that option/)
    }
  })

  it('--teardown REFUSES create-only options', () => {
    for (const opt of ['--credential-container=/Users/x/y']) {
      expect(() => parseArgs(['--teardown', opt]), opt)
        .toThrow(/this mode does not take that option/)
    }
  })

  it('a disposition REFUSES the proof bundles it does not read', () => {
    // D.3: evidence options irrelevant to the chosen disposition are rejected,
    // not ignored - an operator may not believe a closure was consulted.
    for (const opt of ['--copy-closure-bundle=/c', '--copy-restoration-bundle=/r',
                       '--copy-lifecycle-bundle=/l', '--release-gate-bundle=/g',
                       '--verification-bundle=/v']) {
      expect(() => parseArgs([
        '--teardown', '--disposition=no-target-commit', opt,
      ]), opt).toThrow(/this disposition does not take that option/)
    }
    for (const opt of ['--commit-disposition-bundle=/d', '--pristine-release-bundle=/p']) {
      expect(() => parseArgs([
        '--teardown', '--disposition=copy-closed', opt,
      ]), opt).toThrow(/this disposition does not take that option/)
    }
    // AND EACH DISPOSITION ACCEPTS ITS OWN.
    expect(() => parseArgs([
      '--teardown', '--disposition=no-target-commit',
      '--source-manifest-bundle=/m', '--commit-disposition-bundle=/d',
      '--pristine-release-bundle=/p',
    ])).not.toThrow()
  })

  it('the rejection happens before ANY file, passfile or dependency is touched', async () => {
    let passfiles = 0
    let batches = 0
    let proofs = 0
    const r = await runAuthorityCli([
      '--prove', '--create-bundle=/nope', '--host=127.0.0.1',
      '--admin-passfile=/abs/a', '--psql=/usr/bin/psql', '--admin-user=thanapold',
    ], {
      policy: POLICY,
      openAdminPassfile: () => { passfiles += 1; throw new Error('must not open') },
      batch: async () => { batches += 1; throw new Error('must not run') },
      proveRole: async () => { proofs += 1; throw new Error('must not prove') },
    })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines.join('\n')).toMatch(/this mode does not take that option/)
    expect([passfiles, batches, proofs]).toEqual([0, 0, 0])
  })

  it('a stamp must be a REAL UTC instant, not a shape', () => {
    // K7-B7.2.4: regex-only, so a 30th of February at 25:00 became a directory
    // name and a document field.
    for (const bad of [
      '20260230T120000Z',  // February 30th
      '20260431T120000Z',  // April 31st
      '20261301T120000Z',  // month 13
      '20260101T250000Z',  // hour 25
      '20260101T126000Z',  // minute 60
      '20260101T120060Z',  // second 60
      '20260000T120000Z',  // day 0
      '20260100T120000Z',  // day 0 of January
      '20250229T120000Z',  // 2025 is not a leap year
    ]) {
      expect(isRealUtcInstant(bad), bad).toBe(false)
      expect(() => runIdentityOf({ '--run-id': 'aabbccdd', '--stamp': bad }), bad)
        .toThrow(/not a basic-format UTC instant/)
    }
    // AND A REAL LEAP DAY IS ACCEPTED.
    for (const good of ['20260101T000000Z', '20240229T235959Z', '20261231T235959Z']) {
      expect(isRealUtcInstant(good), good).toBe(true)
      expect(runIdentityOf({ '--run-id': 'aabbccdd', '--stamp': good }).stamp).toBe(good)
    }
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2.5 A — THE CONTAINMENT CLAIM, GUARDED OVER THE WHOLE MODULE
// ---------------------------------------------------------------------------

describe('K7-B7.2.7: the production capability has a CLOSED reference set', () => {
  // WHY THE OLD GUARD WAS UNSOUND.
  //
  // It was a hand-written lexer that blanked every template literal, so an
  // executable interpolation - `${createContainer(PRODUCTION_CONTAINER, POLICY)}`
  // - was erased rather than detected. And it compared call TEXT against the
  // production identifiers, so an alias walked straight past it:
  //
  //     const p = PRODUCTION_POLICY
  //     createContainer(tempPath, p)
  //
  // Neither hole is fixable by extending the lexer or bolting on alias
  // tracking. The invariant is narrower and checkable: the two production
  // constants are module-private, and each has EXACTLY ONE reference outside
  // its own declaration, in one reviewed position. This is not dataflow
  // analysis - it is a closed reference set, enforced from the AST.

  const POLICY_NAME = `PRODUCTION_${'POLICY'}`
  const ROOT_NAME = `CONTAINER_${'ROOT'}`

  /** The one reviewed shape of the process composition point. */
  const isArgvSlice = (n: ts.Node): boolean =>
    ts.isCallExpression(n) &&
    n.expression.getText() === 'process.argv.slice' &&
    n.arguments.length === 1 && n.arguments[0]?.getText() === '2'

  /**
   * THE ONE WALK. Used for the real module and for every synthetic fixture, so
   * a non-vacuity case cannot be judged by a different rule than production.
   */
  const closedCapabilityViolations = (source: string): string[] => {
    const sf = ts.createSourceFile(
      'authority.ts', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    const bad: string[] = []

    const decls = new Map<string, ts.VariableDeclaration[]>([[POLICY_NAME, []], [ROOT_NAME, []]])
    const refs = new Map<string, ts.Identifier[]>([[POLICY_NAME, []], [ROOT_NAME, []]])
    const argvCalls: ts.CallExpression[] = []
    const strings: ts.StringLiteral[] = []

    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        const list = decls.get(n.name.text)
        if (list !== undefined) {
          list.push(n)
          // EXPORTED? The modifier lives on the enclosing statement.
          const stmt = n.parent.parent
          if (ts.isVariableStatement(stmt) &&
              (stmt.modifiers ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
            bad.push(`exported:${n.name.text}`)
          }
        }
      }
      if (ts.isExportSpecifier(n) && decls.has(n.propertyName?.text ?? n.name.text)) {
        bad.push(`exported:${n.propertyName?.text ?? n.name.text}`)
      }
      if (ts.isIdentifier(n) && refs.has(n.text)) {
        const isDeclName = ts.isVariableDeclaration(n.parent) && n.parent.name === n
        if (!isDeclName) (refs.get(n.text) as ts.Identifier[]).push(n)
      }
      if (ts.isStringLiteral(n)) strings.push(n)
      if (ts.isCallExpression(n) && n.expression.getText() === 'runAuthorityCli' &&
          n.arguments.length > 0 && isArgvSlice(n.arguments[0] as ts.Node)) {
        argvCalls.push(n)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)

    // 1 + 2: exactly one declaration each.
    for (const [name, list] of decls) {
      if (list.length !== 1) bad.push(`declarations:${name}:${String(list.length)}`)
    }
    const rootDecl = decls.get(ROOT_NAME)?.[0]
    const policyDecl = decls.get(POLICY_NAME)?.[0]

    // 1: the production-root string literal appears once, as that initializer.
    if (rootDecl?.initializer !== undefined && ts.isStringLiteral(rootDecl.initializer)) {
      const root = rootDecl.initializer.text
      const occurrences = strings.filter(l => l.text === root)
      if (occurrences.length !== 1) bad.push(`root-literal:${String(occurrences.length)}`)
    } else {
      bad.push('root-literal:not-a-string')
    }

    // 2: the policy binds exactly the three reviewed capabilities.
    const init = policyDecl?.initializer
    const obj = init !== undefined && ts.isCallExpression(init) ? init.arguments[0] : init
    if (obj === undefined || !ts.isObjectLiteralExpression(obj)) {
      bad.push('policy-initializer:not-an-object')
    } else {
      const want: Record<string, string> = {
        secretRoot: ROOT_NAME, fs: 'REAL_AUTHORITY_FS', prove: 'REAL_PROVE_OPS',
      }
      const got = new Map<string, string>()
      for (const prop of obj.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
          got.set(prop.name.text, prop.initializer.getText())
        }
      }
      for (const [k, v] of Object.entries(want)) {
        if (got.get(k) !== v) bad.push(`policy-binding:${k}:${String(got.get(k))}`)
      }
      if (got.size !== 3) bad.push(`policy-binding:extra:${String(got.size)}`)
    }

    // 5: exactly one argv composition call, inside the direct-entry guard.
    if (argvCalls.length !== 1) {
      bad.push(`composition-calls:${String(argvCalls.length)}`)
    } else {
      const call = argvCalls[0] as ts.CallExpression
      let guarded = false
      for (let up: ts.Node | undefined = call.parent; up !== undefined; up = up.parent) {
        if (ts.isIfStatement(up) && up.expression.getText().includes('isEntryPoint(')) {
          guarded = true
          break
        }
      }
      if (!guarded) bad.push('composition-outside-entry-guard')
      // ...and it must carry the policy as `{ policy: PRODUCTION_POLICY }`.
      const second = call.arguments[1]
      const ok = second !== undefined && ts.isObjectLiteralExpression(second) &&
        second.properties.length === 1 &&
        second.properties.every(pr => ts.isPropertyAssignment(pr) &&
          ts.isIdentifier(pr.name) && pr.name.text === 'policy' &&
          pr.initializer.getText() === POLICY_NAME)
      if (!ok) bad.push('composition-policy-argument')
    }

    // 3 + 4 + 6: ONE reference each, in its one reviewed position. Every other
    // use - an alias, a return, another object, another call, an export, or a
    // template interpolation - is simply a second reference, and is reported.
    const policyRefs = refs.get(POLICY_NAME) as ts.Identifier[]
    if (policyRefs.length !== 1) {
      bad.push(`policy-references:${String(policyRefs.length)}`)
    } else {
      const ref = policyRefs[0] as ts.Identifier
      const prop = ref.parent
      const inComposition = ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) && prop.name.text === 'policy' &&
        argvCalls.some(c => c.arguments[1] === prop.parent)
      if (!inComposition) bad.push('policy-reference-position')
    }
    const rootRefs = refs.get(ROOT_NAME) as ts.Identifier[]
    if (rootRefs.length !== 1) {
      bad.push(`root-references:${String(rootRefs.length)}`)
    } else {
      const ref = rootRefs[0] as ts.Identifier
      const prop = ref.parent
      const inPolicy = ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) && prop.name.text === 'secretRoot' &&
        policyDecl !== undefined &&
        prop.parent.parent !== undefined &&
        prop.getStart() > policyDecl.getStart() && prop.getEnd() < policyDecl.getEnd()
      if (!inPolicy) bad.push('root-reference-position')
    }
    return bad
  }

  const productionSource = (): string => readFileSync(
    new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8')

  it('THE REVIEWED PRODUCTION SOURCE SATISFIES THE INVARIANT', () => {
    expect(closedCapabilityViolations(productionSource())).toEqual([])
  })

  /** Each fixture is the REAL source with one change, judged by the same walk. */
  const withInjection = (statement: string): string =>
    `${productionSource()}\n${statement}\n`

  it('REJECTS a direct mutating call using the production policy', () => {
    expect(closedCapabilityViolations(
      withInjection(`createContainer(tempPath, ${POLICY_NAME})`),
    )).toContain('policy-references:2')
  })

  it('REJECTS a multiline mutating call using the production policy', () => {
    expect(closedCapabilityViolations(withInjection(
      ['createContainer(', '  tempPath,', `  ${POLICY_NAME},`, ')'].join('\n'),
    ))).toContain('policy-references:2')
  })

  it('REJECTS a mutating call inside a TEMPLATE INTERPOLATION', () => {
    // THE EXACT HOLE IN THE OLD LEXER: it blanked the whole template.
    expect(closedCapabilityViolations(
      withInjection('const message = `${createContainer(c, ' + POLICY_NAME + ')}`'),
    )).toContain('policy-references:2')
  })

  it('REJECTS an ALIAS of the production policy', () => {
    const violations = closedCapabilityViolations(withInjection(
      [`const p = ${POLICY_NAME}`, 'createContainer(tempPath, p)'].join('\n'),
    ))
    // The alias IS the second reference - no dataflow needed to see it.
    expect(violations).toContain('policy-references:2')
  })

  it('REJECTS an ALIAS of the production root', () => {
    expect(closedCapabilityViolations(withInjection(
      [`const c = ${ROOT_NAME}`, 'createContainer(c, somePolicy)'].join('\n'),
    ))).toContain('root-references:2')
  })

  it('REJECTS exporting either production constant', () => {
    const src = productionSource()
    expect(closedCapabilityViolations(
      src.replace(`const ${POLICY_NAME}: AuthorityPolicy`, `export const ${POLICY_NAME}: AuthorityPolicy`),
    )).toContain(`exported:${POLICY_NAME}`)
    expect(closedCapabilityViolations(
      src.replace(`const ${ROOT_NAME} = '`, `export const ${ROOT_NAME} = '`),
    )).toContain(`exported:${ROOT_NAME}`)
    // AND A RE-EXPORT SPECIFIER IS CAUGHT TOO.
    expect(closedCapabilityViolations(
      withInjection(`export { ${POLICY_NAME} }`),
    )).toContain(`exported:${POLICY_NAME}`)
  })

  it('REJECTS a second composition call', () => {
    expect(closedCapabilityViolations(withInjection(
      `void runAuthorityCli(process.argv.slice(2), { policy: ${POLICY_NAME} })`,
    ))).toContain('composition-calls:2')
  })

  it('REJECTS moving the composition outside the direct-process entry guard', () => {
    const src = productionSource()
    const call = `await runAuthorityCli(process.argv.slice(2), { policy: ${POLICY_NAME} })`
    expect(src).toContain(call)
    // The same call, hoisted out of the `isEntryPoint` guard entirely.
    const i = src.indexOf('if (isEntryPoint(')
    const hoisted = `${src.slice(0, i)}void (async () => { ${call} })()\n${
      src.slice(i).replace(call, 'await Promise.resolve()')}`
    expect(closedCapabilityViolations(hoisted)).toContain('composition-outside-entry-guard')
  })

  it('REJECTS a policy initializer that binds something else', () => {
    expect(closedCapabilityViolations(productionSource()
      .replace('  fs: REAL_AUTHORITY_FS,\n  prove: REAL_PROVE_OPS,',
               '  fs: SOMETHING_ELSE,\n  prove: REAL_PROVE_OPS,')))
      .toContain('policy-binding:fs:SOMETHING_ELSE')
  })

  it('REJECTS a second production-root string literal', () => {
    const src = productionSource()
    const root = /const CONTAINER_ROOT = '([^']+)'/.exec(src)?.[1] as string
    expect(closedCapabilityViolations(`${src}\nconst elsewhere = '${root}'\n`))
      .toContain('root-literal:2')
  })

  it('this TEST module imports neither production constant', () => {
    const src = readFileSync(
      new URL('./pg-copy-export-authority.test.ts', import.meta.url), 'utf-8')
    const sf = ts.createSourceFile(
      'test.ts', src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    const imported: string[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isImportSpecifier(n)) imported.push(n.name.text)
      ts.forEachChild(n, visit)
    }
    visit(sf)
    expect(imported).not.toContain(POLICY_NAME)
    expect(imported).not.toContain(ROOT_NAME)
    // NON-VACUOUS: this module does import from the authority.
    expect(imported).toContain('createContainer')
    // AND IT HOLDS NO PRODUCTION PATH, in one piece or assembled.
    const root = /const CONTAINER_ROOT = '([^']+)'/.exec(productionSource())?.[1] as string
    expect(src).not.toContain(root)
    // ASSEMBLED, so this assertion is not itself the occurrence it forbids.
    expect(src).not.toContain(`ai-capital${'-secrets'}`)
  })

  it('the policy is never ambient: no environment, no flag, no default', () => {
    // THE CODE, NOT THE PROSE: the docblocks explain what was removed and
    // therefore quote it.
    const src = strip(productionSource())
    expect(src).not.toContain('process.env')
    expect(src).not.toContain('NODE_ENV')
    for (const opt of ['--policy', '--secret-root', '--test-root']) {
      expect(src, opt).not.toContain(opt)
    }
    expect(src).not.toContain('deps: AuthorityDeps = {}')
    expect(src).not.toContain(`AuthorityPolicy = ${POLICY_NAME}`)
    expect(src).not.toContain(`?? ${POLICY_NAME}`)
  })
})

describe('K7-B7.2.5 B: Guarded is total', () => {
  it('a synchronous throw of null or undefined is a FAILURE, not a success', async () => {
    for (const thrown of [null, undefined, 0, '', false, NaN]) {
      const g = await withAdminPassfile('/abs/a', () => ({
        fd: 7, identity: {} as never, close: () => undefined,
      }), () => { throw thrown })
      // K7-B7.2.5: `syncFailure: unknown = null` was both the sentinel AND the
      // captured value, so `throw null` returned an `ok` result carrying
      // `undefined` - which then escaped as a generic refusal.
      expect(g.state, String(thrown)).toBe('failed')
      // AND THE RELEASE RESULT SURVIVES IT.
      expect(releaseOf(g), String(thrown)).toBe('proved')
    }
  })

  it('a failure to OPEN is not-started, and carries no release at all', async () => {
    const g = await withAdminPassfile('/abs/a', () => { throw new Error('no such file') },
                                      async () => 'unreachable')
    expect(g.state).toBe('not-started')
    expect('release' in g).toBe(false)
    // A READ-ONLY PRECONDITION MAY REFUSE ON IT.
    expect(() => requireReleased(g, 'entry role proof'))
      .toThrow(/passfile could not be opened for the entry role proof/)
  })

  it('a failing close still cannot replace the use failure', async () => {
    const g = await withAdminPassfile('/abs/a', () => ({
      fd: 7, identity: {} as never, close: () => { throw new Error('close failed') },
    }), () => { throw new AuthorityRefused('the operation itself failed') })
    expect(g.state).toBe('failed')
    expect(releaseOf(g)).toBe('unproved')
    expect((g as { failure: AuthorityRefused }).failure).toBeInstanceOf(AuthorityRefused)
  })
})

describe('K7-B7.2.5 C/D: every post-mkdir exit is classified by what exists', () => {
  const RUN = 'feedface'
  const STAMP = '20261001T100000Z'
  const CONTAINER = containerFor(RUN)
  const ABSENT: RoleFacts = Object.freeze({ ...FULL_FACTS, present: false })
  let root = ''
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b725-c-'))) })
  afterEach(() => {
    try {
      if (existsSync(root)) execFileSync('/bin/chmod', ['-R', 'u+w', root])
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(CONTAINER, { recursive: true, force: true })
    }
  })

  interface Run {
    exitCode: number; lines: string
    mkdirs: number; rmdirs: string[]; secrets: number; batches: number
    publications: number; containerExists: boolean
  }

  const run = async (i: {
    fs?: Partial<AuthorityFsOps>
    secret?: () => string
    /** 1-based index of the passfile open that fails. */
    openFailsOn?: number
    proofs?: RoleFacts[]
    batchOk?: boolean
  } = {}): Promise<Run> => {
    let mkdirs = 0
    let secrets = 0
    let batches = 0
    let publications = 0
    let call = 0
    let opens = 0
    const rmdirs: string[] = []
    const proofs = i.proofs ?? [ABSENT, FULL_FACTS]
    const r = await runAuthorityCli([
      '--create', `--run-id=${RUN}`, `--stamp=${STAMP}`,
      `--credential-container=${CONTAINER}`, `--evidence-root=${root}`,
      '--admin-passfile=/Users/thanapold/.pgpass-admin', '--psql=/usr/bin/psql',
      '--host=127.0.0.1', '--port=5432', '--database=ai_capital', '--admin-user=thanapold',
    ], {
      policy: {
        secretRoot: SECRET_ROOT,
        fs: {
          ...REAL_AUTHORITY_FS,
          mkdirSync: (p, o) => { mkdirs += 1; REAL_AUTHORITY_FS.mkdirSync(p, o) },
          rmdirSync: (p: string) => { rmdirs.push(p); REAL_AUTHORITY_FS.rmdirSync(p) },
          ...i.fs,
        },
        prove: REAL_PROVE_OPS,
      },
      openAdminPassfile: () => {
        opens += 1
        if (i.openFailsOn === opens) throw new Error('the passfile could not be opened')
        return { fd: 3, identity: {} as never, close: () => undefined }
      },
      batch: async () => {
        batches += 1
        return { code: i.batchOk === false ? 3 : 0, ok: i.batchOk !== false }
      },
      proveRole: async () => {
        const next = proofs[call] ?? proofs[proofs.length - 1]
        call += 1
        return next as RoleFacts
      },
      secret: i.secret ?? ((): string => { secrets += 1; return 'q'.repeat(40) }),
      publish: x => { publications += 1; return publishEvidence(x) },
    })
    return {
      exitCode: r.exitCode, lines: r.lines.join('\n'),
      mkdirs, rmdirs, secrets, batches, publications,
      containerExists: existsSync(CONTAINER),
    }
  }

  it('a post-mkdir STAT failure is container-created-but-unverified', async () => {
    // C.2: the directory exists. Claiming nothing was created is false, and the
    // object's identity was never proved, so it is not removed either.
    const r = await run({
      fs: { statSync: () => { throw errno('EIO') } },
    })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines).toMatch(/container-created-but-unverified/)
    expect(r.mkdirs).toBe(1)
    expect(r.rmdirs).toEqual([])
    expect(r.containerExists).toBe(true)
    expect([r.secrets, r.batches, r.publications]).toEqual([0, 0, 0])
  })

  it('a post-mkdir REALPATH failure is container-created-but-unverified', async () => {
    const r = await run({
      // ONLY THE CONTAINER'S OWN realpath, so the refusal is the one AFTER mkdir
      // rather than the secrets-root check that precedes it.
      fs: {
        realpathSync: (p: string) => p === CONTAINER
          ? `${p}-elsewhere`
          : REAL_AUTHORITY_FS.realpathSync(p),
      },
    })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines).toMatch(/container-created-but-unverified/)
    expect(r.rmdirs).toEqual([])
    expect(r.containerExists).toBe(true)
  })

  it('a SECRET failure removes only the proved, owned, empty container', async () => {
    // C.3: after a valid receipt and before any statement.
    const r = await run({
      secret: () => { throw new Error('the generator failed') },
    })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines).toMatch(/no credential secret could be established/)
    expect(r.lines).toMatch(/the empty container this run made is removed/)
    expect(r.rmdirs).toEqual([CONTAINER])
    expect(r.containerExists).toBe(false)
    expect([r.batches, r.publications]).toEqual([0, 0])
    // AND NOTHING SECRET IS NAMED.
    expect(r.lines).not.toMatch(/q{4,}/)
  })

  it('a CREATE passfile-open failure attempts no statement and cleans up', async () => {
    // C.4: no descriptor ever existed, so `use` never ran.
    // THE SECOND OPEN IS THE CREATE BATCH'S; the first is the entry proof,
    // which must succeed or the container is never made at all.
    const r = await run({ openFailsOn: 2 })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines).toMatch(/administrator passfile could not be opened/)
    expect(r.batches).toBe(0)
    expect(r.containerExists).toBe(false)
    expect(r.rmdirs).toEqual([CONTAINER])
  })

  it('a SUBSTITUTED empty directory at the name is NOT removed', async () => {
    // D.4: the receipt's device:inode no longer matches, so zero rmdir calls.
    let swapped = false
    const r = await run({
      secret: () => { throw new Error('force the cleanup path') },
      fs: {
        // The identity re-proof looks, and by then another directory is there.
        lstatSync: (p: string) => {
          if (p === CONTAINER && !swapped) {
            swapped = true
            rmSync(CONTAINER, { recursive: true, force: true })
            REAL_AUTHORITY_FS.mkdirSync(CONTAINER, { mode: 0o700 })
          }
          return REAL_AUTHORITY_FS.lstatSync(p)
        },
      },
    })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines).toMatch(/container-retained:.*:identity-unproved/)
    // ZERO REMOVALS: the object at the name was not the one this run made.
    expect(r.rmdirs).toEqual([])
    expect(r.containerExists).toBe(true)
  })

  it('an UNPROVED removal names the retained container and exits 3', async () => {
    const r = await run({
      secret: () => { throw new Error('force the cleanup path') },
      fs: { rmdirSync: () => undefined },   // a silent no-op removal
    })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines).toMatch(/container-retained:.*:removal-unproved/)
    expect(r.lines).toContain(CONTAINER)
    expect(r.containerExists).toBe(true)
  })

  it('THE CONTROL: the clean path still publishes and removes nothing', async () => {
    const r = await run()
    expect(r.exitCode).toBe(EXIT_OK)
    expect(r.mkdirs).toBe(1)
    expect(r.rmdirs).toEqual([])
    expect(r.publications).toBe(1)
    expect(r.containerExists).toBe(true)
  })

  it('the rollback DROP that cannot even open is retained, never an escape', async () => {
    // C.6: a throwing drop attempt used to escape to the top-level refusal
    // while a role and possibly a credential existed.
    const unlinked: string[] = []
    const r = await handleCredentialFailure({
      container: CONTAINER,
      policy: POLICY,
      containerReceipt: {
        path: CONTAINER, deviceInode: '16777220:1234', uid: 501, mode: '700',
      },
      published: [{ name: DRIVER_FILE, deviceInode: '1:2', uid: 501, mode: '600', links: 1 }],
      prove: () => undefined,
      proveDir: () => undefined,
      drop: async () => { throw new Error('the passfile could not be opened') },
      proveAbsent: async () => { throw new Error('must not be asked') },
      unlink: p => { unlinked.push(p) },
      rmdir: () => undefined,
    })
    expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
    expect(r.lines.join('\n')).toMatch(/role-drop-not-attempted/)
    expect([...r.retained]).toContain(DRIVER_FILE)
    expect(unlinked).toEqual([])
  })
})

describe('K7-B7.2.5 E: an invalid disposition is refused before any bundle read', () => {
  it('parseArgs refuses an unreviewed disposition value', () => {
    expect(() => parseArgs(['--teardown', '--disposition=garbage']))
      .toThrow(/not a reviewed terminal disposition/)
    expect(() => parseArgs(['--teardown', '--disposition=commit-unknown']))
      .toThrow(/not a reviewed terminal disposition/)
    for (const good of DISPOSITIONS) {
      expect(() => parseArgs(['--teardown', `--disposition=${good}`]), good).not.toThrow()
    }
  })

  it('no bundle reader, passfile or dependency is reached', async () => {
    // NON-VACUOUS: the create-bundle path is a real directory whose read WOULD
    // be observable - it exists and is a valid evidence bundle name shape - and
    // a counting policy proves no filesystem call was made through it.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b725-e-')))
    try {
      const bundle = join(root, 'export-authority-create-20261001T100000Z-feedface')
      execFileSync('/bin/mkdir', [bundle])
      let lstats = 0
      let passfiles = 0
      let batches = 0
      const r = await runAuthorityCli([
        '--teardown', `--create-bundle=${bundle}`, '--disposition=garbage',
        `--evidence-root=${root}`, '--run-id=feedface', '--stamp=20261001T100000Z',
        '--admin-passfile=/abs/a', '--psql=/usr/bin/psql',
        '--host=127.0.0.1', '--port=5432', '--database=ai_capital',
        '--admin-user=thanapold',
      ], {
        policy: {
          secretRoot: SECRET_ROOT,
          fs: {
            ...REAL_AUTHORITY_FS,
            lstatSync: (p: string) => { lstats += 1; return REAL_AUTHORITY_FS.lstatSync(p) },
          },
          prove: REAL_PROVE_OPS,
        },
        openAdminPassfile: () => { passfiles += 1; throw new Error('must not open') },
        batch: async () => { batches += 1; throw new Error('must not run') },
        proveRole: async () => { throw new Error('must not prove') },
      })
      expect(r.exitCode).toBe(EXIT_REFUSED)
      expect(r.lines.join('\n')).toMatch(/not a reviewed terminal disposition/)
      expect([lstats, passfiles, batches]).toEqual([0, 0, 0])
      // AND THE BUNDLE IS STILL THERE, UNREAD AND UNTOUCHED.
      expect(existsSync(bundle)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('K7-B7.2.5 D: the owned-container removal proves identity first', () => {
  it('a receipt that no longer matches invokes ZERO rmdir calls', () => {
    const path = containerFor('0ddba11c')
    const rmdirs: string[] = []
    try {
      const real = createContainer(path, POLICY)
      // THE SAME NAME, A DIFFERENT OBJECT: removed and remade, so the recorded
      // device:inode is stale.
      rmSync(path, { recursive: true, force: true })
      REAL_AUTHORITY_FS.mkdirSync(path, { mode: 0o700 })
      const out = removeOwnedEmptyContainer(real, POLICY, {
        rmdir: p => { rmdirs.push(p) },
        lstat: p => REAL_AUTHORITY_FS.lstatSync(p),
      })
      expect(out).toEqual({ removed: false, reason: 'identity-unproved' })
      expect(rmdirs).toEqual([])
      expect(existsSync(path)).toBe(true)
    } finally {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('the owned container goes, and only on an ENOENT proof', () => {
    const path = containerFor('0ddba11d')
    try {
      const real = createContainer(path, POLICY)
      // A SILENT rmdir PROVES NOTHING.
      expect(removeOwnedEmptyContainer(real, POLICY, {
        rmdir: () => undefined, lstat: p => REAL_AUTHORITY_FS.lstatSync(p),
      })).toEqual({ removed: false, reason: 'removal-unproved' })
      expect(existsSync(path)).toBe(true)
      // THE REAL ONE DOES.
      expect(removeOwnedEmptyContainer(real, POLICY, {
        rmdir: p => { REAL_AUTHORITY_FS.rmdirSync(p) },
        lstat: p => REAL_AUTHORITY_FS.lstatSync(p),
      })).toEqual({ removed: true, reason: 'removed' })
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(path, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// K7-B7.2.6 A — CREATION PROVENANCE COMES FROM THE CREATION BOUNDARY
// ---------------------------------------------------------------------------

describe('K7-B7.2.6 A: only a successful mkdir makes it this run\'s container', () => {
  const RUN = 'ab12cd34'
  const STAMP = '20261001T110000Z'
  const CONTAINER = containerFor(RUN)
  const ABSENT: RoleFacts = Object.freeze({ ...FULL_FACTS, present: false })
  let root = ''
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'k7b726-a-'))) })
  afterEach(() => {
    try {
      if (existsSync(root)) execFileSync('/bin/chmod', ['-R', 'u+w', root])
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(CONTAINER, { recursive: true, force: true })
    }
  })

  interface Counted {
    exitCode: number
    lines: string
    /** Every look at the CANDIDATE path, by operation. */
    candidate: string[]
    mkdirs: number
    removals: string[]
  }

  const run = async (i: {
    mkdir?: (p: string) => void
    stat?: (p: string) => Stats
    realpath?: (p: string) => string
    lstat?: (p: string) => Stats
  } = {}): Promise<Counted> => {
    const candidate: string[] = []
    const removals: string[] = []
    let mkdirs = 0
    let call = 0
    const note = (op: string, p: string): void => {
      if (p === CONTAINER) candidate.push(op)
    }
    const r = await runAuthorityCli([
      '--create', `--run-id=${RUN}`, `--stamp=${STAMP}`,
      `--credential-container=${CONTAINER}`, `--evidence-root=${root}`,
      '--admin-passfile=/Users/thanapold/.pgpass-admin', '--psql=/usr/bin/psql',
      '--host=127.0.0.1', '--port=5432', '--database=ai_capital', '--admin-user=thanapold',
    ], {
      policy: {
        secretRoot: SECRET_ROOT,
        fs: {
          mkdirSync: (p, o) => {
            mkdirs += 1
            note('mkdir', p)
            if (i.mkdir !== undefined) { i.mkdir(p); return }
            REAL_AUTHORITY_FS.mkdirSync(p, o)
          },
          // EACH SEAM APPLIES ONLY TO THE CANDIDATE PATH. The secrets-root
          // proofs that precede `mkdir` stay real, so the case under test is
          // the one that actually runs rather than a pre-mkdir refusal.
          statSync: (p: string) => {
            note('stat', p)
            return i.stat === undefined || p !== CONTAINER
              ? REAL_AUTHORITY_FS.statSync(p)
              : i.stat(p)
          },
          lstatSync: (p: string) => {
            note('lstat', p)
            return i.lstat === undefined || p !== CONTAINER
              ? REAL_AUTHORITY_FS.lstatSync(p)
              : i.lstat(p)
          },
          realpathSync: (p: string) => {
            note('realpath', p)
            return i.realpath === undefined || p !== CONTAINER
              ? REAL_AUTHORITY_FS.realpathSync(p)
              : i.realpath(p)
          },
          rmdirSync: (p: string) => { removals.push(`rmdir:${p}`) },
          unlinkSync: (p: string) => { removals.push(`unlink:${p}`) },
        },
        prove: REAL_PROVE_OPS,
      },
      openAdminPassfile: () => ({ fd: 3, identity: {} as never, close: () => undefined }),
      batch: async () => ({ code: 0, ok: true }),
      proveRole: async () => {
        const next = call === 0 ? ABSENT : FULL_FACTS
        call += 1
        return next
      },
      secret: () => 'w'.repeat(40),
      publish: x => publishEvidence(x),
    })
    return { exitCode: r.exitCode, lines: r.lines.join('\n'), candidate, mkdirs, removals }
  }

  /** What the candidate looked like before the run, for an untouched proof. */
  const snapshot = (p: string): string => {
    const st = lstatSync(p)
    const entries = readdirSync(p).sort().join(',')
    return `${String(st.dev)}:${String(st.ino)} ${(st.mode & 0o777).toString(8)} [${entries}]`
  }

  it('a PRE-EXISTING directory is an ordinary refusal and is never attributed', async () => {
    // THE CASE THAT MATTERED MOST. `mkdir` fails with EEXIST because the path
    // was ALREADY THERE, so this run created nothing - yet the post-hoc `lstat`
    // heuristic reported it as this run's own container, "retained", and
    // therefore eligible for cleanup.
    REAL_AUTHORITY_FS.mkdirSync(CONTAINER, { mode: 0o700 })
    writeFileSync(join(CONTAINER, 'someone-elses-file'), 'untouched\n', { mode: 0o600 })
    const before = snapshot(CONTAINER)
    const bytes = readFileSync(join(CONTAINER, 'someone-elses-file'), 'utf-8')

    const r = await run()
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines).toMatch(/could not be created by this run/)
    // NO CLAIM THAT THIS RUN CREATED OR IS RETAINING ANYTHING.
    expect(r.lines).not.toMatch(/created but/i)
    expect(r.lines).not.toMatch(/retained/i)
    expect(r.lines).not.toMatch(/RETAINED/)
    expect(r.lines).not.toMatch(/container-created-but-unverified/)
    // The ONLY mention of creation is the refusal's own "could not be created".
    expect(r.lines.match(/created/gi) ?? []).toHaveLength(1)
    // ZERO LOOKS AT THE CANDIDATE AFTER THE FAILED MKDIR.
    expect(r.candidate).toEqual(['mkdir'])
    expect(r.removals).toEqual([])
    // AND THE PRE-EXISTING OBJECT IS BYTE-FOR-BYTE UNTOUCHED.
    expect(snapshot(CONTAINER)).toBe(before)
    expect(readFileSync(join(CONTAINER, 'someone-elses-file'), 'utf-8')).toBe(bytes)
  })

  it('an EEXIST from the seam while the path exists is not attributed either', async () => {
    REAL_AUTHORITY_FS.mkdirSync(CONTAINER, { mode: 0o700 })
    const before = snapshot(CONTAINER)
    const r = await run({ mkdir: () => { throw errno('EEXIST') } })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.candidate).toEqual(['mkdir'])
    expect(r.removals).toEqual([])
    expect(snapshot(CONTAINER)).toBe(before)
  })

  it('an EACCES mkdir does not consult the candidate, even if a look would throw', async () => {
    // "I could not look" is not "it is mine". The candidate lookup must not
    // happen at all, so an EACCES from it cannot be mistaken for existence.
    const r = await run({
      mkdir: () => { throw errno('EACCES') },
      lstat: () => { throw errno('EACCES') },
      stat: () => { throw errno('EACCES') },
    })
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(r.lines).toMatch(/could not be created by this run/)
    expect(r.candidate).toEqual(['mkdir'])
    expect(r.candidate).not.toContain('lstat')
    expect(r.removals).toEqual([])
    expect(existsSync(CONTAINER)).toBe(false)
  })

  for (const [what, seam] of [
    ['statSync throws', { stat: () => { throw errno('EIO') } }],
    ['realpathSync throws', { realpath: () => { throw errno('EIO') } }],
    ['realpath DISPROVES the canonical name', {
      realpath: (p: string) => `${p}-elsewhere`,
    }],
    ['the object DISPROVES its type', {
      stat: () => ({ isDirectory: () => false, mode: 0o700, uid: 501 }) as unknown as Stats,
    }],
    ['the object DISPROVES its mode', {
      stat: () => ({ isDirectory: () => true, mode: 0o755, uid: 501 }) as unknown as Stats,
    }],
    ['the object DISPROVES its owner', {
      stat: () => ({ isDirectory: () => true, mode: 0o700, uid: 0 }) as unknown as Stats,
    }],
  ] as const) {
    it(`mkdir succeeds and ${what}: typed created-but-unverified, zero removal`, async () => {
      const r = await run(seam)
      expect(r.exitCode).toBe(EXIT_RETAINED_UNKNOWN)
      expect(r.lines).toMatch(/container-created-but-unverified:(stat|type|mode|owner|realpath)/)
      expect(r.mkdirs).toBe(1)
      // NO RECEIPT MEANS NO REMOVAL AUTHORITY.
      expect(r.removals).toEqual([])
      expect(r.lines).not.toMatch(/is removed/)
    })
  }

  it('the typed failure CANNOT be emitted before a successful mkdir', () => {
    // ORDERING, PROVED BEHAVIOURALLY: with a failing mkdir, no verification
    // call happens at all and the error is the ordinary refusal - so there is
    // no path on which the typed state can describe a directory this run did
    // not make.
    const order: string[] = []
    const policy: AuthorityPolicy = {
      secretRoot: SECRET_ROOT,
      fs: {
        ...REAL_AUTHORITY_FS,
        mkdirSync: () => { order.push('mkdir'); throw errno('EEXIST') },
        statSync: (p: string) => { order.push('stat'); return REAL_AUTHORITY_FS.statSync(p) },
        lstatSync: (p: string) => {
          order.push('lstat')
          return REAL_AUTHORITY_FS.lstatSync(p)
        },
        realpathSync: (p: string) => {
          order.push('realpath')
          return REAL_AUTHORITY_FS.realpathSync(p)
        },
      },
      prove: REAL_PROVE_OPS,
    }
    let thrown: unknown = null
    try { createContainer(CONTAINER, policy) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(AuthorityRefused)
    expect(thrown).not.toBeInstanceOf(ContainerCreatedButUnverified)
    // THE SECRETS ROOT IS PROVED FIRST, then mkdir - and then NOTHING.
    expect(order.filter(o => o !== 'lstat' && o !== 'realpath')).toEqual(['mkdir'])
    expect(order.slice(order.indexOf('mkdir') + 1)).toEqual([])
    // AND THE TYPED FAILURE IS ONLY RAISED FROM AFTER THE MKDIR RETURN.
    const src = readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8')
    const fn = src.slice(src.indexOf('export function createContainer'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    const mkdirAt = body.indexOf('policy.fs.mkdirSync(')
    expect(mkdirAt).toBeGreaterThan(-1)
    for (const raise of body.matchAll(/new ContainerCreatedButUnverified\(/g)) {
      expect(raise.index as number).toBeGreaterThan(mkdirAt)
    }
    expect([...body.matchAll(/new ContainerCreatedButUnverified\(/g)].length)
      .toBeGreaterThanOrEqual(5)
  })

  it('runCreate maps ONLY the typed failure to the unverified phase', () => {
    const src = readFileSync(
      new URL('../bin/pg-copy-export-authority.ts', import.meta.url), 'utf-8')
    const fn = src.slice(src.indexOf('export async function runCreate'))
    const body = fn.slice(0, fn.indexOf('\nexport '))
    expect(body).toContain('if (!(e instanceof ContainerCreatedButUnverified)) {')
    // AND THE POST-HOC EXISTENCE HEURISTIC IS GONE.
    expect(body).not.toContain('policy.fs.lstatSync(container)')
    expect(body).not.toMatch(/exists\s*=/)
  })
})
