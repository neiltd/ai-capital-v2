# Storyline Continuity — Multi-Day Observations

Running log of how storylines evolve, persist, drift, and branch across real collection cycles.  
Updated after each new day's pipeline run.  
Feeds into decisions about scoring adjustments, threshold changes, and branching heuristics.

**Do not build**: graph DB, memory-agent, narrative-agent, AI storyline reasoning.  
**Do build**: lightweight type-specific rules where patterns clearly justify them.

---

## Observation Framework

For each day, record:
1. **Persistence** — which storylines from D-1 received new events on D?
2. **Drift** — which storylines changed `storyline_state`? Which escalated or stabilized?
3. **Merging quality** — any bad merges? Any missed links (events that should have linked)?
4. **Over-aggregation** — any storyline ≥12 events? What's its family composition?
5. **Natural branching** — any storyline with ≥3 event families and ≥6 events (branching candidate)?
6. **Uncertain links** — which borderline (score=5–6) links seem correct vs questionable?
7. **Type-specific rule effectiveness** — did type penalties prevent bad merges?

---

## Type-Specific Continuity Rules (active)

| Event type | Rule | Rationale |
|-----------|------|-----------|
| `natural_disaster` | -3 if storyline has no natural_disaster events | Prevents earthquakes from absorbing into war storylines via country overlap alone |
| `economic_data_release` | -2 if storyline dominant family ≠ economic | Data releases belong in economic threads, not military/diplomatic |
| Military types (airstrike, military_operation, armed_conflict, missile_attack, nuclear_incident) | -1 if storyline is purely diplomatic | Separates active conflict coverage from negotiation threads |
| Diplomatic types (diplomatic_incident, peace_negotiation, treaty, sanctions) | -1 if storyline is purely military | Mirror of above |

Match threshold: **5** (unchanged).  
Adjust type penalty magnitudes if patterns justify it after ≥5 days of data.

---

## Day 1 Baseline — 2026-05-13

**Pipeline run summary:** 7 calibration runs in a single day. Cross-day linking is initialized but will only show real persistence behavior on Day 2.

### Storylines Created

| ID | State | Events | Families | Title (canonical) | Notes |
|----|-------|--------|---------|-------------------|-------|
| `0f642015` | escalating | 3 | mil | Israel Strikes South Lebanon Amid Washington Talks | ✓ Tight, single-theme |
| `8bcf9ef1` | active | 15 | mil+dip+eco | India tariffs (wrong title) | ⚠ Over-aggregation. Iran war mega-thread. Title wrong — should be "US-Iran War and Trump Diplomacy" |
| `5f2def3f` | active | 13 | eco | Japanese Funds Dump US Debt (wrong title) | ⚠ Over-aggregation. Iran war economic spillover. Title wrong — should be "Iran War Global Economic Shock" |
| `3e36b585` | active | 4 | mil | Russia Test-Fires Sarmat ICBM | ✓ Good grouping |
| `720f87e0` | active | 3 | eco+dip | Trump Declares Iran Nuclear Priority | Borderline — France economy + Trump nuclear statement grouped via FRA+IRN |
| `5aa09a29` | emerging | 2 | hum | Strait of Hormuz Shipping Disrupts Fertilizer | ✓ Natural disaster rule isolated earthquake. Hormuz fertilizer linked (borderline) |
| `2ee4f952` | emerging | 2 | eco | India rupee defense | ✓ Correct, small |

**Over-aggregation flags (Day 1):**
- `8bcf9ef1` — 15 events, families: mil+dip+eco — clear branching candidate. The Iran war military thread (ultimatums, airstrikes) and the Trump-Xi diplomatic thread are distinct and should separate on Day 2.
- `5f2def3f` — 13 events, family: eco — large but thematically coherent (all economic impact of Iran war). Less urgent to split.

**Natural branching candidate:**
- `8bcf9ef1` — 3 families (military + diplomatic + economic). On Day 2, if new military events link to this, watch whether diplomatic events also link or begin forming a separate storyline.

**Uncertain links (7):**

