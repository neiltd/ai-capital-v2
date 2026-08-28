# W4 — status and the exact limits of the regression guard

**Production property: CLOSED.**
**Regression guard: LIMITED** — closed for the classes below, with two known
false negatives documented here.

Stopped by decision after nine adversarial rounds. Beyond this point additional
analyzer complexity has diminishing safety value.

---

## The production property (CLOSED)

> No project-owned code the dashboard build or a non-user request evaluates
> holds LLM SDK authority outside an explicit user-action handler body.

**Established independently of the guard.** Warden enumerated every SDK
reference in the tree by hand rather than trusting the analyzer. Exactly five
files reference an LLM SDK, all route handlers, all acquiring by dynamic
`import()` inside the handler body:

- `src/app/api/ask/route.ts`
- `src/app/api/studio/chat/route.ts`
- `src/app/api/studio/visuals/illustration/route.ts`
- `src/app/api/studio/upload/route.ts`
- `src/app/api/thesis-proposals/route.ts`

`src/lib/studio/agent.ts` holds no SDK reference at all — it used to export a
pre-constructed client, which was ambient authority for every importer and is
how four POST-only routes came to construct clients on any GET. Zero SDK
references anywhere under `packages/`.

---

## What the guard does check

`apps/unified-platform/tests/spend-graph.ts`, 44 corpus tests.

| | |
|---|---|
| Roots | every Next render convention, **every** `route.*` regardless of exported methods, `middleware`/`instrumentation`, and the build surfaces `next.config.*`, `tailwind.config.*`, `postcss.config.*` |
| Rule | a file reached from a root may not reference SDK authority, except structurally inside the body of an exported POST/PUT/PATCH/DELETE handler |
| Resolution | delegated to the TypeScript compiler with the app's real tsconfig; traversal stops at the project boundary, decided by `realpath` so workspace symlinks are followed and third-party is not |
| Backstop | this app's `src`, all project-owned source under `packages/*`, and the project root's own top-level files — an unreached file must not even be able to *reach* authority |
| Failure recording | resolution failure on anything that could be project-owned is a guard failure, not an ignored edge |

Verified classes: route module-load acquisition · page/render · middleware ·
HEAD-only · OPTIONS-only · dynamic transitive · module-scope singleton · factory
invoked at module evaluation · top-level await · workspace-package transitive ·
build-time config · GET-body acquisition · default-parameter acquisition ·
direct/one-hop/two-hop/three-hop/cyclic/unresolved/cross-module aliasing.

---

## The two known false negatives

Both require a route to export an HTTP method through a form no route in this
repo uses. **All 26 route files use the direct `export [async] function METHOD`
form**, there are zero destructured method exports, and no method export goes
through an identifier alias. Neither is live.

### L1 — the alias graph is scope-blind

`nodeOf`/`aliasOf` are built by a whole-file sweep with no scope awareness and
are last-write-wins, and `resolveName` consults `nodeOf` before `aliasOf`. So a
function-valued binding of the same name **anywhere in the file, including
inside another handler's body**, outranks the module-level alias and silently
redirects a method name to the wrong node.

```ts
const impl = async () => { /* acquires SDK */ }
const g = impl
export const POST = impl
export const GET = g
export const PUT = async () => { const g = () => 1; return Response.json({ n: g() }) }
```

`GET` claims the *inner* arrow, so `impl`'s method set looks like `{POST}` and
its body is granted permission — while at runtime `GET === impl`. Removing the
nested `const g` makes the same file flag correctly, which isolates the shadow
as the sole cause.

**Fixing it properly means scope-aware binding resolution**, which is the
whole-program data-flow boundary this effort deliberately refused to cross.

### L2 — a destructured method export never registers uncertainty

The declaration loop skips any non-identifier binding name with `continue`, so
an `ObjectBindingPattern` produces no claim at all and never reaches the
`claim(null, …)` path that sets `unprovable`.

```ts
const impl = async () => { /* acquires SDK */ }
const ns = { GET: impl }
export const POST = impl
export const { GET } = ns
```

The file-level suppression itself is sound and does work. **The defect is
upstream of it:** two syntactic forms of a method export never reach `claim`, so
uncertainty is never registered in the first place.

---

## Explicitly out of scope

- **Subprocess / delegated authority** — W5. Spending authority is a strictly
  larger set than SDK reference; a module-scope `execFile` of a CLI that spends
  is invisible to this guard by design.
- **Test / tooling execution** — vitest configs and their imports belong to the
  test-egress boundary. Deliberately not a W4 root; mislabelling it here would
  hide both.
- **Arbitrary non-LLM side effects** — network, filesystem, credentials.
- **Cross-module handler identity** — a handler body imported from a sibling
  module cannot be proven local. It fails closed, and that is asserted.
- **Third-party package internals** — traversal stops at the project boundary.

## Seams 2 and 3

`unresolvedProjectEdges` and the project-root backstop were repaired and are
covered by corpus controls, but Warden stopped at the seam-1 false negative in
both of its last two runs and **never probed them**. They are **unverified, not
verified.** Recorded so the distinction is not lost.
