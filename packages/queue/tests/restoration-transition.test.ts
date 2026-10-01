// THE CHAIN A PROVED REHEARSAL MUST BE ABLE TO WALK.
//
// THE DEFECT THIS FILE PINS. K5.2 put the observed launchd state into the
// OperationalAdapterBinding, and every CLI mode derives that binding before it
// dispatches. The reviewed destination policy therefore had to name a launchd
// state — and no single value worked:
//
//   * naming `installed-unloaded` (true while the producers are stopped for the
//     fence) made `deriveOperationalBinding` REFUSE after the operator restored
//     them, before `--verify-restoration` could run at all;
//   * naming `installed-loaded` (true afterwards) refused before;
//   * and changing the policy between the two moved the binding digest, so
//     `runVerifyRestoration` rejected the restored world as a DIFFERENT world
//     from the one the rehearsal was taken against.
//
// So a rehearsal that succeeded could not reach the review that authorises an
// apply, and the only ways through were to leave the producers stopped, falsify
// the measured state, accept two unrelated binding digests, or edit a published
// bundle. All four are refused elsewhere, correctly, which is why this had to be
// fixed at the vocabulary rather than worked around.
//
// The chain below is the end-to-end contract: four installed-unloaded agents,
// inspect, rehearse, a restoration that changes ONLY what launchctl answers, then
// verify-restoration, review-rehearsal and an apply inspection that accepts the
// chain. No copy is performed and no live service is touched.