| Score | Event | Storyline | Assessment |
|-------|-------|-----------|-----------|
| 6 | Trump Travels to Beijing (diplomatic_incident) | 8bcf9ef1 Iran war | ✓ Correct — same geopolitical context |
| 5 | South Korean Bond Yields | 5f2def3f economic | ✓ Correct — oil shock economic signal |
| 5 | Hormuz Fertilizer (humanitarian) | 5aa09a29 earthquake | ⚠ Questionable — different phenomena |
| 5 | Japan Coal Power | 5f2def3f economic | ✓ Correct |
| 5 | China Missile Stockpile | 8bcf9ef1 Iran war | ⚠ Borderline — China military buildup linked to Iran war mega-thread |
| 5 | Japanese Investors dump US debt | 5f2def3f economic | ✓ Correct |
| 6 | India tariffs (trade_dispute) | 8bcf9ef1 Iran war | ⚠ Borderline — India policy linked to Iran war mega-thread |

**Type rule effectiveness:**
- `natural_disaster` penalty prevented Tehran earthquake from joining `8bcf9ef1` (score reduced from 4→1). ✓
- Diplomatic-military separation (-1 penalty): trump nuclear statement linking to France economic storyline (score 7) shows the rule doesn't prevent all cross-family linking — it just makes it harder for weak matches. ✓
- No false rule applications observed (no correctly-matched events blocked).

**Known title quality issue:** Storyline titles are set to the last high-confidence event rather than the thematic anchor. Fix: store anchor event title permanently, only update if new event confidence is >0.10 higher than current avg. Implement after Day 2.

---

## Day 1 — Signal instrumentation findings (2026-05-13, late)

With full signal breakdown active, the most significant Day 1 observation:

**All 7 storylines have `cohesion_signal = country`.** Geographic overlap is the dominant clustering force across every link decision. Actor overlap and type overlap consistently co-fire, but `country` is the highest-scoring individual signal in all cases.

**Signal breakdown pattern across 35 link decisions:**
```
Most common signature: [N: ctr act typ★/△ ttl tmp]
All 35 links had: ctr✓ act✓ tmp✓
Type exact (★): ~55% of links (exact event_type match)  
Type family (△): ~40% of links (same family, different type)
Title match: 0% (Jaccard rarely reaches 0.20 threshold)
```

**Implication for Day 2 observation:**
- `country` is currently acting as a "gravity anchor" — almost any Iran-related event will score 3 from country alone, then get boosted to 5+ via actor/type
- This means the current 7 storylines may be too few — what looks like 1 storyline (`8bcf9ef1`, 15 events) may actually be 3 distinct narratives (Iran war military, Iran war diplomatic, Iran war spillover) that are clustering via country gravity
- On Day 2: watch whether events with `type_score=0` still link via country+actor — these are the gravity cases to watch

**Signal taxonomy — what each pattern means:**
```
[9+: ctr act typ★ tmp] = Strong thematic + geographic + actor coherence → reliable link
[7:  ctr act typ△ tmp] = Geographic + actor + family match → likely correct, monitor
[5:  ctr act typ△ tmp] = Minimum threshold, family match only → uncertain, watch for divergence
[5:  ctr act typ· tmp] = Minimum threshold, NO type signal → pure gravity via geography+actor
[5+: pen-X]            = Type rule penalized — link only passed because other signals strong
```

**Key observation**: The `typ·` (zero type signal) links at scores 4-6 are the ones to watch on Day 2. These are events being pulled into storylines purely by geographic and actor gravity, with no thematic coherence. If they produce divergent sub-storylines on Day 2, it confirms the story is fracturing.

---

## Multi-Day Observation Checklist

Run after each new calendar day's `npm run observe`. Fill in one row per day.

### Metric tracking table

| Day | Date | Events | Storylines | persistence_rate | cohesion_dominant | gravity_links | fragments | branching_candidates | notes |
|-----|------|--------|-----------|-----------------|-------------------|---------------|-----------|---------------------|-------|
| 1 | 2026-05-13 | 42 | 7 | 0% (baseline) | country (all 7) | 1 | 2 | 8bcf9ef1 (15ev, 3fam) | — |
| 2 | — | — | — | expected 60–80% | — | — | — | — | — |
| 3 | — | — | — | — | — | — | — | — | — |
| 4+ | — | — | — | — | — | — | — | — | — |

### Per-day observation questions

After each day's `npm run link`, answer:

**1. persistence_rate**
- What fraction of new events linked to existing storylines vs created new?
- Is it rising (storylines accumulating) or flat (new storylines forming each day)?
- Note: Day 1 was 0% by definition. Expect 60–80% by Day 3 if the same Iran war storylines persist.

**2. cohesion_signal drift**
- Did any storyline's `cohesion_signal` change from `country` to `actor` or `type`?
- Which specific storyline changed, and what drove it?
- Hypothesis: actor coherence strengthens for storylines about specific named actors (Trump, Putin); type coherence strengthens for specialized topic storylines (nuclear, sanctions).

