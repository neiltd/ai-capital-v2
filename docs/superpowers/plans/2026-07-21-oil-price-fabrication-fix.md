# Fix Fabricated Oil-Price Figures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the daily briefing from citing fabricated commodity/rate
prices (confirmed on 2026-07-20 and 2026-07-21, both times an oil-price
figure that didn't match the real WTI price and was used to justify the
top-priority action item). Two independent fixes: an anti-fabrication
grounding rule in `ai-analysis-engine`'s regime-classification prompt
(where day 1's fabrication occurred), and wiring real live market data
into `investment-analyst-agents`' briefing context plus the same
grounding rule there (where day 2's fabrication occurred, one stage
downstream of a now-clean `ai-analysis-engine` run).

**Architecture:** No new files, no new apps, no cross-app imports — both
changes follow this repo's existing "mirror upstream shapes locally,
optional-context loaders return null not throw" conventions. Three files
touched: `apps/ai-analysis-engine/src/analysis/regime-analyzer.ts`
(prompt-only change), `apps/investment-analyst-agents/src/types.ts` +
`src/context/loader.ts` (new optional `macro` field, following the
`calibration`/`taxHarvest`/`risk` pattern already in that file), and
`apps/investment-analyst-agents/src/briefing/briefing-agent.ts` (render
the new data into the prompt + prompt-only grounding addition).

**Tech Stack:** TypeScript, vitest, Anthropic SDK (mocked in tests).

Full design context: `docs/superpowers/specs/2026-07-21-oil-price-fabrication-fix-design.md`.

---

### Task 1: Grounding rule in `ai-analysis-engine`'s regime prompt

**Files:**
- Modify: `apps/ai-analysis-engine/src/analysis/regime-analyzer.ts:57-83`
- Modify: `apps/ai-analysis-engine/tests/regime-analyzer.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/ai-analysis-engine/tests/regime-analyzer.test.ts`, inside
the existing `describe('analyzeRegime', ...)` block:

```ts
  it('system prompt instructs the model not to fabricate numeric figures', async () => {
    let capturedSystem = ''
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedSystem = params.system
          return {
            content: [{
              type: 'tool_use',
              name: 'classify_macro_regime',
              input: {
                regime: 'AI Acceleration', confidence: 'high',
                rationale: 'GPU demand is strong.', keyIndicators: ['NVDA up'],
                affectedTickers: ['NVDA'],
              },
            }],
          }
        }),
      },
    }

    await analyzeRegime(mockHealth, { client: mockClient as any })

    expect(capturedSystem).toContain('GROUNDING RULE')
    expect(capturedSystem.toLowerCase()).toContain('do not invent')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/ai-analysis-engine && npx vitest run tests/regime-analyzer.test.ts`

Expected: FAIL — current `SYSTEM_PROMPT` has no "GROUNDING RULE" text.

- [ ] **Step 3: Add the grounding rule**

In `apps/ai-analysis-engine/src/analysis/regime-analyzer.ts`, the
`SYSTEM_PROMPT` template literal currently ends with:

```ts
- Stagflationary Pressure: rate risk rising, macro headwinds compressing multiples`
```

Change it to:

```ts
- Stagflationary Pressure: rate risk rising, macro headwinds compressing multiples

GROUNDING RULE: Only state a specific numeric price, dollar threshold, or
count (e.g. a commodity price, a casualty figure, a specific dollar
level) if that exact figure appears in the Macro Asset Prices, Economic
Indicators, World Intelligence, Liquidity, or Government Flow data
supplied above. If a data source describes an event qualitatively (e.g.
"war escalating," "gasoline prices rising") without giving you a number,
describe it qualitatively in your rationale too — do not invent a
specific-sounding number to make it read as more precise than the source
data supports.`
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/ai-analysis-engine && npx vitest run tests/regime-analyzer.test.ts`

Expected: all tests PASS (previous tests + the new one).

- [ ] **Step 5: Run the full app test suite and typecheck**

Run: `cd apps/ai-analysis-engine && npx vitest run && npx tsc --noEmit`

Expected: all PASS, no type errors (prompt-text-only change, should not
affect any other test).

- [ ] **Step 6: Commit**

```bash
cd /Users/thanapold/Desktop/Projects.nosync
git add apps/ai-analysis-engine/src/analysis/regime-analyzer.ts apps/ai-analysis-engine/tests/regime-analyzer.test.ts
git commit -m "$(cat <<'EOF'
fix(ai-analysis-engine): stop regime prompt from fabricating numeric figures

The 2026-07-20 briefing asserted "oil above $90" and "gasoline above
$4/gallon" in its Macro Regime rationale — neither figure exists in any
upstream data (macro.json's real WTI close that day was $81.46; no
gasoline price series exists anywhere in this repo). Traced to
classify_macro_regime's rationale/keyIndicators fields being free text
with no instruction constraining the model to only cite supplied
figures. Added an explicit grounding rule: describe qualitative signals
qualitatively, don't invent a specific number to sound more precise
than the source data supports.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Load live macro data into `investment-analyst-agents`' context

**Files:**
- Modify: `apps/investment-analyst-agents/src/types.ts:212-227`
- Modify: `apps/investment-analyst-agents/src/context/loader.ts`
- Modify: `apps/investment-analyst-agents/tests/loader.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/investment-analyst-agents/tests/loader.test.ts`, inside
the existing `describe('loadContext', ...)` block:

```ts
  it('loads macro data when macro.json is present', () => {
    writeMockFiles(TMP, true)
    writeFileSync(join(TMP, 'macro.json'), JSON.stringify({
      asOf: '2026-07-21',
      marketAssets: [
        { ticker: 'CL=F', label: 'WTI Crude Oil', category: 'commodities', close: 84.66, change1d: 1.43, changePct1d: 1.72, changePct5d: 6.71, changePct30d: -6.49, trend: 'rising' },
      ],
    }))
    const ctx = loadContext('2026-07-21', { ...paths(TMP), macroPath: join(TMP, 'macro.json') })
    expect(ctx.macro?.asOf).toBe('2026-07-21')
    expect(ctx.macro?.marketAssets[0]).toMatchObject({ ticker: 'CL=F', close: 84.66 })
  })

  it('returns macro: null when macro.json is absent', () => {
    writeMockFiles(TMP, true)
    const ctx = loadContext('2026-07-21', { ...paths(TMP), macroPath: join(TMP, 'does-not-exist.json') })
    expect(ctx.macro).toBeNull()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/investment-analyst-agents && npx vitest run tests/loader.test.ts`

Expected: FAIL — `loadContext` doesn't accept `macroPath` and
`ctx.macro` is `undefined`, not matching either assertion.

- [ ] **Step 3: Add the `MacroSnapshot` type**

In `apps/investment-analyst-agents/src/types.ts`, near the other envelope
interfaces (before `ContextBundle` at line 212), add:

```ts
export interface MacroSnapshot {
  asOf:         string
  marketAssets: Array<{
    ticker:       string
    label:        string
    close:        number
    changePct1d:  number
    changePct30d: number
  }>
}
```

Then extend `ContextBundle` (currently `types.ts:212-227`) by adding one
field alongside `risk`:

```ts
  risk?:             RiskContext | null         // VAR, Sharpe, beta, max drawdown, per-ticker risk
  macro?:            MacroSnapshot | null        // live commodity/rate/index prices, for grounding the briefing's own price claims
  correlationReport?: string | null            // weekly pairwise correlation + concentration clusters
```

- [ ] **Step 4: Add the loader**

In `apps/investment-analyst-agents/src/context/loader.ts`:

Add to `LoaderPaths` (currently lines 9-22):
```ts
  riskPath?:             string
  macroPath?:            string
  correlationReportPath?: string
```

Add to `defaults()` (currently lines 24-37), alongside `riskPath`:
```ts
  riskPath:              join(process.cwd(), 'risk/risk.json'),
  macroPath:             join(process.cwd(), '../macro-asset-monitor/data/macro.json'),
  correlationReportPath: join(process.cwd(), 'correlation/report.md'),
```

Add the import at the top (alongside the other upstream types):
```ts
import type {
  ContextBundle, AnalysisJSON, SimulationJSON, GraphJSON, StockIntelJSON, WorldIntelJSON,
  PeopleEvent, PeopleEventsJSON, MacroSnapshot,
} from '../types.js'
```

Add a loader function, modeled on `loadRisk` (currently `loader.ts:102-106`):
```ts
function loadMacro(path: string): MacroSnapshot | null {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf-8')) as MacroSnapshot }
  catch { return null }
}
```

Wire it into `loadContext()` (currently `loader.ts:147-183`), alongside
the other optional loads:
```ts
  const risk               = loadRisk(p.riskPath)
  const macro               = loadMacro(p.macroPath)
  const correlationReport  = loadCorrelationReport(p.correlationReportPath)

  return { date, analysis, simulation, graph, stockIntel, worldIntel, profile, profileMissing, thesisSummary, peopleEvents, calibration, taxHarvest, risk, macro, correlationReport }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/investment-analyst-agents && npx vitest run tests/loader.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Run the full app test suite and typecheck**

Run: `cd apps/investment-analyst-agents && npx vitest run && npx tsc --noEmit`

Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/thanapold/Desktop/Projects.nosync
git add apps/investment-analyst-agents/src/types.ts apps/investment-analyst-agents/src/context/loader.ts apps/investment-analyst-agents/tests/loader.test.ts
git commit -m "$(cat <<'EOF'
feat(investment-analyst-agents): load live macro data into briefing context

investment-analyst-agents never read macro-asset-monitor's live
commodity/rate/index prices — it only saw ai-analysis-engine's prose
rationale. On 2026-07-21, with a correctly-grounded upstream regime
("WTI +1.72% on the day"), the briefing agent still fabricated "Oil
above $88-95" out of nothing, because it had no real number to check
against or cite instead. Adds an optional macro field (null if
macro.json is missing, matching the calibration/taxHarvest/risk
pattern already in this loader) as a prerequisite for grounding the
briefing prompt in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Render live macro data into the briefing prompt + grounding rule

**Files:**
- Modify: `apps/investment-analyst-agents/src/briefing/briefing-agent.ts`
- Modify: `apps/investment-analyst-agents/tests/briefing-agent.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/investment-analyst-agents/tests/briefing-agent.test.ts`,
inside the existing `describe('generateBriefing', ...)` block:

```ts
  it('includes real live market prices in the prompt when macro data is present', async () => {
    let capturedMessages: any[] = []
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    await generateBriefing({
      ...baseCtx,
      macro: {
        asOf: '2026-07-21',
        marketAssets: [
          { ticker: 'CL=F', label: 'WTI Crude Oil', close: 84.66, changePct1d: 1.72, changePct30d: -6.49 },
        ],
      },
    }, { client: mockClient })

    const userText = capturedMessages.map((m: any) => m.content).join('\n')
    expect(userText).toContain('84.66')
    expect(userText).toContain('WTI Crude Oil')
  })

  it('system prompt tells the model to cite Live Market Data over regime rationale', async () => {
    let capturedSystem = ''
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedSystem = params.system
          return { content: [{ type: 'text', text: 'Briefing.' }] }
        }),
      },
    } as unknown as Anthropic

    await generateBriefing(baseCtx, { client: mockClient })

    expect(capturedSystem).toContain('Live Market Data')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/investment-analyst-agents && npx vitest run tests/briefing-agent.test.ts`

Expected: FAIL — no macro data is rendered into the prompt yet, and
`SYSTEM_PROMPT` doesn't mention "Live Market Data."

- [ ] **Step 3: Build the macro block and insert it into the prompt**

In `apps/investment-analyst-agents/src/briefing/briefing-agent.ts`, find
where `risk`/`correlationReport` etc. are destructured from `ctx` near the
top of the prompt-building function (same function containing the
`riskBlock` at line 195 and the final section array at line 294). Add
`macro` to that destructuring, then add a `macroBlock` builder near
`riskBlock`/`correlationBlock`:

```ts
  const macroBlock = macro
    ? `\n## Live Market Data (as of ${macro.asOf})\n${macro.marketAssets
        .map(a => `  ${a.label} (${a.ticker}): ${a.close} (${a.changePct1d >= 0 ? '+' : ''}${a.changePct1d.toFixed(2)}% 1d, ${a.changePct30d >= 0 ? '+' : ''}${a.changePct30d.toFixed(2)}% 30d)`)
        .join('\n')}`
    : ''
```

Add `macroBlock` to the returned section array (currently `briefing-agent.ts:294-312`),
placed immediately before the Macro Regime line so the real numbers sit
next to the upstream narrative they should be checked against:

```ts
    correlationBlock,
    macroBlock,
    `\n## Macro Regime: ${r.regime} (${r.confidence} confidence)\n${r.rationale}\nKey Indicators:\n${r.keyIndicators.map(i => `  - ${i}`).join('\n')}`,
```

- [ ] **Step 4: Add the grounding rule to `SYSTEM_PROMPT`**

In `apps/investment-analyst-agents/src/briefing/briefing-agent.ts`, the
`SYSTEM_PROMPT` constant currently starts:

```ts
const SYSTEM_PROMPT = `You are a senior technology investment analyst with deep knowledge of global markets.
Write a concise daily investment briefing in Markdown.
Ground every claim in the provided data — cite specific tickers, signals, and events.
Each section must be tight: the full briefing should be readable in under 5 minutes.
Do not add generic market commentary not supported by the data.
```

Add immediately after that block (before the `CURRENCY RULE` section):

```ts
Do not add generic market commentary not supported by the data.

GROUNDING RULE: If you cite a specific commodity, rate, or index price
(e.g. oil, gold, 10Y yield), use the exact figure from the "Live Market
Data" section if one is present — never restate or round a number only
because the Macro Regime rationale text implies one. If Live Market Data
doesn't cover an asset the rationale mentions, describe direction/trend
qualitatively (e.g. "oil prices elevated") rather than inventing a
dollar level.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/investment-analyst-agents && npx vitest run tests/briefing-agent.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Run the full app test suite and typecheck**

Run: `cd apps/investment-analyst-agents && npx vitest run && npx tsc --noEmit`

Expected: all PASS, no type errors.

- [ ] **Step 7: Wire `macroPath` through the CLI entry point**

Check `apps/investment-analyst-agents/src/cli/*.ts` (whichever script
calls `loadContext`) — confirm it uses `loadContext(date)` with no
explicit `paths` override (so the new `macroPath` default takes effect
automatically) or, if it does pass explicit paths, add `macroPath` to
that call site matching the other explicit paths already there. No test
needed for this step — it's config wiring, covered by Task 2's loader
tests plus the manual verification in Step 8.

- [ ] **Step 8: Manually verify against real data**

Run:
```bash
cd apps/investment-analyst-agents
npx tsx src/cli/cli-briefing.ts 2>&1 | tail -50
```
(adjust script name to whatever Step 7 identified as the real entry
point)

Expected: completes without error; the generated briefing's Macro Regime
section cites the real live WTI price (check against
`apps/macro-asset-monitor/data/macro.json`'s current `CL=F` close) rather
than a number absent from that file.

- [ ] **Step 9: Commit**

```bash
cd /Users/thanapold/Desktop/Projects.nosync
git add apps/investment-analyst-agents/src/briefing/briefing-agent.ts apps/investment-analyst-agents/tests/briefing-agent.test.ts
git commit -m "$(cat <<'EOF'
fix(investment-analyst-agents): ground briefing prices in live market data

Two consecutive briefings (2026-07-20, 2026-07-21) cited a fabricated
oil price used to justify the top-priority AOT.BK action item. Day 1's
figure originated in ai-analysis-engine (fixed separately); day 2's
figure was fabricated here, one stage downstream, because this agent
never had a real price to cite or check against — only ai-analysis-
engine's prose rationale. Renders macro-asset-monitor's live prices
into a new "Live Market Data" prompt section (placed next to the Macro
Regime narrative it should be checked against) and adds an explicit
rule to use those exact figures rather than inventing a number implied
by the rationale text.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
