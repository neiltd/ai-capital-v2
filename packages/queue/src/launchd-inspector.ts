// INSPECT AN INSTALLED PLIST, AND FAIL IF IT IS UNSAFE.
//
// TWO CORRECTIONS OVER ROUND 1, both of which mattered.
//
// 1. IT PARSES, IT DOES NOT SCAN. Regexes over XML cannot tell a <key> inside a
//    comment from a real one, so a plist containing
//    `<!-- <key>Label</key><string>innocent</string> -->` reported whatever the
//    comment said. The parsed object is what launchd actually reads, and a
//    comment contributes nothing to it.
//
// 2. IT IS A GATE. Round 1 always returned 0, so "the inspector passed" meant
//    only that it ran. A blocking finding now exits non-zero.
//
// AND AN HONEST CLAIM ABOUT WHAT IT HOLDS. The earlier comment said values are
// "never read into memory", which was false — the file is read and parsed, so
// every value is in memory by definition. The guarantee is narrower and is the
// one that matters: no environment VALUE reaches the report or the output. The
// code keeps values out of `findings` entirely, so there is nothing to redact.

export interface PlistFindings {
  label: string | null
  /** Program arguments, with any credential-shaped element SUPPRESSED. */
  programArguments: string[]
  /** True when at least one argument was suppressed. */
  suppressedArguments: number
  environmentKeys: string[]
  hasForbiddenCredentialKey: boolean
  hasUnresolvedPlaceholder: boolean
  hasPostgresUrlLiteral: boolean
}

export const FORBIDDEN_ENV_KEY = /^(DATABASE_URL|[A-Za-z_]*_DATABASE_URL|PG[A-Za-z0-9_]*)$/i
export const POSTGRES_URL = /postgres(ql)?:\/\//i
export const PLACEHOLDER = /@@[A-Z0-9_]+@@/

/** Decode the entity forms a plist may carry, so they cannot hide a URL. */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function credentialShaped(value: string): boolean {
  return POSTGRES_URL.test(decodeXmlEntities(value))
}

/**
 * Derive findings from the PARSED plist.
 *
 * @param parsed the object `plutil -convert json` produced
 */
export function inspectParsedPlist(parsed: unknown): PlistFindings {
  const root = parsed as Record<string, unknown> | null
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('the plist did not parse as a dictionary')
  }

  const label = typeof root.Label === 'string' ? root.Label : null

  const rawArgs = Array.isArray(root.ProgramArguments) ? root.ProgramArguments : []
  const programArguments: string[] = []
  let suppressedArguments = 0
  for (const arg of rawArgs) {
    const text = typeof arg === 'string' ? arg : String(arg)
    // A credential-shaped argument is never printed: the report exists to say
    // that something is wrong, not to hand the reader the secret.
    if (credentialShaped(text)) { suppressedArguments += 1; continue }
    programArguments.push(text)
  }

  const envRaw = root.EnvironmentVariables
  const env: Record<string, unknown> =
    envRaw !== null && typeof envRaw === 'object' && !Array.isArray(envRaw)
      ? envRaw as Record<string, unknown>
      : {}
  const environmentKeys = Object.keys(env)

  // Values are examined, never retained. Nothing below stores one.
  let hasPostgresUrlLiteral = suppressedArguments > 0
  let hasUnresolvedPlaceholder = false
  for (const value of Object.values(env)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (credentialShaped(text)) hasPostgresUrlLiteral = true
    if (PLACEHOLDER.test(text)) hasUnresolvedPlaceholder = true
  }
  for (const arg of rawArgs) {
    if (typeof arg === 'string' && PLACEHOLDER.test(arg)) hasUnresolvedPlaceholder = true
  }
  if (typeof root.Label === 'string' && PLACEHOLDER.test(root.Label)) hasUnresolvedPlaceholder = true

  return {
    label,
    programArguments,
    suppressedArguments,
    environmentKeys,
    hasForbiddenCredentialKey: environmentKeys.some(k => FORBIDDEN_ENV_KEY.test(k)),
    hasUnresolvedPlaceholder,
    hasPostgresUrlLiteral,
  }
}

/** True when any finding should make the inspector exit non-zero. */
export function hasBlockingFinding(f: PlistFindings): boolean {
  return f.hasForbiddenCredentialKey || f.hasPostgresUrlLiteral || f.hasUnresolvedPlaceholder
}

/** Render findings as report lines. No value ever enters this output. */
export function formatFindings(f: PlistFindings): string[] {
  return [
    `label:                     ${f.label ?? '(none)'}`,
    `program:                   ${f.programArguments.join(' ')}`,
    `suppressed arguments:      ${f.suppressedArguments}`,
    `environment keys:          ${f.environmentKeys.join(', ') || '(none)'}`,
    `forbidden credential key:  ${f.hasForbiddenCredentialKey}`,
    `unresolved placeholder:    ${f.hasUnresolvedPlaceholder}`,
    `postgres URL literal:      ${f.hasPostgresUrlLiteral}`,
  ]
}
