# AI Capital — 5-Year Financial Plan (July 2026 → Mid-2031)

**Prepared for:** Neil (Thanapol Doungsaeng) | **Goal:** $1,000,000 USD net worth by ~July 2031
**Prepared by:** Fable-model agent, grounded in live portfolio/risk/tax data on 2026-07-06

> **Editor's note (2026-07-06, same day):** Section 0 below identified a real bug in
> `apps/investment-analyst-agents/src/risk/risk-runner.ts` — THB position values were
> summed into `portfolioValueUSD` without currency conversion, inflating portfolio value
> ~7x and AOT.BK's reported concentration from ~13% of net worth to a fictitious 60%.
> **This has been fixed** (FX conversion added, reusing the `fetchUsdThb()` pattern
> already used in `tax-harvest-runner.ts`) and `risk.json`/`risk/report.md` have been
> regenerated with correct numbers before today's briefing ran. The analysis and figures
> below already use the corrected ~$74.6K net-worth basis — they were computed by
> independently reproducing the correct math, not by reading the (then-buggy) risk.json.

---

## 0. Critical data-quality finding — read this first

**The risk pipeline's portfolio value is wrong, and it likely inflated the basis for the $1M goal.**

`risk.json` reported `portfolioValueUSD: 535,129` with AOT.BK at 60.0% weight. That number is the sum of **raw THB values for SET stocks added to USD values for US stocks with no currency conversion** (321,250 + 138,150 + 65,405 THB treated as dollars + $10,324 of actual US positions = 535,129). The 2026-07-03 briefing inherited the same distortion.

**The true portfolio, converted at 33.28 THB/USD (the rate in `harvest.json`), is ~$74,574 USD:**

| Bucket | USD | % of NW |
|---|---:|---:|
| Cash (THB ฿421,813 + USD $14,519) | $27,194 | 36.5% |
| Thai SET equity (AOT, SCB, GULF) | $15,769 | 21.1% |
| Tax-locked TH funds (PFM009, 2× THAIESG) | $14,526 | 19.5% |
| US equity (LLY, CRWD, PLTR, NET) | $9,009 | 12.1% |
| DCA TH funds (SCBCEH, K-VIETNAM, KFINDIA-A) | $6,760 | 9.1% |
| Gold | $1,315 | 1.8% |

Corrected concentration: **AOT.BK is 12.9% of total net worth** (not 60%), and ~37% of the liquid tactical securities book (this matches the corrected `risk.json` post-fix: AOT.BK = 37.0% of the priced/analyzed subset). Still the dominant single-country bet, but not the hair-on-fire number the pipeline showed.

---

## 1. Target allocation and glide path

Target (end-state, ~2028 onward), designed for a late-20s/early-30s accumulator earning THB but with a USD-denominated goal:

| Bucket | Today | Target | How |
|---|---:|---:|---|
| US/global equity (VOO-style core + tactical) | 12% | **45%** | Nearly all new Phase B cash goes here |
| Thai SET equity | 21% | **10-12%** | Trim AOT (§3); no adds to SCB/GULF |
| EM funds (India, Vietnam) | 3.5% | **10%** | Continue DCA; redirect SCBCEH's slot |
| Tax-locked TH funds | 19.5% | shrinks passively to ~10% | Hold; continue THAIESG contributions for the tax deduction |
| Gold | 2% | **5%** | Add on Phase B cash flow |
| Cash / short T-bills | 36.5% | **10-15%** | Deployed per below |

**Glide path:**
- **Now → Dec 2026 (Phase A):** Keep ~$15K of the $27K cash as living runway — you're a student, this is your safety net, do not fully deploy it. Move ~$8-10K of excess USD cash into a US broad-market position in 2-3 tranches (e.g., monthly Aug-Oct). Execute the SCBCEH harvest and AOT partial trim (§3). Continue existing DCA. Net effect by Jan 2027: US/global ~28%, cash ~18%, Thai SET ~14%.
- **Jan 2027 → mid-2028 (Phase B ramp):** 70% of new monthly cash to US/global equity, 20% to India/Vietnam DCA, 10% to gold, until targets are hit. Max out THAIESG/SSF-type contributions each December for the Thai tax deduction (this directly raises your investable amount by cutting your effective tax rate).
- **2028+:** Rebalance annually back to target; no bucket &gt;±5% drift.

