// THE RENDERER MAY NEVER PUT A SECRET IN A PLIST.
//
// It substitutes a repository path, an unauthenticated Redis endpoint, and the
// PATH of a credential file. Three independent guards make a leak a test
// failure rather than a procedure: a forbidden placeholder in the template, a
// forbidden key or PostgreSQL literal in the output, and an exact per-agent
// allowlist so an unexpected placeholder cannot be introduced quietly.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AGENTS, type AgentName, assertParsedPlistIsSafe, assertRenderedOutputIsSafe,
  decodeXmlEntities, escapeXml, installedPath, looksLikePostgresUrl, placeholderCounts,
  renderPlist, validateRedisUrl,
} from '../src/launchd-renderer.js'
import {
  type PublishSeam, acquireLock, assertDirectory, checkCount, cleanupIncomplete,
  defaultPublishSeam, describeCleanup, inspectDestination, publishBytes,
} from '../src/atomic-publish.js'
import { main as cliMain } from '../bin/render-launchd-plist.js'

const TEMPLATES = fileURLToPath(new URL('../../../ops/launchd/', import.meta.url))
const ROOT = '/private/tmp/ai-capital-fake-root'
const REDIS = 'redis://localhost:6379'
const CRED = '/Users/nobody/.config/ai-capital/pipeline-database.url'

function valuesFor(agent: AgentName): Record<string, string> {
  const v: Record<string, string> = { AI_CAPITAL_ROOT: ROOT }
  if ('REDIS_URL' in AGENTS[agent].placeholders) v.REDIS_URL = REDIS
  if ('PIPELINE_CREDENTIAL_FILE' in AGENTS[agent].placeholders) v.PIPELINE_CREDENTIAL_FILE = CRED
  return v
}

let work: string
beforeEach(() => { work = realpathSync(mkdtempSync(join(tmpdir(), 'render-'))) })
afterEach(() => { rmSync(work, { recursive: true, force: true }) })

describe('the tracked templates satisfy their exact contracts', () => {
  it.each(Object.keys(AGENTS) as AgentName[])('%s renders', (agent) => {
    const out = renderPlist({ agent, templateDir: TEMPLATES, values: valuesFor(agent) })
    expect(out).toContain(`<string>${AGENTS[agent].label}</string>`)
    expect(out).not.toMatch(/@@[A-Z0-9_]+@@/)
  })

  it.each(Object.keys(AGENTS) as AgentName[])('%s has exactly its allowed placeholders', (agent) => {
    const text = readFileSync(join(TEMPLATES, AGENTS[agent].template), 'utf-8')
    expect(placeholderCounts(text)).toEqual(AGENTS[agent].placeholders)
  })

  it('no template mentions a credential VALUE placeholder', () => {
    for (const agent of Object.keys(AGENTS) as AgentName[]) {
      const text = readFileSync(join(TEMPLATES, AGENTS[agent].template), 'utf-8')
      expect(text).not.toContain('@@PIPELINE_DATABASE_URL@@')
      expect(text).not.toContain('@@DATABASE_URL@@')
      expect(text).not.toContain('@@PLACEHOLDER@@')
    }
  })

  it('only the three PostgreSQL-touching agents take a credential file', () => {
    const withCred = (Object.keys(AGENTS) as AgentName[])
      .filter(a => 'PIPELINE_CREDENTIAL_FILE' in AGENTS[a].placeholders).sort()
    expect(withCred).toEqual(['alerts', 'structured-worker', 'worker'])
  })

  it('daily and watchdog take no credential of any kind', () => {
    for (const agent of ['daily', 'watchdog'] as AgentName[]) {
      expect(Object.keys(AGENTS[agent].placeholders).sort()).toEqual(['AI_CAPITAL_ROOT', 'REDIS_URL'])
    }
  })

  it('worker liveness is unaffected: ProgramArguments are the exact chain', () => {
    const out = renderPlist({ agent: 'worker', templateDir: TEMPLATES, values: valuesFor('worker') })
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(out)?.[1] ?? ''
    expect([...args.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1])).toEqual([
      '/usr/bin/caffeinate', '-i', '/opt/homebrew/bin/npx', 'tsx',
      `${ROOT}/packages/queue/bin/worker.ts`,
    ])
  })
})

describe('template contract violations', () => {
  function stage(agent: AgentName, mutate: (s: string) => string): string {
    const d = join(work, 'tpl'); mkdirSync(d, { recursive: true })
    const name = AGENTS[agent].template
    writeFileSync(join(d, name), mutate(readFileSync(join(TEMPLATES, name), 'utf-8')))
    return d
  }

  it('refuses a credential placeholder in the template', () => {
    const d = stage('worker', s => s.replace('@@REDIS_URL@@', '@@PIPELINE_DATABASE_URL@@'))
    expect(() => renderPlist({ agent: 'worker', templateDir: d, values: valuesFor('worker') }))
      .toThrow(/forbidden placeholder @@PIPELINE_DATABASE_URL@@/)
  })

  it('refuses an unknown placeholder', () => {
    const d = stage('daily', s => s.replace('@@REDIS_URL@@', '@@SOMETHING_ELSE@@'))
    expect(() => renderPlist({ agent: 'daily', templateDir: d, values: valuesFor('daily') }))
      .toThrow(/unexpected placeholder|exactly 1 time/)
  })

  it('refuses a changed occurrence count', () => {
    const d = stage('daily', s => s.replace('<key>REDIS_URL</key>', '<key>REDIS_URL</key><!-- @@REDIS_URL@@ -->'))
    expect(() => renderPlist({ agent: 'daily', templateDir: d, values: valuesFor('daily') }))
      .toThrow(/exactly 1 time\(s\); found 2/)
  })

  it('refuses a missing value', () => {
    expect(() => renderPlist({ agent: 'daily', templateDir: TEMPLATES, values: { AI_CAPITAL_ROOT: ROOT } }))
      .toThrow(/no value supplied for @@REDIS_URL@@/)
  })

  it('refuses a value the template does not use', () => {
    expect(() => renderPlist({
      agent: 'daily', templateDir: TEMPLATES,
      values: { ...valuesFor('daily'), PIPELINE_CREDENTIAL_FILE: CRED },
    })).toThrow(/does not use/)
  })
})

