// THE LAUNCHER, RUN FOR REAL — with harmless fixtures only.
//
// tests/run-stage.test.ts pins the launcher's pure helpers and reads its source.
// That cannot show what actually happens to a process tree, so this file starts
// the launcher as a real process against three fixture scripts that write files
// and sleep. No production command, no pipeline stage, no database, no queue and
// no network is involved, and the credential handed in is a syntactically valid
// but deliberately unroutable placeholder that nothing ever connects to.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LAUNCHER = fileURLToPath(new URL('../bin/run-stage.ts', import.meta.url))
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

/** Valid shape, unroutable target. Never connected to; only validated. */
const FAKE_CREDENTIAL = 'postgres://fake_role@fake.invalid:5432/fake_db'

let work: string
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'run-stage-')) })
afterEach(() => { rmSync(work, { recursive: true, force: true }) })

/** Environment with every inherited database variable removed. */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^PG[A-Z0-9_]*$/.test(k) || /_DATABASE_URL$/.test(k) || k === 'DATABASE_URL') continue
    if (typeof v === 'string') env[k] = v
  }
  return { ...env, ...extra }
}

function runLauncher(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(TSX, [LAUNCHER, ...args], {
    env: baseEnv(extraEnv), encoding: 'utf-8', timeout: 60_000,
  })
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('argument fidelity', () => {
  it('passes every argument through unchanged, INCLUDING empty ones', () => {
    const out = join(work, 'argv.txt')
    const r = runLauncher(
      ['--', join(FIXTURES, 'echo-argv.sh'), out, 'first', '', 'third', '  ', '--flag'],
      { PIPELINE_DATABASE_URL: FAKE_CREDENTIAL },
    )
    expect(r.status).toBe(0)
    expect(readFileSync(out, 'utf-8')).toBe('[first]\n[]\n[third]\n[  ]\n[--flag]\n')
  })

  it('refuses when the COMMAND itself is empty, without creating a child', () => {
    const r = runLauncher(['--', ''], { PIPELINE_DATABASE_URL: FAKE_CREDENTIAL })
    expect(r.status).toBe(64)
    expect(r.stderr).toMatch(/no command after/)
  })

  it('refuses when there is no `--` at all', () => {
    const r = runLauncher([join(FIXTURES, 'marker.sh'), join(work, 'm.txt')],
      { PIPELINE_DATABASE_URL: FAKE_CREDENTIAL })
    expect(r.status).toBe(64)
    expect(existsSync(join(work, 'm.txt'))).toBe(false)
  })
})

describe('exit status', () => {
  it.each([0, 1, 7, 42])('propagates an ordinary exit code (%i)', (code) => {
    const r = runLauncher(['--', 'bash', '-c', `exit ${code}`], { PIPELINE_DATABASE_URL: FAKE_CREDENTIAL })
    expect(r.status).toBe(code)
  })
})

describe('credential validation happens before any child exists', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace-wrapped', ` ${FAKE_CREDENTIAL} `],
    ['wrong scheme', 'file:///etc/passwd'],
    ['incomplete', 'postgres://fake_role@fake.invalid:5432'],
  ])('creates NO child for a %s credential', (_label, value) => {
    const marker = join(work, 'marker.txt')
    const r = runLauncher(
      ['--', join(FIXTURES, 'marker.sh'), marker],
      value === undefined ? {} : { PIPELINE_DATABASE_URL: value },
    )
    expect(r.status).toBe(78)
    expect(existsSync(marker)).toBe(false)
  })

  it('never prints the credential, its parts, or the environment', () => {
    const r = runLauncher(['--', 'bash', '-c', 'true'], {
      PIPELINE_DATABASE_URL: ' postgres://secret_role:secret_pw@secret.invalid:5432/secret_db ',
    })
    expect(r.status).toBe(78)
    const output = `${r.stdout}${r.stderr}`
    expect(output).toMatch(/PIPELINE_DATABASE_URL/)
    for (const part of ['secret_role', 'secret_pw', 'secret.invalid', 'secret_db']) {
      expect(output).not.toContain(part)
    }
  })
})

describe('signals reach the whole process tree', () => {
  it('a signalled child leaves no running GRANDCHILD, and reports a signal status', async () => {
    const pidFile = join(work, 'grandchild.pid')
    const child = spawn(TSX, [LAUNCHER, '--', join(FIXTURES, 'spawn-grandchild.sh'), pidFile], {
      env: baseEnv({ PIPELINE_DATABASE_URL: FAKE_CREDENTIAL }), stdio: 'ignore',
    })

    // Wait for the fixture to record its grandchild, bounded.
    const deadline = Date.now() + 20_000
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(existsSync(pidFile)).toBe(true)
    const grandchild = Number(readFileSync(pidFile, 'utf-8').trim())
    expect(Number.isInteger(grandchild)).toBe(true)
    expect(alive(grandchild)).toBe(true)   // non-vacuity: it really is running

    const exited = new Promise<number | null>(res => child.on('exit', (code) => res(code)))
    child.kill('SIGTERM')
    const code = await exited

    // Truthful non-zero status for a signalled tree.
    expect(code).not.toBe(0)

    // The grandchild must be gone. Poll briefly: reaping is not instantaneous.
    const gone = Date.now() + 10_000
    while (alive(grandchild) && Date.now() < gone) {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(alive(grandchild), 'grandchild survived the signal').toBe(false)
  }, 60_000)
})
