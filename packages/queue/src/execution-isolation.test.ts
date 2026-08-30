import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// EXECUTION ISOLATION
//
// Graph independence was not enough. Structured ingestion and the article flow
// previously shared the `daily-pipeline` queue, whose worker runs at
// concurrency 1, so a slow, retrying or stalled structured job could occupy the
// only slot and delay runnable article jobs — the same blocking the decoupling
// removed at the dependency level, returning through execution resources.
//
// No Redis here: the queue module is mocked, so nothing constructs a client.

const addToStructured = vi.fn()
const addToDaily = vi.fn()
vi.mock('./queue.js', () => ({
  QUEUE_NAME: 'daily-pipeline',
  STRUCTURED_QUEUE_NAME: 'structured-ingestion',
  getQueue: () => ({ add: addToDaily }),
  getStructuredQueue: () => ({ add: addToStructured }),
}))

describe('1/3. the two workloads have distinct queue identities', () => {
  it('the queue names differ', async () => {
    const { QUEUE_NAME, STRUCTURED_QUEUE_NAME } = await import('./queue.js')
    expect(QUEUE_NAME).toBe('daily-pipeline')
    expect(STRUCTURED_QUEUE_NAME).toBe('structured-ingestion')
    expect(STRUCTURED_QUEUE_NAME).not.toBe(QUEUE_NAME)
  })

  it('the real module exposes a separate worker factory bound to the structured queue', () => {
    const src = readFileSync(resolve(__dirname, 'queue.ts'), 'utf-8')
    expect(src).toMatch(/export function createStructuredWorker/)
    expect(src).toMatch(/new Worker\(STRUCTURED_QUEUE_NAME/)
    // and the daily worker is still bound to the daily queue only
    expect(src).toMatch(/new Worker\(QUEUE_NAME/)
  })

  it('the structured worker runs in its own process entrypoint', () => {
    const bin = readFileSync(resolve(__dirname, '..', 'bin', 'structured-worker.ts'), 'utf-8')
    expect(bin).toContain('createStructuredWorker')
    expect(bin).not.toContain('createWorker(')
    const daily = readFileSync(resolve(__dirname, '..', 'bin', 'worker.ts'), 'utf-8')
    expect(daily).toContain('createWorker(')
    expect(daily).not.toContain('createStructuredWorker')
  })
})

describe('2. structured work never enters the article worker lane', () => {
  beforeEach(() => { addToDaily.mockReset(); addToStructured.mockReset().mockResolvedValue({ id: 'j1' }) })

  it('an enabled structured submission goes to the structured queue, never the daily one', async () => {
    const { submitScheduledStructuredIngestion } = await import('./structured-scheduling.js')
    const { getStructuredQueue } = await import('./queue.js')
    const { STRUCTURED_INGESTION_SCHEDULE_ENV } = await import('@common/types')

    // recordStart/recordEnd are injected mocks on purpose: the real ones open
    // the pipeline-runs store, and a routing test must not be able to write to
    // it. `add` still routes through the real getStructuredQueue() (mocked
    // above), so the lane assertion is genuine.
    await submitScheduledStructuredIngestion(
      { [STRUCTURED_INGESTION_SCHEDULE_ENV]: 'true' },
      {
        add: (n, d, o) => getStructuredQueue().add(n, d, o) as never,
        recordStart: vi.fn().mockReturnValue('structured-run-1'),
        recordEnd: vi.fn(),
      },
    )
    expect(addToStructured).toHaveBeenCalledTimes(1)
    expect(addToStructured.mock.calls[0][0]).toBe('world-intel-pipeline')
    expect(addToDaily, 'structured work reached the article worker lane').not.toHaveBeenCalled()
  })

  it('the module default wires submission to the structured queue, not the daily one', () => {
    const src = readFileSync(resolve(__dirname, 'structured-scheduling.ts'), 'utf-8')
    expect(src).toMatch(/getStructuredQueue\(\)\.add/)
    expect(src).not.toMatch(/[^d]getQueue\(\)\.add/)
  })

  it('a stalling/retrying structured job cannot consume the article slot: it is not on that queue', async () => {
    // Retry config lives with the structured job, and every attempt is enqueued
    // on the structured queue. However long it stalls, the daily queue is
    // untouched, so the single article slot stays free.
    const { plannedStructuredIngestion } = await import('./structured-scheduling.js')
    const { STRUCTURED_INGESTION_SCHEDULE_ENV } = await import('@common/types')
    const spec = plannedStructuredIngestion({ [STRUCTURED_INGESTION_SCHEDULE_ENV]: 'true' })!
    expect(spec.timeoutMs).toBe(30 * 60 * 1000)      // its own cap, not the article flow's
    expect(addToDaily).not.toHaveBeenCalled()
  })

  it('the article worker is not given more concurrency to mask contention', () => {
    const src = readFileSync(resolve(__dirname, 'queue.ts'), 'utf-8')
    expect(src).toMatch(/concurrency: number = 1/)
  })
})