**3. family_history changes**
- Did `8bcf9ef1` (mil+dip+eco) remain blended or did one family become dominant?
- Cross-day family_history snapshots reveal thematic drift over time.
- Watch: if mil-family events stop arriving but dip-family events continue, the storyline should naturally shift toward dip coherence.

**4. storyline fragmentation**
- Did the `IRN/economic` fragment cluster (`5f2def3f` + `2ee4f952`) merge or stay separate?
- Did the `ISR/military` fragment cluster (`0f642015` + `8bcf9ef1`) merge or stay separate?
- Fragmentation is a signal that the current threshold (5) is too low for the given news cycle.

**5. narrative gravity**
- Did any `typ·` events (zero type signal) that were gravity-linked on Day 1 re-link on Day 2?
- Or did they form their own storylines when the original big storyline lost relevance?
- Gravity persistence = the same large storyline continuing to attract events with no type match.

**6. natural divergence**
- Did `8bcf9ef1` (the Iran war mega-thread) split into sub-threads naturally?
- Watch for: two new storylines appearing with overlapping countries (IRN, USA) but different dominant families (mil vs dip vs eco).
- This would be the first evidence that the current scoring threshold should be raised (or type-family separation strengthened).

**7. fading behavior**
- Which storylines transitioned to `fading` state (days_since_last > 3)?
- `5aa09a29` (Tehran earthquake + Hormuz fertilizer) is the first candidate — watch whether it gets any new events or fades.
- `2ee4f952` (India rupee) is the second candidate — India-specific story may not persist.

### Decision rules (when to act vs just observe)

| Observation | Action threshold | Action |
|------------|-----------------|--------|
| persistence_rate stays < 30% after Day 3 | Storylines not persisting — threshold may be too high | Lower threshold or add temporal decay |
| persistence_rate > 90% after Day 3 | Over-persistence — gravity too strong | Raise threshold or strengthen type requirements |
| cohesion_signal stays `country` after Day 5 | Country gravity dominates — storylines not semantically strengthening | Consider adding actor/type weighting |
| cohesion_signal shifts to `actor`/`type` | Natural semantic strengthening — working as intended | Document and observe |
| 8bcf9ef1 >20 events by Day 3 | Over-aggregation confirmed | Consider type-family required matching (not just scored) |
| Fragmentation cluster stays separate for 3 days | These are genuinely separate narratives | Consider raising threshold for cross-family links |
| gravity_links > 30% of updates for 3 consecutive days | Gravity too dominant | Add large-storyline penalty (reduce score when target has >10 events) |

### Do NOT act on patterns observed in fewer than 3 consecutive days.

### Architecture freeze during observation

Frozen until observation phase concludes:
- Matching threshold (currently 5)
- Type-specific penalty magnitudes
- Temporal proximity window (72h)
- Family composition rules
- Storyline state transitions

Not frozen (fix immediately if broken):
- Pipeline operational errors
- Data corruption
- Schema validation failures

---

## Extended Observation Protocol

**Phase start:** 2026-05-13  
**Minimum duration:** 7 calendar days  
**Review trigger:** same pattern for 3+ consecutive days OR operational degradation

Daily command:
```bash
npm run observe
```

What the system tracks automatically:
- `persistence_rate` — per-run in `npm run link` output
- `cohesion_signal` — per-storyline in storyline table  
- `family_history` — appended per day in `intelligence/outputs/storylines/storylines.json`
- `gravity_links` — flagged in `npm run link` output
- `fragments` — detected in `npm run link` output
- `fading` transitions — shown in cross-day comparison section
- Snapshots — auto-saved to `intelligence/outputs/storylines/snapshots/YYYY-MM-DD.json`

What to record manually (this document):
- Fill in the tracking table after each day's `npm run link`
- Note any unexpected patterns in Day N observations below

---

## Run 8+ Observations — 2026-05-13 (same calendar day, fresh batch)

*Note: Still 2026-05-13 — cross-day snapshot diff will fire on 2026-05-14. This batch represents the latest within-day state with 47 fresh articles, producing the first clear persistence and gravity signals.*

### Tracking table update

| Day | Date | New Events | Storylines | persistence_rate | cohesion_dominant | gravity_links | fragments | branching | notes |
|-----|------|-----------|-----------|-----------------|-------------------|---------------|-----------|-----------|-------|
| 1 baseline | 2026-05-13 morning | 42 | 7 | 0% (all new) | country (7/7) | 1 | 2 | 8bcf9ef1 | — |
| 1 late batch | 2026-05-13 evening | 22 net | 7 | **100%** | country (7/7) | 0 | 3 | 8bcf9ef1 | First state transitions |

