// THE INSPECTOR REPORTS KEYS, NEVER VALUES.
//
// The rejected design printed the plist and redacted afterwards, which means the
// values existed in a buffer one stray write away from disclosure. Here the
// parser never captures an environment VALUE at all, so the sentinel test below
// is checking a structural property rather than the quality of a regex.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultInspectSeam, main as cliMain, type InspectSeam } from '../bin/inspect-launchd-plist.js'

let work: string
beforeEach(() => { work = realpathSync(mkdtempSync(join(tmpdir(), 'insp-'))) })
afterEach(() => { rmSync(work, { recursive: true, force: true }) })
import { formatFindings, hasBlockingFinding, inspectParsedPlist } from '../src/launchd-inspector.js'

const SENTINEL = 'SENTINEL-c0ffee-do-not-print'

const PARSED = {
  Label: 'com.thanapol.ai-capital.worker',
  ProgramArguments: ['/usr/bin/caffeinate', '-i', '/opt/homebrew/bin/npx', 'tsx', '/repo/packages/queue/bin/worker.ts'],
  EnvironmentVariables: {
    PATH: '/usr/bin',
    REDIS_URL: 'redis://localhost:6379',
    PIPELINE_CREDENTIAL_FILE: `/home/u/.config/ai-capital/${SENTINEL}`,
  },
}

describe('findings', () => {
  const f = inspectParsedPlist(PARSED)

  it('reports the label and the program chain', () => {
    expect(f.label).toBe('com.thanapol.ai-capital.worker')
    expect(f.programArguments).toEqual([
      '/usr/bin/caffeinate', '-i', '/opt/homebrew/bin/npx', 'tsx', '/repo/packages/queue/bin/worker.ts',
    ])
  })

  it('reports environment KEY NAMES only', () => {
    expect(f.environmentKeys).toEqual(['PATH', 'REDIS_URL', 'PIPELINE_CREDENTIAL_FILE'])
  })

  it('answers the credential questions as booleans', () => {
    expect(f.hasForbiddenCredentialKey).toBe(false)
    expect(f.hasUnresolvedPlaceholder).toBe(false)
    expect(f.hasPostgresUrlLiteral).toBe(false)
    expect(hasBlockingFinding(f)).toBe(false)
  })

  it('NEVER emits a planted environment value', () => {
    const output = formatFindings(f).join('\n')
    expect(output).not.toContain(SENTINEL)
    expect(output).not.toContain('redis://localhost:6379')
    expect(output).toContain('PIPELINE_CREDENTIAL_FILE')
    expect(output).toContain('com.thanapol.ai-capital.worker')
  })

  it('the whole findings object contains no value', () => {
    expect(JSON.stringify(f)).not.toContain(SENTINEL)
  })
})

describe('it detects what it is asked to detect, and blocks on it', () => {
  const withEnv = (env: Record<string, unknown>) => inspectParsedPlist({ ...PARSED, EnvironmentVariables: { ...PARSED.EnvironmentVariables, ...env } })

  it.each(['DATABASE_URL', 'PGHOST', 'DASHBOARD_DATABASE_URL', 'PIPELINE_DATABASE_URL'])('flags and blocks on %s', (key) => {
    const f = withEnv({ [key]: 'x' })
    expect(f.hasForbiddenCredentialKey).toBe(true)
    expect(hasBlockingFinding(f)).toBe(true)
  })

  it('flags a lower-case forbidden key too', () => {
    expect(withEnv({ database_url: 'x' }).hasForbiddenCredentialKey).toBe(true)
  })

  it('does NOT flag the credential-file path variable, which is not a credential', () => {
    expect(inspectParsedPlist(PARSED).hasForbiddenCredentialKey).toBe(false)
  })

  it.each([
    ['a plain URL', 'postgres://role@host:5432/db'],
    ['MIXED CASE', 'POSTGRES://role@host:5432/db'],
    ['an XML numeric entity', '&#112;ostgres://role@host:5432/db'],
    ['an XML hex entity', '&#x70;ostgresql://role@host:5432/db'],
  ])('flags %s in an environment value, without reporting it', (_l, value) => {
    const f = withEnv({ SOMETHING: value })
    expect(f.hasPostgresUrlLiteral).toBe(true)
    expect(hasBlockingFinding(f)).toBe(true)
    expect(formatFindings(f).join('\n')).not.toContain('role@host')
  })

  it('SUPPRESSES a credential-shaped ProgramArgument rather than printing it', () => {
    const f = inspectParsedPlist({ ...PARSED, ProgramArguments: ['/usr/bin/tsx', 'postgres://secret_role@secret.invalid:5432/secret_db'] })
    expect(f.suppressedArguments).toBe(1)
    expect(f.programArguments).toEqual(['/usr/bin/tsx'])
    expect(f.hasPostgresUrlLiteral).toBe(true)
    const output = formatFindings(f).join('\n')
    expect(output).not.toContain('secret_role')
    expect(output).not.toContain('secret.invalid')
  })

  it('flags an unresolved placeholder in a value, an argument or the label', () => {
    expect(withEnv({ PATH: '@@AI_CAPITAL_ROOT@@/bin' }).hasUnresolvedPlaceholder).toBe(true)
    expect(inspectParsedPlist({ ...PARSED, ProgramArguments: ['@@AI_CAPITAL_ROOT@@/x'] }).hasUnresolvedPlaceholder).toBe(true)
    expect(inspectParsedPlist({ ...PARSED, Label: '@@LABEL@@' }).hasUnresolvedPlaceholder).toBe(true)
  })

  it('refuses a plist that is not a dictionary', () => {
    expect(() => inspectParsedPlist(['a', 'list'])).toThrow(/did not parse as a dictionary/)
    expect(() => inspectParsedPlist(null)).toThrow(/did not parse as a dictionary/)
  })
})

