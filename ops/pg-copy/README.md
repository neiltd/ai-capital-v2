# PostgreSQL copy fence — reviewed operator inputs

`destination-policy.json` is the reviewed destination policy read by
`packages/queue/bin/pg-copy-ops.ts` through `--destination-policy`.

## The reviewed launcher

Every live step runs the command as a **single node process**, from
`<checkout>/packages/queue`:

```
node --import tsx <checkout>/packages/queue/bin/pg-copy-ops.ts <args>
```

`tsx` resolves from the package's own `node_modules`, so the working directory
matters; it is also what makes the package's `tsconfig.json` apply. This form
passes no `--`.

**Not the `node_modules/.bin/tsx` shim.** That is the tsx CLI, which runs the
script in a second node process behind a supervisor. The supervisor installs its
own `SIGINT`/`SIGTERM` handlers, waits for an IPC acknowledgement from the child,
and sends the child `SIGKILL` if two short windows pass without one
(`tsx/dist/cli.mjs`, `relaySignals`). A process holding a source fence cannot
acknowledge while it is inside a synchronous publish, and `SIGKILL` cannot be
held — so the shim could kill the fence holder, which closes the `psql` child's
stdin and releases the fence. It also leaves two node pids, so "the CLI pid" an
operator needs to signal is ambiguous. The `--import` form has one pid and the
application's own handlers.

## Two vocabularies, deliberately

An agent's **stable installation topology** and its **observed launchd state** are
different facts, and conflating them made the rehearsal sequence impossible to
finish. Both are measured; they are used for different things.

### Stable topology — what the operational binding agrees to

| value | meaning |
|---|---|
| `installed` | the exact reviewed plist exists and its full identity was measured |
| `expected-absent` | there is no launchd label **and** no reviewed plist |

This is what `OperationalAdapterBinding` carries, and therefore what the
confirmation token covers. It is invariant across loading, disabling and
unloading, which is the property the whole sequence depends on.

### Observed launchd state — what evidence and restoration compare

| value | meaning |
|---|---|
| `installed-loaded` | launchd holds the label |
| `installed-disabled` | launchd holds it, disabled |
| `installed-unloaded` | launchd holds no label, but the reviewed plist is installed |
| `expected-absent` | no label and no plist |

This is **not** erased or normalised. It is measured freshly at every phase,
recorded on the same producer record, published in evidence, compared against the
post-restoration policy, and digested through `modeObservationDigest` — which
every mode confirmation now carries as a **required** field.

That last part was a claim before it was a mechanism. `modeObservationDigest`
existed, was exported and was tested, and had **zero production call sites**: two
inspections of the same world, one with the labels unloaded and one with them
loaded, minted byte-identical confirmation tokens. An operator could inspect a
quiescent world, take the token, watch every producer come back up, and paste the
same token into a rehearsal, because nothing the token covered had changed. The
observation is now bound into `ExecutionBinding` and serialized as
`mode_observation_digest`, so a changed observed state refuses the confirmation
**before** a supervisor session is opened or a fence is taken. `BINDING_VERSION`
is `3` for that shape change.

The two digests are deliberately separate: the stable one stays comparable across
phases, the observation one makes each confirmation specific to what was actually
seen. The observation digest is **never** compared across rehearsal and
restoration — those phases observe different launchd states on purpose, and
cross-phase equality uses the stable operational digest and the independently
measured post-restoration policy.

## Why the split exists

Every CLI mode derives the operational binding before it dispatches. When the
binding carried the observed launchd state, the reviewed destination policy had to
name one — and no value worked:

* naming `installed-unloaded` (true while the producers are stopped for the fence)
  made `deriveOperationalBinding` **refuse after** the operator restored them,
  before `--verify-restoration` could run at all;
* naming `installed-loaded` (true afterwards) refused **before**;
* changing the policy between the two moved the binding digest, so
  `runVerifyRestoration` rejected the restored world as a *different world* from
  the one the rehearsal was taken against.

So a rehearsal that succeeded could not reach the review that authorises an apply.
The ways "through" were all unacceptable: leave the producers stopped, falsify the
measured state, accept two unrelated binding digests, or edit a published bundle.

The one intended transition — `installed-unloaded` → `installed-loaded` across a
manual restoration — now leaves the binding digest **identical**, and only because
every stable field is identical: label and order, plist path, plist SHA-256, plist
device:inode, served checkout, credential-container path and device:inode,
sanitized host/port/database, disposition, queue and blocking policy, process
policy, Redis identity, evidence-root identity, restoration-policy identity and
implementation identity. Drift in any of those still refuses.

`BINDING_VERSION` is `4`: version 2 moved the observation out of the operational
document, version 3 bound it into the confirmation, and version 4 widened the
disposition domain with `no-postgresql-route` — under which an installed producer
carries five null credential and endpoint fields where version 3 required them
non-null. Digests are not comparable across those versions, which is the intended
signal.

## Who owns which phase-specific fact

