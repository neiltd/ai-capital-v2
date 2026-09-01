// BullMQ wiring — single shared queue + worker for the daily pipeline.
//
// Connection: localhost:6379 (Homebrew Redis). REDIS_URL env overrides.
// Queue name: 'daily-pipeline'.
// Job names within the queue are JobSpec.name (e.g. 'macro-asset-monitor').

import { Queue, Worker, QueueEvents, type ConnectionOptions, type Processor } from 'bullmq'

export const QUEUE_NAME = 'daily-pipeline'

/**
 * Structured/energy ingestion runs on its OWN queue, and therefore its own
 * worker lane.
 *
 * Graph independence was not enough: both workloads previously shared this
 * queue, and the worker runs at concurrency 1, so a slow, retrying or stalled
 * structured job could occupy the single slot and delay runnable article jobs.
 * That is the same "structured blocks article" failure the decoupling exists to
 * remove, arriving through execution resources instead of dependency edges.
 *
 * Separate queue + separate worker process, rather than raising global
 * concurrency: the article flow is deliberately serial and must stay that way.
 */
export const STRUCTURED_QUEUE_NAME = 'structured-ingestion'

function parseRedisUrl(url: string): ConnectionOptions {
  // Accepts redis://host:port or redis://user:pass@host:port/db
  const u = new URL(url)
  const opts: ConnectionOptions = {
    host:     u.hostname || 'localhost',
    port:     u.port ? parseInt(u.port, 10) : 6379,
    // Required by BullMQ when running inside a worker.
    maxRetriesPerRequest: null,
  }
  if (u.username) opts.username = u.username
  if (u.password) opts.password = u.password
  if (u.pathname && u.pathname.length > 1) {
    const db = parseInt(u.pathname.slice(1), 10)
    if (!Number.isNaN(db)) opts.db = db
  }
  return opts
}

export function connectionOptions(): ConnectionOptions {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
  return parseRedisUrl(url)
}

let _queue:            Queue | null = null
let _queueEvents:      QueueEvents | null = null
let _structuredQueue:  Queue | null = null
let _inspectQueue:           Queue | null = null
let _inspectStructuredQueue: Queue | null = null

/**
 * Options for a queue handle that only ever READS.
 *
 * BullMQ 5.78.0's `Queue` constructor issues
 * `client.hset(<queue>:meta, { 'opts.maxLenEvents', version })` from
 * `waitUntilReady()` unless `skipMetasUpdate` is set. Construction is therefore
 * a Redis WRITE. For the daily lane that silently rewrites an existing key; for
 * the dormant structured lane it CREATES `bull:structured-ingestion:meta` where
 * no key exists at all, which is precisely the kind of change a pre-activation
 * inspection promises not to make.
 *
 * BullMQ documents the flag as "useful for read-only systems that should not
 * update the metadata", which is exactly this use. Submission and worker
 * constructors deliberately do NOT use it: they own the queue and must keep
 * publishing their metadata.
 */
function inspectionOptions() {
  return { connection: connectionOptions(), skipMetasUpdate: true as const }
}

export function getQueue(): Queue {
  if (_queue) return _queue
  _queue = new Queue(QUEUE_NAME, { connection: connectionOptions() })
  return _queue
}

export function getQueueEvents(): QueueEvents {
  if (_queueEvents) return _queueEvents
  _queueEvents = new QueueEvents(QUEUE_NAME, { connection: connectionOptions() })
  return _queueEvents
}

export function createWorker(
  processor: Processor,
  concurrency: number = 1,
): Worker {
  // concurrency=1 keeps the pipeline strictly serial; the per-job spec's
  // dependsOn enforces order at submit time. When we later split into
  // parallel jobs we'll bump this and rely on the DAG.
  return new Worker(QUEUE_NAME, processor, {
    connection: connectionOptions(),
    concurrency,
  })
}

/** The structured queue. Lazy, mirroring getQueue(). */
export function getStructuredQueue(): Queue {
  if (_structuredQueue) return _structuredQueue
  _structuredQueue = new Queue(STRUCTURED_QUEUE_NAME, { connection: connectionOptions() })
  return _structuredQueue
}

/**
 * Inspection-only handle on the daily lane. Never writes the meta key.
 * Cached separately from getQueue() so an inspection can never be handed a
 * meta-writing handle, and vice versa.
 */
export function getInspectionQueue(): Queue {
  if (_inspectQueue) return _inspectQueue
  _inspectQueue = new Queue(QUEUE_NAME, inspectionOptions())
  return _inspectQueue
}

/** Inspection-only handle on the structured lane. Never writes the meta key. */
export function getStructuredInspectionQueue(): Queue {
  if (_inspectStructuredQueue) return _inspectStructuredQueue
  _inspectStructuredQueue = new Queue(STRUCTURED_QUEUE_NAME, inspectionOptions())
  return _inspectStructuredQueue
}

/**
 * Worker for the structured lane. Runs in its own process (bin/structured-worker.ts)
 * so its slot is not the article worker's slot — a stalled structured job
 * cannot starve article execution.
 */
export function createStructuredWorker(
  processor: Processor,
  concurrency: number = 1,
): Worker {
  return new Worker(STRUCTURED_QUEUE_NAME, processor, {
    connection: connectionOptions(),
    concurrency,
  })
}

export async function closeAll(): Promise<void> {
  if (_queue)            { await _queue.close();            _queue = null }
  if (_structuredQueue)  { await _structuredQueue.close();  _structuredQueue = null }
  if (_queueEvents)      { await _queueEvents.close();      _queueEvents = null }
  // Inspection handles hold their own Redis clients and must close too, or a
  // dry-run inspection leaves a connection open after the process believes it
  // has released everything.
  if (_inspectQueue)           { await _inspectQueue.close();           _inspectQueue = null }
  if (_inspectStructuredQueue) { await _inspectStructuredQueue.close(); _inspectStructuredQueue = null }
}