---

## 2. Phase B investable cash — three scenarios

**Assumptions (stated explicitly):** FX = 33.28 THB/USD. Bonus = 3 months (mid-range of the 2-6 banking norm). Provident fund: 5% employee contribution with employer match (KBank PF match is typically 5-8% — the match is *extra* net worth, counted separately below). Thai PIT with standard 100K expense deduction + 60K personal allowance + PF/SSO deductions. Bangkok cost of living for a single AVP-grade returnee: **฿45-55K/month** (rent ฿15-22K, rest food/transport/discretionary). If you live with family, add ฿15-20K/month to every investable figure.

| Base salary | Gross/yr | Eff. tax | Take-home/mo (avg incl. bonus) | **Investable/mo** | In USD |
|---|---:|---:|---:|---:|---:|
| ฿100K | ฿1.50M | 11.9% | ฿103K | **฿48-58K** | **$1,450-1,750** |
| ฿120K | ฿1.80M | 13.9% | ฿121K | **฿66-76K** | **$1,980-2,280** |
| ฿150K | ฿2.25M | 15.9% | ฿148K | **฿93-103K** | **$2,780-3,080** |

Plus PF (yours + match): roughly ฿12K / ฿15K / ฿19K per month of additional locked-in net worth in the three scenarios. That's real wealth even though it's illiquid — worth ~$40-60K extra by 2031.

Savings rates implied: ~50%, ~58%, ~66% of take-home. Aggressive but achievable for a single returnee with no rent obligation gap; the bond period means income reliability is high, which justifies running a thin cash buffer (3 months, not 6).

---

## 3. AOT.BK recommendation: **trim ~40-50% now-to-August, in 2 tranches**

- **The corrected risk picture:** 12.9% of NW in one stock, plus SCB+GULF pushing the correlated Thai bloc to 21%+. Not catastrophic, but AOT is your largest non-locked position, down 14% (฿-53,150), with a thesis the briefing itself rates "under pressure" (oil cost drag, Hormuz tail risk explicitly modeled at 25% probability with a -40% AOT scenario).
- **The decisive fact: Thai SET capital gains are tax-exempt for resident individuals** (`harvest.json` confirms). Selling AOT has *zero* tax cost and zero tax benefit — it's a pure portfolio decision. There is no "wait for the harvest" reason to hold.
- **The Phase A constraint cuts the other way from what you'd expect:** because you have *no new cash* until 2027, selling AOT is your **only meaningful source of redeployable capital** ($3.9-4.8K from a 40-50% trim) to start the US/global build *now* instead of waiting 6 months. Waiting costs you half a year of compounding in the bucket you're structurally underweight.
- **Why not sell all:** the briefing's base case (50%) supports a hold, aviation recovery isn't dead, and dumping the full position at a -14% low is capitulation, not risk management. Sell 2,000-2,500 shares now (tranche 1 this week, tranche 2 on any de-escalation bounce or by end-August), keep the rest with a hard stop: **if WTI &gt;$100 or Hormuz disruption materializes, exit the remainder immediately** — that's the briefing's own trigger playbook.
- Redeploy proceeds into US broad equity (respecting the CRWD wash-sale window until 2026-07-15 — a broad index fund has no wash-sale issue).

---

## 4. Return assumptions and the honest $1M math

**Assumptions:** US/global equity 7% nominal (5% bear / 10% bull bands); Thai SET 5%; India/Vietnam 8% with high vol; gold 3%; cash 2%; blended portfolio **~7% nominal** at target allocation; US CPI ~2.5%, Thai ~1.5%; THB/USD flat at 33.28 (THB appreciation would help the USD goal; not counted on).

**Phase A (Jul-Dec 2026):** no contributions, ~$6K cash drawdown for living top-ups, 7% on invested assets → **~$70K entering Jan 2027**.

