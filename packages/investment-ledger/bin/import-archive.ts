#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getPool, closePool, usePostgres, withProductionWrite, assertPoolWriteAuthorized,
  withAuthorizedServiceWorkspaceTransaction,
} from '@common/db'
import { inspectArchive } from '../src/inspect.js'
import { publishArchive } from '../src/publish.js'
import { MASTER_ARCHIVE_SERIES, assertSeriesKey } from '../src/series.js'
import { assertWorkspaceId } from '../src/workspace.js'

export interface CliOptions {
  csv: string
  apply: boolean
  expectSha256: string | null
  series: string | null
  workspace: string | null
}

/**
 * Strict, fail-closed argument parsing.
 *
 * The previous parser was `argv[indexOf(name) + 1]`, so `--csv` with no value
 * silently returned `--apply` or `undefined` and fell back to a DEFAULT ARCHIVE
 * — an operator asking for one file could publish another. Unknown, duplicated
 * and valueless flags are now all rejected before anything is read.
 *
 * THERE IS NO DEFAULT ARCHIVE. `--csv` is mandatory in every mode. The previous
 * default was one developer's absolute path, so the command was unrunnable
 * elsewhere and, worse, an omitted `--csv` silently selected a real personal
 * archive. No path is inferred from HOME, the working directory, the repository
 * location, or any environment variable: the operator names the file or the
 * command refuses, before a byte is read and before any database is opened.
 */
export function parseArgs(argv: string[]): CliOptions {
  let csv: string | null = null
  let apply = false
  let expectSha256: string | null = null
  let series: string | null = null
  let workspace: string | null = null
  let sawApply = false

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    switch (token) {
      case '--apply': {
        if (sawApply) throw new Error('--apply given more than once')
        sawApply = true; apply = true; break
      }
      case '--csv': {
        if (csv !== null) throw new Error('--csv given more than once')
        const value = argv[index + 1]
        if (value === undefined) throw new Error('--csv requires a path')
        if (value.startsWith('--')) throw new Error(`--csv requires a path, got the flag '${value}'`)
        csv = value; index++; break
      }
      case '--expect-sha256': {
        if (expectSha256 !== null) throw new Error('--expect-sha256 given more than once')
        const value = argv[index + 1]
        if (value === undefined) throw new Error('--expect-sha256 requires a 64-character hex digest')
        if (!/^[0-9a-f]{64}$/.test(value)) {
          throw new Error(`--expect-sha256 must be 64 lowercase hex characters, got '${value}'`)
        }
        expectSha256 = value; index++; break
      }
      case '--workspace': {
        if (workspace !== null) throw new Error('--workspace given more than once')
        const value = argv[index + 1]
        if (value === undefined) throw new Error('--workspace requires a workspace UUID')
        if (value.startsWith('--')) {
          throw new Error(`--workspace requires a workspace UUID, got the flag '${value}'`)
        }
        // Validated here so a malformed workspace is rejected before a byte is
        // read, rather than deep inside publication.
        workspace = assertWorkspaceId(value); index++; break
      }
      case '--series': {
        if (series !== null) throw new Error('--series given more than once')
        const value = argv[index + 1]
        if (value === undefined) throw new Error('--series requires a series key')
        if (value.startsWith('--')) throw new Error(`--series requires a series key, got the flag '${value}'`)
        // Validated here, so a malformed series is rejected before any file is
        // read rather than deep inside publication.
        series = assertSeriesKey(value); index++; break
      }
      default:
        throw new Error(`unknown argument '${token}'`)
    }
  }
  // Mandatory, and checked AFTER the loop so `--csv` may appear in any position
  // — but still before main() reads a file or consults a database.
  if (csv === null) {
    throw new Error(
      '--csv <path> is required and has no default; name the archive explicitly ' +
      '(there is no fallback path, and none is inferred from the environment)',
    )
  }
  return { csv: resolve(csv), apply, expectSha256, series, workspace }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  // Structural validation only, and it reports COMPUTED FACTS about the file the
  // operator named — nothing is compared against a snapshot baked into this
  // package. There is deliberately no built-in notion of "the approved archive":
  // an internal expectation would have to embed the private record's digest and
  // totals in committed source, and it would also decide on the operator's
  // behalf which bytes are legitimate. Archive identity is asserted by the
  // OPERATOR, through --expect-sha256, at the moment of apply.
  const inspection = inspectArchive(options.csv)

  console.log(JSON.stringify({
    mode: options.apply ? 'apply' : 'inspect',
    csv: options.csv,
    series: options.series,
    workspace: options.workspace,
    sha256: inspection.sha256,
    rows: inspection.rows.length, logicalSourceFiles: inspection.logicalSourceFiles,
    currencyRows: inspection.currencyRows, cashFlowByCurrency: inspection.cashFlowByCurrency,
    missingAccounts: inspection.missingAccounts, missingNetAmounts: inspection.missingNetAmounts,
    exactDuplicateRows: inspection.exactDuplicateRows,
    multiRowReferenceGroups: inspection.multiRowReferenceGroups,
    switchGroups: inspection.switchGroupKeys.length,
    incompleteSwitchGroups: inspection.incompleteSwitchGroups,
    negativePositionKeys: inspection.negativePositionKeys,
    findings: inspection.findings.length,
  }, null, 2))

  if (!options.apply) {
    console.log('Inspection complete: the file is structurally valid. No database connection was opened.')
    console.log(
      'Use --apply only after independent verification, and pass both ' +
      '--expect-sha256 <digest> and --series <namespace:name>.',
    )
    return
  }

  // Every apply must name the exact bytes the operator inspected. There is no
  // default and no fallback: an omitted or stale digest is a hard failure. This
  // is the ONLY archive-identity gate, which is why it may not be skipped.
  if (!options.expectSha256) {
    throw new Error('--apply requires --expect-sha256 <digest> naming the exact inspected archive bytes')
  }
  if (options.expectSha256 !== inspection.sha256) {
    throw new Error(
      `refusing to publish: --expect-sha256 ${options.expectSha256} does not match the inspected archive ${inspection.sha256}`,
    )
  }

  // Every apply must also name the DATASET it revises. There is no default:
  // an unnamed series is how a fixture came to supersede the master archive.
  if (!options.series) {
    throw new Error(
      '--apply requires --series <namespace:name> naming the dataset this import revises ' +
      `(the historical master archive is '${MASTER_ARCHIVE_SERIES}')`,
    )
  }
  // Every apply must name the WORKSPACE it writes into. There is no default and
  // nothing is inferred from the connection: an import that does not know whose
  // ledger it is joining must not proceed.
  if (!options.workspace) {
    throw new Error(
      '--apply requires --workspace <uuid> naming the workspace this import belongs to',
    )
  }
  if (!usePostgres()) throw new Error('--apply requires DATABASE_URL; no fallback database is permitted')

  await withProductionWrite(
    {
      operation: 'investment-ledger-import', context: 'admin',
      reason: `Publish independently verified archive ${inspection.sha256} into series ${options.series}`,
    },
    async () => {
      const pool = getPool()
      assertPoolWriteAuthorized(pool, 'investment-ledger-import')
      // The workspace is authorized FIRST, from session_user against the live
      // grant table, and only then published as transaction-local context. The
      // actor principal is DERIVED by the database — the CLI cannot assert one.
      const result = await withAuthorizedServiceWorkspaceTransaction(
        options.workspace!, 'archive-import',
        async tx => publishArchive(
          tx as unknown as Parameters<typeof publishArchive>[0],
          inspection, dirname(options.csv), basename(options.csv), options.series!,
          { workspaceId: tx.workspaceId, actorPrincipalId: tx.principalId },
          { transaction: 'nested' },
        ),
      )
      console.log(JSON.stringify(result, null, 2))
    },
  )
}

