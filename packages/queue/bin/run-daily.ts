#!/usr/bin/env node
// Cron entry point — submits the daily pipeline and blocks until the flow
// either completes or fails, then exits with the appropriate code.
//
// daily.sh's replacement. Run this from launchd / cron in place of daily.sh.
// Requires a worker to be running separately (`pnpm -F @common/queue worker`)
// or launchd-managed via the worker plist.

import { ensurePipelineEnv } from '../src/env.js'
ensurePipelineEnv()

import { submitDailyPipeline } from '../src/submit.js'
import { closeAll } from '../src/queue.js'

// Submit-and-exit. The launchd-managed worker (com.thanapol.ai-capital.worker)
// drives all stages to completion independently; whichever stage runs last
// (success path) or first-exhausts-retries (failure path) closes the parent
// pipeline_runs row from inside the worker process. So cron doesn't need to
// stay alive to learn the result — it just needs to enqueue the flow.
//
// For ad-hoc local runs where you want to block until the brief lands, use
// `pnpm -F @common/queue submit` (the original submitAndWait path).

async function main() {
  console.log(`[run-daily] submitting daily pipeline at ${new Date().toISOString()}`)
  const { parentRunId, rootJobId } = await submitDailyPipeline()
  console.log(`[run-daily] submitted — parentRunId=${parentRunId} rootJobId=${rootJobId}`)
  console.log(`[run-daily] launchd worker will drive the flow to completion`)
  await closeAll()
  // Exit 0 means "we successfully handed work to the queue". The pipeline's
  // own success/failure is recorded against parentRunId in pipeline_runs.db.
  process.exit(0)
}

main().catch(err => {
  console.error('[run-daily] fatal:', err)
  process.exit(1)
})
