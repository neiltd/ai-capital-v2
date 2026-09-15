// INSTALLING A SECRET WITHOUT LETTING IT ESCAPE.
//
// The installer is the one tool that legitimately holds the credential, so the
// tests are about the ways a secret leaves a process by accident: argv, stdout,
// a temporary file that outlives a failure, or a partially written destination.
// Every credential here is a reserved-domain fixture (.invalid), never a real
// one, and nothing connects to anything.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DOCUMENTED_DESTINATION, USAGE, installCredential, main as cliMain, readSecretFromFd } from '../bin/install-pipeline-credential.js'
import {
  type PublishSeam, assertDirectory, cleanupIncomplete, defaultPublishSeam, publishBytes,
} from '../src/atomic-publish.js'
import { requireExplicitPostgresUrl } from '@common/db/credential-url'
import { readCredentialFile } from '../src/credential-file.js'

const SECRET = 'postgres://ai_capital_pipeline@fake.invalid:5432/fake_db'
const SOURCE = fileURLToPath(new URL('../bin/install-pipeline-credential.ts', import.meta.url))

let dir: string
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'inst-'))); chmodSync(dir, 0o700) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('installation', () => {
  it('writes the credential atomically at mode 0600, readable by the loader', () => {
    const p = join(dir, 'pipeline-database.url')
    expect(installCredential(SECRET, { path: p, rotate: false }).outcome).toBe('installed')
    expect(statSync(p).mode & 0o7777).toBe(0o600)
    expect(readCredentialFile(p)).toBe(SECRET)
  })

  it('validates BEFORE writing — a bad credential never reaches the filesystem', () => {
    const p = join(dir, 'bad.url')
    expect(() => installCredential('not-a-url', { path: p, rotate: false })).toThrow()
    expect(existsSync(p)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('enforces the exact pipeline role', () => {
    const p = join(dir, 'role.url')
    expect(() => installCredential('postgres://ai_capital_owner@fake.invalid:5432/fake_db', { path: p, rotate: false }))
      .toThrow(/must name the ai_capital_pipeline role/)
    expect(existsSync(p)).toBe(false)
  })

  it('refuses a DIFFERENT credential at an existing destination without --rotate', () => {
    const p = join(dir, 'x.url')
    installCredential(SECRET, { path: p, rotate: false })
    const other = 'postgres://ai_capital_pipeline@fake.invalid:5432/other_db'
    expect(() => installCredential(other, { path: p, rotate: false })).toThrow(/Pass --rotate/)
    // No backup file of any kind: a stale secret copy is a liability.
    expect(readdirSync(dir).sort()).toEqual(['x.url'])
    expect(readCredentialFile(p)).toBe(SECRET)
  })

  it('re-installing the IDENTICAL credential is an idempotent no-op, not an error', () => {
    const p = join(dir, 'idem.url')
    installCredential(SECRET, { path: p, rotate: false })
    expect(installCredential(SECRET, { path: p, rotate: false }).outcome).toBe('unchanged')
  })

  it('rotates in place with --rotate and leaves no extra copy', () => {
    const p = join(dir, 'y.url')
    installCredential(SECRET, { path: p, rotate: false })
    const next = 'postgres://ai_capital_pipeline@fake.invalid:5432/other_db'
    expect(installCredential(next, { path: p, rotate: true }).outcome).toBe('rotated')
    expect(readCredentialFile(p)).toBe(next)
    expect(readdirSync(dir).sort()).toEqual(['y.url'])
  })

  it('refuses a relative path', () => {
    expect(() => installCredential(SECRET, { path: 'rel.url', rotate: false })).toThrow(/absolute/)
  })

  it('refuses a symlinked destination', () => {
    const real = join(dir, 'real.url'); writeFileSync(real, `${SECRET}\n`, { mode: 0o600 })
    const link = join(dir, 'link.url'); symlinkSync(real, link)
    expect(() => installCredential(SECRET, { path: link, rotate: true })).toThrow(/symbolic link/)
  })

  it('refuses a concurrent installer and never steals the lock', () => {
    const p = join(dir, 'z.url')
    const lock = `${p}.lock`
    closeSync(openSync(lock, 'wx', 0o600))
    expect(() => installCredential(SECRET, { path: p, rotate: false })).toThrow(/locks are never stolen/)
    expect(existsSync(lock)).toBe(true)
  })

  it('refuses --rotate when there is nothing to rotate', () => {
    // A rotation that silently becomes an initial install means the operator's
    // model and the filesystem disagree, which is worth stopping for.
    expect(() => installCredential(SECRET, { path: join(dir, 'none.url'), rotate: true }))
      .toThrow(/never silently becomes an initial installation/)
  })

  it('reports an unchanged destination rather than rewriting it', () => {
    const p = join(dir, 'same.url')
    installCredential(SECRET, { path: p, rotate: false })
    expect(installCredential(SECRET, { path: p, rotate: true }).outcome).toBe('unchanged')
  })

  it('refuses to rotate a credential with more than one hard link', () => {
    const p = join(dir, 'linked.url')
    installCredential(SECRET, { path: p, rotate: false })
    linkSync(p, join(dir, 'second-name.url'))
    const next = 'postgres://ai_capital_pipeline@fake.invalid:5432/next_db'
    expect(() => installCredential(next, { path: p, rotate: true })).toThrow(/more than one hard link/)
    // Read the bytes directly: the loader itself (correctly) refuses a file with
    // a second hard link, which is the very condition under test.
    expect(readFileSync(p, 'utf-8')).toBe(`${SECRET}\n`)
  })

  it('a clean install reports a COMPLETE cleanup: one name, no temporary, no lock', () => {
    const p = join(dir, 'clean.url')
    const result = installCredential(SECRET, { path: p, rotate: false })
    expect(result.outcome).toBe('installed')
    expect(result.cleanup.temporary).toBe('removed')
    expect(result.cleanup.lockReleased).toBe(true)
    expect(cleanupIncomplete({ published: true, unchanged: false, cleanup: result.cleanup })).toBe(false)
    expect(statSync(p).nlink).toBe(1)
    expect(readdirSync(dir).sort()).toEqual(['clean.url'])
  })

  it('(b) the CLI exits 75 and says the credential IS published, driven for real', async () => {
    const p = join(dir, 'cli-untidy.url')
    const src = join(dir, 'cli-secret'); writeFileSync(src, `${SECRET}\n`, { mode: 0o600 })
    const fd = openSync(src, 'r')
    const real = defaultPublishSeam
    let linked = false
    const seam: PublishSeam = {
      ...real,
      linkSync: (a, b) => { real.linkSync(a, b); linked = true },
      unlinkSync: (t) => {
        if (linked && t.endsWith('.tmp')) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
        real.unlinkSync(t)
      },
    }
    const err: string[] = []
    const se = process.stderr.write.bind(process.stderr)
    ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s) => { err.push(s); return true }
    let code: number
    try { code = await cliMain(['--path', p, '--fd', String(fd)], seam) }
    finally { (process.stderr as unknown as { write: typeof se }).write = se; closeSync(fd) }

    expect(code).toBe(75)
    const text = err.join('')
    expect(text).toMatch(/IS PRESENT at that path — this is NOT a failed installation/)
    // It wrote the file, so the rotate warning is the correct advice here.
    expect(text).toMatch(/any re-run would have to be a --rotate/)
    expect(text).toMatch(/Cleanup did not complete/)
    expect(text).not.toMatch(/nothing was published/i)
    expect(text).not.toContain(SECRET)          // the value is still never printed
    expect(readFileSync(p, 'utf-8')).toBe(`${SECRET}\n`)
    for (const f of readdirSync(dir)) if (f.endsWith('.tmp')) rmSync(join(dir, f), { force: true })
  })

  it('(c) the CLI exits 0 on a fully clean install, with the default seam', async () => {
    const p = join(dir, 'cli-clean.url')
    const src = join(dir, 'cli-secret2'); writeFileSync(src, `${SECRET}\n`, { mode: 0o600 })
    const fd = openSync(src, 'r')
    const err: string[] = []
    const se = process.stderr.write.bind(process.stderr)
    ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s) => { err.push(s); return true }
    let code: number
    try { code = await cliMain(['--path', p, '--fd', String(fd)]) }
    finally { (process.stderr as unknown as { write: typeof se }).write = se; closeSync(fd) }
    expect(code).toBe(0)
    expect(err.join('')).toMatch(/^installed: /)
    expect(statSync(p).nlink).toBe(1)
  })

  it('(a) the CLI exits nonzero and publishes nothing on a validation failure', async () => {
    const p = join(dir, 'cli-bad.url')
    const src = join(dir, 'cli-bad-secret'); writeFileSync(src, 'not-a-url\n', { mode: 0o600 })
    const fd = openSync(src, 'r')
    const err: string[] = []
    const se = process.stderr.write.bind(process.stderr)
    ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s) => { err.push(s); return true }
    let code: number
    try { code = await cliMain(['--path', p, '--fd', String(fd)]) }
    finally { (process.stderr as unknown as { write: typeof se }).write = se; closeSync(fd) }
    expect(code).toBe(73)
    expect(existsSync(p)).toBe(false)
    expect(err.join('')).not.toMatch(/IS PUBLISHED/)
  })

  it('the CLI distinguishes the three states in its own wording', () => {
    const cli = readFileSync(SOURCE, 'utf-8')
    // (b) published-but-untidy must say the credential IS published…
    expect(cli).toMatch(/the credential IS PRESENT at that path — this is NOT a failed installation/)
    expect(cli).toMatch(/Cleanup did not complete/)
    expect(cli).toMatch(/return 75/)
    // …and must never claim nothing was published after publication.
    expect(cli).not.toMatch(/nothing was published[\s\S]{0,120}cleanup/i)
    // (c) the clean path reports only the outcome and the path.
    expect(cli).toMatch(/process\.stderr\.write\(`\$\{result\.outcome\}: \$\{path\}/)
  })

  it('leaves no temporary behind on the success path', () => {
    const p = join(dir, 'w.url')
    installCredential(SECRET, { path: p, rotate: false })
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('the destination directory must be owner-only', () => {
  it('accepts a 0700 directory owned by the user', () => {
    expect(() => assertDirectory(dir, 0o700)).not.toThrow()
  })

  it.each([0o755, 0o750, 0o777])('refuses mode %s at install time', (mode) => {
    const d = join(dir, `sub${mode.toString(8)}`); mkdirSync(d, { mode: 0o700 }); chmodSync(d, mode)
    expect(() => installCredential(SECRET, { path: join(d, 'c.url'), rotate: false })).toThrow(/mode 0700/)
    chmodSync(d, 0o700)
  })

  it('refuses a symlinked directory', () => {
    const d = join(dir, 'realdir'); mkdirSync(d, { mode: 0o700 })
    const link = join(dir, 'linkdir'); symlinkSync(d, link)
    expect(() => installCredential(SECRET, { path: join(link, 'c.url'), rotate: false })).toThrow(/symbolic link/)
  })
})

describe('secret input channels', () => {
  it('propagates a read ERROR instead of treating it as end of input', () => {
    // Round 1 caught and broke, so an EIO after partial input produced a
    // silently truncated credential that might still parse.
    //
    // The distinction is in WHICH error surfaces: propagation raises the
    // descriptor error (EBADF here); catch-and-break would swallow it, read
    // nothing, and fail far away with a framing complaint about an empty file.
    const bad = 1_000_042        // not an open descriptor
    let message = ''
    try { readSecretFromFd(bad) } catch (e) { message = (e as Error).message }
    expect(message).toMatch(/EBADF|bad file descriptor/i)
    expect(message).not.toMatch(/is empty/)
  })

  it('applies the SAME framing rules as a credential file', () => {
    const cases: Array<[string, string]> = [
      ['two lines', `${SECRET}\nsecond\n`],
      ['a CR', `${SECRET}\r\n`],
    ]
    for (const [label, body] of cases) {
      const f = join(dir, `fd-${label.replace(/\s/g, '-')}`)
      writeFileSync(f, body, { mode: 0o600 })
      const fd = openSync(f, 'r')
      try { expect(() => readSecretFromFd(fd), label).toThrow() } finally { closeSync(fd) }
    }
  })

  it('rejects invalid UTF-8 from the descriptor', () => {
    const f = join(dir, 'fd-utf8')
    writeFileSync(f, Buffer.from([...Buffer.from(SECRET), 0x80]), { mode: 0o600 })
    const fd = openSync(f, 'r')
    try { expect(() => readSecretFromFd(fd)).toThrow(/not valid UTF-8/) } finally { closeSync(fd) }
  })

  it('enforces the 4 KiB bound', () => {
    const f = join(dir, 'fd-big')
    writeFileSync(f, 'x'.repeat(5000), { mode: 0o600 })
    const fd = openSync(f, 'r')
    try { expect(() => readSecretFromFd(fd)).toThrow(/exceeds/) } finally { closeSync(fd) }
  })

  it('leaves the descriptor open — it belongs to the caller', () => {
    const f = join(dir, 'fd-open'); writeFileSync(f, `${SECRET}\n`, { mode: 0o600 })
    const fd = openSync(f, 'r')
    try {
      readSecretFromFd(fd)
      // Still usable: a second read from position 0 must succeed.
      expect(() => readSync(fd, Buffer.alloc(1), 0, 1, 0)).not.toThrow()
    } finally { closeSync(fd) }
  })

  it('reads from a pre-opened descriptor and strips one trailing LF', () => {
    const src = join(dir, 'fd-src')
    writeFileSync(src, `${SECRET}\n`, { mode: 0o600 })
    const fd = openSync(src, 'r')
    try { expect(readSecretFromFd(fd)).toBe(SECRET) } finally { closeSync(fd) }
  })

  it('accepts no credential through argv', () => {
    // There is no --credential/--url/--secret flag to pass one to.
    const code = readFileSync(SOURCE, 'utf-8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).not.toMatch(/'--credential'|'--url'|'--secret'|'--password'/)
    expect(USAGE).toMatch(/Never from argv/)
  })

  it('never writes the secret to stdout', () => {
    const code = readFileSync(SOURCE, 'utf-8')
    // Every report goes to stderr, and only the PATH is ever named.
    expect(code).not.toMatch(/process\.stdout\.write\([^)]*secret/)
    expect(code).toMatch(/process\.stderr\.write\(`\$\{result\.outcome\}: \$\{path\}/)
  })

  it('documents the production location without defaulting to it', () => {
    expect(DOCUMENTED_DESTINATION).toBe('~/.config/ai-capital/pipeline-database.url')
    // The CONSUMER has no default; --path is required.
    expect(USAGE).toMatch(/--path <abs>/)
  })

  it('restores terminal echo on every exit path', () => {
    const code = readFileSync(SOURCE, 'utf-8')
    expect(code).toMatch(/finally \{[\s\S]*restore\(\)/)
    expect(code).toMatch(/SIGINT/)
    expect(code).toMatch(/SIGTERM/)
  })
})

// THE INSTALLER'S POST-PUBLICATION STATES.
//
// A credential left reachable through a second filename is a second, unmanaged
// copy of the secret — the exact thing the file-based architecture exists to
// avoid — so a failure to remove it can never be reported as a clean success.
describe('installer post-publication failure states', () => {
  it('a retained temporary is reported, and the credential stays published', () => {
    const p = join(dir, 'retained.url')
    const real = defaultPublishSeam
    let linked = false
    const result = installCredentialWithSeam(SECRET, { path: p, rotate: false }, {
      ...real,
      linkSync: (a, b) => { real.linkSync(a, b); linked = true },
      unlinkSync: (t) => {
        if (linked && t.endsWith('.tmp')) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
        real.unlinkSync(t)
      },
    })
    expect(result.published).toBe(true)
    expect(result.cleanup.temporary).toBe('retained')
    expect(cleanupIncomplete(result)).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe(`${SECRET}\n`)
    expect(statSync(p).nlink).toBe(2)
    rmSync(result.cleanup.temporaryPath as string, { force: true })
  })

  it('a lock that cannot be released is reported, because it blocks the next rotation', () => {
    const p = join(dir, 'lockheld.url')
    const real = defaultPublishSeam
    const result = installCredentialWithSeam(SECRET, { path: p, rotate: false }, {
      ...real,
      unlinkSync: (t) => {
        if (t.endsWith('.lock')) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
        real.unlinkSync(t)
      },
    })
    expect(result.published).toBe(true)
    expect(result.cleanup.lockReleased).toBe(false)
    expect(cleanupIncomplete(result)).toBe(true)
    // And the consequence is real: a later install is refused by that lock.
    expect(() => installCredential(SECRET, { path: p, rotate: true })).toThrow(/another invocation holds/)
    rmSync(`${p}.lock`, { force: true })
  })
})

/** installCredential's validation plus publishBytes with an injected seam. */
function installCredentialWithSeam(secret: string, options: { path: string; rotate: boolean }, seam: PublishSeam) {
  requireExplicitPostgresUrl('credential', secret, { user: 'ai_capital_pipeline' })
  return publishBytes(options.path, Buffer.from(`${secret}\n`, 'utf-8'), {
    mode: options.rotate ? 'replace' : 'create',
    fileMode: 0o600,
    directoryMode: 0o700,
  }, seam)
}

// UNCHANGED IS NOT THE SAME AS WRITTEN.
//
// If the destination already holds exactly these bytes, nothing was written —
// so a later identical run is still an ordinary install and must NOT be told to
// use --rotate, a flag whose whole purpose is authorizing an overwrite.
describe('installer retry advice matches what actually happened', () => {
  async function runCli(args: string[], seam?: PublishSeam): Promise<{ code: number; err: string }> {
    const err: string[] = []
    const se = process.stderr.write.bind(process.stderr)
    ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s) => { err.push(s); return true }
    try { return { code: await cliMain(args, seam), err: err.join('') } }
    finally { (process.stderr as unknown as { write: typeof se }).write = se }
  }

  function secretFd(): number {
    const f = join(dir, `secret-${Math.random().toString(36).slice(2)}`)
    writeFileSync(f, `${SECRET}\n`, { mode: 0o600 })
    return openSync(f, 'r')
  }

  const lockFail = (): PublishSeam => {
    const real = defaultPublishSeam
    return {
      ...real,
      unlinkSync: (t) => {
        if (t.endsWith('.lock')) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
        real.unlinkSync(t)
      },
    }
  }

  it('UNCHANGED plus a lock-release failure → exit 75 and NO --rotate demand', async () => {
    const p = join(dir, 'retry-unchanged.url')
    // First: a clean install.
    const fd1 = secretFd()
    try { expect((await runCli(['--path', p, '--fd', String(fd1)])).code).toBe(0) } finally { closeSync(fd1) }

    // Second: identical bytes, and only the lock release fails.
    const fd2 = secretFd()
    let r
    try { r = await runCli(['--path', p, '--fd', String(fd2)], lockFail()) } finally { closeSync(fd2) }

    expect(r.code).toBe(75)
    expect(r.err).toMatch(/^unchanged: /m)
    expect(r.err).toMatch(/ALREADY correct and nothing was written/)
    expect(r.err).toMatch(/does NOT require --rotate/)
    expect(r.err).not.toMatch(/any re-run would have to be a --rotate/)
    expect(r.err).not.toContain(SECRET)
    rmSync(`${p}.lock`, { force: true })
  })

  it('INSTALLED plus a lock-release failure still demands --rotate', async () => {
    const p = join(dir, 'retry-installed.url')
    const fd = secretFd()
    let r
    try { r = await runCli(['--path', p, '--fd', String(fd)], lockFail()) } finally { closeSync(fd) }
    expect(r.code).toBe(75)
    expect(r.err).toMatch(/^installed: /m)
    expect(r.err).toMatch(/any re-run would have to be a --rotate/)
    expect(r.err).not.toMatch(/does NOT require --rotate/)
    rmSync(`${p}.lock`, { force: true })
  })

  it('a CLEAN unchanged re-run is still exit 0', async () => {
    const p = join(dir, 'retry-clean.url')
    const fd1 = secretFd()
    try { await runCli(['--path', p, '--fd', String(fd1)]) } finally { closeSync(fd1) }
    const fd2 = secretFd()
    let r
    try { r = await runCli(['--path', p, '--fd', String(fd2)]) } finally { closeSync(fd2) }
    expect(r.code).toBe(0)
    expect(r.err).toMatch(/^unchanged: /m)
  })

  it('a pre-publication failure whose temporary cannot be removed exits nonzero and names it', async () => {
    const p = join(dir, 'temp-stuck.url')
    const real = defaultPublishSeam
    const temps: string[] = []
    const seam: PublishSeam = {
      ...real,
      openSync: (t, flags, mode) => { if (t.endsWith('.tmp')) temps.push(t); return real.openSync(t, flags, mode) },
      fsyncSync: (fd) => { throw new Error('EIO on the file fsync') },
      unlinkSync: (t) => {
        if (t.endsWith('.tmp')) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
        real.unlinkSync(t)
      },
    }
    const fd = secretFd()
    let r
    try { r = await runCli(['--path', p, '--fd', String(fd)], seam) } finally { closeSync(fd) }

    expect(r.code).toBe(73)                       // nothing published
    expect(existsSync(p)).toBe(false)
    expect(r.err).toMatch(/EIO on the file fsync/)
    expect(r.err).toMatch(/destination was NOT published/)
    expect(r.err).toMatch(/may still contain credential material/)
    expect(r.err).toContain(temps[0])
    // The credential itself is still never printed.
    expect(r.err).not.toContain(SECRET)
    rmSync(temps[0], { force: true })
  })
})
