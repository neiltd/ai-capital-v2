import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * THE INVARIANT:
 *
 *   GET / render          -> no Anthropic request
 *   explicit user action  -> Anthropic request
 *
 * WHY. `/studio/chat` set `force-dynamic` and its loader called
 * `anthropic.messages.create()` directly, so every authenticated page load made
 * one blocking, billable model call. It was the only `messages.create` site in
 * the app without a rate limit, and the only one reachable from a GET — every
 * other caller is a rate-limited POST.
 *
 * This test asserts on the CLIENT being called, not on the absence of a string
 * in the source. A source grep would pass while a transitive helper spends, and
 * transitive-below-a-renderer is precisely the failure mode that hid the
 * reapOrphans write for weeks.
 */

const createSpy = vi.fn(async () => ({ content: [{ type: 'text', text: 'should never happen' }] }))

vi.mock('@/lib/studio/agent', () => ({
  anthropic: { messages: { create: createSpy } },
  buildSystemPrompt: () => 'system',
}))

beforeEach(() => { createSpy.mockClear() })

describe('rendering /studio/chat does not spend', () => {
  it('the loader makes no Anthropic call', async () => {
    const { loadStudioChat } = await import('@/app/(next)/studio/chat/data')
    await loadStudioChat()
    expect(createSpy, 'loadStudioChat called the model').not.toHaveBeenCalled()
  })

  it('repeated loads still make none', async () => {
    const { loadStudioChat } = await import('@/app/(next)/studio/chat/data')
    for (let i = 0; i < 10; i++) await loadStudioChat()
    expect(createSpy).toHaveBeenCalledTimes(0)
  })

  it('rendering the PAGE makes no Anthropic call', async () => {
    // The request path, not just the loader — the page is what a GET reaches.
    const page = (await import('@/app/(next)/studio/chat/page')).default
    try { await page() } catch { /* JSX may not render without a Next request context; the spend, if any, already happened */ }
    expect(createSpy, 'rendering StudioChatPage called the model').not.toHaveBeenCalled()
  })

  it('the loader returns an empty opening, so the thread starts unopened', async () => {
    const { loadStudioChat } = await import('@/app/(next)/studio/chat/data')
    const vm = await loadStudioChat()
    expect(vm.opening).toBe('')
  })

  it('no page or loader under (next)/studio imports the Anthropic client', async () => {
    // Belt to the braces above: catch a NEW render path added later that
    // reaches the client directly rather than through the rate-limited route.
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const offenders: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!/\.(ts|tsx)$/.test(e)) continue
        const src = readFileSync(p, 'utf-8')
        // strip comments so an explanatory note about the old defect does not
        // register as the defect — the false-positive shape from the reaper test
        const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
        if (/from\s+'@\/lib\/studio\/agent'/.test(code) && /\banthropic\b/.test(code)) offenders.push(p)
      }
    }
    walk(join(process.cwd(), 'src', 'app', '(next)', 'studio'))
    expect(offenders, `these render paths import the Anthropic client: ${offenders.join(', ')}`).toEqual([])
  })
})