// COMMENTS CANNOT SPOOF THE REPORT.
//
// The Round-1 inspector scanned XML with regexes, so a <key> inside a comment
// was indistinguishable from a real one. Parsing is what fixes that, and this
// test drives the REAL parser (plutil) over a crafted file to prove it.
describe('XML comments cannot spoof findings', () => {
  const SPOOF = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>real.label</string>
	<!-- <key>Label</key><string>spoofed.label</string> -->
	<!-- <key>EnvironmentVariables</key><dict><key>PATH</key><string>/spoofed</string></dict> -->
	<key>EnvironmentVariables</key>
	<dict>
		<key>DATABASE_URL</key>
		<string>postgres://role@host:5432/db</string>
	</dict>
</dict>
</plist>
`

  it('reports the real label and the real forbidden key', () => {
    const file = join(work, 'spoof.plist')
    writeFileSync(file, SPOOF)
    const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf-8', shell: false })
    expect(r.status).toBe(0)
    const f = inspectParsedPlist(JSON.parse(r.stdout))
    expect(f.label).toBe('real.label')
    expect(f.environmentKeys).toEqual(['DATABASE_URL'])
    expect(f.hasForbiddenCredentialKey).toBe(true)
    expect(hasBlockingFinding(f)).toBe(true)
    // The spoofed comment contributed nothing.
    expect(JSON.stringify(f)).not.toContain('spoofed')
  })
})

describe('the CLI is a gate', () => {
  function run(file: string, seam?: Partial<InspectSeam>): number {
    return cliMain([file], { ...defaultInspectSeam, ...seam })
  }

  const CLEAN = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
	<key>Label</key><string>ok</string>
	<key>ProgramArguments</key><array><string>/usr/bin/true</string></array>
	<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string></dict>
</dict></plist>
`

  it('exits 0 on a clean plist', () => {
    const f = join(work, 'clean.plist'); writeFileSync(f, CLEAN)
    expect(run(f)).toBe(0)
  })

  it('exits 70 on a forbidden credential key', () => {
    const f = join(work, 'bad.plist')
    writeFileSync(f, CLEAN.replace('<key>PATH</key><string>/usr/bin</string>', '<key>DATABASE_URL</key><string>x</string>'))
    expect(run(f)).toBe(70)
  })

  it('exits 70 on a PostgreSQL literal', () => {
    const f = join(work, 'url.plist')
    writeFileSync(f, CLEAN.replace('/usr/bin</string>', 'postgres://r@h:5432/d</string>'))
    expect(run(f)).toBe(70)
  })

  it('exits 70 on an unresolved placeholder', () => {
    const f = join(work, 'ph.plist')
    writeFileSync(f, CLEAN.replace('/usr/bin</string>', '@@AI_CAPITAL_ROOT@@</string>'))
    expect(run(f)).toBe(70)
  })

  it('exits 66 on a symlinked input', () => {
    const real = join(work, 'target.plist'); writeFileSync(real, CLEAN)
    const link = join(work, 'link.plist'); symlinkSync(real, link)
    expect(run(link)).toBe(66)
  })

  it('exits 66 on a missing file', () => {
    expect(run(join(work, 'absent.plist'))).toBe(66)
  })

  it('exits 65 when lint fails', () => {
    const f = join(work, 'lint.plist'); writeFileSync(f, CLEAN)
    expect(run(f, { lint: () => ({ status: 1 }) })).toBe(65)
  })

  it('exits 65 when the parser fails', () => {
    const f = join(work, 'parse.plist'); writeFileSync(f, CLEAN)
    expect(run(f, { toJson: () => ({ status: 1, stdout: '' }) })).toBe(65)
  })

  it('exits 65 when the parser returns unusable JSON', () => {
    const f = join(work, 'json.plist'); writeFileSync(f, CLEAN)
    expect(run(f, { toJson: () => ({ status: 0, stdout: 'not json' }) })).toBe(65)
  })

  it('reports ACL state as unknown when the command fails, never as absent', () => {
    const f = join(work, 'acl.plist'); writeFileSync(f, CLEAN)
    const out: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out.push(s); return true }
    try {
      expect(run(f, { acl: () => 'unknown' })).toBe(0)
    } finally {
      ;(process.stdout as unknown as { write: typeof write }).write = write
    }
    expect(out.join('')).toMatch(/acl:\s+unknown/)
  })
})
