# Dashboard "Explain This" Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a slide-out "Explain This" panel to the portfolio page that lets the user click any position row and ask Claude a grounded question about that ticker's thesis, risks, and recommended action.

**Architecture:** A new `ExplainPanel` client component renders as a full-height slide-out overlay. Each portfolio row gets a "?" button that sets `explainTarget` state in `PortfolioTable`. The panel calls the existing `/api/ask` endpoint (no new backend needed) with a pre-built question about the selected ticker. The response streams in using the existing text/plain stream format.

**Tech Stack:** Next.js 14, React 18, TypeScript, `react-markdown` + `remark-gfm` (already installed), existing `/api/ask` route (unchanged), Tailwind CSS (project-standard class names used throughout)

---

## File Map

| File | Status | Purpose |
|------|--------|---------|
| `src/components/ExplainPanel.tsx` | CREATE | Slide-out panel: streams `/api/ask` response for a selected ticker |
| `src/components/PortfolioTable.tsx` | MODIFY | Add `explainTarget` state + "?" button per row + render ExplainPanel |

---

## Task 1: ExplainPanel component

**Files:**
- Create: `src/components/ExplainPanel.tsx`

- [ ] **Step 1: Create ExplainPanel.tsx**

Create `/Users/thanapold/Desktop/Projects/capital-intel-dashboard/src/components/ExplainPanel.tsx`:

```tsx
'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  ticker: string
  action: string
  rationale: string
  onClose: () => void
}

export function ExplainPanel({ ticker, action, rationale, onClose }: Props) {
  const defaultQuestion = `Explain the current investment thesis for ${ticker}. Why is it recommended to ${action}? What are the key risks and what signals should I watch?`
  const [question, setQuestion] = useState(defaultQuestion)
  const [answer, setAnswer] = useState('')
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const ask = useCallback(async (q: string) => {
    if (!q.trim() || loading) return
    if (abortRef.current) abortRef.current.abort()
    abortRef.current = new AbortController()

    setLoading(true)
    setAnswer('')

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
        signal: abortRef.current.signal,
      })
      if (!res.ok || !res.body) {
        setAnswer('Error: failed to get response from server.')
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        setAnswer(prev => prev + decoder.decode(value, { stream: true }))
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setAnswer('Error: network failure.')
      }
    } finally {
      setLoading(false)
    }
  }, [loading])

  // Auto-ask with the default question on mount
  useEffect(() => {
    ask(defaultQuestion)
    return () => { abortRef.current?.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    ask(question)
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative w-full max-w-lg bg-bg-sidebar border-l border-border-subtle flex flex-col h-full shadow-2xl">

        {/* Header */}
        <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-indigo-active">{ticker}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted bg-bg-card border border-border-subtle px-1.5 py-0.5 rounded">
              {action}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-xl leading-none transition-colors"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Rationale context strip */}
        {rationale && (
          <div className="px-4 py-2 border-b border-border-subtle bg-bg-card/40 flex-shrink-0">
            <p className="text-[11px] text-text-muted italic leading-snug">{rationale}</p>
          </div>
        )}

        {/* Answer area */}
        <div className="flex-1 overflow-y-auto px-4 py-4 min-h-0">
          {loading && !answer && (
            <div className="flex items-center gap-2 text-text-muted text-xs">
              <span className="inline-block w-1.5 h-1.5 bg-accent-primary rounded-full animate-pulse" />
              <span className="animate-pulse">Analyzing {ticker}…</span>
            </div>
          )}
          {answer && (
            <div className="prose prose-invert prose-sm max-w-none text-text-secondary
              prose-headings:text-text-primary prose-headings:font-semibold
              prose-strong:text-text-primary
              prose-code:text-accent-primary prose-code:bg-bg-card prose-code:px-1 prose-code:rounded
              prose-a:text-indigo-active
              prose-li:marker:text-accent-primary">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {answer + (loading ? '▌' : '')}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {/* Question input */}
        <form
          onSubmit={handleSubmit}
          className="flex-shrink-0 border-t border-border-subtle p-3 flex gap-2"
        >
          <input
            type="text"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            disabled={loading}
            className="flex-1 bg-bg-card border border-border-subtle rounded px-3 py-1.5 text-xs text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary disabled:opacity-50 transition-colors"
            placeholder={`Ask about ${ticker}…`}
          />
          <button
            type="submit"
            disabled={loading || !question.trim()}
            className="px-3 py-1.5 bg-accent-primary text-white text-xs rounded font-semibold disabled:opacity-40 hover:bg-accent-primary/90 transition-colors"
          >
            {loading ? '…' : 'Ask'}
          </button>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify the file was created**

```bash
ls /Users/thanapold/Desktop/Projects/capital-intel-dashboard/src/components/ExplainPanel.tsx
```

Expected: file exists without error.

- [ ] **Step 3: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard
git add src/components/ExplainPanel.tsx
git commit -m "feat(dashboard): add ExplainPanel streaming component"
```