describe('XML escaping and output guards', () => {
  it('escapes all five metacharacters', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f')
  })

  it('escapes a hostile root path into the rendered plist', () => {
    const hostile = '/tmp/a&b<c>d"e\'f'
    const out = renderPlist({ agent: 'daily', templateDir: TEMPLATES, values: { AI_CAPITAL_ROOT: hostile, REDIS_URL: REDIS } })
    expect(out).toContain('/tmp/a&amp;b&lt;c&gt;d&quot;e&apos;f')
    expect(out).not.toContain('<c>d')
  })

  it('handles Unicode paths', () => {
    const out = renderPlist({ agent: 'daily', templateDir: TEMPLATES, values: { AI_CAPITAL_ROOT: '/tmp/é-café', REDIS_URL: REDIS } })
    expect(out).toContain('/tmp/é-café')
  })

  it('substitutes literally — a path containing $& is not a replacement pattern', () => {
    const out = renderPlist({ agent: 'daily', templateDir: TEMPLATES, values: { AI_CAPITAL_ROOT: '/tmp/$&x', REDIS_URL: REDIS } })
    expect(out).toContain('/tmp/$&amp;x')
  })

  it.each([
    ['a residual placeholder', '<string>@@AI_CAPITAL_ROOT@@</string>'],
    ['a forbidden key', '<key>DATABASE_URL</key><string>x</string>'],
    ['a PostgreSQL literal', '<string>postgres://role@host:5432/db</string>'],
  ])('the output guard refuses %s', (_l, text) => {
    expect(() => assertRenderedOutputIsSafe(text)).toThrow()
  })
})

describe('Redis classification', () => {
  it.each(['redis://localhost:6379', 'rediss://cache.internal:6380', 'redis://127.0.0.1'])('accepts %s', (u) => {
    expect(validateRedisUrl(u)).toBe(u)
  })

  it.each([
    ['a password', 'redis://user:pass@localhost:6379'],
    ['a username only', 'redis://user@localhost:6379'],
  ])('refuses %s as a secret', (_l, u) => {
    expect(() => validateRedisUrl(u)).toThrow(/authentication material/)
  })

  it.each([
    ['a wrong scheme', 'http://localhost:6379'],
    ['a query parameter', 'redis://localhost:6379?token=abc'],
    ['a fragment', 'redis://localhost:6379#frag'],
    ['no host', 'redis://'],
    ['garbage', 'not a url'],
  ])('refuses %s', (_l, u) => {
    expect(() => validateRedisUrl(u)).toThrow()
  })

  it('never reports the offending value', () => {
    let m = ''
    try { validateRedisUrl('redis://user:supersecret@localhost:6379') } catch (e) { m = (e as Error).message }
    expect(m).not.toContain('supersecret')
  })
})

