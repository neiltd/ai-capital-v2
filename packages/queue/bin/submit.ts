#!/usr/bin/env node
// Submits the daily pipeline to the queue and exits. The worker (run-step
// separately) picks up the jobs and runs them in dependency order.

import { ensurePipelineEnv } from '../src/env.js'
ensurePipelineEnv()

import { submitDailyPipeline } from '../src/submit.js'
import { closeAll } from '../src/queue.js'

async function main() {
  const { parentRunId, rootJobId } = await submitDailyPipeline()
  console.log(`[queue-submit] daily pipeline submitted`)
  console.log(`  parent pipeline_runs.id = ${parentRunId}`)
  console.log(`  root BullMQ job id      = ${rootJobId}`)
  console.log(`  start a worker with: pnpm -F @common/queue worker`)
  await closeAll()
}

main().catch(err => { console.error(err); process.exit(1) })
