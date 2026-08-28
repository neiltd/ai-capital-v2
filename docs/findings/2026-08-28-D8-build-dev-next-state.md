# D8 — build validation and the running dev server share mutable `.next`

**Status: RECORDED. Operational, not a security finding.**

## What happened

`pnpm --filter unified-platform build` was run repeatedly as part of the W4
verification gate while `next dev` was serving on `127.0.0.1:3000` from the same
working directory. Both write `.next/`. The build rewrote `BUILD_ID` and emptied
`.next/server/chunks/vendor-chunks/`, so the running dev process lost the chunk
graph it had been serving from.

Observable result: every API route began returning 500 with
`Cannot find module ./chunks/vendor-chunks/next@14.2.35…`.

Evidence at the time: dev server started 10:09; `.next/BUILD_ID` mtime 17:53;
`vendor-chunks/` count 0.

## Why it matters beyond the inconvenience

It briefly looked like a code defect. During the W4 audit, four routes returned
500 on GET while one returned a clean 405 — a split that reads like a real
behavioural difference and was initially treated as signal. It was not; it was
this. **A shared mutable build directory turns a verification step into a
confounder for the thing being verified.**

This is the same failure family as the rest of this effort: a measurement whose
apparatus perturbs what it measures.

## Options, none chosen

- Give `next build` its own `distDir` when run as a gate (`NEXT_DIST_DIR` or a
  config switch), so validation cannot touch a serving instance.
- Run the gate build in a git worktree or a copy.
- Refuse to run the gate build while a dev server is detected on the port.
- Accept it, and always restart the dev server after a gate run.

## Current state

The dev server was deliberately left stopped/broken rather than restarted
mid-W4. A clean restart on `127.0.0.1:3000` with auth and read-only
verification is queued as a separate step after Glenn's W4 briefing.