import { readFileSync, writeFileSync, chmodSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { REVIEWED_PRODUCERS } from '@common/db/pg-copy'

import {
  EXIT_ACTION_REQUIRED, EXIT_OK, EXIT_REFUSED, REHEARSAL_PREFIX, RESTORATION_PREFIX, REVIEW_PREFIX,
  runOpsCli,
} from '../bin/pg-copy-ops.js'
import {
  RUN_ID, STAMP, ROOTS, applyScope, base, deps, ready, rehearseArgs, stage1Bundle,
  tokenFor, type World,
} from './support/ops-world.js'
import { launchdQuiescenceAdapter } from '../src/pg-copy-ops/launchd.js'

const DAILY = 'com.thanapol.ai-capital.daily'
const WORKER = 'com.thanapol.ai-capital.worker'
const STRUCTURED = 'com.thanapol.ai-capital.structured-worker'

const restoreArgs = (w: World, extra: readonly string[] = []): string[] =>
  base(w, ['--verify-restoration', `--run-id=${RUN_ID}`, `--stamp=${STAMP}`,
    `--operational-rehearsal-bundle=${join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)}`,
    ...extra])

const reviewArgs = (w: World, extra: readonly string[] = []): string[] =>
  base(w, ['--review-rehearsal', '--reviewer=operator-under-test',
    `--operational-rehearsal-bundle=${join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)}`,
    `--producer-restoration-bundle=${join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)}`,
    `--run-id=${RUN_ID}`, `--stamp=${STAMP}`, ...extra])

/** Snapshot every STABLE identity field, so the simulation can be proved inert. */
const stableSnapshot = (w: World): string => JSON.stringify(
  REVIEWED_PRODUCERS.filter(l => l !== STRUCTURED).map(label => {
    const p = join(w.agents, `${label}.plist`)
    return { label, bytes: readFileSync(p, 'utf-8'), cred: readFileSync(w.credential, 'utf-8') }
  }))

afterAll(() => {
  for (const r of ROOTS) { try { rmSync(r, { recursive: true, force: true }) } catch { /* bounded */ } }
})

describe('a proved rehearsal can walk through restoration to review and apply', () => {
  it('completes a -> h with one reviewed destination policy throughout', async () => {
    // (a) FOUR INSTALLED-UNLOADED AGENTS, structured-worker expected-absent.
    const w = await ready({ restorable: true })
    const d = deps(w)
    const before = stableSnapshot(w)

    const policy = JSON.parse(readFileSync(w.destinationPolicy, 'utf-8')) as {
      producers: { label: string; installation: string; expected: string }[] }
    expect(policy.producers.filter(p => p.label !== STRUCTURED).map(p => p.installation))
      .toEqual(['installed', 'installed', 'installed', 'installed'])
    expect(policy.producers.find(p => p.label === STRUCTURED)?.installation)
      .toBe('expected-absent')

    // (b) --inspect --for=rehearse succeeds, and yields the confirmation.
    const token = await tokenFor(w, 'rehearse', d)
    expect(token).toMatch(/\S/)

    // (c) --rehearse succeeds with ACTION_REQUIRED (the operator must restore).
    const rehearsal = await runOpsCli(rehearseArgs(w, token), d)
    expect(rehearsal.exitCode, rehearsal.lines.join('\n')).toBe(EXIT_ACTION_REQUIRED)

    // (d) SIMULATED MANUAL RESTORATION — the same four plist identities. Only
    //     what launchctl answers changes; no file is touched.
    w.restore()
    expect(stableSnapshot(w)).toBe(before)

    // (e) --verify-restoration succeeds and publishes its bundle. THE SAME
    //     DESTINATION POLICY FILE IS STILL IN PLACE — unedited.
    expect(readFileSync(w.destinationPolicy, 'utf-8'))
      .toBe(JSON.stringify(policy))
    const restoration = await runOpsCli(restoreArgs(w), d)
    expect(restoration.exitCode, restoration.lines.join('\n')).toBe(EXIT_OK)

    // (f) --review-rehearsal succeeds and publishes the reviewed bundle.
    const review = await runOpsCli(reviewArgs(w), d)
    expect(review.exitCode, review.lines.join('\n')).toBe(EXIT_OK)

    // (g) THE REVIEWED CHAIN AUTHORIZES AN APPLY.
    //
    // K7-B6.1 F1 retired `--inspect --for=apply`: a separately minted apply
    // token named a bundle from an earlier process, while the production apply
    // creates the only bundle it may bind to inside its own fence. The step
    // this walkthrough needs is unchanged - the chain published in (f) is
    // accepted - so it is proved where that acceptance now happens.
    const authorized = await runOpsCli(base(w, [
      '--apply',
      `--reviewed-rehearsal=${join(w.evidence, `${REVIEW_PREFIX}-${STAMP}-${RUN_ID}`)}`,
      `--operational-rehearsal-bundle=${join(w.evidence, `${REHEARSAL_PREFIX}-${STAMP}-${RUN_ID}`)}`,
      `--producer-restoration-bundle=${join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)}`,
      // NO --bundle-dir: the apply publishes its own. The target selectors stay.
      ...applyScope(stage1Bundle(w)).filter(a => !a.startsWith('--bundle-dir=')),
    ]), {
      ...d,
      // THE CHANNEL IS PREFLIGHTED FIRST, and this suite has no terminal.
      operatorChannel: () => ({
        preflight: () => undefined,
        arm: () => () => undefined,
        nextLine: async () => '',
        close: () => undefined,
      }),
    })
    // IT ACCEPTED THE CHAIN - naming the rehearsal it was reviewed against -
    // and then refused for want of a driver credential, which is as far as a
    // walkthrough with no live cluster can go.
    expect(authorized.lines.join('\n')).toContain('reviewed rehearsal ')
    expect(authorized.exitCode).toBe(EXIT_REFUSED)
    expect(authorized.lines.join('\n')).toContain('--export-driver-credential')
    // AND IT TOOK NO FENCE AND PUBLISHED NOTHING: the refusal is pre-fence.
    expect(authorized.lines.join('\n')).not.toContain('stage 1 ')
    expect(authorized.lines.join('\n')).not.toMatch(/^copy binding /m)

    // (h) NO COPY AND NO LIVE MUTATION. The run never reached an --apply, and
    //     the only writes anywhere were evidence bundles under the world's own
    //     evidence root.
    expect(rehearsal.lines.join('\n')).not.toMatch(/COPY (STARTED|COMPLETE)/)
    expect(stableSnapshot(w)).toBe(before)
  })

  it('walks the same chain when the STRUCTURED WORKER is installed too', async () => {
    // THE CASE THAT DISTINGUISHES THE TWO VOCABULARIES FOR THAT LABEL. In every
    // other world the structured worker is expected-absent, where the observed
    // state and the stable topology are the same word — so a comparison written
    // against the observed state would pass for the wrong reason. Installed, its
    // observed state moves across the restoration and its topology does not.
    const w = await ready({ restorable: true, structuredAbsent: false })
    const d = deps(w)
    const token = await tokenFor(w, 'rehearse', d)
    expect((await runOpsCli(rehearseArgs(w, token), d)).exitCode).toBe(EXIT_ACTION_REQUIRED)
    w.restore()
    const r = await runOpsCli(restoreArgs(w), d)
    expect(r.exitCode, r.lines.join('\n')).toBe(EXIT_OK)

    const dir = join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)
    const manifest = JSON.parse(readFileSync(join(dir, 'restoration.json'), 'utf-8')) as {
      structured_worker?: { expected?: string; actual?: string; verdict?: string } }
    // THE TOPOLOGY IS WHAT WAS COMPARED, AND THE OBSERVATION IS WHAT WAS PUBLISHED.
    expect(manifest.structured_worker?.expected).toBe('installed')
    expect(manifest.structured_worker?.actual).toBe('installed-loaded')
    expect(manifest.structured_worker?.verdict).toBe('as-reviewed')
  })

  it('the restoration records the OBSERVED states, not the stable topology', async () => {
    // Requirement: the observation must not be erased or normalised in evidence.
    const w = await ready({ restorable: true })
    const d = deps(w)
    const token = await tokenFor(w, 'rehearse', d)
    expect((await runOpsCli(rehearseArgs(w, token), d)).exitCode).toBe(EXIT_ACTION_REQUIRED)
    w.restore()
    expect((await runOpsCli(restoreArgs(w), d)).exitCode).toBe(EXIT_OK)

    const dir = join(w.evidence, `${RESTORATION_PREFIX}-${STAMP}-${RUN_ID}`)
    const producers = JSON.parse(readFileSync(join(dir, 'producers.json'), 'utf-8')) as {
      producers?: { label: string; required: string; observed: string }[] }
    const rows = producers.producers ?? []
    const state = (l: string): string | undefined => rows.find(r => r.label === l)?.observed
    expect(state(DAILY)).toBe('loaded-scheduled-healthy')
    expect(state(WORKER)).toBe('running')
    expect(state(STRUCTURED)).toBe('absent')
  })
})