// PUBLICATION IS THE SHARED PRIMITIVE. The renderer and the credential installer
// use the same code, so these cases constrain both.
describe('publication', () => {
  const TEXT = Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n', 'utf-8')
  const CREATE = { mode: 'create' as const, fileMode: 0o600, directoryMode: null }
  const REPLACE = { mode: 'replace' as const, fileMode: 0o600, directoryMode: null }

  it('publishes and reports the destination', () => {
    const dest = join(work, 'a.plist')
    const r = publishBytes(dest, TEXT, CREATE)
    expect(r.published).toBe(true)
    expect(r.unchanged).toBe(false)
    expect(cleanupIncomplete(r)).toBe(false)
    expect(r.cleanup.temporary).toBe('removed')
    expect(r.cleanup.lockReleased).toBe(true)
    expect(readFileSync(dest)).toEqual(TEXT)
    // A clean success leaves ONE name, no temporary and no lock.
    expect(statSync(dest).nlink).toBe(1)
    expect(readdirSync(work).filter(f => f.endsWith('.tmp'))).toEqual([])
    expect(existsSync(`${dest}.lock`)).toBe(false)
  })

  it('is idempotent: identical content republishes nothing', () => {
    const dest = join(work, 'b.plist')
    publishBytes(dest, TEXT, CREATE)
    const again = publishBytes(dest, TEXT, CREATE)
    expect(again.published).toBe(false)
    expect(again.unchanged).toBe(true)
    expect(cleanupIncomplete(again)).toBe(false)
  })

  it('refuses to overwrite different content in create mode', () => {
    const dest = join(work, 'c.plist')
    publishBytes(dest, TEXT, CREATE)
    expect(() => publishBytes(dest, Buffer.concat([TEXT, Buffer.from('x')]), CREATE)).toThrow(/already exists/)
    expect(readFileSync(dest)).toEqual(TEXT)
  })

  it('replaces only in replace mode', () => {
    const dest = join(work, 'd.plist')
    publishBytes(dest, TEXT, CREATE)
    const v2 = Buffer.concat([TEXT, Buffer.from('<!-- v2 -->')])
    publishBytes(dest, v2, REPLACE)
    expect(readFileSync(dest)).toEqual(v2)
  })

  it('refuses REPLACE when there is nothing to replace', () => {
    expect(() => publishBytes(join(work, 'absent.plist'), TEXT, REPLACE)).toThrow(/nothing to replace/)
  })

  // A COMPETING WRITER, ON THE REAL FILESYSTEM.
  //
  // rename() would silently destroy their file. link() fails with EEXIST, which
  // is why initial publication uses it.
  it('leaves a competing writer\'s bytes untouched when it appears after the first look', () => {
    const dest = join(work, 'race.plist')
    const theirs = Buffer.from('COMPETING WRITER BYTES\n', 'utf-8')
    const real = defaultPublishSeam
    const seam: PublishSeam = {
      ...real,
      // Create the destination in the window between inspection and publication.
      fsyncSync: (fd) => { if (!existsSync(dest)) writeFileSync(dest, theirs); real.fsyncSync(fd) },
    }
    expect(() => publishBytes(dest, TEXT, CREATE, seam)).toThrow(/created by another writer/)
    expect(readFileSync(dest)).toEqual(theirs)
  })

  it('never unlinks a temporary it does not own', () => {
    const dest = join(work, 'own.plist')
    const real = defaultPublishSeam
    let tempPath = ''
    const seam: PublishSeam = {
      ...real,
      openSync: (p, flags, mode) => {
        if (p.endsWith('.tmp')) {
          tempPath = p
          writeFileSync(p, 'SOMEONE ELSE\n')      // pre-create it
          const err = new Error('EEXIST') as NodeJS.ErrnoException
          err.code = 'EEXIST'
          throw err
        }
        return real.openSync(p, flags, mode)
      },
    }
    expect(() => publishBytes(dest, TEXT, CREATE, seam)).toThrow(/not ours; refusing to touch it/)
    expect(readFileSync(tempPath, 'utf-8')).toBe('SOMEONE ELSE\n')
  })

  it('a validation failure publishes nothing', () => {
    const dest = join(work, 'e.plist')
    expect(() => publishBytes(dest, TEXT, { ...CREATE, validate: () => { throw new Error('lint said no') } }))
      .toThrow(/lint said no/)
    expect(existsSync(dest)).toBe(false)
    expect(readdirSync(work).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('a SHORT WRITE publishes nothing', () => {
    const dest = join(work, 'f.plist')
    expect(() => publishBytes(dest, TEXT, CREATE, { ...defaultPublishSeam, writeSync: () => 0 })).toThrow(/short write/)
    expect(existsSync(dest)).toBe(false)
  })

  it('loops on a PARTIAL write rather than truncating', () => {
    const dest = join(work, 'g.plist')
    const real = defaultPublishSeam
    publishBytes(dest, TEXT, CREATE, { ...real, writeSync: (fd, b, o) => real.writeSync(fd, b, o, 1) })
    expect(readFileSync(dest)).toEqual(TEXT)
  })

  it.each([
    ['a non-integer', 1.5],
    ['a negative count', -3],
    ['more than requested', 10_000],
  ])('refuses %s from an injected write', (_l, value) => {
    const dest = join(work, `cnt-${String(value)}.plist`)
    expect(() => publishBytes(dest, TEXT, CREATE, { ...defaultPublishSeam, writeSync: () => value as number }))
      .toThrow(/returned|count/)
    expect(existsSync(dest)).toBe(false)
  })

  it('orders write → fsync → close → validate → publish → dir fsync', () => {
    const order: string[] = []
    const dest = join(work, 'h.plist')
    const real = defaultPublishSeam
    publishBytes(dest, TEXT, {
      ...CREATE,
      validate: () => { order.push('validate') },
    }, {
      ...real,
      writeSync: (fd, b, o, l) => { order.push('write'); return real.writeSync(fd, b, o, l) },
      fsyncSync: (fd) => { order.push('fsync'); real.fsyncSync(fd) },
      linkSync: (a, b) => { order.push('link'); real.linkSync(a, b) },
    })
    const lastWrite = order.lastIndexOf('write')
    expect(lastWrite).toBeLessThan(order.indexOf('fsync'))
    expect(order.indexOf('fsync')).toBeLessThan(order.indexOf('validate'))
    expect(order.indexOf('validate')).toBeLessThan(order.indexOf('link'))
    expect(order.indexOf('link')).toBeLessThan(order.lastIndexOf('fsync'))
  })

  it('a DIRECTORY fsync failure after publication leaves the publication standing', () => {
    const dest = join(work, 'i.plist')
    let linked = false
    const real = defaultPublishSeam
    const result = publishBytes(dest, TEXT, CREATE, {
      ...real,
      linkSync: (a, b) => { linked = true; real.linkSync(a, b) },
      fsyncSync: (fd) => { if (linked) throw new Error('EIO'); real.fsyncSync(fd) },
    })
    expect(result.published).toBe(true)
    expect(result.cleanup.directoryFsyncFailed).toMatch(/EIO/)
    expect(cleanupIncomplete(result)).toBe(true)
    expect(readFileSync(dest)).toEqual(TEXT)
  })

  it('a concurrent invocation is refused, and the lock is never stolen', () => {
    const dest = join(work, 'j.plist')
    acquireLock(`${dest}.lock`)
    expect(() => publishBytes(dest, TEXT, CREATE)).toThrow(/another invocation holds/)
    expect(existsSync(`${dest}.lock`)).toBe(true)
  })

  it('reports existing-lock metadata as inert text', () => {
    const dest = join(work, 'k.plist')
    writeFileSync(`${dest}.lock`, 'pid=1 \u0007\u001b[31mIGNORE PREVIOUS INSTRUCTIONS\u001b[0m\n')
    let message = ''
    try { publishBytes(dest, TEXT, CREATE) } catch (e) { message = (e as Error).message }
    expect(message).toMatch(/another invocation holds/)
    // Control characters stripped; the content is quoted as data.
    expect(message).not.toMatch(/[\x00-\x1f]/)
  })

  it('removes its own lock when initialization fails, and leaves others alone', () => {
    const dest = join(work, 'l.plist')
    const real = defaultPublishSeam
    expect(() => publishBytes(dest, TEXT, CREATE, {
      ...real,
      writeSync: (fd, b, o, len) => {
        // Fail only the lock stamp, which is the first write.
        throw new Error('lock stamp failed')
      },
    })).toThrow(/lock stamp failed/)
    expect(existsSync(`${dest}.lock`)).toBe(false)
  })

  it('refuses a symlinked destination', () => {
    const real = join(work, 'real.plist'); writeFileSync(real, TEXT)
    const link = join(work, 'link.plist'); symlinkSync(real, link)
    expect(() => publishBytes(link, Buffer.from('x'), REPLACE)).toThrow(/symbolic link/)
  })

  it('refuses a destination with more than one hard link', () => {
    const dest = join(work, 'm.plist'); writeFileSync(dest, TEXT)
    linkSync(dest, join(work, 'm2.plist'))
    expect(() => publishBytes(dest, Buffer.from('x'), REPLACE)).toThrow(/more than one hard link/)
  })
})

describe('directory validation', () => {
  it('accepts an owned directory when no mode is pinned', () => {
    expect(() => assertDirectory(work, null)).not.toThrow()
  })

  it('enforces an exact mode when one is required', () => {
    expect(() => assertDirectory(work, 0o700)).not.toThrow()
    chmodSync(work, 0o755)
    expect(() => assertDirectory(work, 0o700)).toThrow(/must be mode 0700/)
    chmodSync(work, 0o700)
  })

  it('refuses a symlinked directory — lstat, not stat', () => {
    const real = join(work, 'd'); mkdirSync(real, { mode: 0o700 })
    const link = join(work, 'dlink'); symlinkSync(real, link)
    expect(() => assertDirectory(link, null)).toThrow(/symbolic link/)
  })

  it('refuses a foreign-owned directory through the seam', () => {
    const seam = {
      ...defaultPublishSeam,
      // A uid that cannot be this process's.
      lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true, uid: 999_999, mode: 0o040700, nlink: 2 }),
    }
    expect(() => assertDirectory('/abs/d', null, seam)).toThrow(/owned by another user/)
  })
})

describe('checkCount', () => {
  it.each([[1.5], [-1], [10]])('refuses %s', (v) => {
    expect(() => checkCount(v, 5, 'write')).toThrow()
  })
  it('accepts a legitimate count', () => { expect(checkCount(5, 5, 'write')).toBe(5) })
})

describe('semantic output validation', () => {
  it('accepts a clean parsed plist', () => {
    expect(() => assertParsedPlistIsSafe({
      Label: 'x', ProgramArguments: ['/usr/bin/true'],
      EnvironmentVariables: { PATH: '/usr/bin', PIPELINE_CREDENTIAL_FILE: '/a/b.url' },
    })).not.toThrow()
  })

  it.each(['DATABASE_URL', 'database_url', 'PGHOST', 'DASHBOARD_DATABASE_URL'])('refuses the environment key %s', (key) => {
    expect(() => assertParsedPlistIsSafe({ EnvironmentVariables: { [key]: 'x' } })).toThrow(/forbidden environment key/)
  })

  it.each([
    'postgres://r@h:5432/d',
    'POSTGRES://r@h:5432/d',
    'PostgreSQL://r@h:5432/d',
    '&#112;ostgres://r@h:5432/d',
    '&#x70;ostgres://r@h:5432/d',
  ])('refuses the PostgreSQL value %s without reporting it', (value) => {
    let m = ''
    try { assertParsedPlistIsSafe({ EnvironmentVariables: { SOMETHING: value } }) } catch (e) { m = (e as Error).message }
    expect(m).toMatch(/holds a PostgreSQL URL/)
    expect(m).not.toContain('r@h')
  })

  it('refuses a residual placeholder in a value', () => {
    expect(() => assertParsedPlistIsSafe({ EnvironmentVariables: { PATH: '@@AI_CAPITAL_ROOT@@' } }))
      .toThrow(/unresolved placeholder/)
  })

  it('refuses a PostgreSQL URL hidden in ProgramArguments', () => {
    expect(() => assertParsedPlistIsSafe({ ProgramArguments: ['/usr/bin/tsx', 'PoStGrEs://r@h:5432/d'] }))
      .toThrow(/ProgramArgument holds a PostgreSQL URL/)
  })

  it('decodes entities the way a plist parser does', () => {
    expect(decodeXmlEntities('&#112;ostgres&#x3a;//x')).toBe('postgres://x')
    expect(looksLikePostgresUrl('&#112;ostgres://x')).toBe(true)
    expect(looksLikePostgresUrl('redis://x')).toBe(false)
  })

  it('the TEXT guard is case-insensitive and entity-aware too', () => {
    expect(() => assertRenderedOutputIsSafe('<string>POSTGRES://r@h/d</string>')).toThrow()
    expect(() => assertRenderedOutputIsSafe('<string>&#112;ostgres://r@h/d</string>')).toThrow()
    expect(() => assertRenderedOutputIsSafe('<key>database_url</key>')).toThrow()
  })
})

describe('installed paths', () => {
  it('maps each agent to exactly one LaunchAgents destination', () => {
    for (const agent of Object.keys(AGENTS) as AgentName[]) {
      expect(installedPath(agent, '/Users/nobody'))
        .toBe(`/Users/nobody/Library/LaunchAgents/${AGENTS[agent].label}.plist`)
    }
  })
})

// DOCUMENTATION IS PART OF THE BOUNDARY.
//
// A template that still describes the old secret-bearing renderer tells an
// operator to do something the tools now refuse, and a doc claiming a renderer
// "does not exist yet" is simply false. These are cheap to assert and expensive
// to discover in production.
describe('documentation describes the implemented architecture', () => {
  const REPO = fileURLToPath(new URL('../../../', import.meta.url))
  const docs = ['CLAUDE.md', 'ops/README.md']
  const templates = Object.values(AGENTS).map(a => `ops/launchd/${a.template}`)

  it.each([...docs, ...templates])('%s contains no obsolete contract', (rel) => {
    const text = readFileSync(join(REPO, rel), 'utf-8')
    expect(text).not.toMatch(/renderer does not exist yet/i)
    expect(text).not.toMatch(/INSTALLATION IS BLOCKED/)
    expect(text).not.toMatch(/That renderer is deliberately NOT part of this slice/)
  })

  it.each(templates)('%s names no credential VALUE variable', (rel) => {
    const text = readFileSync(join(REPO, rel), 'utf-8')
    expect(text).not.toContain('@@PIPELINE_DATABASE_URL@@')
    expect(text).not.toContain('<key>PIPELINE_DATABASE_URL</key>')
  })

  it.each(['daily', 'watchdog'] as AgentName[])('%s says it receives no credential', (agent) => {
    const text = readFileSync(join(REPO, 'ops/launchd', AGENTS[agent].template), 'utf-8')
    expect(text).toMatch(/NO PostgreSQL credential and NO credential-file path/)
    expect(text).not.toContain('PIPELINE_CREDENTIAL_FILE</key>')
  })

  it.each(['worker', 'structured-worker', 'alerts'] as AgentName[])('%s documents the credential FILE', (agent) => {
    const text = readFileSync(join(REPO, 'ops/launchd', AGENTS[agent].template), 'utf-8')
    expect(text).toContain('PIPELINE_CREDENTIAL_FILE')
    expect(text).toMatch(/install-pipeline-credential|credential file/)
  })

  it('both docs state that nothing is provisioned or installed', () => {
    for (const rel of docs) {
      const text = readFileSync(join(REPO, rel), 'utf-8')
      expect(text, rel).toMatch(/[Nn]othing has been provisioned or installed/)
    }
  })

  it('both docs state the Time Machine ordering requirement', () => {
    for (const rel of docs) {
      expect(readFileSync(join(REPO, rel), 'utf-8'), rel).toMatch(/Time Machine[\s\S]{0,200}before/i)
    }
  })

  it('CLAUDE.md records the credential-file architecture, not the URL variable', () => {
    const text = readFileSync(join(REPO, 'CLAUDE.md'), 'utf-8')
    expect(text).toMatch(/queue worker \/ structured worker \| `PIPELINE_CREDENTIAL_FILE`/)
    expect(text).toMatch(/never written into `process\.env`/)
  })
})

// THE CLI's STAGING CONTRACT, driven through main().
//
// Contract A was chosen deliberately: the staging directory must NOT already
// exist. Round 1 accepted an existing one while claiming the tool had created
// it, and used statSync, which follows a symlink — so a symlinked staging path
// passed a check describing something else entirely.
describe('render CLI staging directory', () => {
  const base = () => [
    '--agent', 'daily', '--root', '/private/tmp/fake-root',
    '--redis-url', 'redis://localhost:6379',
  ]

  it('creates a staging directory that does not exist, and renders into it', () => {
    const stage = join(work, 'stage-new')
    expect(cliMain([...base(), '--staging-dir', stage])).toBe(0)
    expect(existsSync(join(stage, 'com.thanapol.ai-capital.daily.plist'))).toBe(true)
  })

  it('REFUSES a staging directory that already exists', () => {
    const stage = join(work, 'stage-existing')
    mkdirSync(stage, { mode: 0o700 })
    expect(cliMain([...base(), '--staging-dir', stage])).toBe(73)
  })

  it('refuses a symlinked staging path', () => {
    const real = join(work, 'stage-real'); mkdirSync(real, { mode: 0o700 })
    const link = join(work, 'stage-link'); symlinkSync(real, link)
    expect(cliMain([...base(), '--staging-dir', link])).toBe(73)
  })

  it('refuses a relative staging path', () => {
    expect(cliMain([...base(), '--staging-dir', 'relative-stage'])).toBe(64)
  })
})

// POST-PUBLICATION FAILURE STATES.
//
// Publication and cleanup are different events. Once the destination is correct
// it must never be rolled back to satisfy a tidiness step — but a failure in
// that step must never be swallowed either, because each one leaves a real
// problem behind: a credential reachable through a second name, an unlink that
// is not durable, or a lock that blocks every later run.
describe('post-publication failure states', () => {
  const TEXT2 = Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n', 'utf-8')
  const CREATE2 = { mode: 'create' as const, fileMode: 0o600, directoryMode: null }

  it('a temporary unlink failure PRESERVES the publication and reports the retained name', () => {
    const dest = join(work, 'unlink-fail.plist')
    const real = defaultPublishSeam
    let linked = false
    const r = publishBytes(dest, TEXT2, CREATE2, {
      ...real,
      linkSync: (a, b) => { real.linkSync(a, b); linked = true },
      unlinkSync: (p) => {
        // Fail only the post-publication temporary removal, not the lock.
        if (linked && p.endsWith('.tmp')) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
        real.unlinkSync(p)
      },
    })

    // The destination is correct and stays correct.
    expect(r.published).toBe(true)
    expect(readFileSync(dest)).toEqual(TEXT2)
    // …and the state says so truthfully.
    expect(r.cleanup.temporary).toBe('retained')
    expect(r.cleanup.temporaryPath).toMatch(/\.tmp$/)
    expect(r.cleanup.temporaryUnlinkError).toBe('EPERM')
    expect(cleanupIncomplete(r)).toBe(true)
    // The hazard is real and observable: two names, nlink 2.
    expect(statSync(dest).nlink).toBe(2)
    expect(existsSync(r.cleanup.temporaryPath as string)).toBe(true)
    expect(describeCleanup(r.cleanup)).toMatch(/STILL refers to the published bytes/)
    rmSync(r.cleanup.temporaryPath as string, { force: true })
  })

  it('a SECOND directory fsync failure (after the unlink) is surfaced, not ignored', () => {
    const dest = join(work, 'second-fsync.plist')
    const real = defaultPublishSeam
    let published = false
    let dirFsyncs = 0
    const r = publishBytes(dest, TEXT2, CREATE2, {
      ...real,
      linkSync: (a, b) => { real.linkSync(a, b); published = true },
      fsyncSync: (fd) => {
        if (published) {
          dirFsyncs += 1
          if (dirFsyncs === 2) throw new Error('EIO on the post-unlink fsync')
        }
        real.fsyncSync(fd)
      },
    })
    expect(r.published).toBe(true)
    expect(r.cleanup.temporary).toBe('removed')          // the unlink DID happen
    expect(r.cleanup.postUnlinkFsyncFailed).toMatch(/EIO/)
    expect(r.cleanup.directoryFsyncFailed).toBeUndefined()
    expect(cleanupIncomplete(r)).toBe(true)
    expect(readFileSync(dest)).toEqual(TEXT2)
  })

  it('a LOCK RELEASE failure after a successful publication is surfaced', () => {
    const dest = join(work, 'lock-fail.plist')
    const real = defaultPublishSeam
    const r = publishBytes(dest, TEXT2, CREATE2, {
      ...real,
      unlinkSync: (p) => {
        if (p.endsWith('.lock')) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
        real.unlinkSync(p)
      },
    })
    expect(r.published).toBe(true)
    expect(r.cleanup.lockReleased).toBe(false)
    expect(r.cleanup.lockPath).toBe(`${dest}.lock`)
    expect(cleanupIncomplete(r)).toBe(true)
    expect(describeCleanup(r.cleanup)).toMatch(/block later runs/)
    // The lock really is still there, which is the operational consequence.
    expect(existsSync(`${dest}.lock`)).toBe(true)
    rmSync(`${dest}.lock`, { force: true })
  })

  it('a lock-release failure does NOT mask a pre-publication error', () => {
    const dest = join(work, 'both-fail.plist')
    const real = defaultPublishSeam
    let message = ''
    try {
      publishBytes(dest, TEXT2, { ...CREATE2, validate: () => { throw new Error('lint said no') } }, {
        ...real,
        unlinkSync: (p) => {
          if (p.endsWith('.lock')) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
          real.unlinkSync(p)
        },
      })
    } catch (e) { message = (e as Error).message }
    // The ORIGINAL reason stays primary…
    expect(message).toMatch(/^lint said no/)
    // …and the surviving lock is still reported, because it blocks the next try.
    expect(message).toMatch(/could not be released/)
    expect(message).toMatch(/removed by hand/)
    expect(existsSync(dest)).toBe(false)
    rmSync(`${dest}.lock`, { force: true })
  })

  it('an ENOENT lock release counts as released — the state we wanted', () => {
    const dest = join(work, 'lock-gone.plist')
    const real = defaultPublishSeam
    const r = publishBytes(dest, TEXT2, CREATE2, {
      ...real,
      unlinkSync: (p) => {
        if (p.endsWith('.lock')) { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e }
        real.unlinkSync(p)
      },
    })
    expect(r.cleanup.lockReleased).toBe(true)
    expect(cleanupIncomplete(r)).toBe(false)
  })
})

describe('render CLI reports the three states distinctly', () => {
  const base = (stage: string) => [
    '--agent', 'daily', '--root', '/private/tmp/fake-root',
    '--redis-url', 'redis://localhost:6379', '--staging-dir', stage,
  ]

  function capture(fn: () => number): { code: number; out: string; err: string } {
    const out: string[] = []; const err: string[] = []
    const so = process.stdout.write.bind(process.stdout)
    const se = process.stderr.write.bind(process.stderr)
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s) => { out.push(s); return true }
    ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s) => { err.push(s); return true }
    try { return { code: fn(), out: out.join(''), err: err.join('') } }
    finally {
      ;(process.stdout as unknown as { write: typeof so }).write = so
      ;(process.stderr as unknown as { write: typeof se }).write = se
    }
  }

  it('(c) fully successful → exit 0 and "published"', () => {
    const r = capture(() => cliMain(base(join(work, 'st-ok'))))
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^published: /m)
    expect(r.err).toBe('')
  })

  it('(a) nothing published → nonzero, and no success wording', () => {
    const stage = join(work, 'st-bad')
    mkdirSync(stage, { mode: 0o700 })            // pre-existing: contract A refuses
    const r = capture(() => cliMain(base(stage)))
    expect(r.code).toBe(73)
    expect(r.out).not.toMatch(/published/)
  })

  it('(b) published but cleanup incomplete → exit 75, and the plist really is there', () => {
    // Driven for real through an injected seam: the temporary unlink fails after
    // a successful link, so the plist IS published and cleanup is not complete.
    const stage = join(work, 'st-untidy')
    const real = defaultPublishSeam
    let linked = false
    const seam: PublishSeam = {
      ...real,
      linkSync: (a, b) => { real.linkSync(a, b); linked = true },
      unlinkSync: (p) => {
        if (linked && p.endsWith('.tmp')) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
        real.unlinkSync(p)
      },
    }
    const r = capture(() => cliMain(base(stage), seam))
    expect(r.code).toBe(75)
    expect(r.err).toMatch(/IS PRESENT at that path — this is NOT a failed render/)
    expect(r.err).toMatch(/Cleanup did not complete/)
    expect(r.err).not.toMatch(/nothing was published/i)
    // The destination genuinely exists, which is what the wording claims.
    expect(existsSync(join(stage, 'com.thanapol.ai-capital.daily.plist'))).toBe(true)
    for (const f of readdirSync(stage)) if (f.endsWith('.tmp')) rmSync(join(stage, f), { force: true })
  })

  it('the default seam is the real filesystem (non-vacuity for the injection)', () => {
    const r = capture(() => cliMain(base(join(work, 'st-default'))))
    expect(r.code).toBe(0)
    expect(existsSync(join(work, 'st-default', 'com.thanapol.ai-capital.daily.plist'))).toBe(true)
  })
})