**Phase B (Jan 2027 → Jul 2031, 54 months of contributions):**

| Scenario | r = 5% | r = 7% | r = 10% | r = 15% |
|---|---:|---:|---:|---:|
| ฿100K base ($1,500/mo) | $178K | $190K | $209K | $244K |
| ฿120K base ($2,100/mo) | $214K | $227K | $249K | $289K |
| ฿150K base ($2,900/mo) | $262K | **$278K** | $303K | $348K |

**$1M by mid-2031 is not achievable. It's not close, and no reasonable assumption changes that.** The best realistic case (150K base, 7%) lands at ~$278K — about 28% of target. Even a sustained 15%/year (top-decile outcome) with the best salary scenario reaches ~$350K. To actually hit $1M by Jul 2031 you would need **~$14,400/month (~฿478K/month) of contributions at 7%** — more than 4× your entire gross salary in the best scenario. Adding the PF match (~$50K) and a THB appreciation to 30 doesn't move the answer either.

Why the goal was probably set wrong: **$535K → $1M in 5 years is a plausible 13.3% CAGR — but $535K was the currency-bug number.** From the real ~$74.6K base, $1M in 5 years requires ~68% CAGR with no contributions. The goal inherited the pipeline's bug.

**What would have to be true — pick one:**
1. **Timeline extension (recommended):** At the 150K scenario with contributions growing 7%/yr as your KBank comp rises, 8% returns → **$1M around 2038** (~11 years). At 120K base → ~2040. That is the honest trajectory.
2. **Revised 2031 target:** **$250-300K by mid-2031** is the realistic, still-ambitious milestone. That's ~4× current NW and requires a 55-65% savings rate — hard enough to be a real goal.
3. **Income step-change after the bond:** the bond period blocks job-hopping until it expires (likely ~2029-2030 depending on terms — confirm the exact bond length in your contract). A post-bond move to a ฿250K+/mo role or equity-bearing comp is the single biggest lever for pulling $1M forward to ~2034-2035. Nothing inside this portfolio substitutes for that.

---

## 5. Actions

**This week (by ~July 12):**
1. ~~Fix the FX bug in the risk pipeline~~ — **done 2026-07-06**, see editor's note at top.
2. **Sell SCBCEH** (~฿138K / $4.1K): the briefing's own highest-accuracy signal (TRIM, 76.5% 7-day accuracy) already calls it, it's harvestable (-฿9.5K offsets taxable Thai fund gains), and the China thesis has no catalyst. Redirect its DCA schedule to KFINDIA-A/K-VIETNAM or a global fund.
3. **AOT tranche 1:** sell 2,000-2,500 shares (~฿128-160K), tax-free. Park proceeds with excess USD cash and start the US broad-market build in monthly tranches from August (avoid any CRWD/individual-name rebuys before 2026-07-15 per wash-sale windows).

**Ready before Jan 2027:**
1. **Comp negotiation (Aug-Sep):** anchor at ฿150K base — the table above shows the 100K→150K difference is worth ~$88K of net worth by 2031 alone. Also negotiate the **PF match percentage** (5% vs 8% is ~$20K over the plan) and confirm the **bond duration in writing** — it determines when lever #3 unlocks.
2. **Automation ready day one:** standing monthly transfers (70/20/10 per §1) configured so the first January paycheck invests itself. Every month of "I'll set it up later" costs ~฿70-100K of contributions. Pre-plan December THAIESG/SSF top-ups to cut your effective tax from ~14-16% toward 10-12%.
3. **Decide the revised goal now:** either formally re-baseline to **$275K by 2031 / $1M by ~2038**, or define the post-bond income plan that justifies keeping an earlier date. Update the scenario-simulator with the corrected base so the system tracks the real target.

---

**Bottom line:** the portfolio is healthy but 7× smaller than the pipeline reported (now fixed). The plan that actually works is: free up dead capital (SCBCEH, half of AOT) now since Phase A brings no new cash, win the salary negotiation, then run a 55-65% savings rate into a 45% US-equity core. That gets you to ~$275K by 2031 and $1M by ~2038 — or sooner if post-bond income breaks out.