describe('the confirmation binds the launchd observation', () => {
  /** The same world, answering as if every reviewed label were loaded. */
  const asLoaded = (w: World) => ({
    openPlist: w.commands.openPlist,
    run: async (file: string, args: readonly string[], c: never) => {
      if (file.endsWith('launchctl') && args[0] === 'print') {
        const label = String(args[1]).split('/').pop() as string
        if (label !== STRUCTURED) {
          return { code: 0, stderr: '',
            stdout: `\tpath = ${join(w.agents, `${label}.plist`)}\n` +
                    '\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n' }
        }
      }
      return await w.commands.run(file, args, c)
    },
  })

  it('a changed observed state REFUSES the confirmation, before any supervisor', async () => {
    // THE HOLE THIS CLOSES. The stable binding is invariant across
    // installed-unloaded -> installed-loaded, by design — that invariance is
    // what lets a rehearsal survive the restoration. Without the observation in
    // the execution binding, an operator could inspect a quiescent world, take
    // the token, watch every producer come back up, and paste the same token
    // into a rehearsal: nothing the token covered had changed. Measured before
    // this was bound: the two tokens were byte-identical.
    const w = await ready({ restorable: true })
    const token = await tokenFor(w, 'rehearse', deps(w))

    const loaded = { ...w, commands: asLoaded(w) }
    // THE SUPERVISOR IS COUNTED AND THEN REFUSED, so this case can never reach a
    // fence or an intervention hold in the parent worker. A hold is unbounded by
    // design; if a regression ever made this confirmation match, an
    // in-worker hold would hang the suite and be stopped only by a matrix-level
    // ceiling — which is exactly how the K5.3 chain lost 5 GiB once already.
    // Refusing here turns that regression into a fast, bounded failure.
    let supervisorsOpened = 0
    const d = deps(loaded, {
      openSupervisor: async () => {
        supervisorsOpened += 1
        throw new Error('the confirmation should have been refused before this')
      },
    })
    const r = await runOpsCli(rehearseArgs(loaded, token), d)

    expect(r.exitCode, r.lines.join('\n')).not.toBe(EXIT_OK)
    expect(r.exitCode).not.toBe(EXIT_ACTION_REQUIRED)
    expect(r.lines.join('\n')).toMatch(/confirmation does not match/)
    // AND IT REFUSED EARLY: no supervisor session, so no fence could be taken.
    expect(supervisorsOpened).toBe(0)
  })

  it('the SAME observed states accept the confirmation', async () => {
    // NON-VACUITY. The refusal above must be about the observation, not about
    // the token being unusable in general.
    const w = await ready({ restorable: true })
    const token = await tokenFor(w, 'rehearse', deps(w))
    expect((await runOpsCli(rehearseArgs(w, token), deps(w))).exitCode)
      .toBe(EXIT_ACTION_REQUIRED)
  })

  it('the inspection prints the observation digest beside the stable one', async () => {
    const w = await ready({ restorable: true })
    const r = await runOpsCli(base(w, ['--for=rehearse', '--inspect',
      `--rehearsal-authorization=${w.authorization}`]), deps(w))
    expect(r.exitCode, r.lines.join('\n')).toBe(EXIT_OK)
    const stable = r.lines.find(l => l.startsWith('operational adapter binding '))
    const observed = r.lines.find(l => l.startsWith('launchd observation '))
    expect(stable).toBeDefined()
    expect(observed).toBeDefined()
    expect((observed as string).trim().split(/\s+/).pop()).toMatch(/^[0-9a-f]{64}$/)
    // TWO DIFFERENT DIGESTS, so neither is a restatement of the other.
    expect((stable as string).trim().split(/\s+/).pop())
      .not.toBe((observed as string).trim().split(/\s+/).pop())
  })
})