| document | owns |
|---|---|
| `destination-policy.json` | is the agent installed, and where does it write |
| quiescence census | are the producers stopped, before and while fenced |
| post-restoration policy | are they back: `loaded-scheduled-healthy` / `running` / `absent` |

The destination policy therefore **must not** prescribe whether an installed agent
is currently loaded, and the reader refuses a policy that names a transient state.

Quiescence remains independent: a stable `installed` classification is never proof
that nothing is running. The process census matches the reviewed command pattern
and a match defeats quiescence — which is exactly the post-cutover risk, when the
plists are installed, the labels are out, and a producer someone started by hand
is still writing to the source.

## How an installed plist is found

One exact filename, `<agents-dir>/<label>.plist`, derived from the reviewed label.

The directory is **never scanned**: a scan would let an unrelated file become the
evidence for a reviewed agent, and would make the set of files consulted depend on
directory contents rather than on the reviewed label list. No alternate path is
accepted — there is no flag, plist key or environment variable that redirects it —
because the whole value of the check is that the file measured is the file launchd
would load.

The `agentsDir` option is therefore **authoritative and is used to derive a path**.
It previously carried a comment saying the opposite ("recorded, never used to
invent a path"), which was true of the three-state vocabulary and is not true now;
that comment has been corrected in `launchd.ts`.

Detection is fail-closed. Only one shape may become `expected-absent`: nothing at
that name at all. Each of these **refuses** instead:

* a symlink at the plist path — whoever controls the link chooses what launchd loads;
* a **dangling** symlink — `existsSync` follows links and reports absence, which
  would have downgraded the agent and dropped its whole identity;
* a directory or any non-regular file;
* a file this user does not own, or one that is group- or world-writable;
* a link count above one;
* a file that cannot be examined, cannot be read, or changed under the descriptor;
* a malformed plist;
* a plist whose own `Label` does not equal the filename it was found under. The
  path was derived *from* the label, so unlike the loaded case there is no
  launchctl statement tying the two together — the document's own `Label` is that
  statement, and a file claiming another label at this name is a misinstallation.

## Destinations — what plist inspection does and does not prove

| value | meaning |
|---|---|
| `writes-copy-source` | the plist names a credential container whose measured endpoint IS the copy source |
| `writes-another-reviewed-database` | it names one, and the endpoint is a different reviewed database |
| `no-postgresql-route` | the plist names **no** credential container, no forbidden database key and no inline URL |
| `destination-unproved` | the configuration is malformed, unreadable or ambiguous — a refusal, not a state |
| `expected-absent` | there is no label and no plist, so there is nothing to classify |

`no-postgresql-route` exists because two reviewed agents genuinely have no route.
`daily` and `watchdog` are shell scripts that orchestrate the pipeline; their
plists bind `AI_CAPITAL_ROOT`, `DATA_ROOT`, `REDIS_URL`, `PATH`,
`PIPELINE_RUNS_DB` and `SCHEDULER_HEARTBEAT_FILE`, and no
`PIPELINE_CREDENTIAL_FILE`. Declaring them `writes-copy-source` refused the first
K6 inspection, and correctly: the completeness rule requires a container path, a
container device:inode and a sanitized host/port/database, and none of those
exists for an agent that holds no credential.

**What the state claims is narrow, deliberately.** It says: this plist names no
PostgreSQL credential container, and the inline checks found no URL, no userinfo
and no forbidden database key. It does **not** claim the agent cannot cause a
write. Both of these agents can put work into a queue whose consumer writes the
copy source, so both stay in the reviewed stop order, the process census and the
queue census. It also does not claim anything about what the scripts do at
runtime: a plist is a static document, and reading one proves what launchd will
put in the environment, nothing more.

`destination-unproved` is untouched and still invalid in a binding. The two
states are not interchangeable: one says nothing is there, the other says
something is there and could not be understood.

The measured value is never copied from the policy. That line used to read
`disposition = entry.expected`, which made the comparison compare the policy with
itself — a plist binding nothing satisfied `writes-copy-source`, and the
contradiction only surfaced later as a completeness check that could name no
container.

## Current policy

| label | installation | destination |
|---|---|---|
| `com.thanapol.ai-capital.daily` | `installed` | `no-postgresql-route` |
| `com.thanapol.ai-capital.watchdog` | `installed` | `no-postgresql-route` |
| `com.thanapol.ai-capital.alerts` | `installed` | `writes-copy-source` |
| `com.thanapol.ai-capital.structured-worker` | `expected-absent` | `expected-absent` |
| `com.thanapol.ai-capital.worker` | `installed` | `writes-copy-source` |

Entries must appear in `REVIEWED_PRODUCERS` order. The order is part of the stop
sequence, and the reader refuses a policy that is in any other order or that omits
or duplicates a label.

This policy does not change when the operator restores the agents. That is the
point: the same reviewed file is in place before the fence and after the
restoration, and `--verify-restoration` compares the world against it without
either document having been edited.
