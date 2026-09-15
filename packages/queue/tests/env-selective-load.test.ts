// THE ROOT .env IS READ SELECTIVELY, OR THE BOUNDARY IS DECORATIVE.
//
// Before slice S4D, every queue bin called process.loadEnvFile(root/.env) as its
// first act. That file carries database credentials, so each of the nine bins —
// including the five that never reach PostgreSQL — held a credential merely
// because it shared a file with two API keys. A launchd plist could then be made
// least-privilege and change nothing: the .env value was already installed.
//
// process.loadEnvFile CANNOT be made selective. It writes the whole file into
// process.env before any code can look at it; "delete it afterwards" installs
// the credential first and removes it second, which is a different guarantee. So
// env.ts reads the file, parses it in memory, and assigns only allowlisted keys.
//
// THE PARSER IS dotenv's, NOT node:util's. `engines.node` is ">=20" and parseEnv
// landed in 20.12, so the standard-library parser would crash at import time on
// a runtime the repository claims to support. Only dotenv's pure `parse` export
// is used; `dotenv/config` writes straight into process.env.
//
// These tests write .env fixtures into a temporary directory. None of them
// touches the repository's real .env, and none opens a connection.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync as readFileSyncRaw } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadApprovedRootEnv, APPROVED_ROOT_ENV_KEYS } from '../src/env.js'

const SOURCE = fileURLToPath(new URL('../src/env.ts', import.meta.url))

let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'queue-env-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function writeDotEnv(body: string): void {
  writeFileSync(join(root, '.env'), body, 'utf-8')
}

