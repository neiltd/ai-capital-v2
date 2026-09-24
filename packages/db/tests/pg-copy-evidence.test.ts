// THE IMMUTABLE EVIDENCE PUBLISHER — offline, on a real filesystem.
//
// These use a real temporary directory rather than a mocked `fs`, because every
// property under test is a property of the FILESYSTEM: a mode that a umask
// masked, a dangling symlink that `existsSync` reports as absent, an append
// that a 0400 file refuses. A mock would answer whatever it was told to.
//
// The injected `EvidenceOps` seam is used for exactly two things a real
// filesystem will not do on demand: failing an individual operation, and
// RECORDING THE ORDER of operations. The order is most of the contract here -
// "DIGEST last", "freeze after writing", "fsync after freezing", "rename after
// fsync" - and a finished directory looks identical whichever order produced
// it. Recording is the only way those mutants can be killed.

import { execFileSync } from 'node:child_process'
import {
  closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import {
  HELPER_SOURCE, LIBSYSTEM, PYTHON3, RENAME_EXCL, atomicRenameNoReplace,
} from '../src/pg-copy/atomic-rename.js'
import {
  BUILD_DIR_MODE, DIGEST_FILE, EvidencePublishedButUnverified, EvidenceRefused,
  FROZEN_DIR_MODE, FROZEN_FILE_MODE, REAL_EVIDENCE_OPS, assertArtifactPath, assertEvidenceRoot,
  digestFileText, evidenceNames, evidenceStamp, newRunId, parseDigestFile, pathIsPresent,
  publishEvidence, sha256Hex, verifyPublishedEvidence,
  type EvidenceArtifact, type EvidenceOps,
} from '../src/pg-copy/evidence.js'

const ROOTS: string[] = []

/** A real 0700 root this process owns. `mkdtemp` is 0700 already; set it anyway. */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pgcopy-evidence-'))
  execFileSync('/bin/chmod', ['700', root])
  ROOTS.push(root)
  return root
}

afterEach(() => {
  for (const r of ROOTS.splice(0)) {
    // Frozen trees are 0500; restore write before removing, or the cleanup
    // itself would be the first thing this suite proves cannot happen.
    try { execFileSync('/bin/chmod', ['-R', 'u+rwX', r]) } catch { /* already gone */ }
    rmSync(r, { recursive: true, force: true })
  }
})

const STAMP = '20260924T101530Z'
const RUN = 'a1b2c3d4'

const artifact = (path: string, text: string): EvidenceArtifact =>
  ({ path, bytes: Buffer.from(text, 'utf-8') })

const manifest = (over: Record<string, unknown> = {}): EvidenceArtifact =>
  artifact('manifest.json', JSON.stringify({ complete: true, ...over }))

const publish = (root: string, over: Partial<Parameters<typeof publishEvidence>[0]> = {},
                 ops?: EvidenceOps): ReturnType<typeof publishEvidence> =>
  publishEvidence({
    root, prefix: 'source-manifest', stamp: STAMP, runId: RUN,
    artifacts: [artifact('source-contract.json', '{"a":1}')],
    manifest: manifest(),
    ...over,
  }, ops)

/** Every surface an error could carry a secret on. */
const surfaces = (e: unknown): string => {
  const err = e as Error & Record<string, unknown>
  let json = ''
  try { json = JSON.stringify(err, Object.getOwnPropertyNames(err)) } catch { json = '' }
  return [String(err.message), String(err.stack ?? ''),
          Object.getOwnPropertyNames(err).join(','), json,
          inspect(err, { depth: 6 })].join('\n')
}

/** Wrap the real ops, recording every call in order. */
function recordingOps(over: Partial<EvidenceOps> = {}): { ops: EvidenceOps; log: string[] } {
  const log: string[] = []
  const rel = (p: unknown): string => String(p).split('/').slice(-2).join('/')
  const ops: EvidenceOps = {
    ...REAL_EVIDENCE_OPS,
    mkdirSync: ((p: string, o: unknown) => {
      log.push(`mkdir ${rel(p)}`); return REAL_EVIDENCE_OPS.mkdirSync(p, o as never)
    }) as typeof mkdirSync,
    openSync: ((p: string, f: string, m?: number) => {
      log.push(`open ${f} ${rel(p)}`); return REAL_EVIDENCE_OPS.openSync(p, f as never, m)
    }) as typeof openSync,
    writeSync: ((fd: number, b: Buffer) => {
      log.push('write'); return REAL_EVIDENCE_OPS.writeSync(fd, b as never)
    }) as typeof writeSync,
    fsyncSync: ((fd: number) => { log.push('fsync'); return REAL_EVIDENCE_OPS.fsyncSync(fd) }),
    chmodSync: ((p: string, m: number) => {
      log.push(`chmod ${(m).toString(8)} ${rel(p)}`); return REAL_EVIDENCE_OPS.chmodSync(p, m)
    }) as typeof import('node:fs').chmodSync,
    renameNoReplace: ((a: string, b: string) => {
      log.push(`rename ${rel(a)} -> ${rel(b)}`)
      return REAL_EVIDENCE_OPS.renameNoReplace(a, b)
    }),
    ...over,
  }
  return { ops, log }
}