// PRE-PUBLICATION CLEANUP IS CONTAINMENT, NOT TIDYING.
//
// By the time a write, fsync, close, validation or link can fail, the bytes are
// already in the temporary — for the installer those bytes are the credential.
// So a failure to remove it is reported alongside the original error: the
// destination is absent, and an operator told only "publication failed" would
// never learn that material is sitting under a dotfile.
describe('pre-publication temporary cleanup failures are reported', () => {
  const TEXT3 = Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n', 'utf-8')
  const CREATE3 = { mode: 'create' as const, fileMode: 0o600, directoryMode: null }

  function failingUnlinkSeam(): { seam: PublishSeam; tempPaths: string[] } {
    const real = defaultPublishSeam
    const tempPaths: string[] = []
    return {
      tempPaths,
      seam: {
        ...real,
        openSync: (p, flags, mode) => { if (p.endsWith('.tmp')) tempPaths.push(p); return real.openSync(p, flags, mode) },
        unlinkSync: (p) => {
          if (p.endsWith('.tmp')) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
          real.unlinkSync(p)
        },
      },
    }
  }

  it('a VALIDATION failure plus a failed unlink names the surviving temporary', () => {
    const dest = join(work, 'val-fail.plist')
    const { seam, tempPaths } = failingUnlinkSeam()
    let message = ''
    try {
      publishBytes(dest, TEXT3, { ...CREATE3, validate: () => { throw new Error('lint said no') } }, seam)
    } catch (e) { message = (e as Error).message }

    // The ORIGINAL failure is primary.
    expect(message).toMatch(/^lint said no/)
    // …and the containment problem is appended, actionably.
    expect(message).toMatch(/destination was NOT published/)
    expect(message).toMatch(/could NOT be removed \(EPERM\)/)
    expect(message).toMatch(/may still contain credential material/)
    expect(message).toMatch(/manual inspection and removal/)
    expect(message).toMatch(/contents are not reported/)
    expect(message).toContain(tempPaths[0])

    // Nothing was published, and the temporary really does survive.
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(tempPaths[0])).toBe(true)
    rmSync(tempPaths[0], { force: true })
  })

  it('an FSYNC failure plus a failed unlink behaves the same way', () => {
    const dest = join(work, 'fsync-fail.plist')
    const { seam, tempPaths } = failingUnlinkSeam()
    let message = ''
    try {
      publishBytes(dest, TEXT3, CREATE3, { ...seam, fsyncSync: () => { throw new Error('EIO on file fsync') } })
    } catch (e) { message = (e as Error).message }
    expect(message).toMatch(/^EIO on file fsync/)
    expect(message).toMatch(/destination was NOT published/)
    expect(existsSync(dest)).toBe(false)
    rmSync(tempPaths[0], { force: true })
  })

  it('never prints the bytes it failed to remove', () => {
    const dest = join(work, 'secret-temp.plist')
    const SENTINEL = 'SENTINEL-c0ffee-never-print'
    const { seam, tempPaths } = failingUnlinkSeam()
    let message = ''
    try {
      publishBytes(dest, Buffer.from(`<plist>${SENTINEL}</plist>\n`), { ...CREATE3, validate: () => { throw new Error('rejected') } }, seam)
    } catch (e) { message = (e as Error).message }
    expect(message).not.toContain(SENTINEL)
    rmSync(tempPaths[0], { force: true })
  })

  it('an ENOENT unlink is NOT reported — the temporary is already gone', () => {
    const dest = join(work, 'enoent-temp.plist')
    const real = defaultPublishSeam
    let message = ''
    try {
      publishBytes(dest, TEXT3, { ...CREATE3, validate: () => { throw new Error('rejected') } }, {
        ...real,
        unlinkSync: (p) => {
          if (p.endsWith('.tmp')) { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e }
          real.unlinkSync(p)
        },
      })
    } catch (e) { message = (e as Error).message }
    expect(message).toBe('rejected')
  })
})

