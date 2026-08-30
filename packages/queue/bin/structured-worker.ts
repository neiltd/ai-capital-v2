#!/usr/bin/env node
// Worker for the STRUCTURED ingestion lane.
//
// Separate process, separate queue, separate slot. The daily worker runs at
// concurrency 1 and the article flow is deliberately serial; if structured work
// shared that lane, a slow, retrying or stalled structured job would delay
// runnable article jobs — the same blocking the decoupling removed at the graph
// level, re-entering through execution resources.
//
// Structured scheduling is dormant by default, so this worker normally has
// nothing to do. It is safe to leave unregistered: nothing enqueues structured
// work unless SCHEDULE_STRUCTURED_INGESTION=true.

import { ensurePipelineEnv } from '../src/env.js'
ensurePipelineEnv()

import { createStructuredWorker, closeAll } from '../src/queue.js'
import { processJob } from '../src/processor.js'
import type { Job } from 'bullmq'

const worker = createStructuredWorker(async (job: Job) => processJob(job))

worker.on('completed', (job, result) => {
  console.log(`[structured-worker] ✅ ${job.name} (runId=${(result as { runId: string }).runId})`)
})
worker.on('failed', (job, err) => {
  console.log(`[structured-worker] ❌ ${job?.name ?? 'unknown'} attempt ${(job?.attemptsMade ?? 0) + 1}: ${err.message}`)
})
worker.on('stalled', (jobId) => {
  console.log(`[structured-worker] ⚠️  stalled job ${jobId}`)
})

console.log('[structured-worker] started; waiting for structured jobs…')

let shutting = false
async function shutdown(signal: string) {
  if (shutting) return
  shutting = true
  console.log(`\n[structured-worker] ${signal} received — draining…`)
  await worker.close()
  await closeAll()
  process.exit(0)
}
process.on('SIGINT',  () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
