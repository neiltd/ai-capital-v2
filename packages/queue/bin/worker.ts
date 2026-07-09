#!/usr/bin/env node
// Worker entry point — runs forever, picks jobs off the queue, executes
// them via the processor. Multiple workers can run in parallel for
// horizontal scaling; for the personal-use case one worker is plenty.

import { ensurePipelineEnv } from '../src/env.js'
ensurePipelineEnv()

import { createWorker, getQueueEvents, closeAll } from '../src/queue.js'
import { processJob } from '../src/processor.js'
import type { Job } from 'bullmq'

const worker = createWorker(async (job: Job) => processJob(job))

worker.on('completed', (job, result) => {
  console.log(`[worker] ✅ ${job.name} (runId=${(result as { runId: string }).runId})`)
})
worker.on('failed', (job, err) => {
  console.log(`[worker] ❌ ${job?.name ?? 'unknown'} attempt ${(job?.attemptsMade ?? 0) + 1}: ${err.message}`)
})
worker.on('stalled', (jobId) => {
  console.log(`[worker] ⚠️  stalled job ${jobId}`)
})

// Surface queue-level events for the dashboard later.
const events = getQueueEvents()
events.on('progress', ({ jobId, data }) => {
  console.log(`[worker] progress ${jobId}: ${JSON.stringify(data)}`)
})

console.log('[worker] started; waiting for jobs…')

let shutting = false
async function shutdown(signal: string) {
  if (shutting) return
  shutting = true
  console.log(`\n[worker] ${signal} received — draining…`)
  await worker.close()
  await closeAll()
  process.exit(0)
}
process.on('SIGINT',  () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
