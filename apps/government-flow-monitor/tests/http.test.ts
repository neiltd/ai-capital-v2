import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import { fetchWithDeadline, FETCH_TIMEOUT_MS } from '../src/fetchers/http.js'

// The 2026-08-22..24 pipeline failures were hangs, not errors. Every fetcher
// here already degrades gracefully on a thrown error; what it could not survive
// was a request that never settles. These tests use a real socket rather than a
// mocked fetch, because the failure mode is specifically a server that answers
// the headers and then stalls the body — a mock cannot reproduce that.

let server: Server | null = null

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise(resolve => {
    server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`)
    })
  })
}

afterEach(async () => {
  await new Promise<void>(resolve => {
    if (!server) return resolve()
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
  server = null
})

describe('fetchWithDeadline', () => {
  it('returns normally when the server responds in time', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    const res = await fetchWithDeadline(url, {}, 2_000)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  it('gives up on a server that never responds at all', async () => {
    const url = await listen(() => { /* never write, never end */ })
    await expect(fetchWithDeadline(url, {}, 200))
      .rejects.toThrow(/deadline exceeded after 200ms/)
  })

  it('gives up on a server that sends headers then stalls the body — the actual hang', async () => {
    // This is the case the old helper could not survive: it cleared its abort
    // timer as soon as headers arrived, leaving the body read undeadlined.
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.write('{"partial":')   // headers + a fragment, then silence
    })
    const start = Date.now()
    await expect(
      fetchWithDeadline(url, {}, 300).then(r => r.json()),
    ).rejects.toThrow()
    // and it gave up promptly rather than hanging until the queue's SIGTERM
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('names the deadline in the error so a stage log identifies the wedged source', async () => {
    const url = await listen(() => { /* hang */ })
    await expect(fetchWithDeadline(url, {}, 150))
      .rejects.toThrow(new RegExp(`govflow.*deadline exceeded.*${url}`))
  })

  it('honors a caller-supplied signal alongside the deadline', async () => {
    const url = await listen(() => { /* hang */ })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    // Aborted by the caller well before the 10s deadline — and NOT reported as
    // a deadline breach, because that is not what happened.
    await expect(fetchWithDeadline(url, { signal: ac.signal }, 10_000))
      .rejects.toThrow(/^(?!.*deadline exceeded).*$/s)
  })

  it('defaults to a bounded deadline rather than none', () => {
    expect(FETCH_TIMEOUT_MS).toBeGreaterThan(0)
    expect(FETCH_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })
})
