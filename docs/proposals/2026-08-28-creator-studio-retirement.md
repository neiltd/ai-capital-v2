# creator-studio retirement plan — PROPOSAL, awaiting approval

**Nothing deleted. Nothing moved.** This plan exists to be approved or rejected.

## Why retire rather than harden

| Evidence | Status |
|---|---|
| Nothing launches it — no launchd plist, no script, no DAG stage | Verified |
| Its `prisma/dev.db` last modified **2026-07-05**, ~8 weeks | Verified |
| All 5 commits touching it in 60 days are maintenance, not features | Verified |
| Route names **identical** to unified-platform's gated `/api/studio/*` — all 11 | Verified |
| unified-platform's pages are a strict **superset** (`/`, `/archive`, `/dashboard`, plus `/chat`) | Verified |
| `lib/` module names identical: `agent.ts`, `db.ts`, `growth-tracker.ts`, `topic-engine.ts`, `utils.ts` | Verified |
| It has **no middleware at all** — 11 anonymous routes incl. Anthropic, OpenAI and an upload writer | Verified |
| It runs Next **16.2.6** vs unified-platform's **14.2.35** | Verified |

Hardening means writing and maintaining a **second** security implementation, on
a different framework major, guarding a surface that already exists gated
elsewhere. The only argument against retirement is that Neil still opens it by
hand — which the repository cannot answer.

## Anything unique that would be lost

**Nothing identified.** unified-platform's `/studio` has every page creator-studio
has, plus `/chat`. All five `lib/` modules exist on both sides under the same
names. No component exists in one and not the other.

## Data worth preserving: NONE

```
apps/creator-studio/prisma/dev.db   49152 bytes, mtime 2026-07-05
  GrowthSnapshot      0 rows
  StyleProfile        0 rows
  Session             0 rows
  Video               0 rows
  _prisma_migrations  2 rows
```

Every content table is empty. Only the migration ledger has rows.

## THE THING THAT MAKES THIS NOT A DELETE

**unified-platform depends on two paths inside `apps/creator-studio/`.**

1. **`apps/unified-platform/.env.local` sets `DATABASE_URL` to
   `file:…/apps/creator-studio/prisma/dev.db`.** The dashboard's `/studio` pages
   read creator-studio's database directly. They are not two databases — they
   are one database in creator-studio's directory, read by both apps.

2. `apps/creator-studio/data/performance-weights.json` (3 bytes, an empty `{}`)
   is read by **two** unified-platform modules:
   - `src/lib/studio/topic-engine.ts:40`
   - `src/lib/studio/growth-tracker.ts:48`
   Both guard with `existsSync` and fall back to `{}`, so its absence is
   survivable — but the path is live.

**Deleting `apps/creator-studio/` without relocating these breaks the dashboard's
`/studio` section.** That is the whole reason this is a plan and not a `git rm`.

## Safest archival path

Ordered so each step is reversible and verifiable before the next.

1. **Relocate the shared data out of the retiring app.** Move
   `prisma/dev.db` and `data/performance-weights.json` to a neutral location
   (e.g. `apps/unified-platform/prisma/` and `apps/unified-platform/data/`),
   update `DATABASE_URL` in `.env.local` and the two `join(dataRoot, …)` paths.
   Verify `/studio`, `/studio/archive` and `/studio/dashboard` still render.
2. **Neutralise the server before removing it** — remove the `dev`/`start`
   scripts from its `package.json`, so no one can start an unauthenticated
   Next 16 origin by muscle memory. Cheap, immediate, reversible.
3. **Archive the tree** to `_archive/creator-studio/` (the repo already has an
   `_archive/` convention with six prior entries) rather than deleting, so the
   history and any forgotten local artifact survive.
4. **Remove from the pnpm workspace** and re-run `pnpm install`, confirming no
   other package resolved anything from it.
5. **Update `CLAUDE.md`** — it names creator-studio in 3 places, including the
   apps table and the cross-app Prisma-client landmine note. That landmine note
   becomes obsolete once there is only one client.
6. **Re-run the gate**: build, typecheck, 785 tests, plus the architecture and
   privilege checks.

## What is NOT proposed

Deleting anything in this phase. Touching the shared database. Changing
`DATABASE_URL` before step 1 is approved. Retirement is a sequence, and step 1
is the only one that carries real risk.

## The open question, for Neil alone

**Do you still open creator-studio yourself?** Nothing in the repository settles
it. A dormant database and no automation prove nothing runs it *unattended*;
they do not prove you never launch it by hand.

If yes, (a2) becomes: a Next-16 middleware carrying the same default-deny
posture and the same empty allowlist, plus explicit port/loopback binding
(already applied — it is pinned to `127.0.0.1:3100`).
