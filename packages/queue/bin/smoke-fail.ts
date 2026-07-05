#!/usr/bin/env node
// Smoke test for retry — submits a job that always exits non-zero so we can
// verify BullMQ retries it `attempts` times with the backoff configured.

import { ensurePipelineEnv } from '../src/env.js'
ensurePipelineEnv()

import { getQueue, closeAll } from '../src/queue.js'
import { recordStart } from '@common/pipeline-runs'
import type { JobSpec } from '../src/types.js'

async function main() {
  const parentRunId = recordStart({
    stage:    'queue-smoke-fail',
    source:   'queue',
    metadata: { kind: 'smoke-test-retry' },
  })

  const spec: JobSpec = {
    name: 'queue-smoke-fail',
    cmd:  ['node', '-e', "console.log('[smoke-fail] attempt'); process.exit(1)"],
    cwd:  '.',
    timeoutMs: 10_000,
    // 3 attempts with a 1s exponential backoff so we get the full retry log in seconds.
    retry: { attempts: 3, backoffMs: 1_000 },
  }

  const job = await getQueue().add(spec.name, { spec, parentRunId }, {
    attempts:         spec.retry?.attempts ?? 3,
    backoff:          { type: 'exponential', delay: spec.retry?.backoffMs ?? 1_000 },
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 50 },
  })
  console.log(`[smoke-fail] submitted job id=${job.id} parentRunId=${parentRunId}`)

  await closeAll()
}

main().catch(err => { console.error(err); process.exit(1) })
