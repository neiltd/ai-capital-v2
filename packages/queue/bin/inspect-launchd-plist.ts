#!/usr/bin/env node
// Report on an installed plist, and FAIL when it is unsafe.
//
// ProgramArguments are printed — they are paths, and they are what the
// worker-liveness contract matches on — except for any credential-shaped
// element, which is suppressed and counted instead. Environment VALUES never
// reach the output: see src/launchd-inspector.ts.
//
// Exit codes: 0 clean, 64 usage, 66 unreadable/unsafe input, 65 lint or parse
// failure, 70 a blocking finding.

import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { lstatSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { realpathSync } from 'fs'

import { formatFindings, hasBlockingFinding, inspectParsedPlist } from '../src/launchd-inspector.js'

export const USAGE = 'usage: inspect-launchd-plist.ts <path-to-plist>'

export type AclState = 'present' | 'absent' | 'unknown'

export interface InspectSeam {
  lint: (p: string) => { status: number | null }
  toJson: (p: string) => { status: number | null; stdout: string }
  acl: (p: string) => AclState
}

export const defaultInspectSeam: InspectSeam = {
  lint: (p) => spawnSync('/usr/bin/plutil', ['-lint', p], { shell: false, encoding: 'utf-8' }),
  toJson: (p) => {
    const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', p], { shell: false, encoding: 'utf-8' })
    return { status: r.status, stdout: r.stdout ?? '' }
  },
  acl: (p) => {
    // Node exposes no acl_get_fd, so ACL presence is detected with a subprocess —
    // acceptable here, off any startup path. A FAILED command reports 'unknown',
    // never 'absent': "we could not tell" and "there is none" are different
    // answers, and only one of them is safe to act on.
    const r = spawnSync('/bin/ls', ['-lde', p], { shell: false, encoding: 'utf-8' })
    if (r.status !== 0 || typeof r.stdout !== 'string') return 'unknown'
    return /^\s*\d+:/m.test(r.stdout) ? 'present' : 'absent'
  },
}

export function main(argv: readonly string[] = process.argv.slice(2), seam: InspectSeam = defaultInspectSeam): number {
  const path = argv[0]
  if (path === undefined) { process.stderr.write(`${USAGE}\n`); return 64 }

  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch (e) {
    process.stderr.write(`inspect-launchd-plist: cannot stat ${path} (${(e as NodeJS.ErrnoException).code})\n`)
    return 66
  }
  // lstat, and refuse a symlink: otherwise the report describes one file while
  // launchd loads another.
  if (st.isSymbolicLink()) {
    process.stderr.write(`inspect-launchd-plist: ${path} is a symbolic link; inspect the real file.\n`)
    return 66
  }
  if (!st.isFile()) {
    process.stderr.write(`inspect-launchd-plist: ${path} is not a regular file.\n`)
    return 66
  }

  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch (e) {
    process.stderr.write(`inspect-launchd-plist: cannot read ${path} (${(e as NodeJS.ErrnoException).code})\n`)
    return 66
  }

  const lintOk = seam.lint(path).status === 0
  if (!lintOk) {
    process.stderr.write(`inspect-launchd-plist: plutil -lint FAILED for ${path}\n`)
    return 65
  }

  const json = seam.toJson(path)
  if (json.status !== 0) {
    process.stderr.write(`inspect-launchd-plist: ${path} could not be parsed.\n`)
    return 65
  }
  let findings
  try {
    findings = inspectParsedPlist(JSON.parse(json.stdout))
  } catch (e) {
    process.stderr.write(`inspect-launchd-plist: ${path} could not be interpreted (${(e as Error).message}).\n`)
    return 65
  }

  const acl = seam.acl(path)
  const lines = [
    `path:                      ${path}`,
    `sha256:                    ${createHash('sha256').update(raw).digest('hex')}`,
    `owner uid:                 ${st.uid}`,
    `mode:                      ${(st.mode & 0o7777).toString(8).padStart(4, '0')}`,
    `acl:                       ${acl}`,
    'plutil -lint:              OK',
    ...formatFindings(findings),
  ]
  process.stdout.write(`${lines.join('\n')}\n`)

  if (hasBlockingFinding(findings)) {
    process.stderr.write('inspect-launchd-plist: BLOCKING finding — see the booleans above.\n')
    return 70
  }
  return 0
}

export function isDirectEntrypoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false
  const canonical = (p: string) => {
    try { return pathToFileURL(realpathSync(p)).href } catch { return pathToFileURL(resolve(p)).href }
  }
  const self = (() => { try { return canonical(fileURLToPath(moduleUrl)) } catch { return moduleUrl } })()
  return self === canonical(argv1)
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exitCode = main()
}
