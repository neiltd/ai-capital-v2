export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'

import { isMarketOpen } from '@/lib/market-hours'

// MANUAL PRICE REFRESH — DISABLED AS OF SLICE S4A, DELIBERATELY.
//
// WHAT THIS ROUTE USED TO DO, AND WHY IT COULD NOT STAY.
// It launched a sibling app's price-refresh CLI as a subprocess and handed
// that subprocess a PostgreSQL connection string, because this app's own generic
// database variable is Prisma's SQLite `file:` URL and forwarding it would have
// made @common/db's usePostgres() hand `pg` a file path. The value it handed
// over was read from a pipeline-specific variable, with a hard-coded cluster
// superuser connection string as its `??` default.
//
// That pipeline-specific variable was referenced in exactly one place in the
// whole repository — that line — and was set NOWHERE: not in any plist, not in
// any shell wrapper, not in any .env. So the `??` branch was not a defensive
// default. It was the only branch that ever executed, and every press of the
// button ran as the personal cluster superuser.
//
// The removed identifiers are named in the design record and in
// tests/credential-boundary.test.ts, not here: this file is scanned as raw text
// for credential and child-process symbols, and a comment that mentions them
// would defeat a check that is stronger for being literal.
//
// The credential, not the code path, is the boundary. `ai_capital_pipeline`
// holds INSERT/UPDATE across five schemas; a network-facing Next route must not
// hold it, and a route that hands it to a subprocess has not avoided anything.
// The Unified Platform's server runtime is permitted exactly ONE PostgreSQL
// credential — the dashboard read credential, which is SELECT-only on five
// `trade` tables — and this route needs none at all.
//
// WHY DISABLED RATHER THAN REWIRED NOW. The refresh work still happens: the
// `scenario-refresh` stage runs in the daily DAG, and the scheduled intraday
// price script covers the rest. Only the button is affected. The intended
// replacement is delegated submission of the existing narrowly-scoped background
// job, which this app is already able to reach, so the server would need the
// broker URL and still no database credential at all. That needs its own
// authorization model — a job-type allowlist, rate limiting, and a guarantee
// that submission authority cannot become arbitrary command execution on the
// worker — which is slice S4F-refresh, not this one.
//
// Shipping the disabled state is the honest intermediate: it removes a live
// superuser credential today and does not pretend to a mechanism that does not
// exist yet.

/** Stable machine-readable code for the disabled state. */
const REFRESH_UNAVAILABLE = 'REFRESH_UNAVAILABLE'

export async function POST() {
  // ORDER IS PART OF THE CONTRACT. The market-closed check runs FIRST and still
  // answers 409, so a caller outside market hours gets the same answer it always
  // did — "prices would not have moved" is a different fact from "refresh is not
  // configured", and collapsing them would hide the change from the one caller
  // most likely to notice it.
  if (!isMarketOpen()) {
    return NextResponse.json(
      { ok: false, error: 'Markets are closed right now — prices would not have moved.' },
      { status: 409 },
    )
  }

  // 503, not 500: the request is well-formed and the server is working. The
  // capability is not configured. The message names the alternatives and carries
  // no credential, hostname, path or internal detail.
  return NextResponse.json(
    {
      ok:    false,
      code:  REFRESH_UNAVAILABLE,
      error:
        'Manual price refresh is unavailable: no delegated refresh mechanism is ' +
        'configured. Prices still refresh on the daily pipeline schedule and via ' +
        'the scheduled intraday job.',
    },
    { status: 503 },
  )
}
