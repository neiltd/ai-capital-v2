# Discovery Agent Enhancement Proposal — 2026-07-06

**Status: proposal only. No production code has been changed.**

Scope: the *decision-making* logic of the weekly discovery agent
(`apps/scenario-simulator/src/discovery/` + `src/cli/cli-discover.ts`). The
measurement plumbing fixed in today's reset (`closePosition()` / realized-P&L
ledger, SPY benchmark capture at open/close, the >60%-move price sanity guard
in `price-fetcher.ts`) is taken as given and not re-litigated here.

Every claim below was verified by reading the current code. Where something
could not be verified (e.g. the folklore "wave-analyzer risks 2% per trade"),
it is flagged explicitly.

---

## 1. How the agent actually decides today (verified flow)

Weekly (Sunday-only, `packages/queue/src/jobs.ts` → `scenario-discover`,
depends on `scenario-simulate`):

1. **Candidate sourcing** (`ingestion-reader.ts`, `ticker-filter.ts`) —
   reads the `capital.watchlist` table (Postgres) or the SQLite fallback.
   `getRecentNews()` **always returns `[]`** (lines 74–78), so
   `extractTickers()` never runs on anything and the entire `news_mention`
   source is dead code. Candidates are the ~100+ watchlist rows, minus real
   portfolio + already-open discovery tickers, with `newsSnippet: null`.
2. **Light scoring** (`discovery-scorer.ts`) — one batched Sonnet call scores
   every candidate 0–100. Inputs per candidate: ticker, company name, source
   tag. Nothing else. The prompt asks Claude to judge "recent news signal
   strength, momentum, and data availability" — with no news, no prices, no
   momentum data supplied.
3. **Gate + budget** (`cli-discover.ts`) — score ≥ `THRESHOLD` (70) enters the
   loop; allocation = 12%/8%/5% of `BUDGET × 0.8` by score band (≥90/≥80/else),
   capped by remaining budget (`computeAllocation`, lines 33–41).
4. **Deep analysis** (`discovery-analyzer.ts`) — per ticker, one Sonnet call
   produces best/base/disruption scenarios + a buy/watch recommendation with
   high/medium/low conviction. Cached 7 days unless in `HOT_TICKERS`.
5. **Bear review** (`discovery-reviewer.ts`) — on buy recommendations only, a
   second Sonnet call critiques the bull thesis; `adjustForBear` downgrades
   conviction (bearScore ≥ 40), flips to watch (≥ 55), or rejects (≥ 75).
6. **Open position** — if still a buy: `shares = allocation / price`, position
   recorded with the *light-filter* score, LINE alert sent.
7. **Exit** — manual only: `npm run discover -- --exit=TICKER --price=… --reason=…`.
   Nothing automated ever closes a position.

---

## 2. Verified weaknesses in the decision logic

### W1 — The score that drives everything is generated from almost no evidence

