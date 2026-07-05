#!/usr/bin/env node
// Smoke test — submits a trivial echo job to verify queue+worker plumbing
// works end-to-end without running the (multi-hour) daily pipeline.
//
// Usage (two terminals):
//   pnpm -F @common/queue worker         # terminal 1
//   pnpm -F @common/queue smoke          # terminal 2
//
// Expect terminal 1 to print:
//   [worker] queue-smoke
//   [smoke] hello from worker — runId=<uuid>
//   [worker] ✅ queue-smoke (runId=<uuid>)
//
// And terminal 2 to print the parent runId and exit.

import { ensurePipelineEnv } from '../src/env.js'
ensurePipelineEnv()

import { getQueue, closeAll } from '../src/queue.js'
import { recordStart } from '@common/pipeline-runs'
import type { JobSpec } from '../src/types.js'

async function main() {
  const parentRunId = recordStart({
    stage:    'queue-smoke',
    source:   'queue',
    metadata: { kind: 'smoke-test' },
  })

  const spec: JobSpec = {
    name: 'queue-smoke',
    cmd:  ['node', '-e', "console.log('[smoke] hello from worker — runId=' + process.env.PIPELINE_RUN_ID)"],
    cwd:  '.',
    timeoutMs: 30_000,
    retry:     { attempts: 1, backoffMs: 1_000 },
  }

  const queue = getQueue()
  const job   = await queue.add(spec.name, { spec, parentRunId }, {
    attempts:         1,
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 50 },
  })
  console.log(`[smoke] submitted job id=${job.id}, parentRunId=${parentRunId}`)
  console.log(`[smoke] watch the worker terminal for: '[smoke] hello from worker'`)

  await closeAll()
}

main().catch(err => { console.error(err); process.exit(1) })
