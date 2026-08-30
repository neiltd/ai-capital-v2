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
import { submitScheduledStructuredIngestion, structuredIngestionScheduled, STRUCTURED_INGESTION_SCHEDULE_ENV } from '../src/structured-scheduling.js'
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

  // Structured-event + energy/macro ingestion is submitted SEPARATELY and only
  // when explicitly scheduled. It is dormant by default, so this is normally a
  // no-op that touches no queue, no run record and no source.
  //
  // Deliberately after the daily submission and inside its own catch: this job
  // must never be able to fail, delay or block the article flow. That coupling
  // is the defect this separation exists to remove — it cost 14 days of article
  // collection while nothing consumed the structured output.
  if (structuredIngestionScheduled(process.env)) {
    try {
      const structured = await submitScheduledStructuredIngestion()
      console.log(`[run-daily] structured ingestion submitted independently — parentRunId=${structured?.parentRunId} jobId=${structured?.jobId}`)
    } catch (err) {
      console.error('[run-daily] structured ingestion submission failed (daily flow unaffected):', err)
    }
  } else {
    // ACTIVATION IS TWO STEPS, and this flag is only the second. The dedicated
    // structured worker (packages/queue/bin/structured-worker.ts) must be
    // installed and verified first; it exists as source plus an UNREGISTERED
    // launchd definition under ops/launchd-proposed/. Setting the flag without
    // that worker would enqueue structured jobs nothing drains.
    console.log(`[run-daily] structured ingestion dormant — activation requires (1) the structured worker installed and verified, then (2) ${STRUCTURED_INGESTION_SCHEDULE_ENV}=true`)
  }

  await closeAll()
  // Exit 0 means "we successfully handed work to the queue". The pipeline's
  // own success/failure is recorded against parentRunId in pipeline_runs.db.
  process.exit(0)
}

main().catch(err => {
  console.error('[run-daily] fatal:', err)
  process.exit(1)
})
