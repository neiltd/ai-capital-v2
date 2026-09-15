// RENDERING A LAUNCHD PLIST — AND NEVER A SECRET.
//
// This tool substitutes three kinds of value: a repository path, an
// unauthenticated Redis endpoint, and the PATH of a credential file. It never
// handles a credential, and it REFUSES to: a template carrying a credential
// placeholder, or output containing a PostgreSQL URL literal or a forbidden
// database key, fails before anything is published. "No secret reached a plist"
// is therefore a property the tests enforce, not a procedure people follow.
//
// The earlier `sed`-based instructions were removed rather than fixed. Passing a
// value through command arguments exposes it in the process table, and `sed`
// mishandles `&`, `|`, backslashes and the XML-sensitive characters `& < >`,
// which can silently alter what it substitutes. Substitution here is literal —
// no regular-expression replacement text is ever interpreted.

import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type AgentName = 'worker' | 'structured-worker' | 'daily' | 'watchdog' | 'alerts'

/** Everything an agent is allowed to have substituted, and how many times. */
export interface AgentContract {
  label: string
  template: string
  /** placeholder name -> exact number of occurrences the template must contain */
  placeholders: Readonly<Record<string, number>>
}

/**
 * The exact per-agent contract. An allowlist of NAMES, not a pattern: a rule
 * like "reject anything containing CREDENTIAL" would reject
 * PIPELINE_CREDENTIAL_FILE, which is a path and is required, while a rule like
 * "allow anything" is how a credential placeholder returns. Counts are pinned so
 * a template drifting from N to N+1 occurrences fails loudly instead of
 * half-rendering.
 */
export const AGENTS: Readonly<Record<AgentName, AgentContract>> = Object.freeze({
  worker: {
    label: 'com.thanapol.ai-capital.worker',
    template: 'com.thanapol.ai-capital.worker.plist.template',
    placeholders: { AI_CAPITAL_ROOT: 6, REDIS_URL: 1, PIPELINE_CREDENTIAL_FILE: 1 },
  },
  'structured-worker': {
    label: 'com.thanapol.ai-capital.structured-worker',
    template: 'com.thanapol.ai-capital.structured-worker.plist.template',
    placeholders: { AI_CAPITAL_ROOT: 6, REDIS_URL: 1, PIPELINE_CREDENTIAL_FILE: 1 },
  },
  daily: {
    label: 'com.thanapol.ai-capital.daily',
    template: 'com.thanapol.ai-capital.daily.plist.template',
    placeholders: { AI_CAPITAL_ROOT: 8, REDIS_URL: 1 },
  },
  watchdog: {
    label: 'com.thanapol.ai-capital.watchdog',
    template: 'com.thanapol.ai-capital.watchdog.plist.template',
    placeholders: { AI_CAPITAL_ROOT: 8, REDIS_URL: 1 },
  },
  alerts: {
    label: 'com.thanapol.ai-capital.alerts',
    template: 'com.thanapol.ai-capital.alerts.plist.template',
    placeholders: { AI_CAPITAL_ROOT: 5, PIPELINE_CREDENTIAL_FILE: 1 },
  },
})

/** Placeholder names that may never appear in any template. */
export const FORBIDDEN_PLACEHOLDERS = Object.freeze(['PIPELINE_DATABASE_URL', 'DATABASE_URL'])

/** plist keys that must never appear in rendered output. Case-insensitive: an
 *  environment variable is matched by launchd exactly, but a near-miss spelling
 *  in a template is a mistake worth refusing rather than rendering. */
export const FORBIDDEN_PLIST_KEYS = /<key>\s*(DATABASE_URL|[A-Za-z_]*_DATABASE_URL|PG[A-Za-z0-9_]*)\s*<\/key>/i

/** The environment-key form of the same rule, applied to PARSED keys. */
export const FORBIDDEN_ENV_KEY = /^(DATABASE_URL|[A-Za-z_]*_DATABASE_URL|PG[A-Za-z0-9_]*)$/i

/** A PostgreSQL URL literal in output means a credential leaked into a plist.
 *  Case-insensitive: `POSTGRES://` is the same URL to libpq. */
export const POSTGRES_URL_LITERAL = /postgres(ql)?:\/\//i

