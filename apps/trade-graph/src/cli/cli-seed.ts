#!/usr/bin/env node
// Seed the trade-graph static data:
//   - 44 bootstrap countries (centroids)
//   - 10 maritime chokepoints
//   - chokepoint → (origin, dest) route mapping
//
// Idempotent — re-run anytime to refresh. setChokepointRoutes wipes per-
// chokepoint routes before re-inserting, so editing routes.ts and re-running
// is the right workflow.

import { createTradeStore } from '../store/trade-store.js'
import { COUNTRIES }            from '../data/countries.js'
import { CHOKEPOINTS }          from '../data/chokepoints.js'
import { ROUTES_BY_CHOKEPOINT } from '../data/chokepoint-routes.js'

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (trade-graph is pgvector-native).')
    process.exit(1)
  }

  const store = createTradeStore()
  const t0 = Date.now()

  for (const c of COUNTRIES)    await store.upsertCountry(c)
  for (const cp of CHOKEPOINTS) await store.upsertChokepoint(cp)

  let totalRoutes = 0
  for (const [chokepointId, pairs] of Object.entries(ROUTES_BY_CHOKEPOINT)) {
    await store.setChokepointRoutes(
      chokepointId,
      pairs.map(([originIso3, destIso3]) => ({ originIso3, destIso3 })),
    )
    totalRoutes += pairs.length
  }

  const dur = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`[seed] ${COUNTRIES.length} countries + ${CHOKEPOINTS.length} chokepoints + ${totalRoutes} routes upserted in ${dur}s`)
}

main().catch(err => { console.error(err); process.exit(1) })