### Key findings

**1. persistence_rate = 100%**
Every one of the 22 net new events linked to an existing storyline. Zero new storylines created. This is the expected convergence behavior once storylines are established — they become gravitational anchors for all related incoming content.

**2. No `typ·` gravity-only links**
All 15 new `→ link` decisions had `typ★` (exact type) or `typ△` (family match). No event linked to a storyline purely on country+actor overlap with zero type coherence. This means the new batch had genuine thematic alignment with existing storylines — not just geographic coincidence.

**3. First state transitions observed**

| Storyline | Before | After | Signal |
|-----------|--------|-------|--------|
| `5f2def3f` Iran war economic spillover | active (esc=0.48) | **stabilizing** (esc=0.43) | De-escalating — economic shock absorbing |
| `720f87e0` France/Trump nuclear | active (esc=0.45) | **escalating** (esc=0.51) | Gulf state Shia arrests linked here — borderline correct |
| `0f642015` Israel-Lebanon airstrikes | escalating (esc=0.73) | escalating (esc=0.75) | Held — Hezbollah drone threat confirmed trajectory |

**`5f2def3f` → stabilizing** is the most meaningful signal. The Iran war economic impact thread is de-escalating as markets begin to price in the new reality. avg_escalation dropped from 0.48 to 0.43 across 20 events. This is emergent state behavior — no explicit rule caused it, the escalation_potential values from Claude's extractions naturally pulled it down.

**4. 8bcf9ef1 reached 20 events — RUS fragmentation appeared**

`8bcf9ef1` (Iran war mega-thread) now has [mil:4 dip:3 eco:1] and absorbed "Russia-Ukraine Ceasefires Reduced to Performative Gestures" because:
- An earlier event ("India Faces Russian Oil Import Cutback") added `RUS` to 8bcf9ef1's country list
- Subsequently, Russia-Ukraine content scored 9 (ctr✓ act✓ typ★) against 8bcf9ef1 — matching military family AND now matching RUS country

This is **gravitational country accumulation** — once a storyline acquires a country via one event (India-Russia oil), it becomes a gravity sink for ALL events mentioning that country. This is the over-aggregation mechanism made explicit.

**New fragmentation cluster: RUS/military**
- `8bcf9ef1` (Iran war, 20ev) — now absorbing Russia events via accumulated RUS country
- `3e36b585` (Russia/Sarmat, 4ev) — the "correct" Russia storyline

**5. cohesion_signal = `country` unchanged**
All 7 storylines still cohere on country. No drift to actor or type. This is consistent with early-stage clustering — country gravity dominates when coverage is dense (Iran war is in every article) and storylines haven't had time to differentiate semantically.

**Hypothesis for Day 2 (2026-05-14):** When the cross-day snapshot diff fires:
- `5f2def3f` (stabilizing) may gain few new events if economic shock reporting slows → watch for `fading`
- `5aa09a29` (Tehran earthquake) has days_since_last increasing → approaching fading threshold
- `8bcf9ef1` may gain new diplomatic events from Beijing summit outcome
- cohesion_signal may begin shifting if `3e36b585` (Russia) receives Putin-specific events that strengthen actor coherence

## Day 2 Observations (2026-05-14) — Five specific questions

Run `npm run observe` and answer each question. Do not intervene regardless of answer.

---

### Q1 — Do diplomatic events separate from 8bcf9ef1?

**How to observe:** Look at the link decisions table. For any `diplomatic_incident` or `peace_negotiation` event:
- Did it link to `8bcf9ef1` (score, which signals fired)?
- Or did it create a new storyline?
- Key: if Beijing summit outcome articles (Trump-Xi) score high (9+) on `8bcf9ef1`, diplomatic gravity is still strong. If they score 5–6 (borderline), watch for natural drift.

**Signal to watch:**
```
→ link  [5-6: ctr act typ· ttl tmp]  "Beijing summit..."  →  8bcf9ef1  ← still gravitating
→ link  [9+:  ctr act typ★ ttl tmp]  "Beijing summit..."  →  8bcf9ef1  ← actively coherent
◆ new   [...]  "Beijing summit..."  →  new_id  ← natural separation began
```

**Non-intervention rule:** Even if diplomatic events stay in `8bcf9ef1`, do not split. Observe.

---

### Q2 — Do military threads stabilize independently?

