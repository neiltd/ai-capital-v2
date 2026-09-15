#!/usr/bin/env node
// Worker entry point — runs forever, picks jobs off the queue, executes
// them via the processor. Multiple workers can run in parallel for
// horizontal scaling; for the personal-use case one worker is plenty.

// ── STARTUP ORDER IS STRUCTURAL, NOT TEXTUAL ────────────────────────────────
// ESM evaluates every STATIC import before the first statement of this file, so
// writing ensurePipelineEnv() between imports did not actually order anything.
// It happened to be safe only because queue.ts constructs its Redis resources
// lazily — an accident of that file, not a guarantee of this one.
//
// So the static imports here are inert code only, and the modules that can
// construct a Worker, QueueEvents or a Redis connection are imported
// DYNAMICALLY, after the credential has been validated. If validation throws,
// those modules are never evaluated and no resource can exist.
import type { Job } from 'bullmq'
import { ensurePipelineEnv, requirePipelineCredential } from '../src/env.js'

ensurePipelineEnv()

// Captured once, here, and passed explicitly to every job. Nothing downstream
// re-reads the environment for it: rotating the credential requires restarting
// the worker, which is the honest contract for a process that may already have
// spawned children against the old value.
const pipelineCredential = requirePipelineCredential()

const { createWorker, getQueueEvents, closeAll } = await import('../src/queue.js')
const { processJob } = await import('../src/processor.js')

const worker = createWorker(async (job: Job) => processJob(job, pipelineCredential))

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