describe('names and inputs', () => {
  it('derives both names from one run identifier', () => {
    const n = evidenceNames('source-manifest', STAMP, RUN)
    expect(n.finalName).toBe(`source-manifest-${STAMP}-${RUN}`)
    expect(n.temporaryName).toBe(`.tmp-${RUN}`)
    expect(n.finalName).toMatch(/^source-manifest-\d{8}T\d{6}Z-[0-9a-f]{8}$/)
  })

  it('stamps in UTC, never in the host timezone', () => {
    // 2026-09-24T17:15:30Z is the 24th in UTC and the 24th in Los Angeles at a
    // different hour; the stamp must show the UTC hour.
    expect(evidenceStamp(new Date('2026-09-24T17:15:30.000Z'))).toBe('20260924T171530Z')
    expect(evidenceStamp(new Date('2026-01-01T00:00:00.000Z'))).toBe('20260101T000000Z')
  })

  it('mints eight lowercase hex run identifiers', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 64; i += 1) {
      const id = newRunId()
      expect(id).toMatch(/^[0-9a-f]{8}$/)
      seen.add(id)
    }
    expect(seen.size).toBeGreaterThan(50)
  })

  it('refuses an unreviewed prefix, a malformed stamp and a malformed run id', () => {
    expect(() => evidenceNames('something-else', STAMP, RUN)).toThrow(EvidenceRefused)
    expect(() => evidenceNames('source-manifest', '2026-09-24', RUN)).toThrow(EvidenceRefused)
    expect(() => evidenceNames('source-manifest', STAMP, 'A1B2C3D4')).toThrow(EvidenceRefused)
    expect(() => evidenceNames('source-manifest', STAMP, 'a1b2c3d')).toThrow(EvidenceRefused)
  })

  it('refuses an artifact path that is absolute, traversing, empty or too deep', () => {
    expect(assertArtifactPath('a/b/c.json')).toBe('a/b/c.json')
    for (const bad of ['/etc/passwd', '../x', 'a/../b', './x', 'a//b', '', 'a/b/c/d/e.json',
                       'x\ny', `${'a'.repeat(200)}.json`]) {
      expect(() => assertArtifactPath(bad), bad).toThrow(EvidenceRefused)
    }
  })
})

describe('the evidence root', () => {
  it('accepts an owned, real, 0700 directory', () => {
    const root = makeRoot()
    expect(assertEvidenceRoot(root)).toBe(root)
  })

  it('refuses a missing root, a file, a symlink and a loose mode', () => {
    const root = makeRoot()
    expect(() => assertEvidenceRoot(join(root, 'nope'))).toThrow(/not an existing directory/)

    const file = join(root, 'f')
    writeFileSync(file, 'x')
    expect(() => assertEvidenceRoot(file)).toThrow(/not an existing directory/)

    const real = join(root, 'real')
    mkdirSync(real, { mode: 0o700 })
    const link = join(root, 'link')
    symlinkSync(real, link)
    expect(() => assertEvidenceRoot(link)).toThrow(/symbolic link/)

    const loose = join(root, 'loose')
    mkdirSync(loose)
    execFileSync('/bin/chmod', ['755', loose])
    expect(() => assertEvidenceRoot(loose)).toThrow(/not mode 0700/)
  })

  it('never creates the root it was given', () => {
    const root = makeRoot()
    const missing = join(root, 'absent')
    expect(() => assertEvidenceRoot(missing)).toThrow(EvidenceRefused)
    expect(pathIsPresent(missing)).toBe(false)
  })
})

describe('the digest file', () => {
  it('is deterministic, lexical, relative and covers every artifact but itself', () => {
    const text = digestFileText([artifact('b.json', 'B'), artifact('a/z.json', 'Z'),
                                 artifact('a.json', 'A')])
    expect(text.split('\n').slice(0, -1).map(l => l.split('  ')[1]))
      .toEqual(['a.json', 'a/z.json', 'b.json'])
    expect(text.endsWith('\n')).toBe(true)
    for (const line of text.split('\n').slice(0, -1)) {
      expect(line).toMatch(/^[0-9a-f]{64}  [^/].*$/)
    }
    // Supplying them in another order changes nothing.
    expect(digestFileText([artifact('a.json', 'A'), artifact('b.json', 'B'),
                           artifact('a/z.json', 'Z')])).toBe(text)
  })

  it('records the sha256 of the exact bytes', () => {
    const text = digestFileText([artifact('a.json', 'hello')])
    expect(text).toBe(`${sha256Hex(Buffer.from('hello'))}  a.json\n`)
  })

  it('refuses a malformed, unterminated or duplicated digest body', () => {
    expect(() => parseDigestFile('deadbeef  a.json\n')).toThrow(EvidenceRefused)
    expect(() => parseDigestFile(`${'0'.repeat(64)}  a.json`)).toThrow(EvidenceRefused)
    expect(() => parseDigestFile(`${'0'.repeat(64)}  a.json\n${'1'.repeat(64)}  a.json\n`))
      .toThrow(EvidenceRefused)
  })
})

