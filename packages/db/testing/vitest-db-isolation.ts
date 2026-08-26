// Shared vitest setup: guarantee no test can reach the live AI Capital book.
//
// THE INVARIANT THIS ENFORCES:
//   No test may read from or write to the live Postgres database merely because
//   DATABASE_URL is present in the shell environment.
//
// THE INCIDENT. On 2026-08-25 a `pnpm -r test` run with DATABASE_URL exported
// wrote test fixtures into the real portfolio — a fabricated NVDA position
// (100 sh @ $68.50 = $9,200), plus rows in capital.fetch_log and
// capital.pending_manual_input. The next morning's briefing and LINE alerts
// would have reported a holding that does not exist.
//
// THE MECHANISM. `usePostgres()` is `!!process.env.DATABASE_URL`, and six store
// factories branch on it — portfolio, capital ingestion, thesis, graph, vector,
// and the act store. So `createPortfolioStore('/tmp/fixture.db')` silently
// ignored its own argument and returned a Postgres store pointed at the real
// book. Nothing warned. The tests passed against production data.
//
// THE FIX, in two layers:
//   1. (here) Clear DATABASE_URL before any test runs, so every store takes its
//      explicit file path — the behaviour the test author already asked for.
//   2. (pool.ts) A hard guard that refuses to connect a test process to a
//      database named in LIVE_DATABASE_NAMES, as a backstop for when this file
//      is bypassed.
//
// Tests that genuinely need Postgres set TEST_DATABASE_URL to a throwaway
// database. That variable survives this file untouched and takes precedence
// inside a test process.

import { beforeAll, afterAll } from 'vitest'
// ONE canonicaliser, shared with the pool guard. This file previously carried
// its own `new URL().pathname` copy, which meant layer 1 was still defeatable by
// the very percent-encoding bypass layer 2 had been hardened against.
import { databaseNameOf, liveDatabaseNames } from '../src/pool.js'

const LIVE_URL = process.env.DATABASE_URL
const TEST_URL = process.env.TEST_DATABASE_URL



// Runs at module load — BEFORE any test file body, and therefore before any
// store is constructed. Using beforeAll would be too late for stores created at
// import time.
if (LIVE_URL) {
  const name = databaseNameOf(LIVE_URL)
  if (name && liveDatabaseNames().includes(name)) {
    // The dangerous case: the developer's shell points at the real book.
    delete process.env.DATABASE_URL
    console.warn(
      `[test-isolation] DATABASE_URL pointed at the live database "${name}" — cleared for this test run. ` +
      'Stores will use their explicit SQLite paths. Set TEST_DATABASE_URL if a test needs real Postgres.',
    )
  } else {
    // Some other Postgres. Still not a file path, so still not what a test that
    // passes a fixture path asked for. Clear it, but say so quietly.
    delete process.env.DATABASE_URL
  }
}

// Every OTHER credential that could reach production must go too — and this
// must NOT be a list of variable names.
//
// The first version named CLAIM_WRITER_DATABASE_URL and AGENT_DATABASE_URL
// explicitly, because those are the two that exist today. That is the same
// shape of mistake as the incident it was written after: the claim writer was
// invisible to every guard precisely because every guard had been written
// against the credentials that existed when it was written. A named allowlist
// is always one new variable behind.
//
// So the rule is about the DESTINATION, not the name: any environment variable
// that parses as a connection string aimed at a protected live database is
// removed, whatever it is called. TEST_DATABASE_URL pointed at a throwaway
// survives this untouched, because it is judged the same way and passes.
for (const [key, value] of Object.entries(process.env)) {
  if (!value || key === 'DATABASE_URL') continue          // handled above, with its own message
  if (!/^postgres(ql)?:\/\/|^socket:/i.test(value)) continue
  const target = databaseNameOf(value)
  if (target && liveDatabaseNames().includes(target)) {
    delete process.env[key]
    console.warn(`[test-isolation] ${key} pointed at the live database "${target}" — cleared for this test run.`)
  }
}

// PGDATABASE is not a connection string but pg resolves it as a destination, so
// a discrete-config client would inherit it. Same rule, different spelling.
{
  const pgdb = process.env.PGDATABASE?.trim().toLowerCase()
  if (pgdb && liveDatabaseNames().includes(pgdb)) {
    delete process.env.PGDATABASE
    console.warn(`[test-isolation] PGDATABASE named the live database "${pgdb}" — cleared for this test run.`)
  }
}

// Fail loudly rather than silently if a test re-introduces a live URL mid-run.
beforeAll(() => {
  const current = process.env.DATABASE_URL
  if (!current) return
  const name = databaseNameOf(current)
  if (name && liveDatabaseNames().includes(name)) {
    throw new Error(
      `[test-isolation] a test set DATABASE_URL to the live database "${name}". ` +
      'Isolation cannot be established; refusing to continue.',
    )
  }
})

afterAll(() => {
  // Restore for any tooling that inspects the env after the run. The process is
  // usually about to exit, but leaving a mutated env behind is impolite.
  if (LIVE_URL) process.env.DATABASE_URL = LIVE_URL
  if (TEST_URL) process.env.TEST_DATABASE_URL = TEST_URL
})
