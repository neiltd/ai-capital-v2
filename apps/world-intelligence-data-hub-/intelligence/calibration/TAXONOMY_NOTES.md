# Event Type Taxonomy — Drift Observations

Running notes on `event_type` classification quality.  
Updated after each calibration run. Feeds into eventual schema revision decisions.

**Do not change the taxonomy during calibration.** These notes inform a future schema review
once operational stability is confirmed.

---

## 1. Categories That Feel Too Broad

### `armed_conflict`
The catch-all for anything that doesn't fit a more specific military type. Currently captures:
- Active ongoing wars (US-Iran conflict, Russia-Ukraine)
- Specific ground engagements within a larger war
- Threats of military action (ultimatums)

**Problem:** "Russia-Ukraine armed conflict update" and "Trump warns Iran of renewed military strikes"
are qualitatively different — one is a battlefield update, the other is coercive diplomacy.
The latter might better fit `peace_negotiation` (failed) or a new `military_threat` type.

**Observed cases:**
- Run #3 `51c14d8e`: "Trump Warns Iran: Accept Deal or Face Renewed Military..." typed as `armed_conflict`
  but describes a diplomatic ultimatum, not active combat.

### `other`
Used as fallback when no type fits. In Run #2, France's economic deterioration from Iran war
was typed as `other` (no `economic_spillover` or `macro_shock` type exists).

**Observed cases:**
- `35060430`: "France's Economy Faltering Under Iran War Shock" → `other`
  Should be: `economic_spillover` (proposed) or `supply_disruption` (existing, fits better)

### `diplomatic_incident`
Used for everything from bilateral summits to nuclear threats to routine diplomatic statements.

**Observed cases:**
- Trump-Xi Beijing summit → `diplomatic_incident` (correct but generic)
- Trump nuclear priority statement → typed `nuclear_incident` in one batch, `diplomatic_incident` in another
  → same event, different types across runs = dedup missed it (type mismatch)

---

## 2. Distinctions That Matter But Aren't Captured

### Military vs. Diplomatic Escalation

The current type set doesn't distinguish well between:
- Military escalation: troop movements, airstrikes, blockades (`airstrike`, `military_operation`)
- Diplomatic escalation: ultimatums, failed talks, sanctions threats (`peace_negotiation`, `sanctions`)
- Economic escalation: supply disruptions, market shocks, currency crises (`supply_disruption`, `market_crash`)

The `escalation_potential` field captures trajectory numerically (0.0–1.0), but the event_type
doesn't encode *which axis* the escalation is on. A peace negotiation breakdown (0.8 escalation)
looks the same as a missile test (0.8 escalation) in the type field alone.

**Proposed distinction axis (for schema review):**
```
escalation_domain: 'military' | 'diplomatic' | 'economic' | 'humanitarian' | 'mixed'
```
This is additive — doesn't require changing existing event_types.

### Nuclear: incident vs. capability vs. diplomacy

Three distinct nuclear scenarios are currently collapsed:
- `nuclear_incident`: used for both ICBM tests AND Trump's nuclear priority statement
- Missing: `nuclear_diplomacy` (IAEA inspections, NPT talks, nuclear deal frameworks)
- Missing: `nuclear_signaling` (tests intended as geopolitical signals, not incidents)

**Observed cases:**
- Sarmat ICBM test → typed `missile_attack` (Al Jazeera batch) vs `nuclear_incident` (SCMP batch)
  This event_type mismatch caused the same-day dedup to miss the merge.
  Root cause: ambiguity in whether a nuclear-capable ICBM test is primarily a `missile_attack`
  or a `nuclear_incident`.

**Recommendation (future):** Add `nuclear_test` as a distinct type. Currently `nuclear_incident`
implies something went wrong; a deliberate test is different from an accident.

### Supply Disruption vs. Energy Infrastructure

Both `supply_disruption` and `energy_infrastructure` appear for Hormuz blockade events:
- `c855aa83` (v1): Hormuz → `energy_infrastructure`
- `5639b349`, `08da6c7b` (v2): same event → `supply_disruption`

`energy_infrastructure` implies physical damage/change to infrastructure.
`supply_disruption` implies flow interruption without infrastructure damage.
A naval blockade is correctly `supply_disruption`. The v1 classification was wrong.

**Status:** Fixed in v2 prompt (no explicit mention, but Claude corrected it autonomously).
v1 event `c855aa83` remains in the file with wrong type — this is acceptable (historical artifact).

---

## 3. Cross-Run Type Consistency Issues

Events where the same real-world development received different `event_type` values across
extraction batches, causing same-day dedup to miss the merge:

| Event | Batch A type | Batch B type | Missed merge? |
|-------|-------------|-------------|---------------|
| Sarmat ICBM test | `missile_attack` | `nuclear_incident` | Yes — type mismatch |
| Trump nuclear statement | `nuclear_incident` | `diplomatic_incident` | Yes — type mismatch |
| Trump-Beijing summit | `diplomatic_incident` | `peace_negotiation` | Yes — type mismatch |

**Pattern:** When an event has both military AND diplomatic dimensions, different batches
pick different "dominant" dimensions. This is a prompt calibration issue, not a schema issue.