---

## Task 2: Wire ExplainPanel into PortfolioTable

**Files:**
- Modify: `src/components/PortfolioTable.tsx`

The full modified file. Key changes:
1. Import `ExplainPanel`
2. Add `explainTarget` state: `{ ticker: string; action: string; rationale: string } | null`
3. Add "?" button in the signal column per row
4. Render `<ExplainPanel>` when `explainTarget` is set

- [ ] **Step 1: Update PortfolioTable.tsx**

Replace the entire contents of `/Users/thanapold/Desktop/Projects/capital-intel-dashboard/src/components/PortfolioTable.tsx` with:

```tsx
'use client'

import { useState } from 'react'
import type { PortfolioPosition, SimulationScenario, ScenarioAction } from '@/types'
import { ExplainPanel } from './ExplainPanel'

interface Props {
  positions: PortfolioPosition[]
  scenarios: SimulationScenario[]
  actions: ScenarioAction[]
}

type SortCol = 'ticker' | 'shares' | 'avgCost' | 'currentPrice' | 'pnl' | 'pnlPct' | 'recommendation'
type SortDir = 'asc' | 'desc'

const ACTION_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  buy:  { bg: 'bg-green-signal/10',  text: 'text-green-signal',  label: 'Buy'  },
  hold: { bg: 'bg-amber-signal/10',  text: 'text-amber-signal',  label: 'Hold' },
  trim: { bg: 'bg-orange-400/10',    text: 'text-orange-400',    label: 'Trim' },
  exit: { bg: 'bg-red-signal/10',    text: 'text-red-signal',    label: 'Exit' },
}

const CONVICTION_LABEL: Record<string, string> = {
  high: 'High conviction', medium: 'Medium conviction', low: 'Low conviction',
}

const ACTION_SORT_ORDER: Record<string, number> = { buy: 0, hold: 1, trim: 2, exit: 3 }

interface ExplainTarget {
  ticker: string
  action: string
  rationale: string
}

export function PortfolioTable({ positions, scenarios, actions }: Props) {
  const [sortCol, setSortCol] = useState<SortCol>('ticker')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [tooltip, setTooltip] = useState<string | null>(null)
  const [tooltipTicker, setTooltipTicker] = useState<string | null>(null)
  const [explainTarget, setExplainTarget] = useState<ExplainTarget | null>(null)

  const baseScenario = scenarios.find(s => s.scenarioType === 'base')

  const baseActions: Record<string, ScenarioAction> = {}
  if (baseScenario) {
    for (const a of actions) {
      if (a.scenarioId === baseScenario.id) baseActions[a.ticker] = a
    }
  }

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  const sorted = [...positions].sort((a, b) => {
    const pnlA = (a.currentPrice - a.avgCost) * a.shares
    const pnlB = (b.currentPrice - b.avgCost) * b.shares
    const pnlPctA = a.avgCost === 0 ? 0 : ((a.currentPrice - a.avgCost) / a.avgCost) * 100
    const pnlPctB = b.avgCost === 0 ? 0 : ((b.currentPrice - b.avgCost) / b.avgCost) * 100

    let cmp = 0
    switch (sortCol) {
      case 'ticker':         cmp = a.ticker.localeCompare(b.ticker); break
      case 'shares':         cmp = a.shares - b.shares; break
      case 'avgCost':        cmp = a.avgCost - b.avgCost; break
      case 'currentPrice':   cmp = a.currentPrice - b.currentPrice; break
      case 'pnl':            cmp = pnlA - pnlB; break
      case 'pnlPct':         cmp = pnlPctA - pnlPctB; break
      case 'recommendation': {
        const orderA = ACTION_SORT_ORDER[baseActions[a.ticker]?.action ?? 'hold'] ?? 1
        const orderB = ACTION_SORT_ORDER[baseActions[b.ticker]?.action ?? 'hold'] ?? 1
        cmp = orderA - orderB; break
      }
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  function SortIcon({ col }: { col: SortCol }) {
    if (sortCol !== col) return <span className="text-border-subtle ml-1">↕</span>
    return <span className="text-accent-primary ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  function Th({ col, children, right }: { col: SortCol; children: React.ReactNode; right?: boolean }) {
    return (
      <th
        className={`px-4 py-2 text-[11px] text-text-muted uppercase tracking-wide cursor-pointer select-none hover:text-text-secondary transition-colors ${right ? 'text-right' : 'text-left'}`}
        onClick={() => handleSort(col)}
      >
        {children}<SortIcon col={col} />
      </th>
    )
  }

  const totalPnl = positions.reduce((sum, p) => sum + (p.currentPrice - p.avgCost) * p.shares, 0)
  const totalCost = positions.reduce((sum, p) => sum + p.avgCost * p.shares, 0)
  const totalPnlPct = totalCost === 0 ? 0 : (totalPnl / totalCost) * 100

  return (
    <>
      <div className="bg-bg-card border border-border-subtle rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-accent-primary">Positions</h2>
          <div className={`text-xs font-medium ${totalPnl >= 0 ? 'text-green-signal' : 'text-red-signal'}`}>
            Total P&L: {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)} ({totalPnl >= 0 ? '+' : ''}{totalPnlPct.toFixed(1)}%)
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border-subtle">
                <Th col="ticker">Ticker</Th>
                <Th col="shares" right>Shares</Th>
                <Th col="avgCost" right>Avg Cost</Th>
                <Th col="currentPrice" right>Price</Th>
                <Th col="pnl" right>P&L</Th>
                <Th col="pnlPct" right>P&L %</Th>
                <Th col="recommendation" right>Signal</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(p => {
                const pnl = (p.currentPrice - p.avgCost) * p.shares
                const pnlPct = p.avgCost === 0 ? 0 : ((p.currentPrice - p.avgCost) / p.avgCost) * 100
                const isPos = pnl >= 0
                const baseAction = baseActions[p.ticker]
                const style = baseAction ? ACTION_STYLES[baseAction.action] : null

                return (
                  <tr key={p.ticker} className="border-b border-border-subtle last:border-0 hover:bg-bg-sidebar/50 transition-colors group">
                    <td className="px-4 py-2.5 text-xs font-semibold text-indigo-active">{p.ticker}</td>
                    <td className="px-4 py-2.5 text-xs text-text-secondary text-right">{p.shares}</td>
                    <td className="px-4 py-2.5 text-xs text-text-secondary text-right">${p.avgCost.toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-xs text-text-secondary text-right">
                      {p.currentPrice === 0 ? <span className="text-text-muted">—</span> : `$${p.currentPrice.toFixed(2)}`}
                    </td>
                    <td className={`px-4 py-2.5 text-xs text-right font-medium ${isPos ? 'text-green-signal' : 'text-red-signal'}`}>
                      {p.currentPrice === 0 ? <span className="text-text-muted">—</span> : `${isPos ? '+' : ''}$${pnl.toFixed(2)}`}
                    </td>
                    <td className={`px-4 py-2.5 text-xs text-right font-medium ${isPos ? 'text-green-signal' : 'text-red-signal'}`}>
                      {p.currentPrice === 0 ? <span className="text-text-muted">—</span> : `${isPos ? '+' : ''}${pnlPct.toFixed(1)}%`}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {style && baseAction ? (
                          <div className="relative inline-block">
                            <button
                              className={`text-[10px] font-semibold px-2 py-0.5 rounded ${style.bg} ${style.text} cursor-help`}
                              onMouseEnter={() => { setTooltip(baseAction.rationale); setTooltipTicker(p.ticker) }}
                              onMouseLeave={() => { setTooltip(null); setTooltipTicker(null) }}
                            >
                              {style.label} · {baseAction.conviction}
                            </button>
                            {tooltipTicker === p.ticker && tooltip && (
                              <div className="absolute right-0 bottom-full mb-1 w-64 bg-bg-sidebar border border-border-subtle rounded p-2 text-[11px] text-text-secondary z-10 text-left shadow-xl">
                                <div className="text-[10px] font-semibold text-accent-primary mb-1 uppercase">
                                  Base scenario · {baseAction.conviction ? CONVICTION_LABEL[baseAction.conviction] ?? baseAction.conviction : ''}
                                </div>
                                {tooltip}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-text-muted text-[10px]">—</span>
                        )}
                        <button
                          onClick={() => setExplainTarget({
                            ticker: p.ticker,
                            action: baseAction?.action ?? 'hold',
                            rationale: baseAction?.rationale ?? '',
                          })}
                          className="text-[11px] text-text-muted hover:text-accent-primary transition-colors w-5 h-5 flex items-center justify-center rounded hover:bg-accent-primary/10"
                          title={`Explain ${p.ticker}`}
                        >
                          ?
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {explainTarget && (
        <ExplainPanel
          ticker={explainTarget.ticker}
          action={explainTarget.action}
          rationale={explainTarget.rationale}
          onClose={() => setExplainTarget(null)}
        />
      )}
    </>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard
npx tsc --noEmit
```