/** The one installed destination per agent. There is no arbitrary --out. */
export function installedPath(agent: AgentName, home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${AGENTS[agent].label}.plist`)
}

/** XML text escaping. All five, always — a path may legitimately contain any. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Count of `@@NAME@@` occurrences, by name. */
export function placeholderCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const m of text.matchAll(/@@([A-Z0-9_]+)@@/g)) {
    counts[m[1]] = (counts[m[1]] ?? 0) + 1
  }
  return counts
}

/**
 * Structural validation of an UNAUTHENTICATED Redis URL.
 *
 * Any authentication material makes REDIS_URL a secret, and a secret may not be
 * rendered into a plist — that is a separate design decision, not something this
 * tool may quietly accommodate.
 */
export function validateRedisUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('REDIS_URL is not a valid URL.')
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use the redis: or rediss: scheme.')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      'REDIS_URL carries authentication material, which makes it a secret. ' +
      'A secret must not be rendered into a plist; handling it requires a separate ' +
      'design decision. The value is not reported.',
    )
  }
  if (url.hostname === '') throw new Error('REDIS_URL must state an explicit host.')
  if (url.hash !== '') throw new Error('REDIS_URL must not contain a fragment.')
  if (url.search !== '') {
    throw new Error('REDIS_URL must not contain query parameters; a parameter can carry a token.')
  }
  if (url.port !== '') {
    const port = Number(url.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('REDIS_URL has an invalid port.')
  }
  return raw
}

export interface RenderInput {
  agent: AgentName
  templateDir: string
  values: Record<string, string>
}

/**
 * Produce the rendered plist text, or throw. Pure: touches no destination.
 */
export function renderPlist(input: RenderInput): string {
  const contract = AGENTS[input.agent]
  if (contract === undefined) throw new Error(`unknown agent: ${String(input.agent)}`)

  const template = readFileSync(join(input.templateDir, contract.template), 'utf-8')
  const found = placeholderCounts(template)

  for (const name of FORBIDDEN_PLACEHOLDERS) {
    if (found[name] !== undefined) {
      throw new Error(
        `template ${contract.template} contains the forbidden placeholder @@${name}@@. ` +
        'A credential value is never rendered into a plist.',
      )
    }
  }
  for (const [name, expected] of Object.entries(contract.placeholders)) {
    const actual = found[name] ?? 0
    if (actual !== expected) {
      throw new Error(
        `template ${contract.template} must contain @@${name}@@ exactly ${expected} time(s); found ${actual}.`,
      )
    }
  }
  for (const name of Object.keys(found)) {
    if (!(name in contract.placeholders)) {
      throw new Error(`template ${contract.template} contains an unexpected placeholder @@${name}@@.`)
    }
  }
  for (const name of Object.keys(contract.placeholders)) {
    if (input.values[name] === undefined) throw new Error(`no value supplied for @@${name}@@.`)
  }
  for (const name of Object.keys(input.values)) {
    if (!(name in contract.placeholders)) {
      throw new Error(`value supplied for @@${name}@@, which ${contract.template} does not use.`)
    }
  }

  if ('REDIS_URL' in contract.placeholders) validateRedisUrl(input.values.REDIS_URL)

  let out = template
  for (const [name, value] of Object.entries(input.values)) {
    // Literal split/join: no regular-expression replacement text, so `$&` and
    // friends in a path cannot be interpreted.
    out = out.split(`@@${name}@@`).join(escapeXml(value))
  }

  assertRenderedOutputIsSafe(out)
  return out
}

/** Output-side guard. Cheap, and a construction argument is not evidence. */
export function assertRenderedOutputIsSafe(text: string): void {
  const residual = text.match(/@@[A-Z0-9_]+@@/)
  if (residual) throw new Error(`rendered output still contains ${residual[0]}.`)
  const key = text.match(FORBIDDEN_PLIST_KEYS)
  if (key) throw new Error(`rendered output contains the forbidden key ${key[0]}.`)
  // Entity-aware: `&#112;ostgres://…` is the same string once a plist parser
  // decodes it, so the raw text alone is not a sufficient test.
  if (looksLikePostgresUrl(text)) {
    throw new Error('rendered output contains a PostgreSQL URL literal. The value is not reported.')
  }
}

/** plist validation, injected so a lint failure is testable without plutil. */
export interface LintSeam { lint: (p: string) => { status: number | null; stderr: string } }

export const defaultLintSeam: LintSeam = {
  lint: (p) => {
    // argv array, shell:false. No string is handed to a shell.
    const r = spawnSync('/usr/bin/plutil', ['-lint', p], { shell: false, encoding: 'utf-8' })
    return { status: r.status, stderr: r.stderr ?? '' }
  },
}

/** Parse a plist into a plain object using plutil, which is a real parser. */
export interface ParseSeam {
  toJson: (p: string) => { status: number | null; stdout: string; stderr: string }
}

export const defaultParseSeam: ParseSeam = {
  toJson: (p) => {
    const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', p], { shell: false, encoding: 'utf-8' })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  },
}

/**
 * SEMANTIC validation of the parsed plist.
 *
 * A raw regex over XML is not a safety boundary: it is case-sensitive, it cannot
 * see `&#112;ostgres://`, and it cannot tell a value from a comment. This parses
 * what launchd will actually read and inspects the real EnvironmentVariables
 * dictionary. No parsed value is ever written to stdout or stderr.
 */
export function assertParsedPlistIsSafe(parsed: unknown): void {
  const root = parsed as Record<string, unknown> | null
  if (root === null || typeof root !== 'object') throw new Error('rendered plist did not parse as a dictionary.')

  const env = root.EnvironmentVariables
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null) throw new Error('EnvironmentVariables is not a dictionary.')
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (FORBIDDEN_ENV_KEY.test(key)) {
        throw new Error(`rendered plist declares the forbidden environment key ${key}.`)
      }
      if (typeof value !== 'string') throw new Error(`environment key ${key} is not a string.`)
      if (looksLikePostgresUrl(value)) {
        throw new Error(`environment key ${key} holds a PostgreSQL URL. The value is not reported.`)
      }
      if (/@@[A-Z0-9_]+@@/.test(value)) {
        throw new Error(`environment key ${key} still contains an unresolved placeholder.`)
      }
    }
  }

  for (const arg of Array.isArray(root.ProgramArguments) ? root.ProgramArguments : []) {
    if (typeof arg === 'string' && looksLikePostgresUrl(arg)) {
      throw new Error('a ProgramArgument holds a PostgreSQL URL. The value is not reported.')
    }
  }
}

/** Case-insensitive, entity-aware detection of a PostgreSQL URL. */
export function looksLikePostgresUrl(value: string): boolean {
  return POSTGRES_URL_LITERAL.test(decodeXmlEntities(value))
}

/** Decode the entity forms a plist may legally carry, so they cannot hide a URL. */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
