#!/usr/bin/env node
// CLI wrapper around runMigrations(). Prints applied + already-applied counts.

import { runMigrations } from '../src/migrate.js'
import { closePool, usePostgres } from '../src/pool.js'

async function main() {
  if (!usePostgres()) {
    console.error('db-migrate: DATABASE_URL is not set. Nothing to do.')
    process.exit(1)
  }
  const result = await runMigrations()
  console.log(`[@common/db] migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already applied`)
  for (const f of result.applied)        console.log(`  + ${f}`)
  for (const f of result.alreadyApplied) console.log(`  · ${f}`)
  await closePool()
}

main().catch(err => {
  console.error('db-migrate failed:', err.message)
  process.exit(1)
})
