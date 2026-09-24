#!/usr/bin/env node
// Generate or CHECK the expected-target V19 schema contract.
//
// INERT ON IMPORT. Nothing runs until `isDirectEntrypoint` says this module IS
// the process entry point, so the tests can import and assert its shape rather
// than execute it.
//
// TWO MODES, AND ONLY ONE OF THEM WRITES:
//
//   --generate   build a fresh disposable PostgreSQL 17 cluster, apply
//                migrations 001-019 through the repository's own runner,
//                extract the contract and WRITE the committed artifact.
//   --check      do the same extraction and compare the result with the
//                committed artifact WITHOUT touching it. Exits non-zero on any
//                difference and prints a bounded, secret-free diff.
//
// `--check` NEVER REWRITES. A check that repairs what it is checking reports
// success forever; this one has no write path at all outside `--generate`.

import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COPY_SEQUENCES, COPY_TABLES, CONTRACT_PRELUDE, COLUMNS_SQL, CONSTRAINTS_SQL,
  DROPPED_COLUMNS_SQL, EXTENSIONS_SQL, INDEXES_SQL, MIGRATIONS_SQL, PLATFORM_SQL,
  RELATIONS_SQL, SEQUENCES_SQL, TRIGGERS_SQL,
  buildContract, canonicalJson, parseArtifact, serializeArtifact,
  type ContractArtifact, type RawCatalog,
} from '../src/pg-copy/schema-contract.js'
import { startDisposableCluster, type DisposableCluster } from '../testing/disposable-cluster.js'
import { buildV19Database } from '../testing/v19-database.js'

export const EXIT_OK = 0
export const EXIT_DRIFT = 1
export const EXIT_REFUSED = 2

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ARTIFACT_PATH = join(PKG_ROOT, 'contracts', 'expected-target-v19.json')

/** A PostgreSQL text array literal, for `= ANY ($1)` without a bind parameter. */
export function pgTextArray(values: readonly string[]): string {
  return `'{${values.map(v => `"${v}"`).join(',')}}'::pg_catalog.text[]`
}

/** Read the whole contract from one database. One prelude, ten queries. */
export async function extractContract(
  c: DisposableCluster, database: string,
): Promise<ContractArtifact> {
  const tables = pgTextArray(COPY_TABLES)
  const seqs = pgTextArray(COPY_SEQUENCES)
  const q = async (sql: string, arg?: string): Promise<string[][]> =>
    c.rows(`${CONTRACT_PRELUDE} ${arg ? sql.replace('$1', arg) : sql}`, database)

  const raw: RawCatalog = {
    platform: await q(PLATFORM_SQL),
    extensions: await q(EXTENSIONS_SQL),
    migrations: await q(MIGRATIONS_SQL),
    relations: await q(RELATIONS_SQL, tables),
    columns: await q(COLUMNS_SQL, tables),
    droppedColumns: await q(DROPPED_COLUMNS_SQL, tables),
    constraints: await q(CONSTRAINTS_SQL, tables),
    indexes: await q(INDEXES_SQL, tables),
    triggers: await q(TRIGGERS_SQL, tables),
    sequences: await q(SEQUENCES_SQL, seqs),
  }
  return buildContract(raw)
}

/** Build a throwaway V19 database and extract its contract. */
export async function generateContract(): Promise<ContractArtifact> {
  const c = await startDisposableCluster()
  try {
    const db = 'expected_target_v19'
    await buildV19Database(c, db)
    return await extractContract(c, db)
  } finally {
    await c.stop()
  }
}

/** A bounded, secret-free description of where two artifacts differ. */
export function describeDrift(committed: ContractArtifact, fresh: ContractArtifact): string[] {
  const out: string[] = []
  if (committed.digest !== fresh.digest) {
    out.push(`digest: committed ${committed.digest}`)
    out.push(`        fresh     ${fresh.digest}`)
  }
  const a = canonicalJson(committed.payload).split(/(?<=[}\],])/)
  const b = canonicalJson(fresh.payload).split(/(?<=[}\],])/)
  let shown = 0
  for (let i = 0; i < Math.max(a.length, b.length) && shown < 12; i += 1) {
    if (a[i] !== b[i]) {
      out.push(`  fragment ${i}: committed ${JSON.stringify((a[i] ?? '').slice(0, 160))}`)
      out.push(`  fragment ${i}: fresh     ${JSON.stringify((b[i] ?? '').slice(0, 160))}`)
      shown += 1
    }
  }
  if (shown === 0 && committed.digest === fresh.digest) out.push('  (no difference)')
  return out
}

export interface RunResult { exitCode: number; lines: string[] }

export async function runCli(argv: string[]): Promise<RunResult> {
  const lines: string[] = []
  const say = (s: string): void => { lines.push(s) }
  const generate = argv.includes('--generate')
  const check = argv.includes('--check')
  const unknown = argv.filter(a => a !== '--generate' && a !== '--check')
  if (unknown.length > 0) {
    say(`unknown argument(s): ${unknown.join(', ')}`)
    say('usage: pg-copy-contract (--generate | --check)')
    return { exitCode: EXIT_REFUSED, lines }
  }
  if (generate === check) {
    say('exactly one of --generate or --check is required.')
    return { exitCode: EXIT_REFUSED, lines }
  }

  let fresh: ContractArtifact
  try {
    fresh = await generateContract()
  } catch (err) {
    say(err instanceof Error ? err.message : String(err))
    return { exitCode: EXIT_REFUSED, lines }
  }
  const bytes = serializeArtifact(fresh)

  if (generate) {
    writeFileSync(ARTIFACT_PATH, bytes, { encoding: 'utf-8', mode: 0o644 })
    say(`wrote ${ARTIFACT_PATH}`)
    say(`digest ${fresh.digest}`)
    return { exitCode: EXIT_OK, lines }
  }

  let committedText: string
  try {
    committedText = readFileSync(ARTIFACT_PATH, 'utf-8')
  } catch {
    say(`the committed contract is missing: ${ARTIFACT_PATH}`)
    return { exitCode: EXIT_DRIFT, lines }
  }
  let committed: ContractArtifact
  try {
    committed = parseArtifact(committedText)
  } catch (err) {
    say(err instanceof Error ? err.message : String(err))
    return { exitCode: EXIT_DRIFT, lines }
  }
  if (committedText === bytes) {
    say('expected-target contract matches the committed artifact.')
    say(`digest ${committed.digest}`)
    return { exitCode: EXIT_OK, lines }
  }
  say('DRIFT: the freshly generated contract differs from the committed artifact.')
  say(`  committed: ${ARTIFACT_PATH}`)
  for (const l of describeDrift(committed, fresh)) say(l)
  say('The committed artifact was NOT modified. Review the change, then re-run --generate.')
  return { exitCode: EXIT_DRIFT, lines }
}

export function isDirectEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  runCli(process.argv.slice(2))
    .then(r => { for (const l of r.lines) console.log(l); process.exit(r.exitCode) })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(EXIT_REFUSED)
    })
}