describe('publication', () => {
  it('publishes a complete, frozen, verifiable bundle', () => {
    const root = makeRoot()
    const p = publish(root)

    expect(p.finalPath).toBe(join(root, `source-manifest-${STAMP}-${RUN}`))
    expect(p.temporaryPath).toBe(join(root, `.tmp-${RUN}`))
    expect(pathIsPresent(p.temporaryPath)).toBe(false)
    expect([...p.files]).toEqual(['manifest.json', 'source-contract.json', DIGEST_FILE])

    // Modes: the directory 0500, every file 0400, every link count 1.
    expect(lstatSync(p.finalPath).mode & 0o777).toBe(FROZEN_DIR_MODE)
    for (const f of p.files) {
      const st = lstatSync(join(p.finalPath, f))
      expect(st.mode & 0o777, f).toBe(FROZEN_FILE_MODE)
      expect(st.nlink, f).toBe(1)
      expect(st.isFile(), f).toBe(true)
    }

    // DIGEST is independently verifiable with no help from this module.
    const recorded = parseDigestFile(readFileSync(join(p.finalPath, DIGEST_FILE), 'utf-8'))
    expect([...recorded.keys()].sort()).toEqual(['manifest.json', 'source-contract.json'])
    for (const [rel, digest] of recorded) {
      expect(sha256Hex(readFileSync(join(p.finalPath, rel))), rel).toBe(digest)
    }
    expect(verifyPublishedEvidence(p.finalPath)).toEqual([...p.files])
  })

  it('writes every artifact, then the manifest, then DIGEST - and freezes, syncs, renames', () => {
    const root = makeRoot()
    const { ops, log } = recordingOps()
    // A NESTED artifact, so directory freezing and directory fsync are actually
    // exercised rather than trivially absent.
    publish(root, {
      artifacts: [artifact('source-contract.json', '{"a":1}'), artifact('sub/inner.json', 'i')],
    }, ops)

    const writes = log.filter(l => l.startsWith('open wx')).map(l => l.split('/').pop())
    expect(writes).toEqual(['source-contract.json', 'inner.json', 'manifest.json', DIGEST_FILE])

    const at = (pred: (l: string) => boolean): number => log.findIndex(pred)
    const digestWritten = at(l => l === `open wx .tmp-${RUN}/${DIGEST_FILE}`)
    const firstChmod400 = at(l => l.startsWith('chmod 400'))
    const chmod500Sub = at(l => l === 'chmod 500 .tmp-a1b2c3d4/sub')
    const firstFsync = log.indexOf('fsync')
    const rename = at(l => l.startsWith('rename'))
    const chmod500Final = log.findIndex(
      (l, i) => i > rename && l.startsWith('chmod 500'))

    // DIGEST is written after every other artifact and before anything is
    // frozen; freezing is files, then nested directories; fsync comes after
    // freezing; the rename comes after every fsync but the last two.
    expect(digestWritten).toBeGreaterThan(-1)
    expect(firstChmod400).toBeGreaterThan(digestWritten)
    expect(chmod500Sub).toBeGreaterThan(firstChmod400)
    expect(firstFsync).toBeGreaterThan(chmod500Sub)
    expect(rename).toBeGreaterThan(firstFsync)

    // Four files + the nested directory + the temporary root, all before the
    // rename; the bundle root's own freeze and fsync, and the parent's fsync,
    // after it.
    expect(log.slice(0, rename).filter(l => l === 'fsync').length).toBe(4 + 1 + 1)
    expect(chmod500Final).toBeGreaterThan(rename)
    expect(log.slice(rename).filter(l => l === 'fsync').length).toBe(2)
  })

  it('refuses a manifest without the completion marker, and publishes nothing', () => {
    const root = makeRoot()
    for (const bad of [artifact('manifest.json', '{"complete":false}'),
                       artifact('manifest.json', '{}'),
                       artifact('manifest.json', 'not json'),
                       artifact('manifest.json', '{"complete":"true"}')]) {
      expect(() => publish(root, { manifest: bad })).toThrow(/completion marker/)
    }
    expect(readdirSync(root)).toEqual([])
  })

  it('refuses an empty artifact set, a repeated path and a supplied DIGEST', () => {
    const root = makeRoot()
    expect(() => publish(root, { artifacts: [] })).toThrow(/no artifact was supplied/)
    expect(() => publish(root, { artifacts: [artifact('x.json', '1'), artifact('x.json', '2')] }))
      .toThrow(/supplied more than once/)
    expect(() => publish(root, { artifacts: [artifact(DIGEST_FILE, 'x')] }))
      .toThrow(/digest file may not be supplied/)
    expect(readdirSync(root)).toEqual([])
  })
})