describe('loadApprovedRootEnv', () => {
  it('copies the approved keys', () => {
    writeDotEnv('ANTHROPIC_API_KEY=fake-anthropic\nSEC_FUND_API_KEY=fake-sec\n')
    const target: NodeJS.ProcessEnv = {}
    loadApprovedRootEnv(root, target)
    expect(target.ANTHROPIC_API_KEY).toBe('fake-anthropic')
    expect(target.SEC_FUND_API_KEY).toBe('fake-sec')
  })

  it('copies NOTHING else, including every database credential in the file', () => {
    // The shapes below are deliberately not valid destinations; what matters is
    // that a key of each forbidden SHAPE is present in the file and absent after.
    writeDotEnv([
      'ANTHROPIC_API_KEY=fake-anthropic',
      'DATABASE_URL=fake-value',
      'PIPELINE_DATABASE_URL=fake-value',
      'DASHBOARD_DATABASE_URL=fake-value',
      'CLAIM_WRITER_DATABASE_URL=fake-value',
      'PGHOST=fake-host',
      'PGDATABASE=fake-db',
      'PGCONNECT_TIMEOUT=5',
      'MIGRATION_OWNER_ROLE=fake-role',
      'LIVE_DATABASE_NAMES=fake-db',
      'LINE_CHANNEL_ACCESS_TOKEN=fake-token',
      '',
    ].join('\n'))

    const target: NodeJS.ProcessEnv = {}
    loadApprovedRootEnv(root, target)

    expect(Object.keys(target).sort()).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('never overwrites a value the real environment already supplied', () => {
    // launchd and an operator export are the authority; the file is a fallback
    // for two API keys, not a source of truth that can silently replace one.
    writeDotEnv('ANTHROPIC_API_KEY=from-file\n')
    const target: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'from-launchd' }
    loadApprovedRootEnv(root, target)
    expect(target.ANTHROPIC_API_KEY).toBe('from-launchd')
  })

  it('is silent when the file does not exist', () => {
    const target: NodeJS.ProcessEnv = {}
    expect(() => loadApprovedRootEnv(root, target)).not.toThrow()
    expect(Object.keys(target)).toEqual([])
  })

  it('parses a lenient file without throwing, and still installs nothing forbidden', () => {
    // dotenv's parser is deliberately tolerant: junk lines are skipped rather
    // than raised. That is fine — what must NOT happen is a forbidden key
    // arriving because the file was odd.
    writeDotEnv('this is not a parseable assignment\nANTHROPIC_API_KEY=fake-anthropic\nDATABASE_URL=fake-value\n')
    const target: NodeJS.ProcessEnv = {}
    expect(() => loadApprovedRootEnv(root, target)).not.toThrow()
    expect(target.ANTHROPIC_API_KEY).toBe('fake-anthropic')
    expect(target.DATABASE_URL).toBeUndefined()
  })

  it('THROWS when the path exists but cannot be read, rather than starting half-configured', () => {
    // DETERMINISTIC BY CONSTRUCTION. This was a chmod(000) fixture whose
    // assertions were wrapped in `if (!readable)`, so a privileged runner — root
    // in CI, most obviously — skipped them and the suite still went green. A
    // DIRECTORY at the .env path fails readFileSync with EISDIR for every user
    // including root, so the assertion below always executes.
    mkdirSync(join(root, '.env'))
    const code = (() => {
      try { readFileSyncRaw(join(root, '.env'), 'utf-8'); return 'READABLE' }
      catch (e) { return (e as NodeJS.ErrnoException).code }
    })()
    // Non-vacuity: the fixture really does produce a non-ENOENT read failure.
    expect(code).not.toBe('READABLE')
    expect(code).not.toBe('ENOENT')

    expect(() => loadApprovedRootEnv(root, {})).toThrow(/could not read/)
  })

  it('names the path and a safe error classification, and no values, when it throws', () => {
    // The secrets live in a sibling file: the unreadable path is a directory, so
    // nothing can be read from it — which is the point. What must not leak is
    // the target environment being populated or anything the process already
    // holds.
    mkdirSync(join(root, '.env'))
    const target: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: 'super-secret-value',
      DATABASE_URL: 'another-secret',
    }

    let message = ''
    let threw = false
    try {
      loadApprovedRootEnv(root, target)
    } catch (e) {
      threw = true
      message = (e as Error).message
    }

    expect(threw, 'loadApprovedRootEnv did not throw').toBe(true)
    expect(message).toContain(join(root, '.env'))
    expect(message).toMatch(/EISDIR|EACCES|EPERM|EIO|unknown error/)
    for (const secret of ['super-secret-value', 'another-secret']) {
      expect(message).not.toContain(secret)
    }
  })

  it('honours an injected allowlist, so the allowlist is the mechanism', () => {
    // Non-vacuity control: if the function simply copied the approved constants,
    // this narrowed list would change nothing.
    writeDotEnv('ANTHROPIC_API_KEY=fake-anthropic\nSEC_FUND_API_KEY=fake-sec\n')
    const target: NodeJS.ProcessEnv = {}
    loadApprovedRootEnv(root, target, ['SEC_FUND_API_KEY'])
    expect(target.SEC_FUND_API_KEY).toBe('fake-sec')
    expect(target.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('does not mutate process.env', () => {
    writeDotEnv('ANTHROPIC_API_KEY=fake-anthropic\nPGHOST=fake-host\n')
    const before = process.env.PGHOST
    loadApprovedRootEnv(root, {})
    expect(process.env.PGHOST).toBe(before)
  })
})

describe('the allowlist itself', () => {
  it('is exactly the two keys a stage cannot obtain locally', () => {
    expect([...APPROVED_ROOT_ENV_KEYS]).toEqual(['ANTHROPIC_API_KEY', 'SEC_FUND_API_KEY'])
  })

  it('is frozen, so a caller cannot widen it at runtime', () => {
    expect(Object.isFrozen(APPROVED_ROOT_ENV_KEYS)).toBe(true)
  })

  it('contains no credential-shaped key', () => {
    for (const key of APPROVED_ROOT_ENV_KEYS) {
      expect(key).not.toMatch(/_DATABASE_URL$|^PG[A-Z0-9_]*$|^DATABASE_URL$/)
    }
  })
})

describe('env.ts reaches the file the only way that can be selective', () => {
  const src = () => readFileSyncRaw(SOURCE, 'utf-8')

  it("uses dotenv's PURE parser, which every supported Node version has", () => {
    expect(src()).toMatch(new RegExp(["import \\{ parse as parseDotenv \\} from '", 'dotenv', "'"].join('')))
  })

  it('does NOT use the standard-library parser, which needs Node 20.12', () => {
    // engines.node is ">=20". A 20.0-20.11 runtime satisfies that and has no
    // such export, so importing it would crash before the first statement runs.
    // env.ts explains that in prose, so only CODE lines are scanned.
    const code = src().split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).not.toMatch(/\bparseEnv\b/)
    expect(code).not.toMatch(/from 'node:util'/)
    // Non-vacuity: the comment-stripped text is still the body of the module.
    expect(code).toContain('export function loadApprovedRootEnv')
  })

  it("never imports dotenv's SIDE-EFFECTING entry point, in either form", () => {
    // Both `import 'dotenv/config'` (bare) and `import x from 'dotenv/config'`
    // populate process.env from the whole file, which is precisely what this
    // module exists to avoid. The bare form has no `from`, so match the
    // specifier itself.
    expect(src()).not.toMatch(new RegExp(["'", 'dotenv', "/config'"].join('')))
  })

  it('interpolates no file content, parsed value or target environment into an error', () => {
    // R2-02: an error message is the one place a redacted failure can stop being
    // redacted. Nothing read from the file, nothing parsed out of it, and not
    // the environment being populated may appear in a thrown message.
    const code = src().split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    const throws = [...code.matchAll(/throw new Error\(([\s\S]*?)\n\s*\)/g)].map(m => m[1])
    expect(throws.length).toBeGreaterThan(0)
    for (const body of throws) {
      // Only the INTERPOLATIONS can carry a value; the prose may legitimately
      // use the word "contents" to say that they are never reported.
      const interpolated = [...body.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]).join(' ')
      for (const forbidden of ['contents', 'parsed', 'target', 'value', 'raw']) {
        expect(interpolated, `error message interpolates ${forbidden}`).not.toContain(forbidden)
      }
      // Non-vacuity: these messages really do interpolate something.
      expect(interpolated).toContain('envPath')
    }
  })

  it('swallows no read failure', () => {
    const code = src().split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    // Every catch either re-throws or returns for the one benign code.
    expect(code).toMatch(/code === 'ENOENT'/)
    expect(code).toMatch(/throw new Error\(/)
  })

  it('never CALLS the whole-file loader', () => {
    // env.ts names it in prose, explaining why it is unusable here, so the word
    // alone proves nothing either way. Comment lines are dropped and the scan
    // looks for an invocation in CODE.
    const code = src()
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(code).not.toMatch(new RegExp(['load', 'EnvFile'].join('')))
    // Non-vacuity: the comment-stripped text is still the body of the module.
    expect(code).toContain('export function loadApprovedRootEnv')
  })


})