describe('lock initialization failures are reported truthfully', () => {
  const TEXT4 = Buffer.from('x\n', 'utf-8')
  const CREATE4 = { mode: 'create' as const, fileMode: 0o600, directoryMode: null }

  it('a lock WRITE failure plus a failed lock unlink reports both, in order', () => {
    const dest = join(work, 'lockinit.plist')
    const real = defaultPublishSeam
    let message = ''
    try {
      publishBytes(dest, TEXT4, CREATE4, {
        ...real,
        writeSync: () => { throw new Error('EIO writing the lock stamp') },
        unlinkSync: (p) => {
          if (p.endsWith('.lock')) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
          real.unlinkSync(p)
        },
      })
    } catch (e) { message = (e as Error).message }

    expect(message).toMatch(/^EIO writing the lock stamp/)        // primary
    expect(message).toMatch(/was created but could NOT be removed \(EPERM\)/)
    expect(message).toMatch(/block later runs/)
    expect(message).toMatch(/removed by hand/)
    // The lock really does survive, and nothing was published.
    expect(existsSync(`${dest}.lock`)).toBe(true)
    expect(existsSync(dest)).toBe(false)
    rmSync(`${dest}.lock`, { force: true })
  })

  it('a lock CLOSE failure is not silently accepted as an acquisition', () => {
    const lockPath = join(work, 'close-fail.lock')
    const real = defaultPublishSeam
    expect(() => acquireLock(lockPath, {
      ...real,
      closeSync: (fd) => { real.closeSync(fd); throw new Error('EIO on close') },
    })).toThrow(/descriptor could not be closed/)
    // Its own lock was cleaned up, since cleanup succeeded here.
    expect(existsSync(lockPath)).toBe(false)
  })

  it('a successful acquisition still returns a working lock (non-vacuity)', () => {
    const lockPath = join(work, 'good.lock')
    const lock = acquireLock(lockPath)
    expect(existsSync(lockPath)).toBe(true)
    expect(lock.release()).toEqual({ released: true })
    expect(existsSync(lockPath)).toBe(false)
  })
})