describe('the transition is permitted; drift inside it is not', () => {
  const chainTo = async (w: World): Promise<void> => {
    const d = deps(w)
    const token = await tokenFor(w, 'rehearse', d)
    expect((await runOpsCli(rehearseArgs(w, token), d)).exitCode).toBe(EXIT_ACTION_REQUIRED)
  }

  it('REFUSES when the plist BYTES change across the restoration', async () => {
    const w = await ready({ restorable: true })
    await chainTo(w)
    w.restore()
    const p = join(w.agents, `${DAILY}.plist`)
    writeFileSync(p, `${readFileSync(p, 'utf-8')}<!-- swapped -->`)
    chmodSync(p, 0o644)
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).not.toBe(EXIT_OK)
  })

  it('REFUSES when the plist is replaced with identical bytes at a new inode', async () => {
    const w = await ready({ restorable: true })
    await chainTo(w)
    w.restore()
    const p = join(w.agents, `${DAILY}.plist`)
    const bytes = readFileSync(p)
    unlinkSync(p)
    writeFileSync(p, bytes)
    chmodSync(p, 0o644)
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).not.toBe(EXIT_OK)
  })

  it('REFUSES when the credential container is replaced', async () => {
    const w = await ready({ restorable: true })
    await chainTo(w)
    w.restore()
    const bytes = readFileSync(w.credential)
    unlinkSync(w.credential)
    writeFileSync(w.credential, bytes)     // same bytes, new device:inode
    chmodSync(w.credential, 0o600)
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).not.toBe(EXIT_OK)
  })

  it('REFUSES when the sanitized endpoint changes', async () => {
    const w = await ready({ restorable: true })
    await chainTo(w)
    w.restore()
    writeFileSync(w.credential, 'postgres://u:p@%2Ftmp%2Fs/another_database\n')
    chmodSync(w.credential, 0o600)
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).not.toBe(EXIT_OK)
  })

  it('REFUSES when an installed plist is REMOVED across the restoration', async () => {
    const w = await ready({ restorable: true })
    await chainTo(w)
    w.restore()
    unlinkSync(join(w.agents, `${DAILY}.plist`))
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).not.toBe(EXIT_OK)
  })

  it('REFUSES when the STRUCTURED WORKER appears', async () => {
    const w = await ready({ restorable: true })
    await chainTo(w)
    w.restore()
    const p = join(w.agents, `${STRUCTURED}.plist`)
    writeFileSync(p, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>' +
      `<key>Label</key><string>${STRUCTURED}</string>` +
      `<key>WorkingDirectory</key><string>${w.dir}</string>` +
      '<key>EnvironmentVariables</key><dict>' +
      `<key>PIPELINE_CREDENTIAL_FILE</key><string>${w.credential}</string>` +
      '</dict></dict></plist>')
    chmodSync(p, 0o644)
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).not.toBe(EXIT_OK)
  })

  it('REFUSES a restoration that was never performed at all', async () => {
    // The producers are still unloaded, so the post-restoration policy is unmet.
    // This is the control proving the happy path above is not vacuous.
    const w = await ready({ restorable: true })
    await chainTo(w)
    const r = await runOpsCli(restoreArgs(w), deps(w))
    expect(r.exitCode).not.toBe(EXIT_OK)
  })

  it('REFUSES a scheduled agent that came back LOADED BUT UNHEALTHY', async () => {
    const w = await ready({ restorable: true })
    await chainTo(w)
    w.restore()
    // The same restored world, except the scheduled agents report a failing last
    // exit — loaded, scheduled, and not healthy.
    const unhealthy = {
      openPlist: w.commands.openPlist,
      run: async (file: string, args: readonly string[], c: never) => {
        const r = await w.commands.run(file, args, c)
        if (file.endsWith('launchctl') && args[0] === 'print' && r.code === 0) {
          return { ...r, stdout: r.stdout.replace('last exit code = 0', 'last exit code = 78') }
        }
        return r
      },
    }
    const r = await runOpsCli(restoreArgs({ ...w, commands: unhealthy }),
                             deps({ ...w, commands: unhealthy }))
    expect(r.exitCode).not.toBe(EXIT_OK)
  })

  it('REFUSES when the WORKER did not come back running', async () => {
    const w = await ready({ restorable: true })
    await chainTo(w)
    w.restore()
    const idleWorker = {
      openPlist: w.commands.openPlist,
      run: async (file: string, args: readonly string[], c: never) => {
        const r = await w.commands.run(file, args, c)
        if (file.endsWith('launchctl') && args[0] === 'print' &&
            String(args[1]).endsWith('.worker') && r.code === 0) {
          return { ...r, stdout: r.stdout.replace('state = running\n\tpid = 4242\n',
                                                  'state = not running\n') }
        }
        return r
      },
    }
    const r = await runOpsCli(restoreArgs({ ...w, commands: idleWorker }),
                             deps({ ...w, commands: idleWorker }))
    expect(r.exitCode).not.toBe(EXIT_OK)
  })
})