describe('collisions refuse without mutating anything', () => {
  it('refuses when the final path is already a directory, and leaves it alone', () => {
    const root = makeRoot()
    const first = publish(root)
    const before = readFileSync(join(first.finalPath, 'manifest.json'), 'utf-8')

    expect(() => publish(root, { artifacts: [artifact('other.json', 'x')] }))
      .toThrow(/already present at the publication destination/)
    expect(readFileSync(join(first.finalPath, 'manifest.json'), 'utf-8')).toBe(before)
    expect(verifyPublishedEvidence(first.finalPath)).toBeTruthy()
    expect(readdirSync(first.finalPath).sort())
      .toEqual([DIGEST_FILE, 'manifest.json', 'source-contract.json'])
  })

  it('refuses a DANGLING symlink at the final path', () => {
    const root = makeRoot()
    const final = join(root, `source-manifest-${STAMP}-${RUN}`)
    symlinkSync(join(root, 'does-not-exist'), final)
    expect(pathIsPresent(final)).toBe(true)
    expect(() => publish(root)).toThrow(/already present at the publication destination/)
    // The link is untouched and still dangles - nothing was written through it.
    expect(lstatSync(final).isSymbolicLink()).toBe(true)
    expect(pathIsPresent(join(root, 'does-not-exist'))).toBe(false)
  })

  it('refuses a DANGLING symlink at the temporary path, and never reuses it', () => {
    const root = makeRoot()
    const tmp = join(root, `.tmp-${RUN}`)
    symlinkSync(join(root, 'nowhere'), tmp)
    expect(() => publish(root)).toThrow(/already present at the temporary directory/)
    expect(lstatSync(tmp).isSymbolicLink()).toBe(true)
    expect(pathIsPresent(join(root, 'nowhere'))).toBe(false)
  })

  it('refuses a RETAINED temporary directory rather than reusing or merging it', () => {
    const root = makeRoot()
    const tmp = join(root, `.tmp-${RUN}`)
    mkdirSync(tmp, { mode: BUILD_DIR_MODE })
    writeFileSync(join(tmp, 'left-behind.json'), 'from the failed run')
    expect(() => publish(root)).toThrow(/already present at the temporary directory/)
    expect(readdirSync(tmp)).toEqual(['left-behind.json'])
    expect(readFileSync(join(tmp, 'left-behind.json'), 'utf-8')).toBe('from the failed run')
  })
})

describe('a published bundle cannot be edited', () => {
  it('refuses create, append, truncate and replace - and DIGEST still verifies', () => {
    const root = makeRoot()
    const p = publish(root)
    const target = join(p.finalPath, 'manifest.json')

    // CREATE a new file in the frozen directory.
    expect(() => { closeSync(openSync(join(p.finalPath, 'new.json'), 'wx', 0o600)) })
      .toThrow(/EACCES|EPERM/)
    // APPEND to a frozen file.
    expect(() => { closeSync(openSync(target, 'a')) }).toThrow(/EACCES|EPERM/)
    // TRUNCATE a frozen file.
    expect(() => { closeSync(openSync(target, 'w')) }).toThrow(/EACCES|EPERM/)
    // REPLACE it by renaming something over it.
    const outside = join(root, 'replacement.json')
    writeFileSync(outside, '{"complete":true,"tampered":true}')
    expect(() => renameSync(outside, target)).toThrow(/EACCES|EPERM/)

    expect(verifyPublishedEvidence(p.finalPath)).toEqual([...p.files])
    expect(readdirSync(p.finalPath).sort())
      .toEqual([DIGEST_FILE, 'manifest.json', 'source-contract.json'])
  })

  it('detects a tamper the owner forced through by chmod - which DIGEST is for', () => {
    const root = makeRoot()
    const p = publish(root)
    // The honest limit: the OWNER can always chmod the tree back. What they
    // cannot do is make the bytes still match DIGEST.
    execFileSync('/bin/chmod', ['700', p.finalPath])
    execFileSync('/bin/chmod', ['600', join(p.finalPath, 'manifest.json')])
    writeFileSync(join(p.finalPath, 'manifest.json'), '{"complete":true,"tampered":true}')
    expect(() => verifyPublishedEvidence(p.finalPath))
      .toThrow(/does not describe the published bytes|type, mode or link count/)
  })

  it('detects an added file and a removed file', () => {
    const root = makeRoot()
    const added = publish(root)
    execFileSync('/bin/chmod', ['700', added.finalPath])
    writeFileSync(join(added.finalPath, 'extra.json'), 'x')
    execFileSync('/bin/chmod', ['400', join(added.finalPath, 'extra.json')])
    execFileSync('/bin/chmod', ['500', added.finalPath])
    expect(() => verifyPublishedEvidence(added.finalPath)).toThrow(EvidenceRefused)

    const root2 = makeRoot()
    const removed = publish(root2)
    execFileSync('/bin/chmod', ['700', removed.finalPath])
    rmSync(join(removed.finalPath, 'source-contract.json'), { force: true })
    execFileSync('/bin/chmod', ['500', removed.finalPath])
    expect(() => verifyPublishedEvidence(removed.finalPath))
      .toThrow(/does not describe the published bytes/)
  })

  it('a second run publishes a DISTINCT directory and never changes the first', () => {
    const root = makeRoot()
    const first = publish(root)
    const firstDigest = readFileSync(join(first.finalPath, DIGEST_FILE), 'utf-8')
    const firstManifest = readFileSync(join(first.finalPath, 'manifest.json'), 'utf-8')

    const second = publish(root, {
      stamp: '20260924T101531Z', runId: 'ffff0000',
      artifacts: [artifact('source-contract.json', '{"a":2}')],
      manifest: manifest({ run: 2 }),
    })
    expect(second.finalPath).not.toBe(first.finalPath)
    expect(readFileSync(join(first.finalPath, DIGEST_FILE), 'utf-8')).toBe(firstDigest)
    expect(readFileSync(join(first.finalPath, 'manifest.json'), 'utf-8')).toBe(firstManifest)
    expect(verifyPublishedEvidence(first.finalPath)).toBeTruthy()
    expect(verifyPublishedEvidence(second.finalPath)).toBeTruthy()
    expect(readdirSync(root).sort()).toEqual([
      `source-manifest-${STAMP}-${RUN}`, 'source-manifest-20260924T101531Z-ffff0000',
    ])
  })
})

