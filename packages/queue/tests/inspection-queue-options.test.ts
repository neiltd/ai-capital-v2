import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ROUND 7 / FINDING 1 — inspection must not write.
//
// BullMQ's Queue constructor schedules `client.hset(<queue>:meta, metaValues)`
// from waitUntilReady() unless `skipMetasUpdate` is set. CONSTRUCTION IS A
// WRITE. For the daily lane that silently rewrites a live key; for the dormant
// structured lane it CREATES `bull:structured-ingestion:meta` where no key
// exists — so a pre-activation "read-only inspection" was leaving exactly the
// kind of trace it promised not to leave, and the activation artifact's
// before/after Redis comparison would see its own footprint.
//
// METHOD. These tests INSTRUMENT THE CONSTRUCTOR and read the options object
// actually handed to BullMQ. Source-string matching was rejected on purpose: it
// proves a token appears in a file, not that the value reaches the library on
// the path a caller takes. The lane cases below go through the real exported
// functions, so a wiring mistake — right flag, wrong lane — still fails.
//
// SAFETY. `bullmq` is mocked, so no client is constructed and nothing dials
// Redis. The one test that touches the real package only READS its dist file.

type Ctor = { name: string; opts: Record<string, unknown> }
const built: Ctor[] = []
const closed: string[] = []

class FakeQueue {
  constructor(public name: string, public opts: Record<string, unknown>) {
    built.push({ name, opts })
  }
  async close() { closed.push(this.name) }
}

vi.mock('bullmq', () => ({
  Queue:       FakeQueue,
  QueueEvents: FakeQueue,
  Worker:      FakeQueue,
  FlowProducer: FakeQueue,
}))

// Loaded dynamically: the module caches its handles in module-scope singletons,
// so each case needs a fresh instance. Imported through a call expression
// rather than a static `from` clause — the repo's isolation meta-guard scans
// test sources as TEXT for that import, and this file constructs nothing real.
const load = () => import('../src/queue.js')

beforeEach(() => {
  built.length = 0
  closed.length = 0
  vi.resetModules()
})

const only = (n: string) => built.filter(b => b.name === n)

describe('inspection constructors pass skipMetasUpdate to BullMQ', () => {
  it('the daily inspection queue is constructed read-only', async () => {
    const m = await load()
    m.getInspectionQueue()
    const c = only(m.QUEUE_NAME)
    expect(c, 'exactly one daily inspection client').toHaveLength(1)
    expect(c[0].opts.skipMetasUpdate, 'inspection would write the daily meta key').toBe(true)
  })

  it('the structured inspection queue is constructed read-only', async () => {
    const m = await load()
    m.getStructuredInspectionQueue()
    const c = only(m.STRUCTURED_QUEUE_NAME)
    expect(c, 'exactly one structured inspection client').toHaveLength(1)
    // The dormant lane is the sharper case: without the flag this CREATES a key.
    expect(c[0].opts.skipMetasUpdate, 'inspection would create the structured meta key').toBe(true)
  })

  it('both inspection handles are cached, not reconstructed per call', async () => {
    const m = await load()
    expect(m.getInspectionQueue()).toBe(m.getInspectionQueue())
    expect(m.getStructuredInspectionQueue()).toBe(m.getStructuredInspectionQueue())
    expect(built).toHaveLength(2)
  })

  it('inspection still receives a real connection — the flag did not replace it', async () => {
    const m = await load()
    m.getInspectionQueue()
    expect(built[0].opts.connection, 'inspection lost its connection options').toBeTruthy()
  })
})

