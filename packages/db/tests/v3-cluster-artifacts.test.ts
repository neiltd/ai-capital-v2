/**
 * The ai-capital-v3 provisioning artifacts, checked as TEXT.
 *
 * NO TEST HERE CONTACTS POSTGRESQL. Nothing is executed, no directory is
 * created, no credential is generated and no cluster is started. Every
 * assertion reads a file from the repository and makes a statement about what
 * the script WILL do when an operator eventually runs it.
 *
 * WHY THIS IS WORTH DOING AT ALL. `provision.sh --apply` is a one-shot,
 * irreversible-in-practice act against a real-money migration target: by the
 * time it is run there is no iteration loop left. The properties that matter —
 * migrator cannot reach TCP, the lockdown does not run early, credentials
 * cannot land in the evidence bundle, the cluster is stopped before its digest
 * is published — are all decidable from the source, so they are decided here,
 * where a mistake costs nothing.
 *
 * TEXT-LEVEL ASSERTIONS ARE WEAKER THAN EXECUTION, AND THAT IS ACKNOWLEDGED.
 * A grep cannot prove semantics. It can prove ordering, presence, absence and
 * exact contract text, which is what this file claims and nothing more.
 */

import { describe, it, expect } from 'vitest'
import {
  readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync,
  lstatSync, readdirSync, realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '..')
const CLUSTER = join(REPO, 'ops', 'clusters', 'ai-capital-v3')

const CONF_PATH = join(CLUSTER, 'postgresql.conf.d', 'ai-capital-v3.conf')
const HBA_PATH = join(CLUSTER, 'pg_hba.conf')
const PROVISION_PATH = join(CLUSTER, 'provision.sh')
const VERIFY_PATH = join(CLUSTER, 'verify.sh')
const README_PATH = join(CLUSTER, 'README.md')

const read = (p: string): string => readFileSync(p, 'utf-8')

/** Lines that are neither blank nor a comment — the part a parser acts on. */
const activeLines = (text: string): string[] =>
  text.split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))

/** Shell source with comment-only lines removed, for "does it DO this" checks. */
const executable = (text: string): string =>
  text.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')

/**
 * What the script actually EXECUTES: comments gone, the human-readable prose
 * inside note/step/die/printf string literals replaced, and `/dev/null`
 * redirections removed.
 *
 * Both extra steps exist for the same reason. Without the prose step, an
 * assertion like "never mentions 090" fails on the *comment* explaining why 090
 * is not applied, which would pressure the author into deleting the
 * explanation to make the test pass — a test that punishes documentation is
 * worse than no test. Without the `/dev/null` step, "no output redirection"
 * fails on `2>/dev/null`, which is a way of reading quietly, not of writing.
 */
const commands = (text: string): string =>
  executable(text)
    .split('\n')
    .map(l => l.replace(/\b(note|step|die|printf)\s+'[^']*'/g, '$1 <prose>'))
    .map(l => l.replace(/2?>\s*\/dev\/null/g, ''))
    .join('\n')

const SECRET_ROOT = '/Users/thanapold/ai-capital-secrets/s4f-d4'
const EVIDENCE_ROOT = '/Users/thanapold/ai-capital-evidence/s4f-d4-provision'
const PGDATA_ROOT = '/Users/thanapold/ai-capital-v3-pgdata'
const SOCKET_ROOT = '/Users/thanapold/ai-capital-v3-run'

// ── The artifacts exist at all ──────────────────────────────────────────────

describe('the artifact set', () => {
  it('has all five cluster artifacts, and the scripts are executable', () => {
    // NON-VACUITY GUARD for this whole file. Every assertion below reads one of
    // these; if a path were wrong, `read` would throw, but an `existsSync`
    // check states the expectation instead of relying on an exception.
    for (const p of [CONF_PATH, HBA_PATH, PROVISION_PATH, VERIFY_PATH, README_PATH]) {
      expect(existsSync(p), `missing artifact: ${p}`).toBe(true)
      expect(readFileSync(p, 'utf-8').length, `empty artifact: ${p}`).toBeGreaterThan(0)
    }
    for (const p of [PROVISION_PATH, VERIFY_PATH]) {
      expect(statSync(p).mode & 0o111, `not executable: ${p}`).not.toBe(0)
    }
  })
})

// ── postgresql.conf.d/ai-capital-v3.conf ────────────────────────────────────

describe('the cluster configuration', () => {
  const REQUIRED: [string, string][] = [
    ['port', '5433'],
    ['listen_addresses', "'127.0.0.1'"],
    ['unix_socket_directories', `'${SOCKET_ROOT}'`],
    ['unix_socket_permissions', '0700'],
    ['password_encryption', "'scram-sha-256'"],
    ['cluster_name', "'ai-capital-v3'"],
    ['logging_collector', 'on'],
    ['log_directory', "'log'"],
    ['log_line_prefix', "'%m [%p] %q%u@%d '"],
    ['log_connections', 'on'],
    ['log_disconnections', 'on'],
    ['datestyle', "'iso, mdy'"],
    ['timezone', "'America/Los_Angeles'"],
    ['lc_messages', "'en_US.UTF-8'"],
    ['lc_monetary', "'en_US.UTF-8'"],
    ['lc_numeric', "'en_US.UTF-8'"],
    ['lc_time', "'en_US.UTF-8'"],
    ['default_text_search_config', "'pg_catalog.english'"],
  ]

  it('sets every required value explicitly, and to exactly the reviewed value', () => {
    const lines = activeLines(read(CONF_PATH))
    expect(lines.length, 'the config has no active settings at all').toBeGreaterThan(0)
    for (const [name, value] of REQUIRED) {
      const match = lines.filter(l => new RegExp(`^${name}\\s*=`).test(l))
      expect(match.length, `${name} is not set exactly once (found ${match.length})`).toBe(1)
      expect(match[0].replace(/^[^=]*=\s*/, '').trim(), `${name} has the wrong value`).toBe(value)
    }
  })

  it('binds the literal 127.0.0.1, never localhost', () => {
    // On macOS `localhost` resolves to ::1 first, and the 5432 cluster binds
    // both families. A literal removes the ambiguity in the credential too.
    const lines = activeLines(read(CONF_PATH))
    expect(lines.some(l => /^listen_addresses\s*=\s*'127\.0\.0\.1'$/.test(l))).toBe(true)
    expect(lines.some(l => /localhost/.test(l))).toBe(false)
  })

  it('keeps the socket out of /tmp, which the macOS temp reaper sweeps', () => {
    const lines = activeLines(read(CONF_PATH))
    const socket = lines.find(l => l.startsWith('unix_socket_directories'))!
    expect(socket).not.toMatch(/\/tmp/)
    expect(socket).toContain(SOCKET_ROOT)
  })

  it('declares no setting twice, even with a different value', () => {
    // A duplicate is not a syntax error: PostgreSQL takes the LAST occurrence,
    // so a stale line above a corrected one is silently authoritative in the
    // reviewer's reading and silently ignored by the server.
    const names = activeLines(read(CONF_PATH))
      .filter(l => l.includes('='))
      .map(l => l.split('=')[0].trim())
    const duplicated = names.filter((n, i) => names.indexOf(n) !== i)
    expect(duplicated, `duplicated settings: ${[...new Set(duplicated)].join(', ')}`).toEqual([])
  })

  it('is the canonical input, not a sample to copy and edit', () => {
    expect(read(PROVISION_PATH)).toContain('postgresql.conf.d/ai-capital-v3.conf')
    expect(read(CONF_PATH)).toMatch(/CANONICAL INPUT/i)
  })
})

// ── pg_hba.conf ─────────────────────────────────────────────────────────────

describe('the authentication contract', () => {
  const EXPECTED_RULES = [
    ['local', 'ai_capital_v3', 'ai_capital_migrator', 'scram-sha-256'],
    ['local', 'all', 'thanapold', 'peer'],
    ['local', 'all', 'all', 'reject'],
    ['host', 'ai_capital_v3', 'ai_capital_pipeline', '127.0.0.1/32', 'scram-sha-256'],
    ['host', 'all', 'all', '0.0.0.0/0', 'reject'],
    ['host', 'all', 'all', '::/0', 'reject'],
  ]

  const rules = (): string[][] => activeLines(read(HBA_PATH)).map(l => l.split(/\s+/))

  it('has exactly six active rules, in exactly the reviewed order', () => {
    // ORDER IS THE CONTRACT. pg_hba is first-match-wins, so a correct set of
    // rules in the wrong order is a different policy.
    const actual = rules()
    expect(actual.length, 'rule count').toBe(6)
    expect(actual).toEqual(EXPECTED_RULES)
  })

  it('contains zero trust rules and zero replication rules', () => {
    const active = activeLines(read(HBA_PATH))
    expect(active.length).toBe(6)   // non-vacuity: an empty file trivially has zero
    expect(active.filter(l => /\btrust\b/.test(l))).toEqual([])
    expect(active.filter(l => /\breplication\b/.test(l))).toEqual([])
  })

  it('gives the migrator a local socket path and NO TCP path whatsoever', () => {
    // legacy-copy.ts refuses a TCP session outright (transport is checked
    // before socket path). The transport layer must agree, rather than being
    // widened so a live negative test has something to fail against.
    const r = rules()
    const migratorRules = r.filter(x => x.includes('ai_capital_migrator'))
    expect(migratorRules.length, 'the migrator has no rule at all').toBe(1)
    expect(migratorRules[0][0]).toBe('local')
    expect(migratorRules[0][1]).toBe('ai_capital_v3')
    expect(migratorRules[0][migratorRules[0].length - 1]).toBe('scram-sha-256')

    // REACHABILITY, NOT NAME PRESENCE. `host all all 127.0.0.1/32 scram-sha-256`
    // hands the migrator a TCP path without containing the string
    // "ai_capital_migrator" anywhere — which is exactly how this protection
    // would be lost in practice, by someone broadening the pipeline rule rather
    // than by adding a migrator rule. So ask which host rules would MATCH a
    // migrator connection, and require every one of them to be a reject.
    const reachesMigrator = r.filter(
      x => x[0] === 'host' && (x[2] === 'all' || x[2] === 'ai_capital_migrator'),
    )
    expect(reachesMigrator.length, 'no host rule at all — the catch-alls are missing').toBeGreaterThan(0)
    for (const rule of reachesMigrator) {
      expect(rule[rule.length - 1], `this host rule would admit the migrator: ${rule.join(' ')}`)
        .toBe('reject')
    }
  })

  it('gives the pipeline IPv4 loopback only, scoped to one role and one database', () => {
    const r = rules()
    const pipelineRules = r.filter(x => x.includes('ai_capital_pipeline'))
    expect(pipelineRules.length).toBe(1)
    expect(pipelineRules[0]).toEqual(['host', 'ai_capital_v3', 'ai_capital_pipeline', '127.0.0.1/32', 'scram-sha-256'])
    // A broad `host all all 127.0.0.1/32 scram` would hand the migrator a TCP
    // path by the back door.
    expect(r.filter(x => x[0] === 'host' && x[1] === 'all' && x[2] === 'all' && x[4] === 'scram-sha-256')).toEqual([])
  })

  it('ends each transport with an explicit catch-all reject', () => {
    const r = rules()
    const lastLocal = r.map((x, i) => (x[0] === 'local' ? i : -1)).filter(i => i >= 0).pop()!
    expect(r[lastLocal]).toEqual(['local', 'all', 'all', 'reject'])
    expect(r[r.length - 2]).toEqual(['host', 'all', 'all', '0.0.0.0/0', 'reject'])
    expect(r[r.length - 1]).toEqual(['host', 'all', 'all', '::/0', 'reject'])
  })

  it('tells a future editor to insert above the rejects', () => {
    expect(read(HBA_PATH)).toMatch(/insert the new rule ABOVE the catch-all rejects/i)
  })

  it('is the canonical input installed by the script', () => {
    expect(read(PROVISION_PATH)).toMatch(/HBA_SRC=.*pg_hba\.conf/)
    expect(read(PROVISION_PATH)).toMatch(/install -m 600 "\$\{HBA_SRC\}"/)
  })
})

// ── provision.sh: modes and shell hygiene ───────────────────────────────────

describe('provision.sh modes and hygiene', () => {
  it('has --inspect and --apply and NO default mode', () => {
    const src = read(PROVISION_PATH)
    expect(src).toMatch(/--inspect\)\s*run_inspect/)
    expect(src).toMatch(/--apply\)\s*run_apply/)
    // The fallthrough must print usage and exit non-zero, never pick a mode.
    expect(src).toMatch(/\*\)[\s\S]{0,400}?exit 2/)
    expect(src).toMatch(/There is no default mode/)
  })

  it('fails closed: set -euo pipefail and a restrictive umask', () => {
    const src = read(PROVISION_PATH)
    expect(src).toMatch(/^set -euo pipefail$/m)
    expect(src).toMatch(/^umask 077$/m)
  })

  it('uses absolute PostgreSQL 17 paths and never the PATH shims', () => {
    const src = read(PROVISION_PATH)
    expect(src).toMatch(/PG_BIN='\/opt\/homebrew\/opt\/postgresql@17\/bin'/)
    // /opt/homebrew/bin is the shim directory that `brew link` repoints.
    expect(executable(src)).not.toMatch(/\/opt\/homebrew\/bin\//)
  })

  it('reads no .env and takes no ambient database fallback', () => {
    const src = read(PROVISION_PATH)
    expect(executable(src)).not.toMatch(/\.env/)
    expect(src).toMatch(/assert_sterile_environment/)
    // It REFUSES a polluted environment rather than silently unsetting it.
    expect(src).toMatch(/the environment carries database variables/)
  })

  it('reaches no network and shells out to no package manager', () => {
    const exec = commands(read(PROVISION_PATH))
    for (const forbidden of [/\bcurl\b/, /\bwget\b/, /\bgit\s+(fetch|pull|clone|push)\b/, /\bnc\b/]) {
      expect(exec, `network command matched ${forbidden}`).not.toMatch(forbidden)
    }
    for (const pm of [/\bpnpm\b/, /\bnpm\b/, /\bnpx\b/, /\bcorepack\b/, /\byarn\b/]) {
      expect(exec, `package manager matched ${pm}`).not.toMatch(pm)
    }
    expect(read(PROVISION_PATH)).toMatch(/TSX=.*node_modules\/\.bin\/tsx/)
  })

  it('never retries, repairs or rolls back', () => {
    const exec = commands(read(PROVISION_PATH))
    expect(exec).not.toMatch(/\|\|\s*(true|:)\s*$/m)
    expect(exec).not.toMatch(/\bretry\b/i)
    expect(exec).not.toMatch(/\btrap\b.*\b(rm|pg_ctl|rollback)\b/i)
  })

  it('never references or connects to port 5432', () => {
    // The foreign cluster is named ONLY in the isolation proof, which reads a
    // process table. No psql, createdb or URL may carry that port.
    const exec = commands(read(PROVISION_PATH))
    for (const line of exec.split('\n')) {
      if (!line.includes('5432')) continue
      expect(line, `a 5432 reference outside the read-only isolation proof: ${line.trim()}`)
        .toMatch(/lsof|FOREIGN_|postgresql@17\/bin|var\/postgresql@17|LaunchAgents/)
      expect(line).not.toMatch(/psql|createdb|postgresql:\/\/|-p 5432/)
    }
  })

  it('is inert on source: running it with no argument only prints usage', () => {
    // No provisioning work may sit at top level. Everything is in a function,
    // and `main "$@"` is the single entrypoint at the very end.
    const src = read(PROVISION_PATH)
    const lastReal = src.split('\n').filter(l => l.trim() !== '' && !/^\s*#/.test(l)).pop()
    expect(lastReal!.trim()).toBe('main "$@"')
    expect(src).not.toMatch(/^\s*run_apply\s*$/m)
    expect(src.match(/^main "\$@"$/gm)!.length).toBe(1)
  })
})