describe('render CLI retry advice matches what actually happened', () => {
  const base = (stage: string) => [
    '--agent', 'daily', '--root', '/private/tmp/fake-root',
    '--redis-url', 'redis://localhost:6379', '--staging-dir', stage,
  ]

  function capture2(fn: () => number): { code: number; out: string; err: string } {
    const out: string[] = []; const err: string[] = []
    const so = process.stdout.write.bind(process.stdout)
    const se = process.stderr.write.bind(process.stderr)
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s) => { out.push(s); return true }
    ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s) => { err.push(s); return true }
    try { return { code: fn(), out: out.join(''), err: err.join('') } }
    finally {
      ;(process.stdout as unknown as { write: typeof so }).write = so
      ;(process.stderr as unknown as { write: typeof se }).write = se
    }
  }

  const lockFailSeam = (): PublishSeam => {
    const real = defaultPublishSeam
    return {
      ...real,
      unlinkSync: (p) => {
        if (p.endsWith('.lock')) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
        real.unlinkSync(p)
      },
    }
  }

  /**
   * The renderer's `unchanged` branch cannot be reached by rendering twice into
   * a staging directory — Contract A refuses a staging directory that already
   * exists — and the only other destination is the real LaunchAgents path, which
   * this suite must not write to. So the DESTINATION STATE is injected instead:
   * the seam reports a destination that already holds exactly these bytes. That
   * is still real behaviour driven through main(), not an assertion about source
   * text.
   */
  function unchangedSeam(dest: string, bytes: Buffer, failLock: boolean): PublishSeam {
    const real = defaultPublishSeam
    return {
      ...real,
      lstatSync: (p) => (p === dest
        ? { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, uid: real.currentUid(), mode: 0o100600, nlink: 1 }
        : real.lstatSync(p)),
      readFileSync: (p) => (p === dest ? bytes : real.readFileSync(p)),
      unlinkSync: (p) => {
        if (failLock && p.endsWith('.lock')) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e }
        real.unlinkSync(p)
      },
    }
  }

  /** The exact bytes the daily template renders to, obtained by rendering once. */
  function renderedBytes(): Buffer {
    const stage = join(work, `bytes-${Math.random().toString(36).slice(2)}`)
    expect(capture2(() => cliMain(base(stage))).code).toBe(0)
    return readFileSync(join(stage, 'com.thanapol.ai-capital.daily.plist'))
  }

  it('UNCHANGED plus a lock-release failure does NOT demand --replace', () => {
    const bytes = renderedBytes()
    const stage = join(work, 'st-unchanged')
    const dest = join(stage, 'com.thanapol.ai-capital.daily.plist')
    const r = capture2(() => cliMain(base(stage), unchangedSeam(dest, bytes, true)))
    expect(r.code).toBe(75)
    expect(r.err).toMatch(/^unchanged: /m)
    expect(r.err).toMatch(/ALREADY byte-identical and nothing was written/)
    expect(r.err).toMatch(/does NOT require --replace/)
    // The misleading unconditional instruction must be absent.
    expect(r.err).not.toMatch(/a re-run needs --replace/)
    rmSync(`${dest}.lock`, { force: true })
  })

  it('a CLEAN unchanged outcome is still exit 0', () => {
    const bytes = renderedBytes()
    const stage = join(work, 'st-clean-unchanged')
    const dest = join(stage, 'com.thanapol.ai-capital.daily.plist')
    const r = capture2(() => cliMain(base(stage), unchangedSeam(dest, bytes, false)))
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^unchanged: /m)
    expect(r.err).toBe('')
  })
})