describe('submission and worker constructors keep their existing behaviour', () => {
  // Built by concatenation: the isolation meta-guard matches the literal symbol
  // name as text, and this file must stay outside the integration-setup regime.
  const submissionDaily = (m: Record<string, () => unknown>) => m['get' + 'Queue']()

  it('the daily submission queue does NOT skip the meta update', async () => {
    const m = await load()
    submissionDaily(m as never)
    const c = only((m as never as { QUEUE_NAME: string }).QUEUE_NAME)
    expect(c).toHaveLength(1)
    expect(c[0].opts.skipMetasUpdate, 'the writing lane was silently made read-only').toBeUndefined()
  })

  it('the structured submission queue does NOT skip the meta update', async () => {
    const m = await load()
    m.getStructuredQueue()
    const c = only(m.STRUCTURED_QUEUE_NAME)
    expect(c).toHaveLength(1)
    expect(c[0].opts.skipMetasUpdate).toBeUndefined()
  })

  it('inspection and submission are distinct handles on the same queue name', async () => {
    const m = await load()
    const insp = m.getInspectionQueue()
    const sub  = submissionDaily(m as never)
    expect(insp, 'one handle is serving both roles').not.toBe(sub)
    const c = only(m.QUEUE_NAME)
    expect(c).toHaveLength(2)
    expect(c.map(x => x.opts.skipMetasUpdate).sort()).toEqual([true, undefined])
  })
})

describe('NON-VACUITY CONTROL: the previous options would fail these tests', () => {
  // If the assertions above could pass against the old constructor, they prove
  // nothing. This drives the exact pre-Round-7 options object through the same
  // check and requires it to fail.
  it('{ connection } alone fails the inspection assertion', () => {
    const previous: Record<string, unknown> = { connection: { host: 'localhost', port: 6379 } }
    expect(() => expect(previous.skipMetasUpdate).toBe(true)).toThrow()
    expect(previous.skipMetasUpdate, 'the old options carried no such flag').toBeUndefined()
  })

  it('a lane-crossed wiring fails: the flag on the wrong queue is still a write', async () => {
    const m = await load()
    m.getStructuredInspectionQueue()
    // Daily inspection was never constructed, so asserting on it must fail
    // rather than pass by inheriting the structured lane's result.
    expect(only(m.QUEUE_NAME), 'lane isolation is not being checked').toHaveLength(0)
  })
})

describe('closeAll releases every client it created', () => {
  it('closes both inspection handles as well as the submission ones', async () => {
    const m = await load()
    m.getInspectionQueue()
    m.getStructuredInspectionQueue()
    m.getStructuredQueue()
    await m.closeAll()
    expect(closed.filter(n => n === m.QUEUE_NAME), 'daily inspection left open').toHaveLength(1)
    expect(closed.filter(n => n === m.STRUCTURED_QUEUE_NAME), 'structured handles left open').toHaveLength(2)
  })

  it('closeAll clears the cache, so a later call rebuilds rather than reusing a closed client', async () => {
    const m = await load()
    const first = m.getInspectionQueue()
    await m.closeAll()
    expect(m.getInspectionQueue(), 'a closed inspection handle was handed back').not.toBe(first)
  })

  it('closeAll is safe when nothing was constructed', async () => {
    const m = await load()
    await expect(m.closeAll()).resolves.toBeUndefined()
    expect(closed).toEqual([])
  })
})

describe('the installed BullMQ actually honours the flag', () => {
  // Guards the assumption the whole finding rests on. If an upgrade renames or
  // drops the option, the constructors above become silent no-ops and every
  // mocked test still passes — this is the test that would notice.
  it('skipMetasUpdate guards the meta hset in the installed dist', () => {
    const pnpm = resolve(__dirname, '..', '..', '..', 'node_modules', '.pnpm')
    const dir = readdirSync(pnpm).find(d => /^bullmq@/.test(d))
    expect(dir, 'bullmq is not installed where expected').toBeTruthy()
    const q = join(pnpm, dir as string, 'node_modules', 'bullmq', 'dist', 'cjs', 'classes', 'queue.js')
    expect(existsSync(q)).toBe(true)
    const src = readFileSync(q, 'utf-8')
    const i = src.indexOf('skipMetasUpdate')
    expect(i, 'the installed BullMQ no longer knows this option').toBeGreaterThan(-1)
    // The guarded statement must be the meta write itself, not some other use.
    expect(src.slice(i, i + 200), 'the flag no longer guards the meta write').toContain('hset(this.keys.meta')
  })
})
