// Shared HTTP helper for the government-flow fetchers.
//
// Every fetch in this app already sits inside a try/catch that degrades to an
// empty result, so a source that ERRORS is handled cleanly. What was not
// handled is a source that HANGS: a request with no deadline never throws, so
// the catch never runs and the stage simply stops making progress.
//
// That is what happened on 2026-08-24 — `government-flow-monitor` was SIGTERM'd
// by the queue's 1-hour cap twice (4347s and 4129s), and the DAG below it never
// ran. Giving each request a total deadline converts a hang into a throw, which
// the existing catch blocks already turn into a graceful empty result.

/** Total deadline per request — covers headers AND body, not just connect. */
export const FETCH_TIMEOUT_MS = 20_000

/**
 * `fetch` with a total deadline. `AbortSignal.timeout` stays armed until the
 * request fully settles, so a server that sends headers and then stalls the
 * body is still cut off — that half-open state is the realistic hang, not a
 * refused connection.
 */
export async function fetchWithDeadline(
  input: string,
  init: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline
  try {
    return await fetch(input, { ...init, signal })
  } catch (err) {
    if (deadline.aborted) {
      // Name the deadline so a stage log says which source wedged and for how
      // long, instead of a bare "This operation was aborted".
      throw new Error(`[govflow] request deadline exceeded after ${timeoutMs}ms: ${input}`)
    }
    throw err
  }
}
