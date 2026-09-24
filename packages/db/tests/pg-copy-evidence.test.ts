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
  BUILD_DIR_MODE, DIGEST_FILE, EvidenceRefused, FROZEN_DIR_MODE, FROZEN_FILE_MODE,
  REAL_EVIDENCE_OPS, assertArtifactPath, assertEvidenceRoot, digestFileText, evidenceNames,
  evidenceStamp, newRunId, parseDigestFile, pathIsPresent, publishEvidence, sha256Hex,
  verifyPublishedEvidence, type EvidenceArtifact, type EvidenceOps,
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
    renameSync: ((a: string, b: string) => {
      log.push(`rename ${rel(a)} -> ${rel(b)}`); return REAL_EVIDENCE_OPS.renameSync(a, b)
    }) as typeof renameSync,
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

describe('injected filesystem failures fail closed', () => {
  const finalOf = (root: string): string => join(root, `source-manifest-${STAMP}-${RUN}`)

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
    const { ops } = recordingOps({
      renameSync: (() => { throw new Error('EXDEV: cross-device link, pw_canary') }) as never,
    })
    let thrown: unknown = null
    try { publish(root, {}, ops) } catch (e) { thrown = e }
    expect((thrown as EvidenceRefused).phase).toBe('publish')
    expect(pathIsPresent(finalOf(root))).toBe(false)
    expect(pathIsPresent(join(root, `.tmp-${RUN}`))).toBe(true)
    expect(surfaces(thrown)).not.toContain('pw_canary')
    expect(surfaces(thrown)).not.toContain('EXDEV')
  })

  it('a failed PARENT fsync fails after publication rather than reporting success', () => {
    const root = makeRoot()
    let renamed = false
    let post = 0
    const { ops } = recordingOps({
      renameSync: ((a: string, b: string) => {
        renamed = true; return REAL_EVIDENCE_OPS.renameSync(a, b)
      }) as typeof renameSync,
      fsyncSync: ((fd: number) => {
        // The LAST fsync is the parent's; the one before it is the freshly
        // frozen bundle root.
        if (renamed) { post += 1; if (post === 2) throw new Error('EIO: parent fsync, pw_canary') }
        return REAL_EVIDENCE_OPS.fsyncSync(fd)
      }),
    })
    let thrown: unknown = null
    try { publish(root, {}, ops) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(EvidenceRefused)
    expect((thrown as EvidenceRefused).phase).toBe('fsync')
    expect(surfaces(thrown)).not.toContain('pw_canary')
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