Expected: no errors. If `react-markdown` types are missing, install:
```bash
npm install --save-dev @types/react
```
(already present — should pass clean)

- [ ] **Step 3: Start dev server and test in browser**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard
npm run dev
```

Navigate to `http://localhost:3000/portfolio`.

Verify:
1. Every portfolio row has a small "?" button on the right side of the Signal column
2. Clicking "?" opens a slide-out panel from the right
3. The panel shows the ticker and action badge in the header
4. The panel auto-asks a question and streams Claude's response
5. Clicking the backdrop (dark overlay) closes the panel
6. Typing a custom question and pressing Enter or clicking "Ask" triggers a new response
7. The "×" button in the header closes the panel
8. Existing tooltip behavior on the signal badge is unchanged

- [ ] **Step 4: Commit**

```bash
cd /Users/thanapold/Desktop/Projects/capital-intel-dashboard
git add src/components/PortfolioTable.tsx
git commit -m "feat(dashboard): wire ExplainPanel into portfolio table rows"
```

---

## Self-Review

**Spec coverage:**
- ✅ "?" button per portfolio row → `explainTarget` state in PortfolioTable
- ✅ Slide-out panel → `ExplainPanel` component with overlay + close button
- ✅ Pre-filled question based on ticker + action → `defaultQuestion` in ExplainPanel
- ✅ Streaming response → `ReadableStream` reader + progressive `setAnswer`
- ✅ Custom follow-up question → question input + form submission
- ✅ Abort on close → `AbortController` ref + `useEffect` cleanup
- ✅ Cursor blink during streaming → `▌` appended while `loading`
- ✅ Markdown rendering → `ReactMarkdown` with `remarkGfm`
- ✅ No new backend needed → uses existing `/api/ask`
- ✅ Existing tooltip behavior preserved → unchanged code path

**No placeholders:** All component code is complete and self-contained.

**Type consistency:** `ExplainTarget` interface defined in PortfolioTable matches exactly the props of `ExplainPanel` (`ticker`, `action`, `rationale`).