**How to observe:** Check whether Israel-Lebanon (`0f642015`) and Russia/Sarmat (`3e36b585`) receive their own new military events, or whether those events get absorbed into `8bcf9ef1` instead.

**Signal to watch:**
```
→ link  [9: ...]  "Airstrike on..."  →  0f642015  ← correct, independent
→ link  [9: ...]  "Airstrike on..."  →  8bcf9ef1  ← gravity absorbing military thread
```

RUS/military fragmentation: if new Russia events link to `3e36b585` rather than `8bcf9ef1`, the independent military thread is stabilizing.

---

### Q3 — Does economic spillover remain coherent?

**How to observe:** `5f2def3f` is now `stabilizing` (avg_esc 0.43). Watch whether:
- New economic events (inflation data, oil prices, sanctions impact) continue to link here
- Or whether it starts attracting off-theme events via country gravity (any IRN article)
- Check `family_composition` — should stay [eco:N], any non-eco entries = drift

**Signal to watch:**
```
5f2def3f  stabilizing  ev:N  [eco:N]  ← coherent, staying economic
5f2def3f  stabilizing  ev:N  [eco:N mil:1]  ← drift starting, military event absorbed
5f2def3f  fading       ev:N  [eco:N]  ← economic shock coverage slowing
```

---

### Q4 — Does country-cohesion weaken?

**How to observe:** Check the `Cohes` column in the storyline table.
- Day 1 baseline: `country` for all 7
- Day 2 signal: any storyline showing `actor`, `type`, or `mixed` is semantically strengthening

**Mechanism:** For `cohesion_signal` to shift from `country` to `actor`, more than half of the new link decisions for that storyline must have `actor` as their primary signal (actor score > country score). This happens when a storyline's actors become so distinctive that actor name matching becomes the dominant discriminator.

**Most likely to shift first:** `3e36b585` (Russia/Putin/Sarmat — Putin appears repeatedly) or `0f642015` (Hezbollah/Naim Qassem — militia leadership recurring).

---

### Q5 — Does semantic coherence continue strengthening?

**How to observe:** Count `typ★`/`typ△`/`typ·` across all `→ link` decisions in the output.

**Day 1 baseline:** ~40% `typ·` (pure gravity), ~60% `typ★`/`typ△`
**Day 1 late batch:** 0% `typ·` — every link had real type coherence
**Day 2 hypothesis:** Continues at ~0% `typ·` if storylines have matured into distinct type attractors

If `typ·` returns at >20%, it means a new wave of diverse articles arrived and country gravity is dominating again (normal for a breaking news day).

---

### Day 2 cross-day diff — what the system shows automatically

When `npm run link` runs on 2026-05-14:

```
Cross-day changes  (vs snapshot 2026-05-13)
──────────────────────────────────────────────
  8bcf9ef1…  +N events  [day 1]  active → ?  cohesion: country → ?
  5f2def3f…  +N events  [day 1]  stabilizing → ?  cohesion: country → ?
  0f642015…  +N events  [day 1]  escalating → ?  ...
  5aa09a29…  no new events  [day 1]  emerging → fading  ← expected
  2ee4f952…  no new events  [day 1]  emerging → fading  ← expected
```

**Fading candidates:**
- `5aa09a29` (Tehran earthquake + Hormuz fertilizer): if no new IRN humanitarian events, will transition to `fading` by Day 3 (3 days since last event)
- `2ee4f952` (India rupee): if India-specific coverage doesn't continue, fades similarly

---

### Non-intervention confirmation

Regardless of Day 2 findings:
- Do NOT split `8bcf9ef1`
- Do NOT tighten match threshold
- Do NOT add semantic weighting
- Do NOT add actor-specific boosting

The only permitted action: fix operational bugs if the pipeline breaks.

*Fill in Day 2 results here after running `npm run observe` on 2026-05-14.*

## Day 2 Observations (pending — fires on 2026-05-14)

Watch for:
1. Does `8bcf9ef1` (Iran war mega-thread) continue to grow, or do diplomatic events begin forming a separate storyline?
2. Does `5aa09a29` (Hormuz fertilizer) persist if no new IRN humanitarian events appear? It should move to `fading`.
3. Do any storylines reach `confirmed` event_state (3+ sources, 2+ runs, conf ≥0.75)?
4. Does the `escalating` state on `0f642015` (Israel-Lebanon) hold or shift?
5. Do genuinely new events create new storylines, or do they all absorb into existing ones?

*Next update: Day 2 pipeline results.*
