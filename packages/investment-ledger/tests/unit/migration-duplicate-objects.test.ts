import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// DUPLICATE OBJECT NAMES — no database connection anywhere in this file.
//
// THE DEFECT THIS EXISTS FOR. 013 created `idx_reconciliation_case_events_case`
// TWICE: once on (workspace_id, case_id, id) and again on (case_id, id). On a
// fresh database the second CREATE INDEX raises 42P07 "relation already
// exists", the migration's transaction rolls back, and NOTHING from 013 onward
// applies. Review read past it twice because the two statements were four lines
// apart and differed only in their column list.
//
// A human cannot reliably diff a 500-line DDL file against itself. This can.

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = resolve(HERE, '..', '..', '..', 'db', 'migrations')
const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()

/**
 * Reduce SQL to the text a duplicate-name check may reason about.
 *
 * A one-pass scanner rather than a chain of regexes, because the three things
 * being removed can contain each other: a `--` inside a string literal is not a
 * comment, and a dollar-quoted body contains both. Dollar-quoted bodies go
 * because the DO blocks in 012 and 017 build object names with
 * `EXECUTE format(...)` at RUNTIME, once per table — those are not static
 * declarations and counting them would produce noise, not findings.
 */
function statementsOnly(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {                    // line comment
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl
      continue
    }
    if (sql.startsWith('/*', i)) {                    // block comment
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      continue
    }
    if (sql[i] === "'") {                             // string literal
      i++
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
        if (sql[i] === "'") { i++; break }
        i++
      }
      out += "''"
      continue
    }
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i))
    if (dollar) {                                     // dollar-quoted body
      const tag = dollar[0]
      const end = sql.indexOf(tag, i + tag.length)
      i = end === -1 ? sql.length : end + tag.length
      out += ' $BODY$ '
      continue
    }
    out += sql[i]
    i++
  }
  return out
}

/**
 * Objects whose name is unique per SCHEMA. Two CREATEs of the same name in one
 * database is always an error, whichever file they are in.
 */
const SCHEMA_SCOPED = /\bCREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TYPE|SCHEMA|FUNCTION)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w.]*)/gi

/**
 * Objects whose name is unique per TABLE. `authority_read` on six identity
 * tables and `actor_is_authorized` on seventeen ledger tables are correct and
 * deliberate, so the identity of these is (name, table).
 */
const TABLE_SCOPED = /\bCREATE\s+(POLICY|TRIGGER)\s+([A-Za-z_]\w*)[\s\S]{0,80}?\bON\s+([A-Za-z_][\w.]*)/gi

interface Decl { kind: string; name: string; file: string }

function schemaScoped(file: string): Decl[] {
  const out: Decl[] = []
  for (const m of statementsOnly(readFileSync(join(DIR, file), 'utf-8')).matchAll(SCHEMA_SCOPED)) {
    // `CREATE SCHEMA IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS` are
    // idempotent by construction; only unguarded creates can collide.
    if (/IF\s+NOT\s+EXISTS/i.test(m[0])) continue
    out.push({ kind: m[1].toUpperCase().replace(/\s+/g, ' '), name: m[2].toLowerCase(), file })
  }
  return out
}

function tableScoped(file: string): Decl[] {
  const out: Decl[] = []
  for (const m of statementsOnly(readFileSync(join(DIR, file), 'utf-8')).matchAll(TABLE_SCOPED)) {
    out.push({ kind: m[1].toUpperCase(), name: `${m[2].toLowerCase()} ON ${m[3].toLowerCase()}`, file })
  }
  return out
}

describe('no migration creates the same object name twice', () => {
  it.each(files)('%s declares each schema-scoped object once', file => {
    const seen = new Map<string, number>()
    for (const d of schemaScoped(file)) {
      const key = `${d.kind} ${d.name}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    const dupes = [...seen].filter(([, n]) => n > 1)
    // A duplicate here is not a style issue: the second statement raises 42P07
    // and rolls the whole migration back.
    expect(dupes, `${file} creates these more than once`).toEqual([])
  })

  it.each(files)('%s declares each policy and trigger once per table', file => {
    const seen = new Map<string, number>()
    for (const d of tableScoped(file)) {
      const key = `${d.kind} ${d.name}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    expect([...seen].filter(([, n]) => n > 1), `${file} creates these more than once`).toEqual([])
  })

  it('no schema-scoped name is created by two different migrations either', () => {
    const owner = new Map<string, string>()
    const clashes: string[] = []
    for (const file of files) {
      for (const d of schemaScoped(file)) {
        const key = `${d.kind} ${d.name}`
        const first = owner.get(key)
        if (first) clashes.push(`${key}: ${first} and ${file}`)
        else owner.set(key, file)
      }
    }
    expect(clashes).toEqual([])
  })

  it('is not vacuous: it sees the objects that are really there', () => {
    const ledger = schemaScoped('013_investment_ledger.sql')
    expect(ledger.filter(d => d.kind === 'TABLE').length).toBe(15)
    expect(ledger.filter(d => d.kind === 'INDEX').map(d => d.name)).toContain(
      'idx_reconciliation_case_events_case')
    const views = schemaScoped('017_ledger_views_rls_grants.sql').filter(d => d.kind === 'VIEW')
    expect(views.length).toBe(9)
  })

  it('would FAIL on the exact defect it was written for', () => {
    // The regression, reconstructed literally: the same index name, twice.
    const injected = `
      CREATE INDEX idx_x ON investment_ledger.t(workspace_id, a);
      CREATE INDEX idx_x ON investment_ledger.t(a);
    `
    const found = [...statementsOnly(injected).matchAll(SCHEMA_SCOPED)].map(m => m[2].toLowerCase())
    expect(found).toEqual(['idx_x', 'idx_x'])
    expect(new Set(found).size).toBe(1)   // i.e. the checker above reports a dupe
  })
})