describe('quiescence is still proved independently of the stable topology', () => {
  // DRIVEN AT THE ADAPTER, NOT THROUGH THE CLI. A rehearsal that finds the
  // producers not quiescent enters the operator intervention hold by design —
  // that hold is unbounded and is resolved by a person, so driving it from here
  // would hang rather than assert. What this test needs to establish is that the
  // census still sees the process, which is exactly what the adapter answers.
  const adapterFor = (w: World, commands = w.commands) => launchdQuiescenceAdapter(
    REVIEWED_PRODUCERS, { uid: '501', agentsDir: w.agents, commands })
  const ctx = (): { signal: AbortSignal } => ({ signal: new AbortController().signal })

  it('a matching producer PROCESS defeats quiescence for an INSTALLED agent', async () => {
    // The post-cutover shape exactly: plists installed, labels out, and a
    // producer somebody left running by hand. A stable `installed` classification
    // must never be mistaken for proof that nothing is running.
    const w = await ready({ restorable: true })
    const withProcess = {
      openPlist: w.commands.openPlist,
      run: async (file: string, args: readonly string[], c: never) => {
        if (file.endsWith('/ps')) {
          return { code: 0, stderr: '',
            stdout: '  1 /sbin/launchd\n 999 /bin/bash /x/daily-queue.sh\n' }
        }
        return await w.commands.run(file, args, c)
      },
    }
    const dirty = await adapterFor(w, withProcess).measure(ctx())
    const daily = dirty.find(p => p.name === DAILY)
    expect(daily?.stopped).toBe(false)
    expect(daily?.processPids).toEqual(['999'])
    // And the agent IS installed, so the two facts are independent.
    expect(daily?.presence).toBe('absent')

    // NON-VACUITY: the same world with no producer process is quiescent.
    const clean = await adapterFor(w).measure(ctx())
    for (const p of clean) expect([p.name, p.stopped]).toEqual([p.name, true])
  })

  it('a RESTORED world is NOT quiescent — the labels are loaded again', async () => {
    // The other direction of the same independence: the stable topology is
    // unchanged by the restoration, and quiescence is emphatically not.
    const w = await ready({ restorable: true })
    const before = await adapterFor(w).measure(ctx())
    expect(before.every(p => p.stopped)).toBe(true)
    w.restore()
    const after = await adapterFor(w).measure(ctx())
    expect(after.find(p => p.name === DAILY)?.stopped).toBe(false)
    expect(after.find(p => p.name === WORKER)?.stopped).toBe(false)
    expect(after.find(p => p.name === STRUCTURED)?.stopped).toBe(true)
  })
})
