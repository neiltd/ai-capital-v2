# W5 — delegated / subprocess authority boundary

**Status: RECORDED, not scoped.** No code, no detector. Opened so W4 stays a
bounded property instead of drifting into "detect every possible side effect".

## Why it is separate from W4

W4 asks one question: can project-owned code that the dashboard build or a
non-user request evaluates *reference LLM SDK authority* outside a user-action
handler body? Its detector is deliberately narrow — SDK module specifiers, LLM
client construction, and the two API hostnames.

Warden's round-7 observation, which is correct:

> spending authority ⊃ SDK reference

A process can acquire credentials and spend without importing any SDK. It can
shell out to something that does.

## The evidence that opened this

`apps/unified-platform/src/app/api/portfolio/refresh/route.ts:27` runs

```ts
execFileAsync(tsxBin, ['src/cli/cli-refresh.ts'], …)
```

**No live exposure today.** That call sits inside the handler, and
`apps/scenario-simulator/src/cli/cli-refresh.ts` reaches no LLM. But the W4
analyzer cannot see it either way: a module-scope `execFile` of a CLI that
spends would be entirely invisible to it, and would remain green.

Related, already established earlier in this effort: the same route carried a
hardcoded production `DATABASE_URL`, and `scripts/pipeline-watchdog.sh` records
that a `[TEST]` watchdog once sent a real LINE push because it loaded production
credentials. Delegated execution inheriting ambient capability is a pattern this
repo has already been bitten by.

## What the model needs to cover, when scoped

```
execFile / spawn / exec / shell
  → resolved executable (which script? which interpreter?)
  → inherited environment and capabilities (API keys, DATABASE_URL, tokens)
  → network / spending / write effects of the child
```

Open questions to settle before building anything:

- Is the unit "does the child spend" (requires analysing another program) or
  "does the parent hand the child spending credentials" (analysable locally, and
  probably the more useful boundary)?
- Does this belong to the dashboard, or is it a repo-wide capability-inheritance
  property that also covers the queue worker and the shell scripts?
- Can it reuse the W4 authority-graph machinery, or is credential flow a
  different shape entirely?

## Deliberately NOT done

Not bolted into the W4 detector. Conflating the two would make W4 unfalsifiable
and would have hidden the actual production finding behind noise.
