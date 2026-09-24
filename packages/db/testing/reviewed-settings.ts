// The ONE authority for the two host-derived settings the expected target fixes.
//
// THE DEFECT THIS EXISTS TO CLOSE. `REVIEWED_TARGET_SETTINGS` in
// src/pg-copy/schema-contract.ts named `timezone` and `default_text_search_config`
// as TypeScript literals. The values a real V3 cluster runs with come from
// ops/clusters/ai-capital-v3/postgresql.conf.d/ai-capital-v3.conf, which
// provision.sh installs verbatim. Two independent literals for one value is how
// the expected-target artifact and the production cluster drift apart with
// nothing to notice: the contract would keep passing against a target nobody
// operates.
//
// So the canonical file is PARSED, the parsed values are what the disposable
// expected-target database is built with, and the TypeScript constants are
// re-checked against them. Either half moving alone is a failure, not a merge.
//
// WHY A STRICT PARSER RATHER THAN A GREP. postgresql.conf uses the last active
// assignment when a key appears more than once. This parser refuses duplicates
// because a reviewed value must not depend on file order. `#` starts a comment
// outside a quoted string, and a value may be quoted or bare. A grep that
// matched the commented-out line, one of two assignments, or a half-quoted
// value would report agreement that does not exist. Every one of those shapes
// is refused here rather than resolved, because this file has exactly one
// reviewed spelling and anything else means someone edited it without reading
// this comment.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REVIEWED_TARGET_SETTINGS } from '../src/pg-copy/schema-contract.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT_FOR_CONF = resolve(HERE, '..', '..', '..')

/** provision.sh installs THIS file verbatim. There is no second copy. */
export const CANONICAL_CONF_PATH = join(
  REPO_ROOT_FOR_CONF, 'ops', 'clusters', 'ai-capital-v3',
  'postgresql.conf.d', 'ai-capital-v3.conf')

/**
 * The canonical key for each reviewed setting.
 *
 * GUC names are case-insensitive: the file spells it `timezone`, the server
 * reports it as `TimeZone`, and `ALTER DATABASE … SET` accepts either. The
 * mapping is stated once, here, so neither spelling can be mistaken for a
 * second setting.
 */
export const CONF_KEY_FOR_SETTING: Readonly<Record<string, string>> = Object.freeze({
  TimeZone: 'timezone',
  default_text_search_config: 'default_text_search_config',
})

export class ReviewedSettingsRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReviewedSettingsRefused'
  }
}

/** One active `key = value` assignment, with the line it was found on. */
export interface ConfAssignment {
  readonly key: string
  readonly value: string
  readonly line: number
}

/**
 * Every ACTIVE assignment in a postgresql.conf fragment, comments removed.
 *
 * Refuses a line that opens a single-quoted value and never closes it. A
 * half-quoted value is the one shape where "ignore what follows" and "this is
 * part of the value" give different answers, and guessing between them is how a
 * parser silently reads a different configuration than the server does.
 */
export function parseConfAssignments(text: string): ConfAssignment[] {
  const found: ConfAssignment[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    // Strip a comment, honouring single quotes and the '' escape.
    let code = ''
    let inQuote = false
    for (let j = 0; j < raw.length; j++) {
      const ch = raw[j]
      if (ch === "'") {
        if (inQuote && raw[j + 1] === "'") { code += "''"; j++; continue }
        inQuote = !inQuote
        code += ch
        continue
      }
      if (ch === '#' && !inQuote) break
      code += ch
    }
    if (inQuote) {
      throw new ReviewedSettingsRefused(
        `${CANONICAL_CONF_PATH}:${i + 1}: unterminated quoted value: ${raw.trim()}`)
    }
    const trimmed = code.trim()
    if (trimmed === '') continue
    const m = /^([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!m) {
      throw new ReviewedSettingsRefused(
        `${CANONICAL_CONF_PATH}:${i + 1}: not a setting assignment: ${trimmed}`)
    }
    const rhs = m[2].trim()
    if (rhs === '') {
      throw new ReviewedSettingsRefused(
        `${CANONICAL_CONF_PATH}:${i + 1}: ${m[1]} has an empty value.`)
    }
    let value: string
    if (rhs.startsWith("'")) {
      if (!rhs.endsWith("'") || rhs.length < 2) {
        throw new ReviewedSettingsRefused(
          `${CANONICAL_CONF_PATH}:${i + 1}: ${m[1]} has a malformed quoted value: ${rhs}`)
      }
      value = rhs.slice(1, -1).replace(/''/g, "'")
    } else {
      if (rhs.includes("'")) {
        throw new ReviewedSettingsRefused(
          `${CANONICAL_CONF_PATH}:${i + 1}: ${m[1]} mixes a bare and a quoted value: ${rhs}`)
      }
      value = rhs
    }
    found.push({ key: m[1].toLowerCase(), value, line: i + 1 })
  }
  return found
}

/** The value of exactly ONE active assignment of `key`, or a refusal. */
export function requireSingleAssignment(
  assignments: readonly ConfAssignment[], key: string,
): string {
  const hits = assignments.filter(a => a.key === key.toLowerCase())
  if (hits.length === 0) {
    throw new ReviewedSettingsRefused(
      `${CANONICAL_CONF_PATH} has no active assignment for "${key}". The expected target ` +
      'cannot be built from a value nobody reviewed.')
  }
  if (hits.length > 1) {
    throw new ReviewedSettingsRefused(
      `${CANONICAL_CONF_PATH} has ${hits.length} active assignments for "${key}" ` +
      `(lines ${hits.map(h => h.line).join(', ')}). postgresql.conf takes the LAST one, ` +
      'which makes the reviewed value a question of file order rather than of review.')
  }
  return hits[0].value
}

/**
 * The reviewed settings, READ FROM THE CANONICAL FILE and reconciled with the
 * published constants. Disagreement in either direction is a refusal.
 */
export function reviewedTargetSettings(
  confText: string = readFileSync(CANONICAL_CONF_PATH, 'utf-8'),
  expected: Readonly<Record<string, string>> = REVIEWED_TARGET_SETTINGS,
): Record<string, string> {
  const assignments = parseConfAssignments(confText)
  const out: Record<string, string> = {}
  const settingNames = Object.keys(expected)
  const mappedNames = Object.keys(CONF_KEY_FOR_SETTING)
  // NON-VACUITY: a constant nobody mapped would be silently unchecked.
  for (const name of settingNames) {
    if (!mappedNames.includes(name)) {
      throw new ReviewedSettingsRefused(
        `REVIEWED_TARGET_SETTINGS names "${name}", which has no canonical configuration key. ` +
        'Every reviewed setting must be traceable to the file provision.sh installs.')
    }
  }
  for (const name of mappedNames) {
    if (!settingNames.includes(name)) {
      throw new ReviewedSettingsRefused(
        `CONF_KEY_FOR_SETTING maps "${name}", which REVIEWED_TARGET_SETTINGS does not declare.`)
    }
  }
  for (const name of settingNames) {
    const value = requireSingleAssignment(assignments, CONF_KEY_FOR_SETTING[name])
    if (value !== expected[name]) {
      throw new ReviewedSettingsRefused(
        `${CANONICAL_CONF_PATH} sets ${CONF_KEY_FOR_SETTING[name]} = "${value}" but ` +
        `REVIEWED_TARGET_SETTINGS.${name} is "${expected[name]}". The expected-target artifact ` +
        'would describe a cluster nobody operates.')
    }
    out[name] = value
  }
  return out
}
