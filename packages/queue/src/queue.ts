// BullMQ wiring — single shared queue + worker for the daily pipeline.
//
// Connection: localhost:6379 (Homebrew Redis). REDIS_URL env overrides.
// Queue name: 'daily-pipeline'.
// Job names within the queue are JobSpec.name (e.g. 'macro-asset-monitor').

import { Queue, Worker, QueueEvents, type ConnectionOptions, type Processor } from 'bullmq'

export const QUEUE_NAME = 'daily-pipeline'

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

let _queue:        Queue | null = null
let _queueEvents:  QueueEvents | null = null

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

export async function closeAll(): Promise<void> {
  if (_queue)        { await _queue.close();        _queue = null }
  if (_queueEvents)  { await _queueEvents.close();  _queueEvents = null }
}