// ── provision.sh: --inspect is genuinely read-only ──────────────────────────

describe('provision.sh --inspect mutates nothing', () => {
  /** The body of run_inspect, from its opening brace to the closing one. */
  const inspectBody = (): string => {
    const src = read(PROVISION_PATH)
    const start = src.indexOf('run_inspect() {')
    expect(start, 'run_inspect is not defined').toBeGreaterThan(-1)
    const end = src.indexOf('\n}', start)
    expect(end, 'run_inspect is not closed').toBeGreaterThan(start)
    return src.slice(start, end)
  }

  it('contains no mutating command', () => {
    const body = commands(inspectBody())
    expect(body.length, 'the inspect body is empty').toBeGreaterThan(200)
    const mutators = [
      /\bmkdir\b/, /\binitdb\b/, /\bpg_ctl\b/, /\bcreatedb\b/, /\btmutil\b/,
      /\bchmod\b/, /\bchown\b/, /\bmv\b/, /\brm\b/, /\binstall -m\b/,
      /\bopenssl\s+rand\b/, /\bpsql\b/, /\btouch\b/,
      // Any output redirection that is not stderr (`>&2`) or a pipe. The
      // /dev/null reads were already removed by commands().
      />\s*[^&|\s]/,
    ]
    // Report the OFFENDING LINE, not just that something matched. A failure
    // here is about one command, and naming it is the difference between a
    // one-minute fix and a hunt.
    for (const m of mutators) {
      const offending = body.split('\n').filter(l => m.test(l))
      expect(offending, `--inspect contains a mutating construct matching ${m}`).toEqual([])
    }
  })

  it('asserts all four operational roots are absent', () => {
    const body = inspectBody()
    for (const root of [PGDATA_ROOT, SOCKET_ROOT, SECRET_ROOT, EVIDENCE_ROOT]) {
      expect(read(PROVISION_PATH), `${root} is not a declared root`).toContain(root)
    }
    expect(body).toMatch(/PGDATA_ROOT.*SOCKET_ROOT.*SECRET_ROOT.*EVIDENCE_ROOT/s)
    expect(body).toMatch(/\[ ! -e "\$\{p\}" \] \|\| die/)
  })

  it('asserts port 5433 is unused, by listener and by socket', () => {
    const body = inspectBody()
    expect(body).toMatch(/lsof_count -nP -iTCP:"\$\{TARGET_PORT\}"/)
    expect(body).toMatch(/\.s\.PGSQL\.\$\{TARGET_PORT\}/)
  })

  it('asserts the six-rule, zero-trust HBA contract before anything else runs', () => {
    const body = inspectBody()
    expect(body).toMatch(/\[ "\$\{active\}" = '6' \]/)
    expect(body).toMatch(/HBA contains a trust rule/)
    expect(body).toMatch(/HBA contains a replication rule/)
  })
})

// ── provision.sh --apply: ordering ──────────────────────────────────────────

describe('provision.sh --apply ordering', () => {
  const applyBody = (): string => {
    const src = read(PROVISION_PATH)
    const start = src.indexOf('run_apply() {')
    expect(start, 'run_apply is not defined').toBeGreaterThan(-1)
    const end = src.indexOf('\nmain() {', start)
    expect(end, 'run_apply is not followed by main').toBeGreaterThan(start)
    return src.slice(start, end)
  }

  /** Index of the first line matching `re`, or -1. */
  const at = (body: string, re: RegExp): number => {
    const lines = body.split('\n')
    const i = lines.findIndex(l => re.test(l))
    expect(i, `no line matched ${re}`).toBeGreaterThan(-1)
    return i
  }

  it('re-runs the full inspection before any mutation', () => {
    const body = applyBody()
    expect(at(body, /^\s*run_inspect$/)).toBeLessThan(at(body, /\bmkdir\b/))
  })

  it('creates the directories BEFORE calling tmutil', () => {
    // tmutil addexclusion on a nonexistent path is a no-op that reports
    // success, which would silently leave the cluster inside Time Machine.
    const body = applyBody()
    expect(at(body, /\bmkdir -m 700\b/)).toBeLessThan(at(body, /\btmutil addexclusion\b/))
  })

  it('verifies ownership and real-directory status before tmutil too', () => {
    const body = applyBody()
    expect(at(body, /is a symlink, refusing/)).toBeLessThan(at(body, /\btmutil addexclusion\b/))
  })

  it('proves the exclusion took effect rather than assuming it', () => {
    expect(applyBody()).toMatch(/tmutil isexcluded[\s\S]{0,120}?exclusion did not take/)
  })

  it('initdb precedes config installation, which precedes start', () => {
    const body = applyBody()
    expect(at(body, /\$\{INITDB\}/)).toBeLessThan(at(body, /install -m 600 "\$\{HBA_SRC\}"/))
    expect(at(body, /install -m 600 "\$\{HBA_SRC\}"/)).toBeLessThan(at(body, /\$\{PG_CTL\}.*start/))
  })

  it('initdb requests UTF-8, en_US.UTF-8, checksums, local peer and host scram', () => {
    const body = applyBody()
    for (const flag of [
      /--encoding=UTF8/, /--locale=en_US\.UTF-8/, /--data-checksums/,
      /--auth-local=peer/, /--auth-host=scram-sha-256/,
    ]) {
      expect(body, `initdb is missing ${flag}`).toMatch(flag)
    }
  })

  it('proves isolation from 5432 without connecting to it', () => {
    const body = applyBody()
    const lines = body.split('\n')
    const i = at(body, /isolation from the 5432 cluster/)
    expect(at(body, /\$\{PG_CTL\}.*start/)).toBeLessThan(i)
    // The proof spans its own step only — from its header to the next one.
    const next = lines.findIndex((l, n) => n > i && /^\s*step /.test(l))
    expect(next, 'the isolation step is not followed by another step').toBeGreaterThan(i)
    const proof = lines.slice(i, next).join('\n')
    expect(proof).toMatch(/lsof/)
    expect(proof).toMatch(/\/bin\/ps/)
    // It reads a process table and a socket inode. It must not open a session.
    expect(commands(proof)).not.toMatch(/psql|PSQL/)
  })

  it('creates roles, then sets passwords, then publishes credentials', () => {
    const body = applyBody()
    expect(at(body, /ROLES_SQL/)).toBeLessThan(at(body, /openssl rand/))
    expect(at(body, /openssl rand/)).toBeLessThan(at(body, /ALTER ROLE/))
    expect(at(body, /ALTER ROLE/)).toBeLessThan(at(body, /migrator\.url/))
  })

  it('creates the database, bootstraps it, then migrates', () => {
    const body = applyBody()
    expect(at(body, /\$\{CREATEDB\}/)).toBeLessThan(at(body, /BOOTSTRAP_SQL/))
    expect(at(body, /BOOTSTRAP_SQL/)).toBeLessThan(at(body, /bin\/migrate\.ts/))
  })

  it('runs migrations BEFORE the inventory', () => {
    // CURRENT_V19 recognition needs all nineteen rows to recognise; inventorying
    // first would produce an artifact describing an unmigrated database.
    const body = applyBody()
    expect(at(body, /bin\/migrate\.ts/)).toBeLessThan(at(body, /DB_INVENTORY/))
  })

  it('stops the cluster BEFORE publishing the digest', () => {
    const body = applyBody()
    expect(at(body, /-m fast -w -t 60 stop/)).toBeLessThan(at(body, /> "\$\{EVIDENCE_ROOT\}\/DIGEST"/))
  })

  it('proves the shutdown positively, not by absence alone', () => {
    // NON-VACUITY. An absent listener is also what a crashed postmaster leaves
    // behind; only the control file separates clean from dirty.
    const body = applyBody()
    const stop = at(body, /-m fast -w -t 60 stop/)
    const after = body.split('\n').slice(stop).join('\n')
    expect(after).toMatch(/Database cluster state: \+shut down/)
    expect(after).toMatch(/still has .* lsof rows after stop/)
    expect(after).toMatch(/the socket survived the stop/)
    expect(after).toMatch(/PG_VERSION/)
  })
})

