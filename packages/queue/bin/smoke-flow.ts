#!/usr/bin/env node
// Smoke test for the full submit-and-wait path — uses a 2-step flow of trivial
// echo jobs to verify FlowProducer chains them, waitUntilFinished blocks until
// the root completes, and the parent pipeline_runs row gets closed as success.

import { ensurePipelineEnv } from '../src/env.js'
ensurePipelineEnv()

import { FlowProducer } from 'bullmq'
import { recordStart, recordEnd } from '@common/pipeline-runs'
import { QUEUE_NAME, connectionOptions, getQueue, getQueueEvents, closeAll } from '../src/queue.js'
import type { JobSpec } from '../src/types.js'

async function main() {
  const parentRunId = recordStart({
    stage:    'queue-smoke-flow',
    source:   'queue',
    metadata: { kind: 'smoke-flow-test' },
  })

  const stepA: JobSpec = {
    name: 'queue-smoke-flow-A',
    cmd:  ['node', '-e', "console.log('[smoke-flow] A ran'); setTimeout(() => {}, 200)"],
    cwd:  '.',
    timeoutMs: 10_000,
    retry: { attempts: 1, backoffMs: 1_000 },
  }
  const stepB: JobSpec = {
    name: 'queue-smoke-flow-B',
    cmd:  ['node', '-e', "console.log('[smoke-flow] B ran')"],
    cwd:  '.',
    timeoutMs: 10_000,
    retry: { attempts: 1, backoffMs: 1_000 },
  }

  // FlowProducer: child runs first, parent waits for child.
  const producer = new FlowProducer({ connection: connectionOptions() })
  const flow = await producer.add({
    name: stepB.name,
    queueName: QUEUE_NAME,
    data: { spec: stepB, parentRunId },
    opts: { attempts: 1, removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } },
    children: [{
      name: stepA.name,
      queueName: QUEUE_NAME,
      data: { spec: stepA, parentRunId },
      opts: { attempts: 1, removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } },
    }],
  })
  await producer.close()

  console.log(`[smoke-flow] submitted root=${flow.job.id} parentRunId=${parentRunId}`)

  // Wait for the root job to finish.
  const queue        = getQueue()
  const queueEvents  = getQueueEvents()
  const rootJob      = await queue.getJob(flow.job.id!)
  if (!rootJob) throw new Error('root job missing from queue')

  const status: 'success' | 'failed' = await rootJob
    .waitUntilFinished(queueEvents)
    .then(() => 'success' as const)
    .catch(() => 'failed' as const)

  recordEnd(parentRunId, {
    status,
    error:    null,
    metadata: { kind: 'smoke-flow-test', rootJobId: flow.job.id },
  })

  console.log(`[smoke-flow] root finished — status=${status}`)
  await closeAll()
}

main().catch(err => { console.error(err); process.exit(1) })
