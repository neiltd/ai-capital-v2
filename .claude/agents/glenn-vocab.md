# Glenn's vocabulary state — what Neil already understands

Glenn reads this at the start of every job to decide how much to explain.
Glenn is read-only and does **not** edit this file. He proposes changes at
the end of his output; the main agent or Neil applies them.

Three tiers. Move terms **down** as Neil internalises them.

---

## Tier 0 — Never explain. Assume full fluency.

Neil spent ~5 years as a Data Scientist / ML Engineer at KBTG doing
credit-risk modelling, fraud detection and customer analytics, and is
finishing an MSBA at UCLA Anderson. Explaining anything in this tier is
condescending and actively damages the working relationship.

Statistics and modelling: correlation, covariance, regression, beta as a
regression coefficient, R², p-values, significance, distributions,
variance, standard deviation, sampling, overfitting, cross-validation,
train/test split, feature engineering, model drift, calibration,
backtesting, confusion matrices, precision/recall, AUC.

Engineering and data: SQL, Postgres, schemas, joins, indexes, APIs, JSON,
git, CI, DAGs, queues, caching, timezones, floating point.

Business analytics: cohort analysis, segmentation, A/B tests, funnels,
unit economics, CAC/LTV.

---

## Tier 1 — Explained already. Use freely; one clause of reminder at most.

Terms Neil has met and shown he follows. Do not re-teach these from
scratch. A short appositive is fine: "the sleeve (his discretionary
stock-picking bucket)".

- **sleeve** — a named bucket of the portfolio with its own rules
- **core / satellite** — core is the untouchable index engine; satellite is
  the discretionary stock-picking bucket, capped at 15%
- **denominator problem** — a share reported against the wrong base, making
  it look bigger or smaller than it is
- **hedged / unhedged** — whether a fund neutralises its currency exposure
  back to baht
- **DCA** — dollar-cost averaging; buying a fixed amount on a schedule
- **dip ladder** — pre-set price levels that each release a fixed tranche
- **tranche** — one slice of a planned purchase
- **de-THB** — the mission: reduce true Thai-home exposure
- **Thai-home exposure** — Thai assets *plus* baht cash, as a share of net
  worth

---

## Tier 2 — Still explain properly on each appearance.

Finance's private vocabulary that has been *used at* Neil but not yet
unpacked well enough to assume it stuck. Define inline, in a half-sentence,
then use normally.

- **read-through** — inferring one company's results from another's
- **basis point** — one hundredth of a percent
- **ARR / net new ARR** — annual recurring revenue; the new increment added
  in a quarter
- **billings** — what was invoiced, which leads recognised revenue
- **situs** (US estate tax) — the legal location of an asset, which decides
  whose estate tax applies
- **UCITS** — the EU fund wrapper, usually Irish-domiciled, that avoids US
  estate tax for non-US holders
- **carry trade / carry unwind** — borrowing in a cheap currency to buy
  higher-yielding assets, and the forced unwind when that reverses
- **disposition effect** — selling winners early and holding losers too long
- **status-quo bias** — leaving a position alone because nobody ever put it
  back in the decision set
- **wash sale** — a US rule that disallows a loss if you rebuy within 30
  days; **does not apply to Neil**, and the pipeline wrongly applies it
- **tax-loss harvesting** — realising a loss to offset taxable gains; also
  largely irrelevant to Neil, since Thai mutual-fund and SET gains are exempt
- **HSCEI** — the Hang Seng China Enterprises index: Hong Kong-listed
  Chinese companies, heavy in state banks and energy
- **REER** — real effective exchange rate; a currency against a
  trade-weighted basket, adjusted for inflation
- **provident fund (กองทุนสำรองเลี้ยงชีพ)** — the Thai employer retirement
  scheme; Neil knows the institution, but not always how it is being used
  in a portfolio argument

---

## How Glenn proposes updates

At the end of any job where he taught a term properly, Glenn ends with:

```
VOCAB: promote <term> Tier2 -> Tier1   (explained in full this session)
VOCAB: add <term> Tier2                (new term encountered)
```

Nothing else. The main agent applies these. If Neil says "you don't need to
explain X anymore," that is an immediate promotion — his word beats this
file.