// ── provision.sh --apply: what it must NOT do ───────────────────────────────

describe('provision.sh --apply exclusions', () => {
  const exec = (): string => commands(read(PROVISION_PATH))

  it('never applies 090_post_migration_lockdown.sql', () => {
    // Its line 41 revokes ai_capital_owner FROM ai_capital_migrator, which is
    // exactly the membership legacy-copy.ts needs for SET LOCAL ROLE.
    expect(exec()).not.toMatch(/090/)
    expect(exec()).not.toMatch(/post_migration_lockdown/)
    // ...and the positive proof that it did not run is asserted at the end.
    expect(read(PROVISION_PATH)).toMatch(/pg_has_role\('\$\{MIGRATOR_ROLE\}', '\$\{OWNER_ROLE\}', 'MEMBER'\)/)
  })

  it('never runs verify-privileges', () => {
    expect(exec()).not.toMatch(/verify-privileges/)
    // Like the copy credential: it may be NAMED in the sterile-environment guard
    // that refuses it. What must not exist is an assignment that USES it.
    expect(exec()).not.toMatch(/AGENT_DATABASE_URL\s*=/)
    // The README must say why, so the omission reads as a decision.
    expect(read(README_PATH)).toMatch(/verify-privileges[\s\S]{0,400}?Deferred to cutover/)
  })

  it('never runs legacy-copy or an archive importer', () => {
    expect(exec()).not.toMatch(/legacy-copy/)
    // The copy credential may be NAMED in the sterile-environment guard, which
    //  refuses it; what must not exist is an assignment that USES it.
    expect(exec()).not.toMatch(/AI_CAPITAL_COPY_DATABASE_URL\s*=/)
  })

  it('never writes the consumer credential or touches launchd', () => {
    const e = exec()
    expect(e).not.toMatch(/\.config\/ai-capital/)
    expect(e).not.toMatch(/launchctl/)
    expect(e).not.toMatch(/LaunchAgents\/com\./)
    expect(e).not.toMatch(/\bplist\b/)
  })

  it('labels verify-architecture as source-tree evidence, never database evidence', () => {
    const src = read(PROVISION_PATH)
    expect(src).toMatch(/SOURCE-TREE EVIDENCE, NOT DATABASE EVIDENCE/)
    expect(src).toMatch(/source-tree-check\.txt/)
    // db-inventory is the thing labelled as live evidence.
    expect(src).toMatch(/LIVE DATABASE EVIDENCE/)
  })
})

// ── The inventory invocation ────────────────────────────────────────────────

