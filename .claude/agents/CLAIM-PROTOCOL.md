# Claim governance protocol — `claim/1`

**This is the single canonical definition.** Agent files reference it; they must
not restate the serialization rules, because four divergent copies of a format
spec is how a rename silently corrupts everyone's output.

## The rule everything else follows from

> **Agents decide and emit structured governance events. Orchestration persists
> them. No agent receives direct write authority.**

This is enforced by PostgreSQL, not by instruction. Specialists, Vizier and
Warden all authenticate as `ai_capital_agent`, which has `SELECT` and nothing
else. Only orchestration holds `ai_capital_claim_writer`, which can write
`desk.agent_claims` and `desk.agent_runs` — and nothing else in the cluster.

So: emitting a block is a **request to record**, never a write. If a block is
malformed, nothing lands.

## Why this exists

Specialist agents start cold every time and vanish when they answer. Nothing
recorded what they claimed. On 2026-08-25 both Atlas and Sentinel retracted,
under challenge, the single claim their own recommendation rested on — the most
useful calibration evidence this desk has produced — and it survived nowhere.

---

## Block: `claim` — asserting something

Emit one per **load-bearing** claim: one that materially supports a
recommendation, a portfolio decision, a regime call, a risk warning, or another
consequential conclusion.

````
```claim
protocol: claim/1
claimant: atlas
domain: monetary-liquidity
type: forecast
confidence: medium
horizon: 3mo
claim: With overnight RRP exhausted, further TGA rebuild drains bank reserves
  directly rather than being absorbed.
evidence: macro.json — overnight RRP $0.38bn, TGA $953.6bn (+14.9bn/4wk)
invalidated_if: RRP rebuilds above ~$50bn, or TGA stops growing for 4+ weeks
supersedes_concept: the prior claim that reserves remain ample
```
````

| Field | Required | Notes |
|---|---|---|
| `protocol` | yes | must be `claim/1`; a mismatch is an error, not a warning |
| `claimant` | yes | whose claim it is |
| `domain` | yes | short slug — `monetary-liquidity`, `sanctions`, `concentration`, `tax` |
| `type` | yes | `factual` \| `interpretation` \| `forecast` \| `recommendation` \| `risk_warning` |
| `confidence` | yes | `high` \| `medium` \| `low` |
| `claim` | yes | one sentence, specific enough to be checked later |
| `horizon` | for forward-looking types | `3mo`, `12mo`, `structural`; omit for a timeless fact |
| `evidence` | strongly preferred | what you actually cited — file, table, filing, source |
| `invalidated_if` | **required for `forecast` and `risk_warning`** | the observation that would prove this wrong |
| `supersedes_concept` | optional | plain-language reference to the earlier claim this replaces |

**`invalidated_if` is what earns a row its place.** A claim nobody could ever
disprove is not a claim, it is a mood. It is required for forward-looking types
and **not** demanded of purely factual ones — inventing a fake disconfirming
condition for "Treasury announced X on 2026-08-24" is worse than omitting it.

**`supersedes_concept`, not an ID.** You start cold and do not know database
IDs. Describe what you are replacing in words; orchestration resolves it to the
prior claim. If several prior claims plausibly match, orchestration will **not
guess** — it surfaces the ambiguity for Vizier to settle.

---

## Block: `claim-event` — verification and resolution (Vizier)

Vizier owns analytical verification and resolution, and like everyone else emits
rather than writes.

````
```claim-event
protocol: claim/1
event: verify_unsupported
claim_id: 41
actor: vizier
evidence: Checked the Fed statement of 2026-08-24 directly; no such announcement.
```
````

| `event` | Meaning |
|---|---|
| `verify_supported` | an independent check found the evidence does support it |
| `verify_unsupported` | checked, and the evidence does **not** support it |
| `verify_unverifiable` | checked, and no verification path exists |
| `confirm` | it happened as claimed |
| `falsify` | the predicted outcome did not occur |
| `invalidate` | the claim's **own stated** invalidation condition fired |
| `retract` | withdrawn: the original evidence never supported it |

**Verification and resolution are different events and must not be collapsed.**
A forecast can be properly supported when made and still be overtaken by
events; scoring that like an unsupported assertion would punish good reasoning.
Equally, `retract` (never supported) and `supersede` (updated on new evidence)
are opposite signals about reliability and must never be summed.

A specialist may not verify its own claim — the database refuses
`verified_by = claimant`.

---

## Block: `claim-capture` — recording someone else's claim (Vizier)

The block that exists because of the 08-25 incident. When a load-bearing claim
becomes visible **under challenge** — typically because its author is retracting
or defending it — Vizier records it on the claimant's behalf.

````
```claim-capture
protocol: claim/1
claimant: atlas
recorded_by: vizier
domain: emerging-markets
type: interpretation
confidence: high
claim: The finalized plan contains zero EM exposure, so selling the EM funds
  leaves a genuine structural hole.
evidence: Surfaced under challenge; Atlas retracted it when shown that Thailand
  is itself an emerging market and the book is ~36% EM.
invalidated_if: terminal EM-ex-Thailand falls below ~5% of the equity book
```
````

Persisted with `capture_method = 'challenger'`. The database **refuses**
`recorded_by = claimant` for a challenger capture, so a reconstructed claim can
never masquerade as a voluntary self-declaration.

This matters because the claim a specialist is least likely to volunteer is
precisely the shaky one carrying its own recommendation.

---

## Block: `claim-finding` — claim-system integrity (Warden)

Warden owns whether the machinery worked, never whether the analysis is sound.

````
```claim-finding
protocol: claim/1
kind: missing_persistence
detail: atlas emitted 3 blocks; 2 persisted; 1 rejected on a duplicate key.
```
````

`kind`: `missing_persistence` \| `malformed_lifecycle` \| `broken_provenance` \|
`immutable_field_mutated` \| `privilege_violation` \| `failed_resolution` \|
`orphaned_supersession`.

---

## Parser behaviour — strict, and fails as a batch

An error in any block **rejects the whole batch**. A partially-landed set is
worse than none: it reads as a complete record and is not one.

Errors: unknown key · duplicate key · invalid enum · missing required field ·
missing `invalidated_if` on a forward-looking type · protocol version mismatch ·
malformed syntax · unresolvable `supersedes_concept` ambiguity.

Unknown keys are an **error**, not ignored. Silently discarding a key means a
future rename corrupts every agent's output with no signal.

## Provenance is mandatory and automatic

Orchestration attaches session, run reference, artifact and context. You do not
supply them — the runtime already knows them, and asking agents to restate
machine-known facts invites drift. A row without at least one durable source
reference is refused by the database.

## What is deliberately NOT here

No numeric leaderboard. No accuracy multiplier. No trust score. No automatic
recommendation weighting. This phase is instrumentation and governance; scoring
would require data that does not exist yet, and a reputation built on a handful
of observations is worse than none.
