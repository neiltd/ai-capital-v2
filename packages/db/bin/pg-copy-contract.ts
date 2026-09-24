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
  canonicalJson, extractContractFromSession, parseArtifact, pgTextArray, serializeArtifact,
  type ContractArtifact,
} from '../src/pg-copy/schema-contract.js'
import { startDisposableCluster, type DisposableCluster } from '../testing/disposable-cluster.js'
import { openPsqlSession } from '../testing/psql-session.js'
import { buildV19Database } from '../testing/v19-database.js'

export { pgTextArray }

export const EXIT_OK = 0
export const EXIT_DRIFT = 1
export const EXIT_REFUSED = 2

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ARTIFACT_PATH = join(PKG_ROOT, 'contracts', 'expected-target-v19.json')

/**
 * The transaction Stage 1 runs in, and the one this generator runs in too.
 *
 * Generating the committed artifact through a DIFFERENT reader than the copy
 * uses would make the artifact a claim about a reader nobody runs. One
 * primitive, one transaction shape, both paths.
 */
export const EXTRACTION_BEGIN_SQL =
  'BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ'

/**
 * Read the whole contract from one database, on ONE backend inside ONE
 * READ ONLY REPEATABLE READ transaction.
 *
 * This wrapper owns the transaction; `extractContractFromSession` never begins
 * or ends one. The rollback is unconditional: the transaction read nothing it
 * could write, and leaving it open would hold a snapshot after the caller is
 * done with it.
 */
export async function extractContract(
  c: DisposableCluster, database: string,
): Promise<ContractArtifact> {
  const session = await openPsqlSession(c, database)
  try {
    await session.must(EXTRACTION_BEGIN_SQL)
    const artifact = await extractContractFromSession(session, session.pid)
    await session.must('ROLLBACK')
    return artifact
  } finally {
    await session.close()
  }
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
