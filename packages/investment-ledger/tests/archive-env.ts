// The real historical archive is NEVER named by a path in committed source.
//
// It is one operator's private financial record. Round 1 hardcoded
// `/Users/<user>/Desktop/tmp_folder/transactions_all.csv` in the CLI and in
// three test files, which made the package unrunnable anywhere else and made an
// omitted `--csv` silently select real personal data.
//
// The path now arrives through exactly one explicit variable, and its absence is
// a LOUD FAILURE rather than a skip: a suite that quietly passes with nothing
// loaded is indistinguishable from one that verified the archive.
export const ARCHIVE_ENV = 'INVESTMENT_ARCHIVE_CSV'

export function archivePath(): string {
  const value = process.env[ARCHIVE_ENV]
  if (!value || !value.trim()) {
    throw new Error(
      `${ARCHIVE_ENV} is required for archive-dependent tests and has no default. ` +
      `Set it to the archive CSV you want checked, or run the portable suites instead ` +
      `(pnpm --filter @common/investment-ledger test). No path is inferred.`,
    )
  }
  return value.trim()
}