const finalOf = (root: string): string => join(root, `source-manifest-${STAMP}-${RUN}`)

describe('injected filesystem failures fail closed', () => {

  it('a failed WRITE leaves the temporary directory and no final path', () => {
    const root = makeRoot()
    let n = 0
    const { ops } = recordingOps({
      writeSync: ((fd: number, b: Buffer) => {
        n += 1
        if (n === 2) throw new Error('ENOSPC: device is full, secret=pw_canary')
        return REAL_EVIDENCE_OPS.writeSync(fd, b as never)
      }) as typeof writeSync,
    })
    let thrown: unknown = null
    try { publish(root, {}, ops) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(EvidenceRefused)
    expect(pathIsPresent(finalOf(root))).toBe(false)
    expect(pathIsPresent(join(root, `.tmp-${RUN}`))).toBe(true)
    expect(surfaces(thrown)).not.toContain('pw_canary')
    expect(surfaces(thrown)).not.toContain('ENOSPC')
  })

  it('a failed FREEZE leaves the temporary directory and no final path', () => {
    const root = makeRoot()
    const { ops } = recordingOps({
      chmodSync: ((p: string, m: number) => {
        if (m === FROZEN_FILE_MODE) throw new Error('EPERM: chmod refused, pw_canary')
        return REAL_EVIDENCE_OPS.chmodSync(p, m)
      }) as typeof import('node:fs').chmodSync,
    })
    let thrown: unknown = null
    try { publish(root, {}, ops) } catch (e) { thrown = e }
    expect((thrown as EvidenceRefused).phase).toBe('freeze')
    expect(pathIsPresent(finalOf(root))).toBe(false)
    expect(pathIsPresent(join(root, `.tmp-${RUN}`))).toBe(true)
    expect(surfaces(thrown)).not.toContain('pw_canary')
  })

  it('a failed FSYNC of a file, and of the temporary root, fails closed', () => {
    for (const failOn of [1, 4]) {
      const root = makeRoot()
      let n = 0
      const { ops } = recordingOps({
        fsyncSync: ((fd: number) => {
          n += 1
          if (n === failOn) throw new Error('EIO: fsync failed, pw_canary')
          return REAL_EVIDENCE_OPS.fsyncSync(fd)
        }),
      })
      let thrown: unknown = null
      try { publish(root, {}, ops) } catch (e) { thrown = e }
      expect((thrown as EvidenceRefused).phase, String(failOn)).toBe('fsync')
      expect(pathIsPresent(finalOf(root)), String(failOn)).toBe(false)
      expect(surfaces(thrown)).not.toContain('pw_canary')
    }
  })

  it('a failed RENAME publishes nothing and keeps the temporary directory', () => {
    const root = makeRoot()
    const { ops } = recordingOps({ renameNoReplace: () => 'failed' })
    let thrown: unknown = null
    try { publish(root, {}, ops) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(EvidenceRefused)
    expect((thrown as EvidenceRefused).phase).toBe('publish')
    expect(pathIsPresent(finalOf(root))).toBe(false)
    expect(pathIsPresent(join(root, `.tmp-${RUN}`))).toBe(true)
  })

  it('REFUSES rather than falling back when atomic no-replace is unavailable', () => {
    // The one downgrade that must never happen quietly: publishing through an
    // overwrite-capable primitive because the safe one could not be reached.
    const root = makeRoot()
    const { ops } = recordingOps({ renameNoReplace: () => 'unavailable' })
    let thrown: unknown = null
    try { publish(root, {}, ops) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(EvidenceRefused)
    expect(String((thrown as Error).message)).toMatch(/no atomic no-replace publication/)
    expect(pathIsPresent(finalOf(root))).toBe(false)
    expect(pathIsPresent(join(root, `.tmp-${RUN}`))).toBe(true)
  })
})

describe('errors never carry filesystem content or a credential', () => {
  it('names at most a reviewed relative path, and never an absolute one', () => {
    const secretRoot = mkdtempSync(join(tmpdir(), 'pgcopy-evidence-pw_canary-'))
    ROOTS.push(secretRoot)
    execFileSync('/bin/chmod', ['700', secretRoot])
    // A real publication that fails inside the bundle: the reason names the
    // relative artifact path and nothing about where the root actually is.
    const { ops } = recordingOps({
      writeSync: (() => { throw new Error('EIO') }) as typeof writeSync,
    })
    let thrown: unknown = null
    try { publish(secretRoot, {}, ops) } catch (e) { thrown = e }
    const seen = surfaces(thrown)
    expect(seen).toContain('source-contract.json')
    expect(seen).not.toContain(secretRoot)
    expect(seen).not.toContain('pw_canary')
    expect(seen).not.toContain('/var/folders')
    expect(seen).not.toContain('postgresql://')
    expect((thrown as EvidenceRefused & { cause?: unknown }).cause).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// D — a path probe may only answer "absent" when it MEANS absent
// ---------------------------------------------------------------------------

describe('path probes fail closed', () => {
  it('answers false only for ENOENT', () => {
    const root = makeRoot()
    expect(pathIsPresent(join(root, 'nothing-here'))).toBe(false)
    expect(pathIsPresent(root)).toBe(true)
  })

  it('still reports a DANGLING symlink as present', () => {
    const root = makeRoot()
    const link = join(root, 'dangling')
    symlinkSync(join(root, 'nowhere-at-all'), link)
    // `existsSync` would follow the link and say false. That is the bug.
    expect(pathIsPresent(link)).toBe(true)
  })

  it('REFUSES on every other lstat failure rather than calling it absent', () => {
    const root = makeRoot()
    for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG']) {
      const ops: EvidenceOps = {
        ...REAL_EVIDENCE_OPS,
        lstatSync: (() => {
          const e = new Error(`${code}: injected, pw_canary /absolute/secret/path`) as
            NodeJS.ErrnoException
          e.code = code
          throw e
        }) as typeof lstatSync,
      }
      let thrown: unknown = null
      try { pathIsPresent(join(root, 'x'), ops) } catch (e) { thrown = e }
      expect(thrown, code).toBeInstanceOf(EvidenceRefused)
      expect((thrown as EvidenceRefused).reason, code).toBe('a path could not be examined')
      expect(surfaces(thrown), code).not.toContain('pw_canary')
      expect(surfaces(thrown), code).not.toContain('/absolute/secret/path')
      expect(surfaces(thrown), code).not.toContain(code)
    }
  })

  it('an unreadable evidence ROOT refuses rather than reading as missing', () => {
    const ops: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      lstatSync: (() => {
        const e = new Error('EACCES: injected') as NodeJS.ErrnoException
        e.code = 'EACCES'
        throw e
      }) as typeof lstatSync,
    }
    let thrown: unknown = null
    try { assertEvidenceRoot('/anywhere', ops) } catch (e) { thrown = e }
    expect((thrown as EvidenceRefused).reason).toBe('a path could not be examined')
  })

  it('a publication whose collision probe cannot answer publishes nothing', () => {
    const root = makeRoot()
    const real = REAL_EVIDENCE_OPS.lstatSync
    const ops: EvidenceOps = {
      ...REAL_EVIDENCE_OPS,
      lstatSync: ((p: string) => {
        if (String(p).includes('source-manifest-')) {
          const e = new Error('EIO: injected') as NodeJS.ErrnoException
          e.code = 'EIO'
          throw e
        }
        return real(p)
      }) as typeof lstatSync,
    }
    let thrown: unknown = null
    try { publish(root, {}, ops) } catch (e) { thrown = e }
    expect((thrown as EvidenceRefused).reason).toBe('a path could not be examined')
    expect(readdirSync(root)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// C — atomic no-replace, and the race the old primitive lost
// ---------------------------------------------------------------------------

describe('publication is atomic and cannot replace a destination', () => {
  it('uses renamex_np with RENAME_EXCL through the OS interpreter only', () => {
    expect(PYTHON3).toBe('/usr/bin/python3')
    expect(LIBSYSTEM).toBe('/usr/lib/libSystem.B.dylib')
    expect(RENAME_EXCL).toBe(0x4)
    expect(HELPER_SOURCE).toContain('renamex_np')
    // The program travels on stdin, so it never appears in a process list.
    expect(HELPER_SOURCE).toContain('sys.argv[1]')
    // And there is no fallback to an overwrite-capable primitive anywhere.
    expect(HELPER_SOURCE).not.toContain('os.rename')
    expect(HELPER_SOURCE).not.toContain('shutil')
  })

  it('publishes onto an absent name and REFUSES an existing one', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'src'), { mode: 0o700 })
    writeFileSync(join(root, 'src', 'f'), 'payload')
    expect(atomicRenameNoReplace(join(root, 'src'), join(root, 'fresh'))).toBe('published')
    expect(readFileSync(join(root, 'fresh', 'f'), 'utf-8')).toBe('payload')

    mkdirSync(join(root, 'src2'), { mode: 0o700 })
    expect(atomicRenameNoReplace(join(root, 'src2'), join(root, 'fresh')))
      .toBe('destination-exists')
    expect(readFileSync(join(root, 'fresh', 'f'), 'utf-8')).toBe('payload')
    expect(readdirSync(join(root, 'src2'))).toEqual([])
  })

  it('PRESERVES a destination created in the former check-then-rename window', () => {
    // The exact race the old implementation lost: an EMPTY directory appearing
    // between the absence check and the rename. Plain rename(2) replaces it
    // silently on this platform - measured - so the empty case is the one that
    // matters, and inode identity is how "not replaced" is proved for it.
    const root = makeRoot()
    const final = finalOf(root)
    let raced: { ino: bigint; dev: number } | null = null
    const { ops } = recordingOps({
      renameNoReplace: (a: string, b: string) => {
        // Slip into the window, exactly as a concurrent publisher would.
        mkdirSync(final, { mode: 0o700 })
        const st = lstatSync(final, { bigint: true })
        raced = { ino: st.ino, dev: Number(st.dev) }
        return REAL_EVIDENCE_OPS.renameNoReplace(a, b)
      },
    })
    let thrown: unknown = null
    try { publish(root, {}, ops) } catch (e) { thrown = e }

    expect(thrown).toBeInstanceOf(EvidenceRefused)
    expect(String((thrown as Error).message))
      .toMatch(/already present at the publication destination/)
    // The racer's directory is STILL THERE, and is the same object.
    const after = lstatSync(final, { bigint: true })
    expect(after.ino).toBe((raced as unknown as { ino: bigint }).ino)
    expect(readdirSync(final)).toEqual([])
    // And our bundle is still under its temporary name, untouched.
    expect(pathIsPresent(join(root, `.tmp-${RUN}`))).toBe(true)
    expect(readdirSync(join(root, `.tmp-${RUN}`)).sort())
      .toEqual([DIGEST_FILE, 'manifest.json', 'source-contract.json'])
  })

  it('PRESERVES a non-empty destination byte for byte', () => {
    const root = makeRoot()
    const final = finalOf(root)
    const { ops } = recordingOps({
      renameNoReplace: (a: string, b: string) => {
        mkdirSync(final, { mode: 0o700 })
        writeFileSync(join(final, 'someone-elses.json'), '{"complete":true,"theirs":1}')
        return REAL_EVIDENCE_OPS.renameNoReplace(a, b)
      },
    })
    expect(() => publish(root, {}, ops))
      .toThrow(/already present at the publication destination/)
    expect(readdirSync(final)).toEqual(['someone-elses.json'])
    expect(readFileSync(join(final, 'someone-elses.json'), 'utf-8'))
      .toBe('{"complete":true,"theirs":1}')
  })
})

// ---------------------------------------------------------------------------
// B — before the rename nothing exists; after it, something does
// ---------------------------------------------------------------------------

describe('publication state is truthful on both sides of the rename', () => {
  const postRename = (over: Partial<EvidenceOps>): {
    thrown: unknown; root: string; final: string
  } => {
    const root = makeRoot()
    let renamed = false
    const { ops } = recordingOps({
      renameNoReplace: (a: string, b: string) => {
        const r = REAL_EVIDENCE_OPS.renameNoReplace(a, b)
        renamed = r === 'published'
        return r
      },
      ...Object.fromEntries(Object.entries(over).map(([k, v]) => [
        k, ((...args: unknown[]) => {
          if (renamed) return (v as (...a: unknown[]) => unknown)(...args)
          return (REAL_EVIDENCE_OPS as unknown as Record<string, (...a: unknown[]) => unknown>)
            [k](...args)
        }),
      ])),
    })
    let thrown: unknown = null
    try { publish(root, {}, ops) } catch (e) { thrown = e }
    return { thrown, root, final: finalOf(root) }
  }

  it('freeze-final: the bundle EXISTS and is preserved', () => {
    const { thrown, root, final } = postRename({
      chmodSync: () => { throw new Error('EPERM: pw_canary') },
    })
    expect(thrown).toBeInstanceOf(EvidencePublishedButUnverified)
    expect((thrown as EvidencePublishedButUnverified).phase).toBe('freeze-final')
    expect(pathIsPresent(final)).toBe(true)
    expect(pathIsPresent(join(root, `.tmp-${RUN}`))).toBe(false)
    expect(readdirSync(final).sort())
      .toEqual([DIGEST_FILE, 'manifest.json', 'source-contract.json'])
    expect(surfaces(thrown)).not.toContain('pw_canary')
  })

  it('fsync-final: the bundle EXISTS and is preserved', () => {
    let seen = 0
    const { thrown, root, final } = postRename({
      fsyncSync: () => { seen += 1; throw new Error('EIO: pw_canary') },
    })
    expect(seen).toBeGreaterThan(0)
    expect((thrown as EvidencePublishedButUnverified).phase).toBe('fsync-final')
    expect(pathIsPresent(final)).toBe(true)
    expect(pathIsPresent(join(root, `.tmp-${RUN}`))).toBe(false)
    expect(surfaces(thrown)).not.toContain('pw_canary')
  })

  it('fsync-parent: the bundle EXISTS and is preserved', () => {
    let n = 0
    const { thrown, root, final } = postRename({
      fsyncSync: ((fd: number) => {
        n += 1
        // The first post-rename fsync is the bundle root's; the second is the
        // parent's, which is the one under test.
        if (n === 2) throw new Error('EIO: pw_canary')
        return REAL_EVIDENCE_OPS.fsyncSync(fd)
      }) as never,
    })
    expect((thrown as EvidencePublishedButUnverified).phase).toBe('fsync-parent')
    expect(pathIsPresent(final)).toBe(true)
    expect(pathIsPresent(join(root, `.tmp-${RUN}`))).toBe(false)
    expect(surfaces(thrown)).not.toContain('pw_canary')
  })

  it('verify: the bundle EXISTS, is preserved, and is NOT repaired', () => {
    const { thrown, root, final } = postRename({
      readFileSync: (() => 'deadbeef  tampered.json\n') as never,
    })
    expect(thrown).toBeInstanceOf(EvidencePublishedButUnverified)
    expect((thrown as EvidencePublishedButUnverified).phase).toBe('verify')
    expect(pathIsPresent(final)).toBe(true)
    expect(pathIsPresent(join(root, `.tmp-${RUN}`))).toBe(false)
    // Untouched: the real DIGEST is still the real DIGEST.
    expect(verifyPublishedEvidence(final)).toEqual(
      ['manifest.json', 'source-contract.json', DIGEST_FILE])
    expect(readdirSync(root).sort()).toEqual([`source-manifest-${STAMP}-${RUN}`])
  })

  it('names the bundle but never an absolute path, a cause or a filesystem error', () => {
    const { thrown } = postRename({
      chmodSync: () => { throw new Error('EPERM: /var/folders/secret pw_canary') },
    })
    const e = thrown as EvidencePublishedButUnverified
    expect(e.publishedName).toBe(`source-manifest-${STAMP}-${RUN}`)
    expect(e.temporaryName).toBe(`.tmp-${RUN}`)
    const seen = surfaces(thrown)
    expect(seen).toContain('has NOT been removed')
    expect(seen).not.toContain('/var/folders')
    expect(seen).not.toContain('pw_canary')
    expect(seen).not.toContain('EPERM')
    expect((e as unknown as { cause?: unknown }).cause).toBeUndefined()
  })

  it('EVERY pre-rename failure leaves no final path at all', () => {
    const cases: Array<[string, Partial<EvidenceOps>]> = [
      ['construct', { openSync: (() => { throw new Error('EIO') }) as never }],
      ['digest', { writeSync: (() => { throw new Error('EIO') }) as never }],
      ['freeze', { chmodSync: (() => { throw new Error('EPERM') }) as never }],
      ['fsync', { fsyncSync: (() => { throw new Error('EIO') }) as never }],
      ['publish', { renameNoReplace: () => 'failed' }],
    ]
    for (const [label, over] of cases) {
      const root = makeRoot()
      const { ops } = recordingOps(over)
      let thrown: unknown = null
      try { publish(root, {}, ops) } catch (e) { thrown = e }
      expect(thrown, label).toBeInstanceOf(EvidenceRefused)
      expect(thrown, label).not.toBeInstanceOf(EvidencePublishedButUnverified)
      expect(pathIsPresent(finalOf(root)), label).toBe(false)
      expect(readdirSync(root), label).toEqual([`.tmp-${RUN}`])
    }
  })
})