**Potential fix (without schema change):** Add guidance to extractor prompt:
> "When an event spans multiple domains (e.g. a summit that also involves military threats),
> classify by the PRIMARY action taken, not the context. A summit is `diplomatic_incident`.
> A test launch is `missile_attack` or `nuclear_incident` depending on payload. A threat is
> `peace_negotiation` if talks are ongoing, `military_operation` if forces are being positioned."

---

## 4. Missing Event Types

Types that would have been useful but don't exist:

| Proposed type | Example that needed it | Current workaround |
|---------------|----------------------|-------------------|
| `economic_spillover` | France/Korea/Japan Iran war economic impact | `other` / `central_bank_action` |
| `nuclear_test` | Sarmat ICBM test | `missile_attack` / `nuclear_incident` |
| `military_threat` | Trump's "accept deal or face strikes" | `armed_conflict` |
| `intelligence_report` | US intel: Iran retains missile capabilities | `other` |
| `diplomatic_summit` | Trump-Xi Beijing meeting | `diplomatic_incident` |
| `sanctions_announcement` | US sanctions on MizarVision | `sanctions` (OK but undersized) |

**Note:** The existing 29-type taxonomy covers most cases. Only add new types when the same
gap appears ≥3 times across runs and produces demonstrable accuracy loss.

---

## 5. Run-by-Run Taxonomy Drift Log

### Runs #1–#3 (2026-05-13)

**Stable classifications (consistent across batches):**
- `airstrike` → Israeli Lebanon strikes ✓
- `supply_disruption` → Hormuz oil impact (v2 batches) ✓
- `peace_negotiation` → Iran ceasefire talks ✓
- `sanctions` → US sanctions on Chinese firm ✓
- `natural_disaster` → Tehran earthquake ✓
- `humanitarian_crisis` → Hormuz fertilizer/food security ✓
- `trade_dispute` → India gold tariffs ✓

**Unstable classifications (vary across batches):**
- Sarmat ICBM: `missile_attack` ↔ `nuclear_incident`
- Trump nuclear statement: `nuclear_incident` ↔ `diplomatic_incident`
- Trump-Beijing summit: `diplomatic_incident` ↔ `peace_negotiation`
- Iran war economic impact: `other` ↔ `central_bank_action` ↔ `supply_disruption`

**Threshold for prompt fix:** Same drift ≥3 consecutive runs → add classification guidance to extractor-v3.
Current status: Sarmat ambiguity observed 2 runs. Monitor Run #4+.

---

---

### Storyline linker — day 1 observations (2026-05-13)

7 storylines emerged from 42 events. Cross-day behavior to assess on day 2.

**Storyline taxonomy quality:**

| ID | State | Events | Theme | Quality |
|----|-------|--------|-------|---------|
| 0f642015 | escalating | 3 | Israel-Lebanon airstrikes | ✓ Correct, tight grouping |
| 8bcf9ef1 | active | 15 | US-Iran war / Trump-Xi / diplomacy | ⚠ Too broad — Iran+USA actors attract everything |
| 5f2def3f | active | 13 | Iran war global economic impact | ✓ Correct theme, slightly broad |
| 3e36b585 | active | 4 | Russia-Ukraine / Sarmat ICBM | ✓ Correct, clear grouping |
| 720f87e0 | active | 3 | France economic fallout + Trump nuclear | ⚠ Mixed — two thematically distinct events grouped via IRN country |
| 5aa09a29 | emerging | 2 | Tehran earthquake + Hormuz fertilizer | ✗ Questionable — different phenomena, same primary country |
| 2ee4f952 | emerging | 2 | India economic defense / rupee | ✓ Correct |

**Issues to fix before day 2:**

1. **Storyline titles**: Currently uses last-linked highest-confidence event's title. Should be fixed to use the anchor event's title (set at creation, update only if confidence significantly higher). `5f2def3f` shows as "Japanese Funds Dump Most US Sovereign Debt" — wrong theme label.

2. **`5aa09a29` grouping**: Tehran earthquake (natural_disaster, IRN) + Hormuz fertilizer (humanitarian_crisis, IRN/MWI). Both IRN primary country but unrelated events. Score was 5 (at threshold). Consider raising threshold or adding event_type family as a required (not just scored) condition for some groupings.

3. **`8bcf9ef1` over-broadness**: 15 events is too many for one storyline. The Iran war diplomatic thread (Trump ultimatums, ceasefire collapse) and the Trump-Xi summit thread are separate storylines that are clustering together because they share IRN+USA actors. Sub-storyline splitting needed on day 2+.

**Uncertain links flagged (7 total):**
- "South Korean Bond Yields" → Iran economic impact: ✓ correct (economic signal from Iran war)
- "Hormuz Fertilizer" → Tehran earthquake: ✗ questionable (different phenomena)  
- "Japan Coal Power" → Iran economic impact: ✓ correct
- "China Missile Stockpile" → US-Iran war mega-storyline: ⚠ borderline (military + CHN, but different from diplomatic thread)
- "Japanese Investors dump US debt" → Iran economic impact: ✓ correct
- "India tariffs" → US-Iran war mega-storyline: ⚠ borderline (IND, trade_dispute)

*Next update: after day 2 collection to observe cross-day storyline persistence.*