describe('the db-inventory invocation', () => {
  it('uses VERIFY_INVENTORY_DATABASE_URL and no other credential variable', () => {
    const src = read(PROVISION_PATH)
    expect(src).toMatch(/VERIFY_INVENTORY_DATABASE_URL="\$\(\/bin\/cat "\$\{SECRET_ROOT\}\/migrator\.url"\)"/)
  })

  it('passes --target ai_capital_v3 and the mandatory mode, run-id and absolute output', () => {
    const src = read(PROVISION_PATH)
    const call = src.slice(src.indexOf('DB_INVENTORY}'))
    expect(call).toMatch(/--mode inventory/)
    expect(call).toMatch(/--target "\$\{TARGET_DB\}"/)
    expect(src).toMatch(/TARGET_DB='ai_capital_v3'/)
    expect(call).toMatch(/--run-id/)
    expect(call).toMatch(/--output "\$\{EVIDENCE_ROOT\}\//)
  })

  it('runs the CLI through the package-local tsx, not a package manager', () => {
    const src = read(PROVISION_PATH)
    expect(src).toMatch(/"\$\{TSX\}" "\$\{DB_INVENTORY\}"/)
  })
})

// ── Secrets and evidence ────────────────────────────────────────────────────

describe('secrets and evidence are disjoint', () => {
  it('uses two roots, neither inside the other', () => {
    expect(SECRET_ROOT.startsWith(EVIDENCE_ROOT)).toBe(false)
    expect(EVIDENCE_ROOT.startsWith(SECRET_ROOT)).toBe(false)
    const src = read(PROVISION_PATH)
    expect(src).toContain(`SECRET_ROOT='${SECRET_ROOT}'`)
    expect(src).toContain(`EVIDENCE_ROOT='${EVIDENCE_ROOT}'`)
  })

  it('writes both credential files under the secret root and neither under evidence', () => {
    const e = commands(read(PROVISION_PATH))
    for (const f of ['migrator.url', 'pipeline.url']) {
      const lines = e.split('\n').filter(l => l.includes(f))
      expect(lines.length, `${f} is never written`).toBeGreaterThan(0)
      for (const l of lines) {
        expect(l, `${f} referenced via the evidence root: ${l.trim()}`).not.toContain('EVIDENCE_ROOT')
      }
    }
  })

  it('roots the evidence walk at the evidence directory, so it cannot reach secrets', () => {
    const src = read(PROVISION_PATH)
    const digest = executable(src.slice(src.indexOf('publish the evidence digest')))
    expect(digest).toMatch(/cd "\$\{EVIDENCE_ROOT\}"/)
    expect(digest).toMatch(/find \. -type f/)
    // The walk must not name the secret root, and must not start anywhere it
    // could ascend into one.
    expect(digest).not.toContain('SECRET_ROOT')
    expect(digest).not.toMatch(/find \$\{?HOME/)
    expect(digest).not.toMatch(/\.\./)
  })

  it('never prints, logs, hashes or argv-exposes a credential', () => {
    const e = commands(read(PROVISION_PATH))
    // No echo/printf of a secret variable, and no hashing of one.
    expect(e).not.toMatch(/(echo|printf|note)[^\n]*\$\{?(migrator|pipeline)_secret/)
    expect(e).not.toMatch(/shasum[^\n]*(migrator|pipeline)[_.](secret|url)/)
    expect(e).not.toMatch(/shasum[^\n]*SECRET_ROOT/)
    // The password is set over STDIN, not as a psql -c argument where ps(1)
    // would show it.
    expect(read(PROVISION_PATH)).toMatch(/PGOPTIONS='-c log_statement=none'/)
    expect(e).not.toMatch(/psql[^\n]*-c[^\n]*ALTER ROLE/)
    // The secrets are dropped from the shell once written.
    expect(e).toMatch(/unset migrator_secret pipeline_secret/)
  })

  it('generates a secret whose alphabet needs no URL escaping, and asserts it', () => {
    const src = read(PROVISION_PATH)
    expect(src).toMatch(/openssl rand -base64 32[\s\S]{0,60}?tr '\+\/' '-_'/)
    expect(src).toMatch(/\^\[A-Za-z0-9_-\]\{43\}\$/)
  })

  it('builds the migrator URL in Unix-socket form and the pipeline URL in TCP form', () => {
    const src = read(PROVISION_PATH)
    expect(src).toMatch(/postgresql:\/\/%s:%s@\/%s\?host=%%2FUsers%%2Fthanapold%%2Fai-capital-v3-run&port=%s/)
    expect(src).toMatch(/postgresql:\/\/%s:%s@127\.0\.0\.1:%s\/%s/)
  })

  it('publishes both credential files at 0600', () => {
    const src = read(PROVISION_PATH)
    expect(src).toMatch(/chmod 600 "\$\{mig_tmp\}" "\$\{pipe_tmp\}"/)
    expect(src).toMatch(/mv -f "\$\{mig_tmp\}"/)
    expect(src).toMatch(/mv -f "\$\{pipe_tmp\}"/)
  })
})

// ── verify.sh ───────────────────────────────────────────────────────────────

describe('verify.sh', () => {
  it('has --running and --stopped and NO default mode', () => {
    const src = read(VERIFY_PATH)
    expect(src).toMatch(/--running\)\s*verify_running/)
    expect(src).toMatch(/--stopped\)\s*verify_stopped/)
    expect(src).toMatch(/\*\)[\s\S]{0,400}?exit 2/)
    expect(src).toMatch(/There is no default mode/)
  })

  it('fails closed and uses absolute PostgreSQL 17 paths', () => {
    const src = read(VERIFY_PATH)
    expect(src).toMatch(/^set -euo pipefail$/m)
    expect(src).toMatch(/^umask 077$/m)
    expect(src).toMatch(/PG_BIN='\/opt\/homebrew\/opt\/postgresql@17\/bin'/)
  })

  it('never starts, stops, repairs, migrates, grants, revokes or makes a credential', () => {
    const e = commands(read(VERIFY_PATH))
    for (const forbidden of [
      /pg_ctl[^\n]*\b(start|stop|restart|reload)\b/, /\binitdb\b/, /\bcreatedb\b/,
      /\bGRANT\b/, /\bREVOKE\b/, /\bALTER ROLE\b/, /\bCREATE\b/, /\bDROP\b/,
      /\bINSERT\b/, /\bUPDATE\b/, /\bDELETE\b/, /runMigrations/,
      /openssl rand/, /\btmutil\b/, /\bmkdir\b/, /\brm\b/, /\bmv\b/, /\bchmod\b/,
    ]) {
      expect(e, `verify.sh contains a mutating construct matching ${forbidden}`).not.toMatch(forbidden)
    }
  })

  it('--stopped makes no connection at all', () => {
    const src = read(VERIFY_PATH)
    const start = src.indexOf('verify_stopped() {')
    const body = src.slice(start, src.indexOf('\n}', start))
    expect(body.length).toBeGreaterThan(200)
    expect(executable(body)).not.toMatch(/\$\{PSQL\}|\bpsql\b/)
    expect(body).toMatch(/pg_controldata|PG_CONTROLDATA/)
  })

  it('--stopped proves clean shutdown non-vacuously', () => {
    const src = read(VERIFY_PATH)
    const start = src.indexOf('verify_stopped() {')
    const body = src.slice(start, src.indexOf('\n}', start))
    expect(body).toMatch(/shut down/)
    // An unreadable control file must FAIL, not silently report no problems.
    expect(body).toMatch(/clean shutdown is UNPROVEN, not proven/)
  })

  it('never reads a credential value into its output', () => {
    const src = read(VERIFY_PATH)
    expect(src).toMatch(/content not read/)
    expect(executable(src)).not.toMatch(/cat[^\n]*(migrator|pipeline)\.url/)
  })

  it('never touches port 5432', () => {
    expect(commands(read(VERIFY_PATH))).not.toMatch(/5432/)
  })

  it('checks the installed HBA non-vacuously', () => {
    // A missing or empty pg_hba.conf must fail, not yield "0 trust rules".
    expect(read(VERIFY_PATH)).toMatch(/canonical source missing, comparison is UNPROVEN/)
    expect(read(VERIFY_PATH)).toMatch(/installed file missing/)
  })

  it('is inert on source', () => {
    const src = read(VERIFY_PATH)
    const lastReal = src.split('\n').filter(l => l.trim() !== '' && !/^\s*#/.test(l)).pop()
    expect(lastReal!.trim()).toBe('main "$@"')
    expect(src.match(/^main "\$@"$/gm)!.length).toBe(1)
  })
})

// ── Documentation ───────────────────────────────────────────────────────────

describe('the cluster README', () => {
  it('records the 090 ordering rule with its reason', () => {
    const md = read(README_PATH)
    expect(md).toMatch(/090_post_migration_lockdown\.sql.{0,8}must NOT be\s+applied/is)
    expect(md).toMatch(/REVOKE ai_capital_owner FROM ai_capital_migrator/)
    expect(md).toMatch(/legacy-copy\.ts/)
  })

  it('records the backup blocker', () => {
    const md = read(README_PATH)
    expect(md).toMatch(/must not become the system of record until a real\s*\n?backup and recovery design has been separately approved/i)
  })

  it('records the rollback boundary and prefers trash over rm', () => {
    const md = read(README_PATH)
    expect(md).toMatch(/## Rollback/)
    expect(md).toMatch(/with `trash`, \*\*not\*\* `rm`/)
  })

  it('is linked from ops/README.md', () => {
    expect(read(join(REPO, 'ops', 'README.md'))).toContain('ops/clusters/ai-capital-v3')
  })
})

// ── EXECUTION SEMANTICS, NOT TEXT ───────────────────────────────────────────
//
// Everything above reads the scripts as text. Text assertions cannot see the
// defects that live in how bash EVALUATES a line — and those are the ones that
// bite, because they look correct on the page.
//
// The concrete case: both scripts set `IFS=$'\n\t'`. Under that IFS, a
// space-delimited scalar does not word-split on spaces at all. `for r in
// ${ROLES}` runs ONCE with the whole string as a single role name, and
// `${COMMAND_STRING} -c '...'` makes bash look for an executable literally
// named "psql --no-psqlrc …". Both read as ordinary shell; both are broken;
// neither is visible to grep.
//
// So these tests SOURCE the real scripts in a controlled harness and observe
// what bash does. Nothing reaches PostgreSQL: the harness puts a fake `psql` on
// the path that records its argv and exits, and no function that touches a
// cluster is ever called.

describe('shell execution semantics', () => {
  const HARNESS = mkdtempSync(join(tmpdir(), 'v3-artifacts-'))

  /**
   * Run a bash snippet with the script's own prologue in force.
   *
   * `IFS` is set exactly as the scripts set it, because that is the whole point
   * — a harness with a default IFS would reproduce none of the defects.
   */
  const bash = (script: string, env: Record<string, string> = {}) =>
    spawnSync('/bin/bash', ['-c', script], {
      encoding: 'utf-8',
      cwd: HARNESS,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: HARNESS, ...env },
    })

  it('the role list survives IFS=$\'\\n\\t\' and yields six separate exact roles', () => {
    // Extract the real declaration and iterate it under the real IFS.
    const src = read(PROVISION_PATH)
    const decl = src.slice(src.indexOf('readonly PASSWORDLESS_ROLES'))
      .slice(0, src.slice(src.indexOf('readonly PASSWORDLESS_ROLES')).indexOf(')') + 1)
    expect(decl, 'the declaration was not found').toContain('PASSWORDLESS_ROLES')

    const r = bash(`set -euo pipefail\nIFS=$'\\n\\t'\n${decl}\nfor x in "\${PASSWORDLESS_ROLES[@]}"; do printf '%s\\n' "$x"; done`)
    expect(r.status, r.stderr).toBe(0)
    const roles = r.stdout.trim().split('\n')
    expect(roles).toEqual([
      'ai_capital_app', 'ai_capital_importer', 'ai_capital_agent',
      'ai_capital_claim_writer', 'ai_capital_operator', 'ai_capital_dashboard',
    ])
    // SIX DISTINCT entries — a scalar would give exactly one, and a duplicated
    // array would still give six lines.
    expect(new Set(roles).size).toBe(6)
    for (const role of roles) expect(role).not.toMatch(/\s/)
  })

  it('the provision script also asserts the array size before iterating it', () => {
    // Non-vacuity: a loop over an emptied array checks nothing and passes.
    expect(read(PROVISION_PATH)).toMatch(/\$\{#PASSWORDLESS_ROLES\[@\]\}.*=\s*'6'/)
  })

  it('psql_ro invokes the real psql binary with SEPARATE argv entries', () => {
    // A fake `psql` that writes its argv out, one entry per line. If verify.sh
    // built a command STRING, bash under IFS=$'\n\t' would fail to find any
    // executable at all and this would never run.
    const fakeBin = join(HARNESS, 'bin')
    mkdirSync(fakeBin, { recursive: true })
    const fakePsql = join(fakeBin, 'psql')
    writeFileSync(fakePsql, '#!/bin/bash\nprintf "%s\\n" "$@"\nprintf "PGOPTIONS=%s\\n" "${PGOPTIONS-<unset>}"\n')
    chmodSync(fakePsql, 0o755)

    // Take verify.sh's real prologue and helper, with PSQL repointed at the fake.
    const src = read(VERIFY_PATH)
    const helper = src.slice(src.indexOf('readonly RO_PGOPTIONS'), src.indexOf('# ── Shared'))
    expect(helper, 'psql_ro was not found').toContain('psql_ro()')

    const r = bash([
      `set -euo pipefail`,
      `IFS=$'\\n\\t'`,
      `readonly PSQL='${fakePsql}'`,
      `readonly SOCKET_ROOT='/Users/thanapold/ai-capital-v3-run'`,
      `readonly TARGET_PORT='5433'`,
      `readonly TARGET_DB='ai_capital_v3'`,
      `readonly SUPERUSER='thanapold'`,
      helper,
      `psql_ro -c 'SELECT 1'`,
    ].join('\n'))

    expect(r.status, `psql_ro did not execute: ${r.stderr}`).toBe(0)
    // The fake prints its argv first, then one PGOPTIONS= line. Split them, so
    // the environment line does not masquerade as an argument.
    const lines = r.stdout.trim().split('\n')
    const envLine = lines.filter(l => l.startsWith('PGOPTIONS='))
    expect(envLine).toHaveLength(1)
    const argv = lines.filter(l => !l.startsWith('PGOPTIONS='))
    // Each of these is its OWN argv entry. A command string would have arrived
    // as one blob, or not arrived at all.
    for (const expected of ['--no-psqlrc', '-At', '-h', '/Users/thanapold/ai-capital-v3-run',
                            '-p', '5433', '-d', 'ai_capital_v3', '-U', 'thanapold',
                            '-c', 'SELECT 1']) {
      expect(argv, `missing a separate argv entry: ${expected}`).toContain(expected)
    }
    expect(argv.some(a => a.includes(' ') && a !== 'SELECT 1'),
           'an argv entry contains embedded spaces — the command was built as a string').toBe(false)
  })

  it('every live verification session carries default_transaction_read_only=on', () => {
    const fakeBin = join(HARNESS, 'bin2')
    mkdirSync(fakeBin, { recursive: true })
    const fakePsql = join(fakeBin, 'psql')
    writeFileSync(fakePsql, '#!/bin/bash\nprintf "PGOPTIONS=%s\\n" "${PGOPTIONS-<unset>}"\n')
    chmodSync(fakePsql, 0o755)

    const src = read(VERIFY_PATH)
    const helper = src.slice(src.indexOf('readonly RO_PGOPTIONS'), src.indexOf('# ── Shared'))
    const r = bash([
      `set -euo pipefail`, `IFS=$'\\n\\t'`,
      `readonly PSQL='${fakePsql}'`,
      `readonly SOCKET_ROOT='/x'`, `readonly TARGET_PORT='5433'`,
      `readonly TARGET_DB='ai_capital_v3'`, `readonly SUPERUSER='thanapold'`,
      helper,
      `psql_ro -c 'SELECT 1'`,
    ].join('\n'))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('default_transaction_read_only=on')

    // ...and the server's answer is CHECKED, not merely requested.
    expect(src).toMatch(/current_setting\('transaction_read_only'\)/)
    expect(src).toMatch(/refusing to read further/)
    // provision.sh's own evidence session does the same.
    expect(read(PROVISION_PATH)).toMatch(/default_transaction_read_only=on/)
    expect(read(PROVISION_PATH)).toMatch(/current_setting\('transaction_read_only'\)/)
  })

  it('no live verification session omits the read-only option or the explicit user', () => {
    // Every psql invocation in verify.sh must go through the helper. A direct
    // "${PSQL}" call elsewhere would bypass both PGOPTIONS and -U.
    const direct = commands(read(VERIFY_PATH))
      .split('\n')
      .filter(l => /"\$\{PSQL\}"/.test(l) && !/^psql_ro\(\)/.test(l))
    // The only permitted occurrence is inside psql_ro itself.
    expect(direct.length, `psql invoked outside psql_ro: ${direct.join(' | ')}`).toBe(1)
    expect(direct[0]).toMatch(/PGOPTIONS="\$\{RO_PGOPTIONS\}"/)
  })

  it('migration execution is anchored to packages/db/bin/migrate.ts, whatever the caller cwd', () => {
    const src = read(PROVISION_PATH)
    // A subshell that cd's into the package, so the caller's directory is both
    // irrelevant and unchanged.
    expect(src).toMatch(/\(\s*\n\s*cd "\$\{REPO\}\/packages\/db"/)
    expect(src).toMatch(/"\$\{TSX\}" bin\/migrate\.ts/)
    // The cwd-dependent bare-specifier eval must be gone: `tsx -e
    // "import('@common/db')"` resolves relative to the PROCESS cwd and fails
    // with ERR_MODULE_NOT_FOUND when run from anywhere outside the workspace.
    expect(commands(src)).not.toMatch(/import\('@common\/db'\)/)
    expect(commands(src)).not.toMatch(/\$\{TSX\}" -e/)
    // The target actually exists, so the anchor is not aspirational.
    expect(existsSync(join(REPO, 'packages', 'db', 'bin', 'migrate.ts'))).toBe(true)
  })

  it('the migrate.ts entrypoint refuses without a credential — a second fail-closed layer', () => {
    const migrate = readFileSync(join(REPO, 'packages', 'db', 'bin', 'migrate.ts'), 'utf-8')
    expect(migrate).toMatch(/usePostgres\(\)/)
    expect(migrate).toMatch(/process\.exit\(1\)/)
  })
})

// ── Installed-artifact verification ─────────────────────────────────────────

describe('verify.sh compares installed artifacts byte-for-byte', () => {
  it('compares the installed HBA and config fragment with their canonical sources', () => {
    const src = read(VERIFY_PATH)
    expect(src).toMatch(/HBA_SRC=.*pg_hba\.conf/)
    expect(src).toMatch(/HBA_INSTALLED=.*PGDATA_ROOT.*pg_hba\.conf/)
    expect(src).toMatch(/CONF_SRC=.*postgresql\.conf\.d\/ai-capital-v3\.conf/)
    expect(src).toMatch(/CONF_INSTALLED=.*PGDATA_ROOT/)
    expect(src).toMatch(/\/usr\/bin\/cmp -s "\$\{src\}" "\$\{dst\}"/)
    // NON-VACUITY: a missing canonical source must report UNPROVEN, not pass.
    expect(src).toMatch(/canonical source missing, comparison is UNPROVEN/)
  })

  it('a broad host rule fails the comparison even though it never names the migrator', () => {
    // THE DEFECT THIS CLOSES. `host all all 127.0.0.1/32 scram-sha-256` grants
    // the migrator TCP without containing "ai_capital_migrator" anywhere, so a
    // name-based check passes it. Byte comparison cannot: it admits exactly one
    // policy. Demonstrated here rather than asserted.
    const dir = mkdtempSync(join(tmpdir(), 'v3-hba-'))
    const canonical = read(HBA_PATH)
    const installed = canonical.replace(
      /^host {4}ai_capital_v3 {2}ai_capital_pipeline {2}127\.0\.0\.1\/32 {3}scram-sha-256$/m,
      'host    all            all                  127.0.0.1/32   scram-sha-256',
    )
    expect(installed, 'the substitution did not apply').not.toBe(canonical)
    // The broad rule does NOT mention the migrator...
    expect(installed).not.toMatch(/^host.*ai_capital_migrator/m)
    // ...and cmp still rejects it.
    const a = join(dir, 'canonical'); const b = join(dir, 'installed')
    writeFileSync(a, canonical); writeFileSync(b, installed)
    expect(spawnSync('/usr/bin/cmp', ['-s', a, b]).status, 'cmp accepted a broadened HBA').not.toBe(0)
  })

  it('proves the fragment include appears exactly once, and is the only include', () => {
    const src = read(VERIFY_PATH)
    expect(src).toMatch(/the fragment is included exactly once/)
    // A second `include_if_exists` would make the LAST occurrence
    // authoritative and the reviewed fragment a decoy.
    expect(src).toMatch(/include\(_if_exists\|_dir\)\?/)
    expect(src).toMatch(/no other include\/include_dir\/include_if_exists directive/)
    // ...and provision.sh writes exactly one include.
    expect(read(PROVISION_PATH).match(/include = /g) ?? []).toHaveLength(1)
  })
})

// ── Filesystem posture ──────────────────────────────────────────────────────

describe('verify.sh filesystem checks are symlink-aware', () => {
  it('tests -L BEFORE -d and -f, so a symlink cannot pass as the real thing', () => {
    const src = read(VERIFY_PATH)
    // `[ -d link_to_dir ]` and `[ -f link_to_file ]` both FOLLOW the link and
    // report true. Ordering the symlink test first is what makes the check
    // meaningful rather than decorative.
    //
    // NON-VACUITY FIRST. `indexOf` returns -1 for an absent needle, and -1 is
    // less than any real index — so a bare ordering comparison PASSES when the
    // symlink test has been deleted entirely, which is the exact regression
    // this test exists to catch. Assert presence before asserting order.
    const ordered = (block: string, first: string, second: string, what: string): void => {
      const a = block.indexOf(first)
      const b = block.indexOf(second)
      expect(a, `${what}: ${first} is missing — the symlink check is gone`).toBeGreaterThan(-1)
      expect(b, `${what}: ${second} is missing`).toBeGreaterThan(-1)
      expect(a, `${what}: ${first} must be tested before ${second}`).toBeLessThan(b)
    }

    const rootBlock = src.slice(src.indexOf('for p in "${PGDATA_ROOT}"'), src.indexOf('credential files:'))
    expect(rootBlock.length, 'the roots block was not found').toBeGreaterThan(100)
    ordered(rootBlock, '-L "${p}"', '-d "${p}"', 'roots')

    const credBlock = src.slice(src.indexOf('for f in migrator.url'), src.indexOf('installed artifacts match'))
    expect(credBlock.length, 'the credentials block was not found').toBeGreaterThan(100)
    ordered(credBlock, '-L "${path}"', '-f "${path}"', 'credential files')

    // And both blocks must actually report a symlink as such, rather than
    // silently classifying it as something else.
    expect(rootBlock).toMatch(/is a SYMLINK/)
    expect(credBlock).toMatch(/is a SYMLINK/)
  })

  it('demonstrates that a symlinked credential is caught, not followed', () => {
    // Executed, not asserted: build a real symlink and show that the ordered
    // test pair reports SYMLINK rather than "regular file".
    const dir = mkdtempSync(join(tmpdir(), 'v3-cred-'))
    writeFileSync(join(dir, 'real.url'), 'postgresql://x@/y\n')
    chmodSync(join(dir, 'real.url'), 0o600)
    symlinkSync(join(dir, 'real.url'), join(dir, 'migrator.url'))
    const probe = spawnSync('/bin/bash', ['-c',
      `p="${join(dir, 'migrator.url')}"; if [ -L "$p" ]; then echo SYMLINK; elif [ -f "$p" ]; then echo REGULAR; fi`,
    ], { encoding: 'utf-8' })
    expect(probe.stdout.trim()).toBe('SYMLINK')
    // The naive order would have said REGULAR — that is the bug being avoided.
    const naive = spawnSync('/bin/bash', ['-c',
      `p="${join(dir, 'migrator.url')}"; if [ -f "$p" ]; then echo REGULAR; fi`,
    ], { encoding: 'utf-8' })
    expect(naive.stdout.trim()).toBe('REGULAR')
  })

  it('requires owner, 0600 and a link count of 1 on each credential file', () => {
    const src = read(VERIFY_PATH)
    expect(src).toMatch(/stat -f '%Su' "\$\{path\}"\)" != "\$\{SUPERUSER\}"/)
    expect(src).toMatch(/stat -f '%Lp' "\$\{path\}"\)" != '600'/)
    expect(src).toMatch(/stat -f '%l' "\$\{path\}"\)" != '1'/)
  })

  it('requires owner and 0700 on each root', () => {
    const src = read(VERIFY_PATH)
    expect(src).toMatch(/stat -f '%Su' "\$\{p\}"\)" != "\$\{SUPERUSER\}"/)
    expect(src).toMatch(/stat -f '%Lp' "\$\{p\}"\)" != '700'/)
  })

  it('still never reads a credential value', () => {
    const src = read(VERIFY_PATH)
    expect(src).toMatch(/content not read/)
    expect(commands(src)).not.toMatch(/cat[^\n]*(migrator|pipeline)\.url/)
    expect(commands(src)).not.toMatch(/shasum[^\n]*(migrator|pipeline)\.url/)
  })
})

// ── LOADED STATE: what the SERVER says it read ──────────────────────────────
//
// Byte-comparing files on disk proves the reviewed bytes are at the reviewed
// paths. It says nothing about which files the running postmaster loaded, and
// nothing at all about `postgresql.auto.conf`, which is read LAST and silently
// wins. These tests pin the checks that close that gap.
//
// Several of them drive verify.sh's real logic with a FAKE psql that replays
// canned catalog output, so a wrong answer is demonstrated to fail rather than
// asserted to be impossible. Nothing reaches PostgreSQL.

describe('verify.sh --running proves the loaded state', () => {
  const runningBody = (): string => {
    const src = read(VERIFY_PATH)
    const start = src.indexOf('verify_running() {')
    expect(start, 'verify_running is not defined').toBeGreaterThan(-1)
    const end = src.indexOf('\nmain() {', start)
    expect(end, 'verify_running is not followed by main').toBeGreaterThan(start)
    return src.slice(start, end)
  }

  it('checks the three server-reported paths exactly', () => {
    const body = runningBody()
    for (const [name, want] of [
      ['data_directory', '${PGDATA_ROOT}'],
      ['config_file', '${PGDATA_ROOT}/postgresql.conf'],
      ['hba_file', '${HBA_INSTALLED}'],
    ]) {
      expect(body, `${name} is not checked`).toContain(`"${name}|${want}"`)
    }
    // Read through current_setting, i.e. the server's own answer — not inferred
    // from the filesystem, which is the thing being cross-checked.
    expect(body).toMatch(/current_setting\('\$\{name\}'\)/)
  })

  it('checks every canonical setting for BOTH value and sourcefile', () => {
    const body = runningBody()
    const conf = read(CONF_PATH)
    const declared = activeLines(conf)
      .filter(l => l.includes('='))
      .map(l => l.split('=')[0].trim().toLowerCase())
    // NON-VACUITY: the fragment must actually declare a meaningful number of
    // settings, or "every declared setting is checked" is trivially true.
    expect(declared.length, 'the fragment declares nothing').toBe(18)

    // Value side: each setting appears in the runtime-value table (or, for
    // log_line_prefix, in its own trailing-space-safe comparison).
    for (const name of declared) {
      const inTable = new RegExp(`"${name}\\|`, 'i').test(body)
      const special = name === 'log_line_prefix' && /current_setting\('log_line_prefix'\)/.test(body)
      expect(inTable || special, `${name} has no runtime-value check`).toBe(true)
    }

    // Sourcefile side: each setting is named in the pg_settings queries, and
    // the count assertion is exact rather than "at least".
    const sourceQueries = body.slice(body.indexOf('pg_settings'))
    for (const name of declared) {
      expect(sourceQueries, `${name} is not covered by the sourcefile check`).toContain(`'${name}'`)
    }
    expect(body).toMatch(/\[ "\$\{from_fragment\}" = '18' \]/)
    expect(body).toMatch(/sourcefile IS DISTINCT FROM/)
    expect(body).toMatch(/no canonical setting was supplied by a later source/)
  })

  it('names postgresql.auto.conf as the override it is defending against', () => {
    // The reason has to survive in the file, or a later editor deletes the
    // check as redundant with the byte comparison.
    expect(read(VERIFY_PATH)).toMatch(/postgresql\.auto\.conf/)
  })

  it('inspects pg_hba_file_rules for errors, count and exact ordered semantics', () => {
    const body = runningBody()
    expect(body).toMatch(/FROM pg_hba_file_rules WHERE error IS NOT NULL/)
    expect(body).toMatch(/\[ "\$\{hba_errors\}" = '0' \]/)
    expect(body).toMatch(/\[ "\$\{hba_count\}" = '6' \]/)
    expect(body).toMatch(/ORDER BY rule_number/)
    // Rendered from the PARSED columns, never from the file text.
    for (const col of ['type', 'database', 'user_name', 'address', 'netmask', 'auth_method']) {
      expect(body, `the canonical rendering omits ${col}`).toContain(col)
    }
  })

  it('no longer claims pg_hba_file_rules is out of reach', () => {
    // An earlier note of mine said this view needed privileges the session did
    // not have. It was wrong — the session is the cluster superuser — and the
    // claim had left the parsed ruleset unverified.
    const src = read(VERIFY_PATH)
    expect(src).toMatch(/superuser/)
    expect(src).not.toMatch(/pg_hba_file_rules[^\n]*(unavailable|not available|out of reach)/)
  })
})

// ── Controlled execution against a fake psql ────────────────────────────────

describe('verify.sh --running rejects wrong loaded state (driven by a fake psql)', () => {
  /**
   * Build a fake `psql` that answers a fixed map of query-substring → output,
   * then run verify.sh's real rule-comparison logic against it.
   *
   * Only the pg_hba_file_rules comparison is exercised end-to-end here: it is
   * the block whose correctness is a policy decision rather than a string
   * equality, and the one a reviewer most needs demonstrated.
   */
  const CANONICAL_RULES = [
    'local|ai_capital_v3|ai_capital_migrator|||scram-sha-256',
    'local|all|thanapold|||peer',
    'local|all|all|||reject',
    'host|ai_capital_v3|ai_capital_pipeline|127.0.0.1|255.255.255.255|scram-sha-256',
    'host|all|all|0.0.0.0|0.0.0.0|reject',
    'host|all|all|::|::|reject',
  ].join('\n')

  /** Run the real expected/actual comparison from verify.sh against `actual`. */
  const compare = (actual: string): number => {
    const src = read(VERIFY_PATH)
    const start = src.indexOf("  local expected_rules='")
    expect(start, 'the expected_rules block was not found').toBeGreaterThan(-1)
    // `local` is illegal outside a function, so strip it: the harness runs the
    // block at top level. The VALUE under test — the expected-rules literal —
    // is carried across byte-for-byte.
    // `local` is illegal outside a function and the harness runs this block at
    // top level, so strip the keyword. The VALUE under test — the expected-rules
    // literal — crosses over byte-for-byte, which is the whole point: the test
    // compares against verify.sh's own policy, not a copy of it.
    const expectedBlock = src.slice(start, src.indexOf('  local actual_rules', start))
      .replace(/^\s*local /gm, '')
      .replace(/^\s*local /gm, '')

    const r = spawnSync('/bin/bash', ['-c', [
      `set -uo pipefail`,
      `IFS=$'\\n\\t'`,
      `FAILURES=0`,
      `ok() { printf 'ok %s\\n' "$*"; }`,
      `bad() { FAILURES=$((FAILURES+1)); printf 'FAIL %s\\n' "$*"; }`,
      expectedBlock,
      `actual_rules=$(cat <<'EOF_ACTUAL'\n${actual}\nEOF_ACTUAL\n)`,
      `if [ "\${actual_rules}" = "\${expected_rules}" ]; then ok matched; else bad differs; fi`,
      `exit "\${FAILURES}"`,
    ].join('\n')], { encoding: 'utf-8' })
    return r.status ?? -1
  }

  it('accepts exactly the canonical parsed ruleset', () => {
    // NON-VACUITY for every negative below: if this failed, they would all
    // "pass" for the wrong reason.
    expect(compare(CANONICAL_RULES)).toBe(0)
  })

  it('rejects a BROADENED rule that never names the migrator', () => {
    const broadened = CANONICAL_RULES.replace(
      'host|ai_capital_v3|ai_capital_pipeline|127.0.0.1|255.255.255.255|scram-sha-256',
      'host|all|all|127.0.0.1|255.255.255.255|scram-sha-256',
    )
    expect(broadened).not.toContain('ai_capital_migrator\n')
    expect(compare(broadened), 'a broadened host rule was accepted').not.toBe(0)
  })

  it('rejects REORDERED rules — first-match-wins makes order part of the policy', () => {
    const lines = CANONICAL_RULES.split('\n')
    const swapped = [lines[1], lines[0], ...lines.slice(2)].join('\n')
    expect(new Set(swapped.split('\n'))).toEqual(new Set(lines))   // same rules...
    expect(compare(swapped), 'a reordered ruleset was accepted').not.toBe(0)   // ...different policy
  })

  it('rejects a MISSING rule', () => {
    const missing = CANONICAL_RULES.split('\n').filter(l => l !== 'local|all|all|||reject').join('\n')
    expect(compare(missing), 'a ruleset missing the local catch-all was accepted').not.toBe(0)
  })

  it('rejects an ADDED rule', () => {
    const added = `${CANONICAL_RULES}\nhost|all|all|0.0.0.0|0.0.0.0|scram-sha-256`
    expect(compare(added), 'an extra permissive rule was accepted').not.toBe(0)
  })

  it('rejects empty output — an unreadable catalog is not a pass', () => {
    expect(compare(''), 'empty pg_hba_file_rules output was accepted').not.toBe(0)
    expect(compare('<unreadable>')).not.toBe(0)
  })

  it('treats a parse error and a wrong row count as separate failures', () => {
    // These are distinct catalog facts with distinct causes, so verify.sh
    // asserts them separately rather than folding them into the diff.
    const body = read(VERIFY_PATH)
    expect(body).toMatch(/no line of pg_hba\.conf failed to parse/)
    expect(body).toMatch(/exactly six rules parsed/)
  })
})

// ── provision.sh delegates to the reviewed verifier ─────────────────────────

describe('provision.sh runs the reviewed verifier in both modes', () => {
  const applyBody = (): string => {
    const src = read(PROVISION_PATH)
    const start = src.indexOf('run_apply() {')
    return src.slice(start, src.indexOf('\nmain() {', start))
  }
  const at = (body: string, re: RegExp): number => {
    const i = body.split('\n').findIndex(l => re.test(l))
    expect(i, `no line matched ${re}`).toBeGreaterThan(-1)
    return i
  }

  it('addresses the verifier by its absolute reviewed path', () => {
    const src = read(PROVISION_PATH)
    expect(src).toMatch(/readonly VERIFY_SH="\$\{HERE\}\/verify\.sh"/)
    // HERE is the script's own realpath, so neither PATH nor the caller's cwd
    // can substitute a different copy.
    expect(src).toMatch(/readonly HERE="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd -P\)"/)
    expect(commands(src)).not.toMatch(/(^|[^/])verify\.sh/m)
  })

  it('refuses in --inspect when the verifier is missing or not executable', () => {
    const src = read(PROVISION_PATH)
    expect(src).toMatch(/\[ -x "\$\{VERIFY_SH\}" \] \|\| die/)
  })

  it('runs --running after migrations and inventory, and before the stop', () => {
    const body = applyBody()
    expect(at(body, /bin\/migrate\.ts/)).toBeLessThan(at(body, /VERIFY_SH\}" --running/))
    expect(at(body, /DB_INVENTORY/)).toBeLessThan(at(body, /VERIFY_SH\}" --running/))
    expect(at(body, /VERIFY_SH\}" --running/)).toBeLessThan(at(body, /-m fast -w -t 60 stop/))
  })

  it('runs --stopped after the stop and its checks, and before the digest', () => {
    const body = applyBody()
    expect(at(body, /-m fast -w -t 60 stop/)).toBeLessThan(at(body, /VERIFY_SH\}" --stopped/))
    // After the clean-stop assertions, not before them.
    expect(at(body, /Database cluster state: \+shut down/)).toBeLessThan(at(body, /VERIFY_SH\}" --stopped/))
    expect(at(body, /VERIFY_SH\}" --stopped/)).toBeLessThan(at(body, /> "\$\{EVIDENCE_ROOT\}\/DIGEST"/))
  })

  it('captures both verifier outputs as evidence', () => {
    const body = applyBody()
    expect(body).toMatch(/--running \| \/usr\/bin\/tee "\$\{EVIDENCE_ROOT\}\/verify-running\.txt"/)
    expect(body).toMatch(/--stopped \| \/usr\/bin\/tee "\$\{EVIDENCE_ROOT\}\/verify-stopped\.txt"/)
  })

  it('lets either verifier failure stop provisioning before the digest', () => {
    const src = read(PROVISION_PATH)
    // `set -e` plus `pipefail` is what makes a failing verifier fatal THROUGH a
    // tee. Without pipefail the pipeline would report tee's zero exit and the
    // run would continue to publish a digest for a cluster that failed.
    expect(src).toMatch(/^set -euo pipefail$/m)
    const body = applyBody()
    for (const mode of ['--running', '--stopped']) {
      const line = body.split('\n').find(l => l.includes(`VERIFY_SH}" ${mode}`))!
      expect(line, `${mode} is guarded, so a failure would not be fatal`).not.toMatch(/\|\||if |&&|!\s/)
    }
  })

  it('neither verifier output can contain a credential', () => {
    // verify.sh reads credential files as containers only; nothing in it cats,
    // hashes or prints their contents, so its stdout cannot carry one.
    const v = commands(read(VERIFY_PATH))
    expect(v).not.toMatch(/cat[^\n]*(migrator|pipeline)\.url/)
    expect(v).not.toMatch(/shasum[^\n]*(migrator|pipeline)\.url/)
    expect(read(VERIFY_PATH)).toMatch(/content not read/)
    // ...and the outputs land under the evidence root, never the secret root.
    const body = read(PROVISION_PATH)
    for (const f of ['verify-running.txt', 'verify-stopped.txt']) {
      const line = body.split('\n').find(l => l.includes(f))!
      expect(line).toContain('EVIDENCE_ROOT')
      expect(line).not.toContain('SECRET_ROOT')
    }
  })

  it('numbers its steps truthfully, with no duplicates or gaps up to the total', () => {
    // A renumbering that drifts is a small thing that makes an operator distrust
    // every other claim in the transcript.
    const labels = [...read(PROVISION_PATH).matchAll(/APPLY (\d+)\/(\d+)/g)]
    expect(labels.length).toBeGreaterThan(15)
    const totals = new Set(labels.map(m => m[2]))
    expect(totals.size, `mixed totals: ${[...totals].join(', ')}`).toBe(1)
    const numbers = labels.map(m => Number(m[1]))
    expect(new Set(numbers).size, 'a step number is duplicated').toBe(numbers.length)
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers)   // monotonic
    expect(Math.max(...numbers)).toBe(Number([...totals][0]))
  })
})

// ── The README tells the truth about all of this ────────────────────────────

describe('the README matches the implemented behaviour', () => {
  it('says apply runs both verifier modes automatically', () => {
    const md = read(README_PATH)
    expect(md).toMatch(/provision\.sh --apply` runs both verifier modes itself/)
    expect(md).toMatch(/verify-running\.txt/)
    expect(md).toMatch(/verify-stopped\.txt/)
    expect(md).toMatch(/before\*\*\s+the evidence digest is published/)
  })

  it('says the standalone modes remain available for later read-only checks', () => {
    expect(read(README_PATH)).toMatch(/standalone modes remain available/)
  })

  it('documents the loaded-state and parsed-HBA checks', () => {
    const md = read(README_PATH)
    expect(md).toMatch(/data_directory`, `config_file` and `hba_file`/)
    expect(md).toMatch(/pg_settings\.sourcefile/)
    expect(md).toMatch(/postgresql\.auto\.conf/)
    expect(md).toMatch(/pg_hba_file_rules/)
    expect(md).toMatch(/first-match-wins/)
  })
})

// ── lsof's three states, exercised under the scripts' own shell options ─────
//
// WHAT GATE C FOUND. `lsof` exits 1 when it matches nothing — its ordinary way
// of saying "no such listener". Under `set -o pipefail` a pipeline inherits
// that 1, so
//
//     listeners="$(lsof -iTCP:5433 2>/dev/null | wc -l | tr -d ' ')"
//
// failed as an assignment and `set -e` killed provision.sh BEFORE the explicit
// `[ "${listeners}" = '0' ]` comparison it fed. The abort fired in exactly the
// desired case — a clean host — so --inspect could never pass, and --apply,
// which begins by calling it, could never run.
//
// `bash -n` parses that line happily and every text assertion about it was
// true: the check was present, correctly spelled, and in the right place. Only
// execution could find it. So these tests run the real helper against a FAKE
// lsof on disk, under the same `set -euo pipefail` and `IFS=$'\n\t'`.

describe("lsof no-match semantics", () => {
  const HARNESS = mkdtempSync(join(tmpdir(), 'v3-lsof-'))

  /** Extract a script's real helper block, verbatim, with `readonly LSOF` repointed. */
  const helperBlock = (path: string, fakeLsof: string): string => {
    const src = read(path)
    const start = src.indexOf("readonly LSOF='/usr/sbin/lsof'")
    expect(start, `the LSOF constant is missing from ${path}`).toBeGreaterThan(-1)
    const end = src.indexOf('\n# ──', start)
    expect(end, 'the helper block is not terminated by a section rule').toBeGreaterThan(start)
    return src.slice(start, end).replace("readonly LSOF='/usr/sbin/lsof'", `readonly LSOF='${fakeLsof}'`)
  }

  /** Write a fake lsof with the given exit status, stdout and stderr. */
  const fakeLsof = (name: string, status: number, out = '', err = ''): string => {
    const dir = join(HARNESS, name)
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'lsof')
    writeFileSync(p, [
      '#!/bin/bash',
      out ? `cat <<'EOF_OUT'\n${out}\nEOF_OUT` : ':',
      err ? `cat >&2 <<'EOF_ERR'\n${err}\nEOF_ERR` : ':',
      `exit ${status}`,
    ].join('\n'))
    chmodSync(p, 0o755)
    return p
  }

  /** Run `body` with the real helper in scope, under the scripts' own options. */
  const withHelper = (scriptPath: string, lsof: string, body: string) =>
    spawnSync('/bin/bash', ['-c', [
      'set -euo pipefail',
      "IFS=$'\\n\\t'",
      helperBlock(scriptPath, lsof),
      body,
    ].join('\n')], { encoding: 'utf-8', cwd: HARNESS,
                     env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: HARNESS } })

  /**
   * Make a function body runnable at top level.
   *
   * `local` is illegal outside a function. A declaration-only line
   * (`local foo bar`) must be DELETED — stripping just the keyword would leave
   * `foo bar`, which bash runs as a command and reports as "command not
   * found". A line that also assigns keeps its assignment.
   */
  const topLevel = (block: string): string =>
    block.split('\n')
      .filter(l => !/^\s*local\s+[A-Za-z_][A-Za-z0-9_ ]*$/.test(l))
      .map(l => l.replace(/^(\s*)local\s+/, '$1'))
      .join('\n')

  const LISTENER_ROWS = [
    'COMMAND   PID      USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'postgres 9011 thanapold    7u  IPv6 0xd357521           0t0  TCP [::1]:5433 (LISTEN)',
    'postgres 9011 thanapold    8u  IPv4 0x82f1af5           0t0  TCP 127.0.0.1:5433 (LISTEN)',
  ].join('\n')

  for (const [label, path] of [['provision.sh', PROVISION_PATH], ['verify.sh', VERIFY_PATH]] as const) {
    describe(label, () => {
      it('exit 1 with no output is a NO-MATCH: the caller continues and counts 0', () => {
        // THE GATE-C REGRESSION, stated as a test. Before the fix this aborted.
        const r = withHelper(path, fakeLsof(`${label}-nomatch`, 1),
          'n="$(lsof_count -nP -iTCP:5433)" || { echo ABORTED; exit 9; }\necho "count=${n}"\necho CONTINUED')
        expect(r.status, `the script aborted on a benign no-match: ${r.stderr}`).toBe(0)
        expect(r.stdout).toContain('count=0')
        expect(r.stdout).toContain('CONTINUED')
        expect(r.stdout).not.toContain('ABORTED')
      })

      it('a zero count is exactly "0", with no whitespace to defeat the comparison', () => {
        const r = withHelper(path, fakeLsof(`${label}-zero`, 1),
          'n="$(lsof_count -nP -iTCP:5433)"\n[ "${n}" = "0" ] && echo EXACTLY_ZERO || echo "NOT_ZERO:[${n}]"')
        expect(r.stdout.trim()).toBe('EXACTLY_ZERO')
      })

      it('exit 0 with listener rows preserves every row and detects both families', () => {
        const r = withHelper(path, fakeLsof(`${label}-rows`, 0, LISTENER_ROWS),
          [ 'rows="$(lsof_query -nP -iTCP:5433 -sTCP:LISTEN)"',
            'printf "%s\\n" "${rows}" | /usr/bin/grep -q "127\\.0\\.0\\.1" && echo HAS_V4 || echo NO_V4',
            'printf "%s\\n" "${rows}" | /usr/bin/grep -q "\\[::1\\]" && echo HAS_V6 || echo NO_V6',
            'echo "count=$(lsof_count -nP -iTCP:5433 -sTCP:LISTEN)"',
          ].join('\n'))
        expect(r.status, r.stderr).toBe(0)
        expect(r.stdout).toContain('HAS_V4')
        expect(r.stdout).toContain('HAS_V6')
        expect(r.stdout).toContain('count=3')
      })

      it('exit 2 with a diagnostic is REJECTED, and the diagnostic survives', () => {
        const r = withHelper(path, fakeLsof(`${label}-err2`, 2, '', 'lsof: permission denied'),
          'if n="$(lsof_count -nP -iTCP:5433)"; then echo "ACCEPTED:${n}"; else echo REJECTED; fi')
        expect(r.stdout.trim()).toBe('REJECTED')
        expect(r.stderr, 'the diagnostic was swallowed').toContain('permission denied')
        expect(r.stderr).toContain('exit 2')
      })

      it('exit 1 WITH a diagnostic is REJECTED — it is not a benign no-match', () => {
        // The distinction that makes `|| true` unacceptable: same status, very
        // different meaning, and only the output separates them.
        const r = withHelper(path, fakeLsof(`${label}-err1`, 1, '', 'lsof: no pwd entry for UID 501'),
          'if n="$(lsof_count -nP -iTCP:5433)"; then echo "ACCEPTED:${n}"; else echo REJECTED; fi')
        expect(r.stdout.trim()).toBe('REJECTED')
        expect(r.stderr).toContain('no pwd entry')
      })

      it('a missing lsof binary is REJECTED, not read as "nothing is listening"', () => {
        const r = withHelper(path, join(HARNESS, 'does-not-exist', 'lsof'),
          'if n="$(lsof_count -nP -iTCP:5433)"; then echo "ACCEPTED:${n}"; else echo REJECTED; fi')
        expect(r.stdout.trim()).toBe('REJECTED')
      })

      it('uses no blanket `|| true` around an lsof call', () => {
        // `|| true` would collapse all three states into success, which is the
        // failure mode this whole helper exists to avoid.
        const src = commands(read(path))
        for (const line of src.split('\n')) {
          if (!/lsof/.test(line)) continue
          expect(line, `an lsof call is suppressed with || true: ${line.trim()}`)
            .not.toMatch(/\|\|\s*(true|:)\s*$/)
        }
      })
    })
  }

  it('provision.sh reaches its NAMED refusal when the expected 5432 listener is absent', () => {
    // Before the fix, an absent foreign listener aborted the assignment and the
    // operator saw nothing — the refusal that explains what is wrong was
    // unreachable. The message must actually be produced.
    const src = read(PROVISION_PATH)
    const start = src.indexOf('  local foreign_rows foreign_pid')
    expect(start, 'the foreign-listener block was not found').toBeGreaterThan(-1)
    // `local` is illegal outside a function and the harness runs the block at
    // top level; the logic under test is unaffected.
    const block = topLevel(src.slice(start, src.indexOf('[ -e "${SOCKET_ROOT}', start)))
      .replace(/\$\{FOREIGN_PGDATA\}/g, '/nowhere')
    const r = withHelper(PROVISION_PATH, fakeLsof('foreign-absent', 1), [
      'die() { printf "provision.sh: REFUSED: %s\\n" "$*" >&2; exit 1; }',
      block,
      'echo SHOULD_NOT_REACH',
    ].join('\n'))
    expect(r.status, 'an absent foreign listener did not refuse').not.toBe(0)
    expect(r.stdout).not.toContain('SHOULD_NOT_REACH')
    expect(r.stderr, 'the named refusal was not reached').toContain('the existing listener vanished during provisioning')
  })

  it('provision.sh IPv6-absence cannot pass when lsof itself failed', () => {
    // The old form was `! lsof | grep -q '[::1]'`. With lsof failing, grep
    // finds nothing in an empty stream and `!` turns that miss into a PASS —
    // an error reading as a satisfied security property.
    const src = read(PROVISION_PATH)
    const start = src.indexOf('  local v3_listen')
    expect(start, 'the v3 listener block was not found').toBeGreaterThan(-1)
    const block = topLevel(src.slice(start, src.indexOf('  note "the existing listener', start)))
    const r = withHelper(PROVISION_PATH, fakeLsof('v3-broken', 2, '', 'lsof: internal error'), [
      'die() { printf "provision.sh: REFUSED: %s\\n" "$*" >&2; exit 1; }',
      // The block references constants the real script declares above it.
      "readonly TARGET_PORT='5433'",
      "readonly SOCKET_ROOT='/Users/thanapold/ai-capital-v3-run'",
      block,
      'echo PASSED_DESPITE_LSOF_FAILURE',
    ].join('\n'))
    expect(r.status, 'a failing lsof was treated as a satisfied check').not.toBe(0)
    expect(r.stdout).not.toContain('PASSED_DESPITE_LSOF_FAILURE')
    expect(r.stderr).toMatch(/could not query the port .* listener/)
  })

  it('verify.sh reports UNKNOWN rather than absent when lsof fails', () => {
    for (const marker of [
      /the .* listener state is UNKNOWN, not proven absent/,
      /IPv4 presence and IPv6 absence are UNKNOWN, not proven/,
    ]) {
      expect(read(VERIFY_PATH), `missing the UNKNOWN branch matching ${marker}`).toMatch(marker)
    }
    // And those branches call bad(), so they FAIL the run rather than printing
    // a note beside a green tick.
    // Executable lines only — a comment explaining the distinction is not a
    // branch, and failing on it would push an author to delete the comment.
    const executableUnknown = executable(read(VERIFY_PATH))
      .split('\n')
      .filter(l => l.includes('UNKNOWN'))
    expect(executableUnknown.length, 'no UNKNOWN branch exists at all').toBe(2)
    for (const line of executableUnknown) {
      expect(line, `an UNKNOWN branch does not fail: ${line.trim()}`).toMatch(/^\s*bad /)
    }
  })

  it('every lsof call in both scripts goes through the helper', () => {
    for (const path of [PROVISION_PATH, VERIFY_PATH]) {
      const direct = commands(read(path)).split('\n')
        .filter(l => /\/usr\/sbin\/lsof/.test(l) && !/^readonly LSOF=/.test(l.trim()))
      expect(direct, `a direct lsof pipeline survives in ${path}: ${direct.join(' | ')}`).toEqual([])
      // ...and the helper itself is the only place the binary is named.
      expect(read(path)).toMatch(/readonly LSOF='\/usr\/sbin\/lsof'/)
    }
  })

  it('runs lsof once per assertion group, not once per property', () => {
    // Two runs could observe two different instants, and would report a state
    // that never existed at any single moment.
    for (const path of [PROVISION_PATH, VERIFY_PATH]) {
      const body = commands(read(path))
      const listenQueries = body.split('\n')
        .filter(l => /lsof_query .*-sTCP:LISTEN/.test(l) && !/5432/.test(l))
      expect(listenQueries.length, `${path} queries the v3 listener ${listenQueries.length} times`).toBe(1)
    }
  })
})

// ── The pg_ctl log directory, at the real production seam ───────────────────
//
// WHAT THE FIRST --apply FOUND. `pg_ctl -l FILE` opens FILE through a shell
// redirect BEFORE the postmaster starts. The target was ${PGDATA}/log/pg_ctl.log
// — but `log/` is created by the SERVER (logging_collector=on,
// log_directory='log'), which cannot happen until the server starts, and initdb
// does not create it either. The run died at phase 7 of 25 with
//
//     /bin/sh: .../log/pg_ctl.log: No such file or directory
//     pg_ctl: could not start server
//
// after initdb had succeeded and the reviewed config was installed. Fail-closed,
// but fatal, and invisible to `bash -n` and to every text assertion — the line
// was present, correctly spelled and in the right place.
//
// So this block EXECUTES the production helper, extracted verbatim, against a
// temporary PGDATA fixture. No real PGDATA is touched and no PostgreSQL runs.

describe('pg_ctl log directory preparation', () => {
  const HARNESS = mkdtempSync(join(tmpdir(), 'v3-logdir-'))

  /** The production helper, lifted verbatim from provision.sh. */
  const helperSource = (): string => {
    const src = read(PROVISION_PATH)
    const start = src.indexOf('prepare_log_directory() {')
    expect(start, 'prepare_log_directory is not defined').toBeGreaterThan(-1)
    const end = src.indexOf('\n}', start)
    expect(end, 'prepare_log_directory is not closed').toBeGreaterThan(start)
    return src.slice(start, end + 2)
  }

  /**
   * Run the real helper against a fixture PGDATA.
   *
   * `LOG_DIR` and `SUPERUSER` are the constants the helper reads; they are
   * supplied here exactly as the script supplies them, so the code under test
   * is unmodified.
   */
  const runHelper = (pgdata: string, opts: { argv?: string; superuser?: string } = {}) => {
    // The helper takes NO argument: its destination is the reviewed LOG_DIR
    // constant, bound here exactly as provision.sh binds it. `argv` exists only
    // so the confinement test can prove that a caller-supplied path is refused
    // before anything is created.
    const call = opts.argv === undefined
      ? 'prepare_log_directory'
      : `prepare_log_directory '${opts.argv}'`
    return spawnSync('/bin/bash', ['-c', [
      'set -euo pipefail',
      "IFS=$'\\n\\t'",
      'die() { printf "provision.sh: REFUSED: %s\\n" "$*" >&2; exit 1; }',
      `readonly LOG_DIR='${join(pgdata, 'log')}'`,
      `readonly SUPERUSER='${opts.superuser ?? process.env.USER ?? 'thanapold'}'`,
      helperSource(),
      call,
      'echo PREPARED',
    ].join('\n')], { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', HOME: HARNESS } })
  }

  /** A fresh PGDATA-shaped fixture with NO log directory. */
  const fixture = (name: string): string => {
    const d = join(HARNESS, name)
    mkdirSync(d, { recursive: true, mode: 0o700 })
    writeFileSync(join(d, 'PG_VERSION'), '17\n')
    expect(existsSync(join(d, 'log')), 'the fixture already has a log directory').toBe(false)
    return d
  }

  /** What `pg_ctl -l FILE` does: open FILE for append through a shell redirect. */
  const openLogLikePgCtl = (pgdata: string) =>
    spawnSync('/bin/sh', ['-c', `: >> '${join(pgdata, 'log', 'pg_ctl.log')}'`], { encoding: 'utf-8' })

  it('reproduces the failure: without preparation, the pg_ctl-style open fails', () => {
    // NON-VACUITY for everything below. If this passed, the fix would be
    // unnecessary and every success assertion would be meaningless.
    const pgdata = fixture('repro')
    const r = openLogLikePgCtl(pgdata)
    expect(r.status, 'the open unexpectedly succeeded with no log directory').not.toBe(0)
    expect(r.stderr).toMatch(/No such file or directory/)
  })

  it('preparation creates exactly <PGDATA>/log, and the open then succeeds', () => {
    const pgdata = fixture('happy')
    const r = runHelper(pgdata)
    expect(r.status, `the helper failed: ${r.stderr}`).toBe(0)
    expect(r.stdout).toContain('PREPARED')

    const dir = join(pgdata, 'log')
    const st = lstatSync(dir)
    expect(st.isSymbolicLink(), 'the log directory is a symlink').toBe(false)
    expect(st.isDirectory(), 'the log directory is not a directory').toBe(true)
    expect(st.mode & 0o7777, 'the log directory is not mode 0700').toBe(0o700)
    expect(st.uid, 'the log directory is not owned by the invoking user').toBe(process.getuid!())
    // It landed inside the PGDATA the constant names — asserted against the
    // filesystem, which is where it matters, rather than inside the helper.
    expect(realpathSync(join(dir, '..')), 'the log directory is not inside PGDATA')
      .toBe(realpathSync(pgdata))

    // The thing the whole fix exists for.
    expect(openLogLikePgCtl(pgdata).status, 'the pg_ctl-style open still fails').toBe(0)
  })

  it('creates no sibling or alternate log directory', () => {
    const pgdata = fixture('exact')
    expect(runHelper(pgdata).status).toBe(0)
    // Exactly one new entry, named `log`, beside the fixture's PG_VERSION.
    expect(readdirSync(pgdata).sort()).toEqual(['PG_VERSION', 'log'])
    // ...and nothing was created beside PGDATA itself.
    expect(readdirSync(HARNESS).includes('log'), 'a log directory appeared outside PGDATA').toBe(false)
    expect(existsSync(join(pgdata, 'pg_log')), 'an alternate pg_log was created').toBe(false)
    expect(existsSync(join(pgdata, 'logs')), 'an alternate logs directory was created').toBe(false)
  })

  // ── Fail-closed cases ─────────────────────────────────────────────────────

  it('refuses a pre-existing SYMLINK at <PGDATA>/log', () => {
    // -p would follow it and redirect the postmaster's output somewhere nobody
    // reviewed. A dangling link is covered too: -e is false for one, which is
    // why the guard tests -e OR -L rather than -e alone.
    const pgdata = fixture('symlink')
    const elsewhere = join(HARNESS, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    symlinkSync(elsewhere, join(pgdata, 'log'))
    const r = runHelper(pgdata)
    expect(r.status, 'a symlinked log directory was accepted').not.toBe(0)
    expect(r.stderr).toMatch(/something already exists/)
    // The link is untouched — the helper refuses, it does not "fix".
    expect(lstatSync(join(pgdata, 'log')).isSymbolicLink()).toBe(true)
  })

  it('refuses a DANGLING symlink, which -e alone would miss', () => {
    const pgdata = fixture('dangling')
    symlinkSync(join(HARNESS, 'no-such-target'), join(pgdata, 'log'))
    expect(existsSync(join(pgdata, 'log')), 'the fixture link is not actually dangling').toBe(false)
    expect(runHelper(pgdata).status, 'a dangling symlink was accepted').not.toBe(0)
  })

  it('refuses a pre-existing regular file or directory — no silent reuse', () => {
    const asFile = fixture('as-file')
    writeFileSync(join(asFile, 'log'), '')
    expect(runHelper(asFile).status, 'a regular file at the log path was accepted').not.toBe(0)

    const asDir = fixture('as-dir')
    mkdirSync(join(asDir, 'log'), { mode: 0o755 })
    const r = runHelper(asDir)
    expect(r.status, 'a pre-existing directory was silently reused').not.toBe(0)
    expect(r.stderr).toMatch(/refusing to reuse or overwrite/)
    // Proof this is the -p behaviour being rejected: mkdir -p would accept it.
    expect(spawnSync('/bin/mkdir', ['-p', join(asDir, 'log')]).status,
           'mkdir -p would have accepted it — that is the difference').toBe(0)
  })

  it('refuses wrong OWNERSHIP', () => {
    // Changing a directory's owner needs root, which this suite must not have.
    // The ownership BRANCH is still exercised honestly by pointing the helper's
    // expected owner at a principal that is not the creator: the comparison the
    // production code makes is identical, and it fires.
    const pgdata = fixture('owner')
    const r = runHelper(pgdata, { superuser: 'definitely-not-the-owner' })
    expect(r.status, 'a mismatched owner was accepted').not.toBe(0)
    expect(r.stderr).toMatch(/is owned by .*, not definitely-not-the-owner/)
  })

  it('detects mode widening to 0755', () => {
    // The helper creates with `mkdir -m 700` and then RE-READS the mode, so a
    // umask or a filesystem that ignored the mode is caught. Demonstrated by
    // widening the same check's input.
    const pgdata = fixture('mode')
    expect(runHelper(pgdata).status).toBe(0)
    chmodSync(join(pgdata, 'log'), 0o755)
    const r = spawnSync('/bin/bash', ['-c', [
      'set -euo pipefail',
      'die() { printf "REFUSED: %s\\n" "$*" >&2; exit 1; }',
      `[ "$(/usr/bin/stat -f '%Lp' '${join(pgdata, 'log')}')" = '700' ] || die "mode widened"`,
      'echo OK',
    ].join('\n')], { encoding: 'utf-8' })
    expect(r.status, '0755 passed the mode check').not.toBe(0)
    expect(r.stderr).toContain('mode widened')
    // And the production source really does assert the exact mode.
    expect(helperSource()).toMatch(/stat -f '%Lp' "\$\{dir\}"\)" = '700'/)
  })

  it('refuses a caller-supplied path BEFORE creating anything', () => {
    // THE DEFECT THIS REPLACES. The previous helper took the path as "$1",
    // ran `mkdir` on it, and only then compared it with LOG_DIR — so an
    // alternate path was CREATED and then refused. The old test asserted the
    // non-zero exit and never looked at the filesystem, so it passed while the
    // directory sat there. A check that runs after the mutation it exists to
    // prevent is not a guard.
    const pgdata = fixture('confinement')
    const before = readdirSync(pgdata).sort()

    const r = runHelper(pgdata, { argv: join(pgdata, 'pg_log') })

    expect(r.status, 'a caller-supplied path was accepted').not.toBe(0)
    expect(r.stderr).toMatch(/takes no arguments/)
    // NOTHING WAS CREATED — neither the alternate path nor the canonical one.
    expect(existsSync(join(pgdata, 'pg_log')), 'the alternate path was created').toBe(false)
    expect(existsSync(join(pgdata, 'log')), 'the canonical path was created').toBe(false)
    expect(readdirSync(pgdata).sort(), 'the fixture listing changed').toEqual(before)
    expect(before).toEqual(['PG_VERSION'])
  })

  it('refuses even a caller-supplied path that happens to equal LOG_DIR', () => {
    // Arity, not equality. Accepting the "right" path from a caller would keep
    // the seam open for the wrong one.
    const pgdata = fixture('confinement-equal')
    const r = runHelper(pgdata, { argv: join(pgdata, 'log') })
    expect(r.status, 'a caller-supplied path was accepted because it matched').not.toBe(0)
    expect(r.stderr).toMatch(/takes no arguments/)
    expect(existsSync(join(pgdata, 'log')), 'the directory was created anyway').toBe(false)
  })

  it('the production call passes zero arguments', () => {
    const src = read(PROVISION_PATH)
    const calls = commands(src).split('\n')
      // `prepare_log_directory() {` also starts with the name; the definition
      // is not a call.
      .filter(l => /^\s*prepare_log_directory\b/.test(l) && !/\(\)\s*\{/.test(l))
    expect(calls.length, 'the helper is not called exactly once').toBe(1)
    expect(calls[0].trim(), 'the production call passes an argument').toBe('prepare_log_directory')
  })

  it('the arity guard precedes mkdir in executable code', () => {
    // Ordering inside the helper is the property: a guard after mkdir would be
    // the defect this order corrects.
    const body = commands(helperSource()).split('\n')
    const guard = body.findIndex(l => /"\$#" -eq 0/.test(l))
    const mk = body.findIndex(l => /mkdir/.test(l))
    expect(guard, 'there is no arity guard').toBeGreaterThan(-1)
    expect(mk, 'the helper does not create anything').toBeGreaterThan(-1)
    expect(guard, 'the arity guard runs after mkdir').toBeLessThan(mk)
    // ...and the path is bound from the constant, not from a parameter.
    expect(helperSource()).toMatch(/local dir="\$\{LOG_DIR\}"/)
    expect(commands(helperSource()), 'the helper still reads a positional parameter')
      .not.toMatch(/local dir="\$1"/)
  })

  // ── Ordering and wiring in the production script ──────────────────────────

  it('prepares the directory BEFORE the pg_ctl start, and after the config install', () => {
    const src = read(PROVISION_PATH)
    const start = src.indexOf('run_apply() {')
    // COMMANDS, NOT COMMENTS. `prepare_log_directory` is named in the comment
    // that explains it, several lines ABOVE the call — so a raw line search
    // finds the prose and reports the right order even when the call has been
    // moved after pg_ctl. A mutation that did exactly that survived this test
    // until the body was stripped of comments first.
    const body = commands(src.slice(start, src.indexOf('\nmain() {', start)))
    const at = (re: RegExp): number => {
      const i = body.split('\n').findIndex(l => re.test(l))
      expect(i, `no command line matched ${re}`).toBeGreaterThan(-1)
      return i
    }
    expect(at(/\$\{INITDB\}/)).toBeLessThan(at(/install -m 600 "\$\{HBA_SRC\}"/))
    expect(at(/install -m 600 "\$\{HBA_SRC\}"/)).toBeLessThan(at(/^\s*prepare_log_directory\s*$/))
    expect(at(/^\s*prepare_log_directory\s*$/)).toBeLessThan(at(/\$\{PG_CTL\}.*start/))
  })

  it('points pg_ctl at exactly the prepared directory', () => {
    const src = read(PROVISION_PATH)
    expect(src).toMatch(/readonly LOG_DIR="\$\{PGDATA_ROOT\}\/log"/)
    expect(src).toMatch(/^\s*prepare_log_directory\s*$/m)
    expect(src).toMatch(/"\$\{PG_CTL\}" -D "\$\{PGDATA_ROOT\}" -l "\$\{LOG_DIR\}\/pg_ctl\.log" -w -t 60 start/)
    // The destination is unchanged from the reviewed design.
    expect(src).not.toMatch(/-l "\$\{PGDATA_ROOT\}\/log\/pg_ctl\.log"/)
  })

  it('never uses mkdir -p for the log directory', () => {
    // -p silently accepts whatever is already there. The fresh-run contract
    // says nothing is.
    expect(commands(helperSource())).not.toMatch(/mkdir\s+-p/)
    expect(helperSource()).toMatch(/mkdir -m 700 "\$\{dir\}"/)
  })

  it('validates what was created rather than trusting mkdir', () => {
    const h = helperSource()
    // -L before -d: [ -d symlink_to_dir ] follows the link and reports true.
    expect(h.indexOf('-L "${dir}"')).toBeGreaterThan(-1)
    expect(h.indexOf('! -L "${dir}"')).toBeLessThan(h.indexOf('-d "${dir}"'))
    for (const check of [/-d "\$\{dir\}"/, /%Su/, /%Lp/]) {
      expect(h, `the helper omits ${check}`).toMatch(check)
    }
  })
})
