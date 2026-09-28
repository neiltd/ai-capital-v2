# PostgreSQL copy fence — reviewed operator inputs

`destination-policy.json` is the reviewed destination policy read by
`packages/queue/bin/pg-copy-ops.ts` through `--destination-policy`.

## The four installation states

An agent's *installation* and its *destination* are two different facts, and the
policy declares both so the census can compare rather than infer.

| state | launchd holds the label | reviewed plist installed | evidence bound |
|---|---|---|---|
| `installed-loaded` | yes | yes | complete |
| `installed-disabled` | yes, disabled | yes | complete |
| `installed-unloaded` | **no** | **yes** | **complete** |
| `expected-absent` | no | no | nothing — every field null |

`installed-unloaded` exists because the third row is a real, ordinary state: after
a runtime cutover the four production plists sit under `~/Library/LaunchAgents`
while their labels are booted out. `launchctl print` answers 113 for each of
them, which is the same answer it gives for an agent that was never installed.

Before this state existed there was one place to put that answer —
`expected-absent` — whose contract is that **every** evidence field is null. The
consequence was not a wrong word in a document: the installed plist's path and
digest, the checkout it serves, the credential container it names and the
endpoint it would write to all left the operational binding, and so left the
coverage of the confirmation token. A plist could be replaced between the
pre-fence and fenced censuses and both would compare equal.

So the two absences are now distinguished by looking at the filesystem:

* **no label and no reviewed plist** → `expected-absent`;
* **no label but the exact reviewed plist is safely present** → `installed-unloaded`,
  binding the same complete identity any other installed state binds.

Both are quiescent with respect to launchd — it will not fire a label it does not
hold — and neither is quiescent on its own: a process matching the reviewed
command pattern still defeats quiescence for an installed-unloaded agent exactly
as it does for an absent one. That is the case that matters after a cutover, when
the plists are installed, the labels are out, and a producer someone left running
by hand is still writing to the source.

## How an installed plist is found

One exact filename, `<agents-dir>/<label>.plist`, derived from the reviewed label.

The directory is **never scanned**: a scan would let an unrelated file become the
evidence for a reviewed agent, and would make the set of files consulted depend
on directory contents rather than on the reviewed label list. No alternate path
is accepted — there is no flag, plist key or environment variable that redirects
it — because the whole value of the check is that the file measured is the file
launchd would load.

The `agentsDir` option is therefore **authoritative and is used to derive a
path**. It previously carried a comment saying the opposite ("recorded, never
used to invent a path"), which was true of the three-state vocabulary and is not
true now; that comment has been corrected in `launchd.ts`.

Detection is fail-closed. Only one shape may become `expected-absent`: nothing at
that name at all. Each of these **refuses** instead:

* a symlink at the plist path — whoever controls the link chooses what launchd loads;
* a **dangling** symlink — `existsSync` follows links and reports absence, which
  would have downgraded the agent and dropped its whole identity;
* a directory or any non-regular file;
* a file this user does not own, or one that is group- or world-writable;
* a link count above one;
* a file that cannot be read, or that changed under the descriptor;
* a malformed plist;
* a plist whose own `Label` does not equal the filename it was found under. The
  path was derived *from* the label, so unlike the loaded case there is no
  launchctl statement tying the two together — the document's own `Label` is that
  statement, and a file claiming another label at this name is a misinstallation.

## Current policy

| label | installation | destination |
|---|---|---|
| `com.thanapol.ai-capital.daily` | `installed-unloaded` | `writes-copy-source` |
| `com.thanapol.ai-capital.watchdog` | `installed-unloaded` | `writes-copy-source` |
| `com.thanapol.ai-capital.alerts` | `installed-unloaded` | `writes-copy-source` |
| `com.thanapol.ai-capital.structured-worker` | `expected-absent` | `expected-absent` |
| `com.thanapol.ai-capital.worker` | `installed-unloaded` | `writes-copy-source` |

Entries must appear in `REVIEWED_PRODUCERS` order. The order is part of the stop
sequence, and the reader refuses a policy that is in any other order or that
omits or duplicates a label.

Bootstrapping any of the four labels changes their installation state, and the
policy must be updated in the same change — a census that finds a label loaded
while the policy says unloaded refuses, which is the intended behaviour.