/**
 * Is this module the process entrypoint, or was it merely imported?
 *
 * THE DEFECT THIS CLOSES. The invocation below used to run unconditionally, so
 * `import('bin/import-archive.ts')` — which the unit suite does, for parseArgs —
 * executed the whole CLI. With no --csv it printed the usage error to stderr,
 * set process.exitCode = 1, and called closePool(). Vitest masks that: the
 * worker's exit code is decided by the reporter, so the suite stayed green while
 * every import mutated the importing process. An importer that meant to read one
 * exported function got a command run at it instead.
 *
 * ESM has no `require.main === module`, so the entrypoint is identified by
 * comparing this module's own path with the script node was asked to run.
 * `realpathSync` on both sides makes the comparison survive symlinks, `..`
 * segments and the tsx loader's rewriting — a substring test, a basename test,
 * or anything keyed on cwd or an environment variable would not.
 *
 * It fails CLOSED toward inert: if argv[1] is absent or unresolvable (`node -e`,
 * a REPL, an embedded loader) this returns false and nothing runs. A real direct
 * invocation always has a resolvable argv[1], and the subprocess tests prove the
 * command still executes.
 */
function isProcessEntrypoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry)
  } catch {
    return false
  }
}

if (isProcessEntrypoint()) {
  main().catch(error => { console.error(String(error instanceof Error ? error.message : error)); process.exitCode = 1 })
    .finally(() => closePool())
}