- `ingestion-reader.ts:74-78`: `getRecentNews()` hardcodes `return []` ("news
  content is stored in LanceDB/pgvector"). Consequence chain: `extractTickers`
  never fires → every candidate has `newsSnippet: null` → the scorer prompt's
  own criteria ("recent news signal strength, momentum") are unsatisfiable
  from the input. Claude is scoring ~100 tickers from its parametric memory
  of these companies, i.e. its training-data priors, refreshed never.
- Prices *are* fetched (`cli-discover.ts:218`) but only after scoring, and only
  the single spot price reaches the analyzer. The scorer sees no price at all.
- The scorer system prompt hardwires the bias that produced last month's
  observed failure: *"The investor focuses on AI infrastructure,
  semiconductors, and emerging tech"* (`discovery-scorer.ts:6`). With a
  candidate universe whose largest theme is `ai-infrastructure` (14 tickers in
  `themes.config.ts`) and a prompt that rewards sector fit to AI infra,
  15-of-16-picks-one-theme is not an accident — it is the specified behavior.

### W2 — Sizing ignores everything the pipeline learns after the light screen

`computeAllocation(runningDeployed, candidate.score)` uses only the *light*
score. Verified consequences:

- The analyzer's conviction (high/medium/low) has **zero** effect on size.
- A bear review that downgrades conviction (e.g. high → medium at bearScore
  40–54) changes **nothing** about the dollars deployed. Only a full
  flip-to-watch (≥ 55) prevents the position.
- No volatility adjustment: a 90-scoring OKLO (small-cap nuclear SPAC-alike)
  and a 90-scoring MSFT both get 12% of deployable — wildly different
  risk-per-dollar.
- No stop-loss or downside level is ever defined, so "how much can this pick
  lose before the thesis is wrong" is never asked, let alone used for sizing.

**In-repo precedent, honestly stated:** wave-analyzer's `action-generator.ts`
(`computePrices`, lines 25–64) derives a structural stop (wave-2/wave-4 pivot),
a 1.618-extension target, and a risk:reward ratio for every signal. However,
the "risk 2% of a trade budget per position" share-count formula **does not
exist anywhere in wave-analyzer's code** — `cli-trade.ts` takes `--shares` as
a manual flag. The real precedents this repo has proven are (a) stop/target/R:R
derivation (wave-analyzer) and (b) annualized per-ticker volatility math
(`risk-runner.ts:234`, `stdev(rets) * √252`). The 2%-risk rule proposed in P2
below combines them; it is a new policy, not a port.

### W3 — There is still no *exit decision*, only an exit *mechanism*

The reset added `closePosition()`, but the only caller is the manual `--exit`
CLI path (`cli-discover.ts:50-103`). The weekly run refreshes prices on open
positions and does nothing else with them:

- Every scenario carries a `triggers: string[]` array — **nothing ever checks
  a trigger** after the position opens.
- No stop level, no time stop, no thesis re-review, no "bear review of the
  existing book."
- Last month's failure (budget full → five dead runs) is therefore only half
  fixed: the agent can now be *told* to free budget, but it can never *decide*
  to. Left alone, it will refill the book and go dead again.

### W4 — No calibration loop from score → realized outcome

The main briefing already runs exactly this loop: `backtest-runner.ts` scores
archived predictions against realized prices, emits
`backtest/calibration.json`, and `briefing-agent.ts` injects it with the
SELF-CALIBRATION RULE. It demonstrably has teeth — the current
`calibration.json` shows `calibrationInverted: true` with high-conviction
calls 18.5pp *worse* than medium, and the 2026-06-18 briefing correspondingly
downgraded its own labels.

Discovery has a 0–100 score and now (post-reset) stores it on both open and
closed positions along with benchmark prices at open/close — everything needed
for the same loop exists in the schema for the first time. But no code computes
score-band vs. realized outcome, and neither the scorer nor the analyzer prompt
ever hears how its past scores performed.

### W5 — No diversification awareness, within a batch or vs. the real portfolio

- The scorer receives `realPortfolioTickers` as a flat comma list with one soft
  instruction ("avoid scoring up close substitutes"). No weights, no themes, no
  clusters. The analyzer and the sizing code receive nothing about either
  portfolio.
- The candidate loop walks `topScorers` one at a time; there is no per-theme or
  per-cluster cap, so a batch of correlated AI-infra names sails through
  together.
- Two existing assets are ignored: `themes.config.ts` already maps every
  watchlist ticker to one of 17 themes, and `correlation-runner.ts` already
  computes 90-day correlation clusters with a 30% concentration warning for
  the real portfolio (and runs *after* discovery in the same Sunday DAG — its
  latest report is from the prior week, which is fine for this purpose).
- Concretely: the real portfolio holds CRWD, NET, PLTR — heavy AI-infra beta.
  A new 5–12% AI-infra paper pick is stacking the household's dominant risk
  while presenting itself as discovery.

### W6 — The bear critiques rhetoric, not facts, and its work is thrown away

The bear prompt itself is decent (demands named mechanisms, peer comparisons,
calibrated bearScore semantics). The structural problems:

- **Input starvation**: `reviewCandidate` receives only the bull's own output
  (scenarios, rationale, score) plus the same macro string. It has no
  independent evidence — no news, no valuation, no short interest, no insider
  sales, no analyst ratings — even though `capital-intelligence-ingestion`
  collects short-interest, Form-4, and analyst-ratings data. A bear that can
  only re-read the bull's essay is a debate partner, not a fact-checker.
- **Output discarded**: bearScore, topConcerns, and bearNarrative survive only
  as a console.log line and a rationale-string prefix. They are not persisted
  on the position, not in `DiscoveryJSON`, nowhere. It is therefore impossible
  to ever measure whether the bear review helps (compare: briefing calls are
  archived to `predictions.jsonl` precisely so the backtest can score them).
- **Arbitrary, un-calibratable thresholds**: 40/55/75 in `adjustForBear` were
  picked a priori and, given the point above, can never be tuned from data.
- **Cache mismatch**: a cached bull thesis (up to 7 days old) gets a fresh bear
  every run; the adjustment applies to stale scenarios.

### W7 — Macro regime is a decorative string

- `cli-discover.ts:114` keeps only `analysis.latestRegime?.regime` — the bare
  label ("AI Acceleration"). The confidence, rationale, keyIndicators, and
  affectedTickers that `regime-analyzer.ts` carefully synthesizes from four
  weighted signal sources (company health, world intel, liquidity, gov flows)
  are all dropped.
- More importantly, **no decision changes with the regime**: threshold, size
  bands, and cash reserve are identical whether the regime is "AI Acceleration
  (high confidence)" or "Stagflationary Pressure (high confidence)". The
  regime string is pasted into prompts and otherwise inert.

### W8 — Smaller verified gaps

- **Unvalidated scorer output**: `discovery-scorer.ts:83-94` keeps any ticker
  Claude returns; a hallucinated ticker not in the candidate set falls back to
  `company = ticker, source = 'companies_table'` and proceeds to pricing and
  analysis. If Yahoo happens to resolve it, it can be bought. Low probability,
  trivial to close (drop entries where `candidateMap.get()` misses).
- **Budget never reconciles with realized P&L**: `BUDGET` is a hardcoded
  default (`20184.73`); closing a position frees its cost basis (deployed =
  Σ shares×avg_cost over *open* rows) but realized gains/losses never adjust
  the budget. Acceptable, but it should be an explicit documented choice, and
  the paper book's "return" should be computed off the ledger, not the budget.
- **No per-run position-count cap**: only the budget cap limits how many new
  positions one Sunday can open; a generous-scoring week can open 6+ names at
  5% each in one shot.
- **Cache TTL == run cadence**: `ANALYSIS_CACHE_TTL_DAYS = 7` with a weekly
  run means the cache is almost always just-expired; it only helps for reruns
  in the same week. Harmless, but the cache is mostly not doing what it looks
  like it does.

---

## 3. Proposals

Each proposal states the concrete change, why it should measurably improve
decisions, and the tradeoffs.

### P1 — Theme- and concentration-aware selection and sizing  *(fixes W5, part of W1)*

**Change:**

1. Make a ticker→theme map available to discovery. Simplest robust option:
   a small generated `themes-map.json` exported by
   `capital-intelligence-ingestion` (it owns `themes.config.ts`) into its
   `data/` dir during ingestion, read by `cli-discover.ts` the same way it
   reads `analysis.json`. Avoids a cross-app source import.
2. In `cli-discover.ts`, before the candidate loop, compute:
   - per-theme deployed value across **open discovery positions**;
   - per-theme USD value across the **real portfolio**
     (`portfolio-store.getPositions()` already returns per-position values;
     apply the THB→USD conversion the same way `correlation-runner.ts` does).
3. Enforce two mechanical rules in the loop:
   - **Batch/theme cap**: a theme may hold at most 30% of `maxDeployable`
     across the paper book (mirrors `CONCENTRATION_WARN_PCT = 30` already used
     by correlation). Once hit, further candidates from that theme are skipped
     with a logged reason (`theme-cap`), regardless of score.
   - **Real-portfolio overlap haircut**: if the candidate's theme already
     represents > 30% of the real portfolio's USD value, halve the allocation
     and record the haircut in the position rationale.
4. Prompt changes: replace the scorer's "investor focuses on AI
   infrastructure, semiconductors, and emerging tech" line with a neutral
   mandate plus an explicit block listing (a) current paper-book theme
   weights, (b) real-portfolio theme weights, and the instruction that
   *marginal diversification value is part of the score*. Pass the same block
   to the analyzer.

**Why:** this is the direct fix for the observed, measured failure (15/16
picks one theme; realized performance = sector beta). The 30% number is not
invented — it is the concentration threshold this repo already treats as a red
flag for the real portfolio. The haircut rule encodes the actually-correct
insight from the task framing: a paper agent adding AI-infra on top of
CRWD/NET/PLTR is stacking the human's existing risk, not discovering anything.

**Tradeoffs:** the theme map needs occasional maintenance (new watchlist
tickers must get a theme). A hard cap can suppress a genuinely dominant regime
trade — in a real AI-supercycle year, the capped agent will underperform an
uncapped one; that is deliberate, since the goal of the paper book is to
measure *stock-picking skill net of theme beta*, which requires forcing
cross-theme picks. Cost: negligible (no new LLM calls; a few hundred prompt
tokens).

### P2 — Risk-based sizing with an explicit stop, and automated weekly exit checks  *(fixes W2 + W3)*

**Change (sizing):**

1. Fetch ~60 days of daily candles per top scorer (the fetch pattern already
   exists in `correlation-runner.ts:fetchPriceSeries`; ~5–10 extra Yahoo calls
   per week).
2. Derive a volatility stop: `stop = entry − 2 × ATR20` (or equivalently
   `entry × (1 − 2·σ_daily·√5)` using the same stdev math as
   `risk-runner.ts:234` if ATR is not worth implementing).
3. Size by risk, not score band:
   `riskBudget = 2% × BUDGET` (≈ $404); `shares = riskBudget / (entry − stop)`;
   **cap notional** at the current score-band percentage (12/8/5% of
   deployable) so low-volatility names cannot balloon to huge notionals.
   Apply a conviction multiplier from the *post-bear* adjusted action:
   high 1.0×, medium 0.75×, low 0.5× — this finally makes the analyzer's and
   bear's conviction output actually change dollars.
4. Persist `stop_price`, `target_price` (analyzer's base-scenario implied
   level, if emitted; else `entry + 2×(entry − stop)`), and the adjusted
   conviction on the position row (use the existing `migrateAddColumn`
   pattern in `paper-portfolio.ts`).

**Change (exits):** at the top of every weekly run, *before* opening anything:

1. **Stop check**: for each open position, if current price ≤ stored stop →
   `closePosition(ticker, price, 'stop hit', spy)`. Be honest in the reason
   string that this is a *weekly-checked* stop, not an intraday stop — on a
   weekly cadence the realized loss can far exceed the planned 2%.
2. **Time stop**: positions held > 180 days without hitting target → close
   with reason `time-stop`. Guarantees the ledger accumulates outcomes and
   budget recycles.
3. **Thesis check (LLM, throttled)**: only for positions that are down > 10%
   or held > 90 days, run the existing `reviewCandidate` machinery against the
   position's stored rationale; `suggestedAdjustment === 'reject'` → close
   with reason `thesis broken`. Throttling keeps this to ~0–3 Sonnet calls a
   week.

**Why:** sizing by distance-to-invalidation is the single biggest upgrade in
decision quality per line of code: it forces every buy to answer "at what
price am I wrong," equalizes risk across volatile and calm names, and wires
conviction into dollars. The exit rules convert the reset's *mechanism* into a
*policy*, directly preventing a repeat of the five dead budget-capped runs,
and — critically — they are what makes P3's calibration loop accumulate data
at all.

**Tradeoffs:** honest labeling required — the "2% risk" rule is a new policy
inspired by wave-analyzer's stop/R:R derivation, not code that exists there
today (verified: `cli-trade.ts` takes `--shares` manually). Weekly stops are
review levels, not stops; gap risk is unbounded between runs. Mechanical stops
will sometimes close positions that then recover (whipsaw) — accepted cost,
because a paper book that never realizes outcomes teaches nothing. Adds
schema columns and ~10 Yahoo calls; LLM cost roughly +0–3 bear-style calls a
week.

### P3 — Discovery calibration loop: `discovery-calibration.json`  *(fixes W4)*

**Change:**

1. New non-LLM step (either inside `cli-discover.ts` before scoring, or a tiny
   `cli-discover-calibrate.ts` run first): read
   `discovery_closed_positions` + open positions and compute, per score band
   (90+/80–89/70–79) and per stored conviction:
   `n`, win rate, avg return, and **avg return minus SPY over the same holding
   period** (both benchmark prices are now stored — this is the whole point of
   the reset's benchmark capture). Include open positions' unrealized-vs-SPY as
   clearly-labeled *provisional* rows so the loop produces signal before the
   first closes mature.
2. Write `data/discovery-calibration.json` alongside `discovery.json`.
3. Inject a calibration block into both the scorer and analyzer prompts,
   copying `briefing-agent.ts`'s `calibrationBlock` style, including the
   honest-emptiness rule: when `n < 5` in a band, render "insufficient data —
   do not adjust" rather than fake precision. When a band is underperforming
   SPY, instruct: "your ≥90 scores have underperformed SPY by X pp — reserve
   ≥90 for candidates with a named, dated catalyst."

**Why:** this is the same feedback mechanism that already caught the briefing
agent's inverted conviction labels (18.5pp penalty, visible in today's
`calibration.json` and acted on in the 2026-06-18 briefing). Without it, the
0–100 score is astrology with extra steps: it determines position size but is
never graded. The reset made this possible for the first time; not building
the loop now wastes the reset.

**Tradeoffs:** for the next few months `n` will be tiny and the block will
mostly say "insufficient data" — that is correct behavior, not a failure. Must
resist the temptation to act on n=3. Essentially free: no LLM calls to
compute, a few hundred prompt tokens to inject. Note plainly: **no historical
performance conclusions can be drawn today** — the ledger was reset this
morning; the old book's numbers measured sector beta and were discarded for
exactly that reason.

### P4 — Feed real evidence into the scorer  *(fixes W1's evidence half)*

**Change:**

1. Compute cheap momentum features locally, no LLM: 5d/30d/90d % change per
   candidate from the same Yahoo chart endpoint (batchable; ~110 calls weekly,
   comparable to what `correlation-runner.ts` already does every Sunday).
   Add one line per candidate to the scorer prompt:
   `NVDA (NVIDIA) — 5d +2.1% / 30d +9.4% / 90d +31.0%`.
2. Fix or delete the dead news path: either wire
   `IngestionReader.getRecentNews()` to the pgvector/LanceDB chunks that
   `capital-intelligence-ingestion` actually writes (verify queryability
   first — **not verified in this review**), or remove `extractTickers` and
   the `news_mention` source entirely so the code stops implying evidence it
   doesn't have. If wired: pass the 1–2 most recent chunk snippets per
   candidate into the scorer, which finally makes its "recent news signal
   strength" criterion answerable.

**Why:** the score currently reflects Claude's training-set memory of each
company. Momentum and recent news are the two cheapest real signals available
in this codebase, and both are already fetched elsewhere. This changes the
score from "what Claude remembers about NVDA" to "what happened to NVDA
lately" — which is what a weekly screen is for.

**Tradeoffs:** momentum features bias toward chasing recent winners; showing
both 5d and 90d and telling the model to distinguish fresh breakouts from
extended moves mitigates but does not eliminate this. Prompt grows ~1 line per
candidate (~110 lines) — fine for one batched call. The news-wiring option has
unverified plumbing cost; the delete option is honest and free.

### P5 — Arm the bear and keep its receipts  *(fixes W6)*

**Change:**

1. **Persist**: add `bear_score INTEGER`, `bear_concerns TEXT` (JSON) to
   `discovery_positions` and `discovery_closed_positions` via
   `migrateAddColumn`; include the full `AdjustedRecommendation` (bull, bear,
   adjusted, wasAdjusted) in `DiscoveryJSON.actions`. This makes the bear
   auditable and, once P3 exists, calibratable: *do positions the bear
   flagged at 40–54 (downgraded but still bought) underperform the ones it
   waved through?* That question is currently unanswerable by construction.
2. **Independent evidence**: give `reviewCandidate` the P4 momentum lines
   plus, where ingestion has them, short-interest and recent Form-4 insider
   sales for the ticker (ingestion collects both; retrieval path needs
   verification). A bear with the insider-selling tape is adversarial in
   fact, not just in tone.
3. **Cache coherence**: store the bear review in the analysis cache alongside
   the bull, so a cached bull reuses its contemporaneous bear instead of
   getting a fresh bear against week-old scenarios.

**Why:** the bear is the agent's only internal check, and today it argues
against an essay using only the essay. Persistence costs nothing and is a
precondition for ever knowing whether the 40/55/75 thresholds are right;
evidence injection is what turns "devil's advocate" from a rhetorical exercise
into a second analyst.

**Tradeoffs:** more tokens per bear call (evidence block); short-interest /
Form-4 retrieval paths unverified — scope that as a follow-up if awkward.
Caching the bear means a genuinely changed situation within 7 days is missed
for non-hot tickers — same tradeoff the bull cache already accepts.

### P6 — Make the regime a decision input, not a caption  *(fixes W7)*

**Change:**

1. Pass the full `latestRegime` object (label, confidence, rationale,
   keyIndicators) into the scorer, analyzer, and bear prompts instead of the
   bare label.
2. Add one mechanical, conservative policy: have the **analyzer** emit an
   extra enum field `regimeFit: 'aligned' | 'neutral' | 'contra'` (does this
   pick's base scenario depend on the current regime persisting, is it
   regime-neutral, or is it a bet against the regime?). Use it as a sizing
   multiplier: aligned 1.0×, neutral 1.0×, contra 0.75× — and when regime
   `confidence === 'low'`, multiply all new-position sizes by 0.75× and leave
   the threshold alone.

**Why:** the regime synthesis is one of the most information-dense artifacts
this pipeline produces (four weighted sources, liquidity, gov flows), and
discovery throws away everything but two words of it. The `regimeFit` design
deliberately avoids the brittle alternative (keyword-matching free-form regime
labels to "risk-on/risk-off") by letting the model that already reads the full
regime context classify the *relationship*, while keeping the numeric policy
tiny and hand-auditable.

**Tradeoffs:** one more field per analyzer call (free). The multipliers are
guesses until P3 accumulates data — keep them mild (0.75, not 0.25) so a
wrong regime read cannot dominate outcomes. Note the honest caveat that
regime-conditioning can be procyclical: in a mislabeled regime the agent
de-risks exactly when it should not. Mildness + calibration is the mitigation.

### P7 — Hygiene batch  *(fixes W8)*

- Drop scorer output rows whose ticker is not in the candidate map
  (`discovery-scorer.ts:83-94`) instead of fabricating a fallback candidate —
  closes the hallucinated-ticker-gets-bought hole in ~3 lines.
- Cap new positions per run (suggest 3). Forces the agent to rank, not spray,
  and spreads entries across weeks (accidental time-diversification).
- Document (or change) the budget/realized-P&L relationship explicitly; report
  paper-book performance from the ledger (Σ realized + Σ unrealized vs. SPY),
  never from budget arithmetic.
- Either lengthen `ANALYSIS_CACHE_TTL_DAYS` to ~10 (so the weekly cadence
  actually hits cache) or shorten to 1 and admit it's a same-day rerun guard.

---

## 4. Priorities

If only 2–3 get built, in this order:

1. **P1 — concentration-aware selection/sizing.** Directly fixes the failure
   the month-long run actually exhibited and measured (one-theme book, sector
   beta masquerading as skill), uses two assets the repo already has
   (themes.config, the 30% cluster convention), and costs no LLM budget.
   Include the scorer-prompt de-bias — it is one line and the same root cause.
2. **P2 — risk-based sizing + automated exits.** The largest decision-quality
   upgrade (every buy must state its invalidation price; conviction finally
   moves dollars) and the prerequisite for everything downstream: without
   automated exits the realized-P&L ledger stays nearly empty and the budget
   re-jams.
3. **P3 — calibration loop.** Cheap, newly possible because of today's reset,
   and the only mechanism that ever tells you whether the score — and P1/P2's
   parameters — are earning their keep. Ship it early so data accrues while
   n grows.

P4 is the best fourth (arguably co-first for decision quality, but it touches
unverified vector-store plumbing in its full form — the momentum-only variant
is small and could be bundled into P1's prompt work). P5–P7 follow.

## 5. What could not be verified

- **Wave-analyzer's "2% risk per trade" sizing**: does not exist in code.
  `cli-trade.ts` requires manual `--shares`; the actual precedents are stop /
  target / R:R derivation (`action-generator.ts`) and volatility math
  (`risk-runner.ts`). P2 says so and is framed as a new policy.
- **News/pgvector retrieval for discovery** (P4/P5 evidence wiring): the
  chunks are written by ingestion, but their queryability from
  scenario-simulator was not traced end-to-end in this review.
- **Historical paper-book performance**: the ledger was reset today; the prior
  month's numbers measured AI-infra sector beta and support no conclusion
  about score→outcome relationships. No such relationship is claimed anywhere
  above.
- Current contents of the live `simulation.db` / Postgres tables were not
  queried; all claims are from code, not data.
