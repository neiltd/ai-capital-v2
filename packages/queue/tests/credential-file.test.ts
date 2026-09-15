// THE CREDENTIAL FILE IS DATA, AND THE FILE OBJECT ITSELF IS CHECKED.
//
// Two separable concerns, tested separately:
//
//   * FRAMING — what a credential file may contain. Shell metacharacters must
//     come back verbatim, because nothing interprets them; a second line, a CR,
//     a NUL or an oversized file must be refused.
//   * THE FILE OBJECT — symlink, type, owner, mode, hard links. These are
//     asserted on the OPEN DESCRIPTOR, and the ones a test runner cannot create
//     (a foreign owner, an extra hard link) are exercised through the injected
//     seam rather than skipped. A silently skipped security branch is an
//     untested security branch.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import {
  MAX_CREDENTIAL_FILE_BYTES,
  assertCredentialDirectory,
  checkReadCount,
  decodeCredentialBytes,
  defaultCredentialFileSeam,
  readCredentialFile,
  type CredentialFileSeam,
} from '../src/credential-file.js'

const URL_TEXT = 'postgres://ai_capital_pipeline@fake.invalid:5432/fake_db'
const SOURCE = fileURLToPath(new URL('../src/credential-file.ts', import.meta.url))

let dir: string
beforeEach(() => {
  // realpath, deliberately: on macOS /var and /tmp are symlinks to /private/*,
  // and the loader refuses a path that resolves through one. Using the raw
  // mkdtemp path here would test the symlink rule instead of the case at hand —
  // and that rule has its own tests below.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cred-')))
  chmodSync(dir, 0o700)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function write(name: string, contents: string | Uint8Array, mode = 0o600): string {
  const p = join(dir, name)
  writeFileSync(p, contents, { mode })
  chmodSync(p, mode)
  return p
}

describe('framing — the file holds exactly one URL', () => {
  it('reads a URL with no trailing newline', () => {
    expect(readCredentialFile(write('a.url', URL_TEXT))).toBe(URL_TEXT)
  })

  it('treats ONE trailing LF as framing', () => {
    expect(readCredentialFile(write('b.url', `${URL_TEXT}\n`))).toBe(URL_TEXT)
  })

  it.each([
    ['two lines', `${URL_TEXT}\nsecond\n`],
    ['a blank second line', `${URL_TEXT}\n\n`],
    ['a leading blank line', `\n${URL_TEXT}\n`],
    ['CRLF framing', `${URL_TEXT}\r\n`],
    ['a bare CR', `${URL_TEXT}\r`],
  ])('refuses %s', (_label, body) => {
    expect(() => readCredentialFile(write('c.url', body))).toThrow(/credential file/)
  })

  it('refuses a NUL byte', () => {
    const bytes = new Uint8Array([...Buffer.from(URL_TEXT, 'utf-8'), 0x00])
    expect(() => readCredentialFile(write('d.url', bytes))).toThrow(/NUL/)
  })

  it('refuses an empty file', () => {
    expect(() => readCredentialFile(write('e.url', ''))).toThrow(/is empty/)
  })

  it('refuses a file over the size bound', () => {
    expect(() => readCredentialFile(write('f.url', 'x'.repeat(MAX_CREDENTIAL_FILE_BYTES + 1))))
      .toThrow(/larger than/)
  })

  it('does NOT trim — surrounding whitespace survives to the validator', () => {
    // The canonical validator refuses it. Repairing it here would mean the value
    // checked and the value used were different strings.
    expect(readCredentialFile(write('g.url', ` ${URL_TEXT} `))).toBe(` ${URL_TEXT} `)
  })

  it.each([
    '$(rm -rf /)',
    '`id`',
    'a; echo pwned',
    'a && echo pwned',
    'a | tee /tmp/pwned',
    '${PATH}',
    'PIPELINE_DATABASE_URL=postgres://x@h:5432/d',
  ])('returns %s verbatim — the contents are never executed or parsed', (body) => {
    expect(readCredentialFile(write('h.url', body))).toBe(body)
  })
})

describe('the file object is checked on the open descriptor', () => {
  it('refuses a relative path', () => {
    expect(() => readCredentialFile('relative/path.url')).toThrow(/absolute path/)
  })

  it('refuses a symlink AT the path', () => {
    const real = write('real.url', URL_TEXT)
    const link = join(dir, 'link.url')
    symlinkSync(real, link)
    expect(() => readCredentialFile(link)).toThrow(/symbolic link/)
  })

  it('refuses a path reached through a symlinked ANCESTOR', () => {
    const inner = join(dir, 'inner')
    mkdirSync(inner, { mode: 0o700 })
    writeFileSync(join(inner, 'x.url'), URL_TEXT, { mode: 0o600 })
    const aliasDir = join(dir, 'alias')
    symlinkSync(inner, aliasDir)
    expect(() => readCredentialFile(join(aliasDir, 'x.url'))).toThrow(/symbolic link/)
  })

  it('refuses a directory', () => {
    const d = join(dir, 'adir')
    mkdirSync(d, { mode: 0o700 })
    expect(() => readCredentialFile(d)).toThrow(/regular file|could not be opened/)
  })

  it.each([0o640, 0o604, 0o666, 0o660])('refuses mode %s', (mode) => {
    expect(() => readCredentialFile(write('m.url', URL_TEXT, mode)))
      .toThrow(/beyond its owner/)
  })

  it('refuses a file with a second hard link', () => {
    const p = write('n.url', URL_TEXT)
    linkSync(p, join(dir, 'n2.url'))
    expect(() => readCredentialFile(p)).toThrow(/more than one hard link/)
  })

  it('refuses a missing file', () => {
    expect(() => readCredentialFile(join(dir, 'absent.url'))).toThrow(/could not be resolved/)
  })

  it('refuses a path whose ancestors are symlinks even when they are the platform\'s own', () => {
    // On macOS /tmp is a symlink to /private/tmp, so a credential file named
    // through /tmp resolves elsewhere. The rule refuses it and the message says
    // what to do: supply the real path. This is a deliberate, documented
    // strictness, not an oversight — accepting the resolved path instead would
    // mean the file validated is not the file named.
    const real = write('platform.url', URL_TEXT)
    const viaTmp = real.replace(/^\/private/, '')
    if (viaTmp !== real) {
      expect(() => readCredentialFile(viaTmp)).toThrow(/symbolic link|could not be resolved/)
    }
    expect(readCredentialFile(real)).toBe(URL_TEXT)
  })
})

// Branches the runner cannot create are exercised through the seam. The default
// seam is the real fs — asserted below, so this is injection, not a stub that
// quietly replaces the thing under test.
describe('seam-injected security branches', () => {
  function seamWith(
    stat: Partial<{ uid: number; mode: number; nlink: number; size: number; isFile: boolean }>,
    dirStat: Partial<{ uid: number; mode: number; isDirectory: boolean; isSymlink: boolean }> = {},
    body?: Buffer,
  ): CredentialFileSeam {
    const bytes = body ?? Buffer.from(`${URL_TEXT}\n`, 'utf-8')
    let offset = 0
    // fd 7 is the directory, fd 42 the file: the loader opens the directory
    // first, so the fstat stub answers differently for each.
    const DIR_FD = 7
    return {
      realpathSync: (p) => p,
      lstatSync: () => ({ isSymbolicLink: () => dirStat.isSymlink ?? false }),
      openSync: (_p, flags) => ((flags & 1048576) !== 0 ? DIR_FD : 42),
      fstatSync: (fd) => (fd === DIR_FD
        ? {
          isFile: () => false,
          isDirectory: () => dirStat.isDirectory ?? true,
          uid: dirStat.uid ?? 1000,
          mode: dirStat.mode ?? 0o040700,
          nlink: 2,
          size: 0,
        }
        : {
          isFile: () => stat.isFile ?? true,
          isDirectory: () => false,
          uid: stat.uid ?? 1000,
          mode: stat.mode ?? 0o100600,
          nlink: stat.nlink ?? 1,
          size: stat.size ?? bytes.length,
        }),
      readSync: (fd, buf, off, len) => {
        if (fd === DIR_FD) return 0
        const n = Math.min(len, bytes.length - offset)
        if (n <= 0) return 0
        Buffer.from(buf.buffer, buf.byteOffset).set(bytes.subarray(offset, offset + n), off)
        offset += n
        return n
      },
      closeSync: () => { /* nothing to close */ },
      currentUid: () => 1000,
    }
  }

  it('accepts a well-formed file through the seam (control)', () => {
    expect(readCredentialFile('/abs/ok.url', seamWith({}))).toBe(URL_TEXT)
  })

  it('refuses a FOREIGN OWNER', () => {
    expect(() => readCredentialFile('/abs/x.url', seamWith({ uid: 501 })))
      .toThrow(/owned by another user/)
  })

  it('refuses a group-readable mode', () => {
    expect(() => readCredentialFile('/abs/x.url', seamWith({ mode: 0o100640 })))
      .toThrow(/beyond its owner/)
  })

  it('refuses extra hard links', () => {
    expect(() => readCredentialFile('/abs/x.url', seamWith({ nlink: 3 })))
      .toThrow(/more than one hard link/)
  })

  it('refuses a non-regular file', () => {
    expect(() => readCredentialFile('/abs/x.url', seamWith({ isFile: false })))
      .toThrow(/not a regular file/)
  })

  it('refuses when the uid cannot be determined', () => {
    const seam = { ...seamWith({}), currentUid: () => -1 }
    expect(() => readCredentialFile('/abs/x.url', seam)).toThrow(/ownership-checked/)
  })

  it('CLOSES the descriptor even when a check fails', () => {
    const closed: number[] = []
    const seam = { ...seamWith({ uid: 501 }), closeSync: (fd: number) => { closed.push(fd) } }
    expect(() => readCredentialFile('/abs/x.url', seam)).toThrow()
    // The directory descriptor is closed too, and the file's last.
    expect(closed).toEqual([7, 42])
  })

  it('closes the descriptor on the SUCCESS path too', () => {
    const closed: number[] = []
    const seam = { ...seamWith({}), closeSync: (fd: number) => { closed.push(fd) } }
    readCredentialFile('/abs/ok.url', seam)
    expect(closed).toEqual([7, 42])
  })

  it('handles a SHORT READ by looping to completion', () => {
    const bytes = Buffer.from(`${URL_TEXT}\n`, 'utf-8')
    let offset = 0
    const seam: CredentialFileSeam = {
      ...seamWith({}),
      readSync: (fd, buf, off, len) => {
        if (fd === 7) return 0
        // One byte at a time: a single-read implementation would truncate.
        const n = Math.min(1, len, bytes.length - offset)
        if (n <= 0) return 0
        Buffer.from(buf.buffer, buf.byteOffset).set(bytes.subarray(offset, offset + n), off)
        offset += n
        return n
      },
    }
    expect(readCredentialFile('/abs/ok.url', seam)).toBe(URL_TEXT)
  })

  it('the DEFAULT seam is the real filesystem (non-vacuity)', () => {
    expect(defaultCredentialFileSeam.realpathSync).toBeTypeOf('function')
    const p = write('real-default.url', URL_TEXT)
    expect(readCredentialFile(p)).toBe(URL_TEXT)
  })
})

describe('decodeCredentialBytes', () => {
  it('is the framing rule on its own', () => {
    expect(decodeCredentialBytes('/x', Buffer.from(`${URL_TEXT}\n`))).toBe(URL_TEXT)
    expect(() => decodeCredentialBytes('/x', Buffer.from(`${URL_TEXT}\n\n`))).toThrow(/more than one line/)
  })
})

describe('the module makes no close-on-exec claim', () => {
  it('does not reference O_CLOEXEC, which Node does not define here', () => {
    const code = readFileSync(SOURCE, 'utf-8').split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).not.toMatch(/O_CLOEXEC/)
    expect(constants.O_CLOEXEC).toBeUndefined()
    // Non-vacuity: the flags it DOES use are defined.
    expect(constants.O_NOFOLLOW).toBeTypeOf('number')
    expect(code).toContain('O_NOFOLLOW')
  })
})

// THE CONTAINING DIRECTORY IS PART OF THE CONTRACT.
//
// Round 1 documented a directory rule and enforced none, which is worse than
// having no rule: a 0755 directory lets anyone replace the file between one read
// and the next, and the file's own 0600 says nothing about that.
describe('the credential directory', () => {
  it('accepts an owner-only directory', () => {
    expect(() => assertCredentialDirectory(dir)).not.toThrow()
  })

  it.each([0o755, 0o750, 0o770, 0o777])('refuses mode %s at RUNTIME, not just at install time', (mode) => {
    const d = join(dir, `d${mode.toString(8)}`)
    mkdirSync(d, { mode: 0o700 }); chmodSync(d, mode)
    const p = join(d, 'c.url'); writeFileSync(p, URL_TEXT, { mode: 0o600 }); chmodSync(p, 0o600)
    expect(() => readCredentialFile(p)).toThrow(/owner-only \(mode 0700\)/)
    chmodSync(d, 0o700)
  })

  it('refuses a symlinked directory', () => {
    const real = join(dir, 'realdir'); mkdirSync(real, { mode: 0o700 })
    writeFileSync(join(real, 'c.url'), URL_TEXT, { mode: 0o600 })
    const link = join(dir, 'linkdir'); symlinkSync(real, link)
    expect(() => assertCredentialDirectory(link)).toThrow(/symbolic link/)
  })

  it('refuses a FOREIGN-OWNED directory through the seam', () => {
    const seam = {
      ...defaultCredentialFileSeam,
      lstatSync: () => ({ isSymbolicLink: () => false }),
      openSync: () => 7,
      fstatSync: () => ({ isFile: () => false, isDirectory: () => true, uid: 501, mode: 0o040700, nlink: 2, size: 0 }),
      closeSync: () => { /* stub */ },
      currentUid: () => 1000,
    }
    expect(() => assertCredentialDirectory('/abs/dir', seam)).toThrow(/owned by another user/)
  })

  it('refuses when the uid cannot be determined', () => {
    const seam = {
      ...defaultCredentialFileSeam,
      lstatSync: () => ({ isSymbolicLink: () => false }),
      openSync: () => 7,
      fstatSync: () => ({ isFile: () => false, isDirectory: () => true, uid: 1000, mode: 0o040700, nlink: 2, size: 0 }),
      closeSync: () => { /* stub */ },
      currentUid: () => -1,
    }
    expect(() => assertCredentialDirectory('/abs/dir', seam)).toThrow(/ownership-checked/)
  })
})

describe('bytes are decoded FATALLY', () => {
  it('refuses invalid UTF-8 rather than substituting U+FFFD', () => {
    // A lone continuation byte. toString('utf-8') would silently produce '\uFFFD',
    // turning a corrupted credential into a different, valid-looking string.
    const bytes = new Uint8Array([...Buffer.from('postgres://a@h:5432/d', 'utf-8'), 0x80])
    expect(() => readCredentialFile(write('bad-utf8.url', bytes))).toThrow(/not valid UTF-8/)
  })

  it.each([
    [[0xc3]],           // truncated two-byte sequence
    [[0xe2, 0x82]],     // truncated three-byte sequence
    [[0xff, 0xfe]],     // never valid UTF-8
  ])('refuses the malformed sequence %j', (tail) => {
    const bytes = new Uint8Array([...Buffer.from('postgres://a@h:5432/d', 'utf-8'), ...tail])
    expect(() => decodeCredentialBytes('/x', bytes)).toThrow(/not valid UTF-8/)
  })

  it('accepts legitimate multi-byte UTF-8', () => {
    const text = 'postgres://rôle@fake.invalid:5432/fake_db'
    expect(readCredentialFile(write('utf8.url', text))).toBe(text)
  })
})

describe('injected read counts are validated, not believed', () => {
  it.each([
    ['a non-integer', 1.5],
    ['a negative count', -1],
    ['more than requested', 999999],
    ['a non-number', 'seven'],
  ])('refuses %s', (_label, value) => {
    expect(() => checkReadCount('/x', value, 10)).toThrow(/@common\/queue/)
  })

  it('accepts a legitimate count (non-vacuity)', () => {
    expect(checkReadCount('/x', 7, 10)).toBe(7)
    expect(checkReadCount('/x', 0, 10)).toBe(0)
  })

  // Only the over-large case is driven THROUGH the loop. A negative count is
  // covered by the unit cases above and is deliberately not run here: without
  // the guard it makes `total` shrink forever, so the defect hangs instead of
  // failing — which is an argument for the guard, and a bad shape for a control.
  it.each([
    ['over-large', 99_999],
  ])('refuses %s counts through readCredentialFile itself, not just in isolation', (_l, value) => {
    // Driving it through the real function matters: a validator that exists but
    // is never called on the hot path protects nothing.
    // A local, self-contained seam: `seamWith` belongs to the describe above.
    const DIR_FD = 7
    const seam: CredentialFileSeam = {
      realpathSync: (p) => p,
      lstatSync: () => ({ isSymbolicLink: () => false }),
      openSync: (_p, flags) => ((flags & 1048576) !== 0 ? DIR_FD : 42),
      fstatSync: (fd) => (fd === DIR_FD
        ? { isFile: () => false, isDirectory: () => true, uid: 1000, mode: 0o040700, nlink: 2, size: 0 }
        : { isFile: () => true, isDirectory: () => false, uid: 1000, mode: 0o100600, nlink: 1, size: 10 }),
      readSync: () => value as number,
      closeSync: () => { /* stub */ },
      currentUid: () => 1000,
    }
    expect(() => readCredentialFile('/abs/x.url', seam)).toThrow(/count/)
  })
})
