// INSTALLED BUT UNLOADED: the fourth installation state, and what it binds.
//
// THE DEFECT THIS FILE PINS. After a runtime cutover the four reviewed plists
// are on disk and their launchd labels are booted out. `launchctl print` answers
// 113 for every one of them, and the three-state vocabulary had exactly one
// place to put that: `expected-absent`, the state reserved for an agent that is
// not installed at all. That state's contract is that EVERY evidence field is
// null - so the installed plist's path and digest, the checkout it serves, the
// credential container it names and the endpoint it would write to all left the
// operational binding, and with them the confirmation token's coverage of any of
// it. A plist could be swapped between two censuses and nothing would move.
//
// EVERY TEST HERE USES REAL FILESYSTEM ARTIFACTS for the unsafe cases - a real
// symlink, a real dangling symlink, a real hard link, real modes. A stubbed
// `lstat` would prove the code branches; only a real link proves it branches on
// the thing that actually makes a plist untrustworthy.

import { describe, it, expect, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import {
  chmodSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  REVIEWED_PRODUCERS, operationalBindingDocument, INSTALLATION_STATES, INSTALLED_STATES,
  canonicalJson, modeObservationDigest,
}
  from '@common/db/pg-copy'


import {
  inspectLabel, readDisabled, remeasureLabel, reviewedPlistPath, probeReviewedPlist,
  launchdQuiescenceAdapter, LaunchdInspectionRefused, READ_ONLY_LAUNCHCTL_VERBS,
  type LabelInspection,
} from '../src/pg-copy-ops/launchd.js'
import { installationOf, proveDestinations, DestinationRefused }
  from '../src/pg-copy-ops/destination.js'
import { compareIdentity, compareProducerSets, deriveOperationalBinding, readDestinationPolicy }
  from '../bin/pg-copy-ops.js'
import { world, ROOTS, strip } from './support/ops-world.js'
import { resolveRedis } from '../src/pg-copy-ops/redis-config.js'

const DAILY = 'com.thanapol.ai-capital.daily'
const STRUCTURED = 'com.thanapol.ai-capital.structured-worker'
const SOURCE = { host: '/tmp/s', port: '5432', database: 'ai_capital' } as const

const ctx = (): { signal: AbortSignal } => ({ signal: new AbortController().signal })
const opts = (w: ReturnType<typeof world>) =>
  ({ uid: '501', agentsDir: w.agents, commands: w.commands })

async function look(w: ReturnType<typeof world>, label = DAILY): Promise<LabelInspection> {
  const o = opts(w)
  return await inspectLabel(label, o, ctx(), await readDisabled(o, ctx()))
}

/** The reviewed policy, with one label's declaration overridable. */
const policyFor = (over: Record<string, { expected: string; installation: string }> = {}) =>
  REVIEWED_PRODUCERS.map(label => ({
    label,
    ...(over[label] ?? (label === STRUCTURED
      ? { expected: 'expected-absent', installation: 'expected-absent' }
      : { expected: 'writes-copy-source', installation: 'installed' })),
  })) as never

afterAll(() => {
  for (const r of ROOTS) { try { rmSync(r, { recursive: true, force: true }) } catch { /* bounded */ } }
})

// ── 1. The state exists, and it binds a COMPLETE identity ──────────────────

describe('an absent label whose exact reviewed plist is safely present is installed-unloaded', () => {
  it('reports presence absent, installedUnloaded true, and installation installed-unloaded', async () => {
    const seen = await look(world({ unloaded: true }))
    expect(seen.presence).toBe('absent')
    expect(seen.installedUnloaded).toBe(true)
    expect(installationOf(seen)).toBe('installed-unloaded')
  })

  it('binds every identity field from the one safely opened plist', async () => {
    const w = world({ unloaded: true })
    const seen = await look(w)
    const expectedPath = join(w.agents, `${DAILY}.plist`)
    expect(seen.plistPath).toBe(expectedPath)
    expect(seen.plistSha256).toBe(
      createHash('sha256').update(readFileSync(expectedPath)).digest('hex'))
    expect(seen.plistDeviceInode).toMatch(/^\d+:\d+$/)
    expect(seen.servedCheckout).toBe(w.dir)
    expect(seen.credentialPath).toBe(w.credential)
    expect(seen.plist).not.toBeNull()
  })

  it('never claims the agent is loaded, disabled-and-running, or has a pid', async () => {
    const seen = await look(world({ unloaded: true }))
    expect(seen.presence).not.toBe('loaded')
    expect(seen.running).toBe(false)
    expect(seen.pid).toBeNull()
    expect(seen.lastExitCode).toBeNull()
  })

  it('the full census binds path, digest, checkout, credential identity and sanitized endpoint', async () => {
    const w = world({ unloaded: true })
    const rows = await proveDestinations(
      REVIEWED_PRODUCERS, SOURCE, policyFor(), opts(w), ctx())
    const daily = rows.find(r => r.label === DAILY)
    // BOTH ARE RECORDED: the observation is not erased by the stable topology.
    expect(daily?.installation).toBe('installed-unloaded')
    expect(daily?.stableInstallation).toBe('installed')
    expect(daily?.disposition).toBe('writes-copy-source')
    expect(daily?.plistPath).toBe(join(w.agents, `${DAILY}.plist`))
    expect(daily?.plistSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(daily?.plistDeviceInode).toMatch(/^\d+:\d+$/)
    expect(daily?.servedCheckout).toBe(w.dir)
    expect(daily?.credentialPath).toBe(w.credential)
    expect(daily?.credentialDeviceInode).toMatch(/^\d+:\d+$/)
    expect(daily?.databaseHost).toBe('/tmp/s')
    expect(daily?.databasePort).toBe('5432')
    expect(daily?.databaseName).toBe('ai_capital')
  })

  it('the four cutover agents are installed-unloaded and write the copy source', async () => {
    const w = world({ unloaded: true })
    const rows = await proveDestinations(
      REVIEWED_PRODUCERS, SOURCE, policyFor(), opts(w), ctx())
    for (const row of rows.filter(r => r.label !== STRUCTURED)) {
      expect([row.label, row.installation, row.stableInstallation, row.disposition])
        .toEqual([row.label, 'installed-unloaded', 'installed', 'writes-copy-source'])
    }
  })
})

// ── 2. Absence still means absence ─────────────────────────────────────────

describe('an absent label with no reviewed plist is expected-absent', () => {
  it('reports expected-absent with every evidence field null', async () => {
    // No plist is written for the structured worker in any world.
    const seen = await look(world({ unloaded: true }), STRUCTURED)
    expect(seen.presence).toBe('absent')
    expect(seen.installedUnloaded).toBe(false)
    expect(installationOf(seen)).toBe('expected-absent')
    for (const v of [seen.plistPath, seen.plistSha256, seen.plistDeviceInode,
                     seen.servedCheckout, seen.credentialPath, seen.plist]) {
      expect(v).toBeNull()
    }
  })

  it('the structured worker stays expected-absent in a cutover world', async () => {
    const w = world({ unloaded: true })
    const rows = await proveDestinations(
      REVIEWED_PRODUCERS, SOURCE, policyFor(), opts(w), ctx())
    const s = rows.find(r => r.label === STRUCTURED)
    expect(s?.installation).toBe('expected-absent')
    expect(s?.stableInstallation).toBe('expected-absent')
    expect(s?.disposition).toBe('expected-absent')
    expect(s?.plistPath).toBeNull()
    expect(s?.credentialPath).toBeNull()
    expect(s?.databaseName).toBeNull()
  })

  it('removing an installed plist turns installed-unloaded back into expected-absent', async () => {
    const w = world({ unloaded: true })
    expect(installationOf(await look(w))).toBe('installed-unloaded')
    unlinkSync(join(w.agents, `${DAILY}.plist`))
    expect(installationOf(await look(w))).toBe('expected-absent')
  })
})

// ── 3. The filename convention is exact, and the directory is never scanned ─

describe('the reviewed plist path is one exact filename', () => {
  it('derives <agents-dir>/<label>.plist and nothing else', () => {
    expect(reviewedPlistPath(DAILY, '/Users/x/Library/LaunchAgents'))
      .toBe(`/Users/x/Library/LaunchAgents/${DAILY}.plist`)
  })

  it('refuses a relative agents directory', () => {
    expect(() => reviewedPlistPath(DAILY, 'LaunchAgents')).toThrow(LaunchdInspectionRefused)
  })

  it.each(['../escape', 'a/b', '', '.', '..', 'x/../y'])(
    'refuses %s as a label name rather than joining it', bad => {
      expect(() => reviewedPlistPath(bad, '/tmp/agents')).toThrow(LaunchdInspectionRefused)
    })

  it('a plist under any OTHER name in the directory is not consulted', async () => {
    const w = world({ unloaded: true })
    // A file that a directory scan would have picked up.
    writeFileSync(join(w.agents, 'com.thanapol.ai-capital.daily.plist.bak'), 'not a plist')
    chmodSync(join(w.agents, 'com.thanapol.ai-capital.daily.plist.bak'), 0o644)
    const seen = await look(w)
    expect(seen.plistPath).toBe(join(w.agents, `${DAILY}.plist`))
  })

  it('an alternate path cannot be supplied: the label decides the filename', async () => {
    const w = world({ unloaded: true })
    const elsewhere = join(w.dir, 'elsewhere')
    mkdirSync(elsewhere)
    const decoy = join(elsewhere, `${DAILY}.plist`)
    writeFileSync(decoy, readFileSync(join(w.agents, `${DAILY}.plist`)))
    chmodSync(decoy, 0o644)
    // Only the agents directory is consulted, so the decoy is never measured.
    const seen = await look(w)
    expect(seen.plistPath).toBe(join(w.agents, `${DAILY}.plist`))
    expect(seen.plistPath).not.toBe(decoy)
  })
})

// ── 4. Every unsafe or malformed plist REFUSES ──────────────────────────────

describe('an unsafe or malformed installed plist refuses, and is never read as absent', () => {
  const swap = (w: ReturnType<typeof world>, make: (p: string) => void): void => {
    const p = join(w.agents, `${DAILY}.plist`)
    unlinkSync(p)
    make(p)
  }

  it('a SYMLINK where the plist should be refuses', async () => {
    const w = world({ unloaded: true })
    const real = join(w.dir, 'real.plist')
    writeFileSync(real, readFileSync(join(w.agents, `${DAILY}.plist`)))
    chmodSync(real, 0o644)
    swap(w, p => symlinkSync(real, p))
    await expect(look(w)).rejects.toThrow(/symbolic link/)
  })

  it('a DANGLING symlink refuses rather than reading as absent', async () => {
    // This is the case existsSync gets wrong: it follows the link, finds
    // nothing, and reports absence — which would drop the whole identity.
    const w = world({ unloaded: true })
    swap(w, p => symlinkSync(join(w.dir, 'does-not-exist.plist'), p))
    await expect(look(w)).rejects.toThrow(/symbolic link/)
    const probe = (): unknown => probeReviewedPlist(DAILY, w.agents, w.commands)
    expect(probe).toThrow(LaunchdInspectionRefused)
  })

  it('a DIRECTORY at the plist path refuses', async () => {
    const w = world({ unloaded: true })
    swap(w, p => mkdirSync(p))
    await expect(look(w)).rejects.toThrow(/not a regular file/)
  })

  it.each([0o666, 0o664, 0o622, 0o777, 0o604])(
    'mode %s refuses: a writable plist is one somebody else chooses', async mode => {
      const w = world({ unloaded: true, plistMode: mode })
      await expect(look(w)).rejects.toThrow(/could not be opened safely/)
    })

  it('a plist with MORE THAN ONE LINK refuses', async () => {
    const w = world({ unloaded: true })
    linkSync(join(w.agents, `${DAILY}.plist`), join(w.dir, 'second-name.plist'))
    await expect(look(w)).rejects.toThrow(/could not be opened safely/)
  })

  it('an UNREADABLE plist refuses rather than reading as absent', async () => {
    const w = world({ unloaded: true })
    chmodSync(join(w.agents, `${DAILY}.plist`), 0o000)
    await expect(look(w)).rejects.toThrow(/could not be opened safely/)
  })

  it('an UNEXAMINABLE plist path refuses rather than reading as absent', async () => {
    // lstat fails with EACCES, not ENOENT: the directory cannot be searched. "I
    // was not allowed to look" is not "there is nothing there", and the second
    // answer is the one that would drop the agent to expected-absent.
    const w = world({ unloaded: true })
    chmodSync(w.agents, 0o000)
    try {
      await expect(look(w)).rejects.toThrow(/could not be examined and its state is unknown/)
    } finally {
      chmodSync(w.agents, 0o755)
    }
  })

  it('a MALFORMED plist refuses', async () => {
    const w = world({ unloaded: true })
    writeFileSync(join(w.agents, `${DAILY}.plist`), '<plist><dict><key>oops')
    chmodSync(join(w.agents, `${DAILY}.plist`), 0o644)
    await expect(look(w)).rejects.toThrow(LaunchdInspectionRefused)
  })

  it('a plist whose OWN Label disagrees with its filename refuses', async () => {
    const w = world({ unloaded: true, wrongLabel: true })
    await expect(look(w)).rejects.toThrow(/does not declare the reviewed label/)
  })

  it('a plist with NO Label key refuses: the filename alone does not tie it to the agent', async () => {
    const w = world({ unloaded: true })
    writeFileSync(join(w.agents, `${DAILY}.plist`),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>' +
      `<key>WorkingDirectory</key><string>${w.dir}</string></dict></plist>`)
    chmodSync(join(w.agents, `${DAILY}.plist`), 0o644)
    await expect(look(w)).rejects.toThrow(/does not declare the reviewed label/)
  })

  it('an installed-unloaded plist naming NO credential container refuses the census', async () => {
    const w = world({ unloaded: true })
    writeFileSync(join(w.agents, `${DAILY}.plist`),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>' +
      `<key>Label</key><string>${DAILY}</string>` +
      `<key>WorkingDirectory</key><string>${w.dir}</string></dict></plist>`)
    chmodSync(join(w.agents, `${DAILY}.plist`), 0o644)
    await expect(proveDestinations(
      REVIEWED_PRODUCERS, SOURCE, policyFor(), opts(w), ctx()))
      .rejects.toThrow(DestinationRefused)
  })
})

// ── 5. Policy disagreement refuses ─────────────────────────────────────────

describe('the reviewed policy must have declared the stable topology that was measured', () => {
  it('declaring an INSTALLED agent expected-absent refuses', async () => {
    const w = world({ unloaded: true })
    await expect(proveDestinations(REVIEWED_PRODUCERS, SOURCE,
      policyFor({ [DAILY]: { expected: 'expected-absent', installation: 'expected-absent' } }),
      opts(w), ctx())).rejects.toThrow(/not in its declared installation topology/)
  })

  it('declaring the structured worker INSTALLED refuses when no plist exists', async () => {
    const w = world({ unloaded: true })
    await expect(proveDestinations(REVIEWED_PRODUCERS, SOURCE,
      policyFor({ [STRUCTURED]: { expected: 'writes-copy-source', installation: 'installed' } }),
      opts(w), ctx())).rejects.toThrow(/not in its declared installation topology/)
  })

  it('declaring the WRONG DESTINATION for an installed agent refuses', async () => {
    const w = world({ unloaded: true })
    await expect(proveDestinations(REVIEWED_PRODUCERS, SOURCE,
      policyFor({ [DAILY]: {
        expected: 'writes-another-reviewed-database', installation: 'installed' } }),
      opts(w), ctx())).rejects.toThrow(/does not match its declared disposition/)
  })

  it('THE SAME POLICY holds whether the labels are unloaded, loaded or disabled', async () => {
    // THE WHOLE POINT OF K5.3. One reviewed destination policy has to be
    // satisfiable before the fence (producers stopped) and after the restoration
    // (producers back), because every CLI mode derives the binding from it.
    for (const w of [world({ unloaded: true }), world(), world({ disabled: true })]) {
      const rows = await proveDestinations(REVIEWED_PRODUCERS, SOURCE, policyFor(), opts(w), ctx())
      expect(rows.filter(r => r.label !== STRUCTURED).map(r => r.stableInstallation))
        .toEqual(['installed', 'installed', 'installed', 'installed'])
    }
  })

  it('the three worlds report DIFFERENT observed states under that one policy', async () => {
    const observed = []
    for (const w of [world({ unloaded: true }), world(), world({ disabled: true })]) {
      const rows = await proveDestinations(REVIEWED_PRODUCERS, SOURCE, policyFor(), opts(w), ctx())
      observed.push(rows.find(r => r.label === DAILY)?.installation)
    }
    expect(observed).toEqual(['installed-unloaded', 'installed-loaded', 'installed-disabled'])
  })

  it('a policy naming a TRANSIENT launchd state is refused by the reader', () => {
    const w = world({ unloaded: true })
    const bad = join(w.dir, 'transient-policy.json')
    for (const transient of ['installed-loaded', 'installed-disabled', 'installed-unloaded']) {
      writeFileSync(bad, JSON.stringify({
        producers: REVIEWED_PRODUCERS.map(label => ({
          label, expected: 'writes-copy-source', installation: transient })),
      }))
      expect(() => readDestinationPolicy(bad))
        .toThrow(/no reviewed installation topology/)
    }
  })
})

// ── 6. Post-fence drift refuses ────────────────────────────────────────────

describe('drift between the pre-fence and fenced census refuses', () => {
  it('a plist replaced with different bytes refuses', async () => {
    const w = world({ unloaded: true })
    const seen = await look(w)
    const p = join(w.agents, `${DAILY}.plist`)
    writeFileSync(p, `${readFileSync(p, 'utf-8')}<!-- swapped -->`)
    chmodSync(p, 0o644)
    await expect(remeasureLabel(seen, opts(w), ctx())).rejects.toThrow(/plist changed/)
  })

  it('a plist replaced at the same size refuses on its device:inode', async () => {
    const w = world({ unloaded: true })
    const seen = await look(w)
    const p = join(w.agents, `${DAILY}.plist`)
    const bytes = readFileSync(p)
    unlinkSync(p)
    writeFileSync(p, bytes)          // identical bytes, NEW inode
    chmodSync(p, 0o644)
    await expect(remeasureLabel(seen, opts(w), ctx())).rejects.toThrow(/plist changed/)
  })

  it('an installed plist REMOVED inside the window refuses', async () => {
    const w = world({ unloaded: true })
    const seen = await look(w)
    unlinkSync(join(w.agents, `${DAILY}.plist`))
    await expect(remeasureLabel(seen, opts(w), ctx()))
      .rejects.toThrow(/appeared or was removed/)
  })

  it('an installed plist APPEARING under a previously-absent label refuses', async () => {
    const w = world({ unloaded: true })
    const seen = await look(w, STRUCTURED)
    expect(seen.installedUnloaded).toBe(false)
    const p = join(w.agents, `${STRUCTURED}.plist`)
    writeFileSync(p, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>' +
      `<key>Label</key><string>${STRUCTURED}</string>` +
      `<key>WorkingDirectory</key><string>${w.dir}</string>` +
      '<key>EnvironmentVariables</key><dict>' +
      `<key>PIPELINE_CREDENTIAL_FILE</key><string>${w.credential}</string>` +
      '</dict></dict></plist>')
    chmodSync(p, 0o644)
    await expect(remeasureLabel(seen, opts(w), ctx()))
      .rejects.toThrow(/appeared or was removed/)
  })

  it('a changed served checkout refuses', async () => {
    const w = world({ unloaded: true })
    const seen = await look(w)
    const p = join(w.agents, `${DAILY}.plist`)
    writeFileSync(p, readFileSync(p, 'utf-8').replace(
      `<key>WorkingDirectory</key><string>${w.dir}</string>`,
      '<key>WorkingDirectory</key><string>/tmp/somewhere-else</string>'))
    chmodSync(p, 0o644)
    // The bytes changed too, so the plist check fires first — which is the
    // stronger refusal. What matters is that it does not pass.
    await expect(remeasureLabel(seen, opts(w), ctx())).rejects.toThrow(LaunchdInspectionRefused)
  })

  it('a changed credential container path refuses', async () => {
    const w = world({ unloaded: true })
    const seen = await look(w)
    const other = join(w.dir, 'other.url')
    writeFileSync(other, 'postgres://u:p@%2Ftmp%2Fs/ai_capital\n')
    chmodSync(other, 0o600)
    const p = join(w.agents, `${DAILY}.plist`)
    writeFileSync(p, readFileSync(p, 'utf-8').replace(w.credential, other))
    chmodSync(p, 0o644)
    await expect(remeasureLabel(seen, opts(w), ctx())).rejects.toThrow(LaunchdInspectionRefused)
  })

  it('a label that APPEARS in launchd inside the window refuses', async () => {
    const w = world({ unloaded: true })
    const seen = await look(w)
    const loadedWorld = { ...w, commands: world().commands, agents: w.agents }
    // The loaded world answers `print` with success for the same label.
    await expect(remeasureLabel(seen, { uid: '501', agentsDir: w.agents,
      commands: loadedWorld.commands }, ctx())).rejects.toThrow(/changed presence/)
  })

  it('an unchanged installed-unloaded label remeasures cleanly', async () => {
    const w = world({ unloaded: true })
    const seen = await look(w)
    const again = await remeasureLabel(seen, opts(w), ctx())
    expect(again.installedUnloaded).toBe(true)
    expect(again.plistSha256).toBe(seen.plistSha256)
    expect(again.plistDeviceInode).toBe(seen.plistDeviceInode)
  })
})

// ── 7. Every bound field moves the binding document ────────────────────────

describe('every field installed-unloaded binds changes the operational binding', () => {
  const derive = async (w: ReturnType<typeof world>): Promise<string> => {
    const binding = await deriveOperationalBinding({
      source: SOURCE,
      sourceSystemIdentifier: '7300000000000000001',
      evidenceRoot: w.evidence,
      postRestorationPolicyPath: w.restorationPolicy,
      destinationPolicyPath: w.destinationPolicy,
      implementationHead: '0'.repeat(40),
      launchd: { uid: '501', agentsDir: w.agents, commands: w.commands },
      redis: resolveRedis({ host: '127.0.0.1', port: '6379', db: '0' }),
    }, 5_000)
    return createHash('sha256')
      .update(canonicalJson(operationalBindingDocument(binding))).digest('hex')
  }

  it('the binding records the stable topology, not expected-absent and not the launchd state', async () => {
    const w = world({ unloaded: true })
    const doc = operationalBindingDocument(await deriveOperationalBinding({
      source: SOURCE, sourceSystemIdentifier: '7300000000000000001',
      evidenceRoot: w.evidence, postRestorationPolicyPath: w.restorationPolicy,
      destinationPolicyPath: w.destinationPolicy, implementationHead: '0'.repeat(40),
      launchd: { uid: '501', agentsDir: w.agents, commands: w.commands },
      redis: resolveRedis({ host: '127.0.0.1', port: '6379', db: '0' }),
    }, 5_000)) as unknown as {
      producers: { label: string; stable_installation: string; installation?: string }[] }
    const daily = doc.producers.find(p => p.label === DAILY)
    expect(daily?.stable_installation).toBe('installed')
    // THE TRANSIENT STATE IS NOT IN THE DOCUMENT. That is what makes the digest
    // survive the restoration.
    expect(daily?.installation).toBeUndefined()
  })

  it('the binding digest is IDENTICAL before and after the labels are loaded', async () => {
    // ONE WORLD, ONE SET OF FILES. Only what launchctl ANSWERS changes — which is
    // exactly what a manual restoration changes and nothing else. Separate
    // worlds would differ in temp paths, inodes and digests and would prove
    // nothing, so the same world is re-derived with a runner that reports the
    // labels loaded.
    //
    // Before K5.3 these two digests differed, and that difference is what made
    // --verify-restoration reject the restored world as a different one.
    const w = world({ unloaded: true })
    const unloadedDigest = await derive(w)

    const loaded: typeof w.commands = {
      openPlist: w.commands.openPlist,
      run: async (file, args, c) => {
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
    }
    const loadedDigest = await derive({ ...w, commands: loaded })
    expect(loadedDigest).toBe(unloadedDigest)

    // NON-VACUITY: the two derivations really did observe different launchd
    // states, so the equality above is invariance and not a no-op.
    const before = await proveDestinations(REVIEWED_PRODUCERS, SOURCE, policyFor(), opts(w), ctx())
    const after = await proveDestinations(
      REVIEWED_PRODUCERS, SOURCE, policyFor(), { ...opts(w), commands: loaded }, ctx())
    expect(before.find(r => r.label === DAILY)?.installation).toBe('installed-unloaded')
    expect(after.find(r => r.label === DAILY)?.installation).toBe('installed-loaded')
    expect(before.find(r => r.label === DAILY)?.stableInstallation).toBe('installed')
    expect(after.find(r => r.label === DAILY)?.stableInstallation).toBe('installed')
  })

  it('the OBSERVATION digest moves across that same transition', async () => {
    // Confirmation integrity is preserved by binding the observation into the
    // EXECUTION binding, not by putting it back into the stable topology. That
    // is a live path, not an available helper: `modeObservationDigest` is a
    // required field of `ExecutionBinding`, so a changed observed state refuses
    // the confirmation. See restoration-transition.test.ts >
    // 'a changed observed state REFUSES the confirmation, before any supervisor'.
    const unloaded = REVIEWED_PRODUCERS.map(label => ({
      label, installation: (label === STRUCTURED ? 'expected-absent' : 'installed-unloaded') as never }))
    const loaded = REVIEWED_PRODUCERS.map(label => ({
      label, installation: (label === STRUCTURED ? 'expected-absent' : 'installed-loaded') as never }))
    expect(modeObservationDigest(loaded)).not.toBe(modeObservationDigest(unloaded))
  })

  it('a changed plist digest changes the binding digest', async () => {
    const a = world({ unloaded: true })
    const before = await derive(a)
    const p = join(a.agents, `${DAILY}.plist`)
    writeFileSync(p, `${readFileSync(p, 'utf-8')}<!-- x -->`)
    chmodSync(p, 0o644)
    expect(await derive(a)).not.toBe(before)
  })

  it('a changed served checkout changes the binding digest', async () => {
    const a = world({ unloaded: true })
    const before = await derive(a)
    const p = join(a.agents, `${DAILY}.plist`)
    writeFileSync(p, readFileSync(p, 'utf-8').replace(
      `<key>WorkingDirectory</key><string>${a.dir}</string>`,
      `<key>WorkingDirectory</key><string>${a.dir}/inner</string>`))
    chmodSync(p, 0o644)
    mkdirSync(join(a.dir, 'inner'))
    expect(await derive(a)).not.toBe(before)
  })

  it('a replaced credential container changes the binding digest', async () => {
    const a = world({ unloaded: true })
    const before = await derive(a)
    const bytes = readFileSync(a.credential)
    unlinkSync(a.credential)
    writeFileSync(a.credential, bytes)   // same bytes, new inode
    chmodSync(a.credential, 0o600)
    expect(await derive(a)).not.toBe(before)
  })

  it('a changed sanitized endpoint changes the binding digest', async () => {
    const a = world({ unloaded: true })
    const before = await derive(a)
    writeFileSync(a.credential, 'postgres://u:p@%2Ftmp%2Fs/other_database\n')
    chmodSync(a.credential, 0o600)
    // The declared disposition no longer matches, which is itself a refusal —
    // so the endpoint is proved to be load-bearing either way.
    await expect(derive(a)).rejects.toThrow(DestinationRefused)
  })

  it('a world whose plists are REMOVED produces a different binding digest', async () => {
    const a = world({ unloaded: true })
    const before = await derive(a)
    const b = world({ unloaded: true })
    for (const label of REVIEWED_PRODUCERS.filter(l => l !== STRUCTURED)) {
      unlinkSync(join(b.agents, `${label}.plist`))
    }
    writeFileSync(b.destinationPolicy, JSON.stringify({
      producers: REVIEWED_PRODUCERS.map(label =>
        ({ label, expected: 'expected-absent', installation: 'expected-absent' })),
    }))
    expect(await derive(b)).not.toBe(before)
  })
})

// ── 8. Quiescence semantics are preserved ──────────────────────────────────

describe('installed-unloaded never softens quiescence', () => {
  it('is stopped when no matching process runs', async () => {
    const w = world({ unloaded: true })
    const states = await launchdQuiescenceAdapter(REVIEWED_PRODUCERS, opts(w)).measure(ctx())
    for (const s of states) expect([s.name, s.stopped]).toEqual([s.name, true])
  })

  it('reports presence absent, not loaded and not disabled', async () => {
    const w = world({ unloaded: true })
    const states = await launchdQuiescenceAdapter(REVIEWED_PRODUCERS, opts(w)).measure(ctx())
    const daily = states.find(s => s.name === DAILY)
    expect(daily?.presence).toBe('absent')
    expect(daily?.running).toBe(false)
    expect(daily?.launchdPid).toBeNull()
  })

  it('A MATCHING PROCESS STILL DEFEATS QUIESCENCE for an installed-unloaded agent', async () => {
    const w = world({ unloaded: true })
    const withProcess = {
      ...opts(w),
      commands: {
        openPlist: w.commands.openPlist,
        run: async (file: string, args: readonly string[], c: never) => {
          if (file.endsWith('/ps')) {
            return { code: 0, stderr: '', stdout: '  1 /sbin/launchd\n 999 /bin/bash /x/daily-queue.sh\n' }
          }
          return await w.commands.run(file, args, c)
        },
      },
    }
    const states = await launchdQuiescenceAdapter(REVIEWED_PRODUCERS, withProcess).measure(ctx())
    const daily = states.find(s => s.name === DAILY)
    expect(daily?.stopped).toBe(false)
    expect(daily?.processPids).toEqual(['999'])
  })
})

// ── 9. No mutating launchctl verb was introduced ───────────────────────────

describe('the inspection module still cannot change anything', () => {
  const source = strip(readFileSync('src/pg-copy-ops/launchd.ts', 'utf-8'))

  it.each(['bootstrap', 'bootout', 'kickstart', 'enable', 'disable', 'load', 'unload',
           'kill', 'remove', 'start', 'stop', 'attach', 'blame', 'setenv'])(
    'does not use the mutating verb %s', verb => {
      expect(source).not.toMatch(new RegExp(`['"\`]${verb}['"\`]`))
    })

  it('names only the reviewed read-only verbs', () => {
    expect([...READ_ONLY_LAUNCHCTL_VERBS]).toEqual(['print', 'list', 'print-disabled'])
  })

  it('the only launchctl arguments it builds are print and print-disabled', () => {
    const calls = [...source.matchAll(/LAUNCHCTL,\s*\[([^\]]*)\]/g)].map(m => m[1] ?? '')
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c).toMatch(/'print'|'print-disabled'/)
  })

  it('reads the plist path but never writes to the agents directory', () => {
    for (const w of ['writeFileSync', 'unlinkSync', 'renameSync', 'chmodSync', 'mkdirSync',
                     'rmSync', 'symlinkSync', 'linkSync']) {
      expect(source).not.toContain(w)
    }
  })
})

// ── 10. Collapsing the state back is KILLED ────────────────────────────────

describe('the collapse this remediation removed cannot come back', () => {
  it('installed-unloaded is a declared installation state', () => {
    expect([...INSTALLATION_STATES]).toContain('installed-unloaded')
    expect([...INSTALLED_STATES]).toContain('installed-unloaded')
    expect([...INSTALLED_STATES]).not.toContain('expected-absent')
  })

  it('MUTANT: installationOf returning expected-absent for an installed plist is caught', async () => {
    // The mutation is `return 'expected-absent'` for any absent presence — i.e.
    // the pre-remediation code. It is caught because the reviewed policy for a
    // cutover world declares installed-unloaded and the census compares them.
    const w = world({ unloaded: true })
    const collapsed = (seen: LabelInspection): string =>
      seen.presence === 'absent' ? 'expected-absent'
        : seen.disabled ? 'installed-disabled' : 'installed-loaded'
    const seen = await look(w)
    expect(collapsed(seen)).toBe('expected-absent')
    expect(installationOf(seen)).toBe('installed-unloaded')
    expect(installationOf(seen)).not.toBe(collapsed(seen))
  })

  it('MUTANT: a binding that calls a measured plist expected-absent will not validate', () => {
    const measured = {
      label: DAILY, plistPath: '/Users/x/Library/LaunchAgents/a.plist',
      plistSha256: 'a'.repeat(64), plistDeviceInode: '1:2',
      servedCheckout: '/Users/x/checkout', installation: 'expected-absent' as const,
      stableInstallation: 'expected-absent' as const,
      credentialPath: '/Users/x/c.url', credentialDeviceInode: '1:3',
      databaseHost: '/tmp/s', databasePort: '5432', databaseName: 'ai_capital',
      disposition: 'writes-copy-source' as const,
    }
    expect(() => operationalBindingDocument({
      sourceEndpoint: '/tmp/s', sourceDatabase: 'ai_capital',
      sourceSystemIdentifier: '7300000000000000001',
      producers: [measured], queues: ['daily-pipeline'], blockingStates: ['wait'],
      pausedIsBlocking: true, producerAuthority: DAILY,
      producerProcessPolicy: [{ label: DAILY, pattern: 'daily-queue.sh' }],
      structuredWorkerInstallation: 'expected-absent',
      redisHost: '127.0.0.1', redisPort: '6379', redisDatabase: '0',
      evidenceRoot: '/Users/x/evidence', evidenceRootDeviceInode: '1:4',
      postRestorationPolicyPath: '/Users/x/r.json',
      postRestorationPolicySha256: 'b'.repeat(64), implementationHead: '0'.repeat(40),
    })).toThrow()
  })

  it('MUTANT: an installed-unloaded producer with null identity will not validate', () => {
    const hollow = {
      label: DAILY, plistPath: null, plistSha256: null, plistDeviceInode: null,
      servedCheckout: null, installation: 'installed-unloaded' as const,
      stableInstallation: 'installed' as const,
      credentialPath: null, credentialDeviceInode: null,
      databaseHost: null, databasePort: null, databaseName: null,
      disposition: 'writes-copy-source' as const,
    }
    expect(() => operationalBindingDocument({
      sourceEndpoint: '/tmp/s', sourceDatabase: 'ai_capital',
      sourceSystemIdentifier: '7300000000000000001',
      producers: [hollow], queues: ['daily-pipeline'], blockingStates: ['wait'],
      pausedIsBlocking: true, producerAuthority: DAILY,
      producerProcessPolicy: [{ label: DAILY, pattern: 'daily-queue.sh' }],
      structuredWorkerInstallation: 'expected-absent',
      redisHost: '127.0.0.1', redisPort: '6379', redisDatabase: '0',
      evidenceRoot: '/Users/x/evidence', evidenceRootDeviceInode: '1:4',
      postRestorationPolicyPath: '/Users/x/r.json',
      postRestorationPolicySha256: 'b'.repeat(64), implementationHead: '0'.repeat(40),
    })).toThrow()
  })

  it('MUTANT: an INSTALLED agent with a measured plist but no credential identity is rejected', () => {
    // ISOLATES THE NEW BLOCK. The generic present-label rules already require a
    // plist path, digest, device:inode and served checkout, so a producer with
    // everything null fails on those and proves nothing about the completeness
    // requirement added for this state. Here every one of those IS set and only
    // the credential container and endpoint are missing, so the only rule that
    // can reject it is the installed-unloaded one.
    const half = {
      label: DAILY, plistPath: '/Users/x/Library/LaunchAgents/a.plist',
      plistSha256: 'a'.repeat(64), plistDeviceInode: '1:2',
      servedCheckout: '/Users/x/checkout', installation: 'installed-unloaded' as const,
      stableInstallation: 'installed' as const,
      credentialPath: null, credentialDeviceInode: null,
      databaseHost: null, databasePort: null, databaseName: null,
      disposition: 'writes-copy-source' as const,
    }
    const build = (p: typeof half) => operationalBindingDocument({
      sourceEndpoint: '/tmp/s', sourceDatabase: 'ai_capital',
      sourceSystemIdentifier: '7300000000000000001',
      producers: [p], queues: ['daily-pipeline'], blockingStates: ['wait'],
      pausedIsBlocking: true, producerAuthority: DAILY,
      producerProcessPolicy: [{ label: DAILY, pattern: 'daily-queue.sh' }],
      structuredWorkerInstallation: 'expected-absent',
      redisHost: '127.0.0.1', redisPort: '6379', redisDatabase: '0',
      evidenceRoot: '/Users/x/evidence', evidenceRootDeviceInode: '1:4',
      postRestorationPolicyPath: '/Users/x/r.json',
      postRestorationPolicySha256: 'b'.repeat(64), implementationHead: '0'.repeat(40),
    })
    expect(() => build(half)).toThrow()
    // NON-VACUITY: the same producer WITH the credential identity and endpoint
    // validates, so the rejection above is about completeness and nothing else.
    expect(() => build({
      ...half, credentialPath: '/Users/x/c.url', credentialDeviceInode: '1:3',
      databaseHost: '/tmp/s', databasePort: '5432', databaseName: 'ai_capital',
    })).not.toThrow()
  })

  it('MUTANT: probing with existsSync instead of lstat would misread a dangling link', async () => {
    const w = world({ unloaded: true })
    const p = join(w.agents, `${DAILY}.plist`)
    unlinkSync(p)
    symlinkSync(join(w.dir, 'nothing-here.plist'), p)
    const { existsSync } = await import('node:fs')
    // The mutant's view: "absent", which would become expected-absent.
    expect(existsSync(p)).toBe(false)
    // The reviewed view: a refusal.
    await expect(look(w)).rejects.toThrow(LaunchdInspectionRefused)
  })
})


// ── 11. The fenced comparison and the identity comparison, directly ─────────

describe('the fenced census comparison compares every bound field', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    label: DAILY, plistPath: '/a/x.plist', plistSha256: 'a'.repeat(64),
    plistDeviceInode: '1:2', servedCheckout: '/checkout',
    installation: 'installed-unloaded' as const, stableInstallation: 'installed' as const,
    credentialPath: '/c.url', credentialDeviceInode: '1:3',
    databaseHost: '/tmp/s', databasePort: '5432', databaseName: 'ai_capital',
    disposition: 'writes-copy-source' as const, ...over,
  }) as never

  it('an identical census compares equal', () => {
    expect(compareProducerSets([row()], [row()])).toBeNull()
  })

  it.each([
    ['plistSha256', 'b'.repeat(64)],
    ['plistPath', '/a/other.plist'],
    ['plistDeviceInode', '9:9'],
    ['servedCheckout', '/somewhere-else'],
    ['credentialPath', '/other.url'],
    ['credentialDeviceInode', '9:9'],
    ['databaseHost', '/tmp/other'],
    ['databasePort', '5433'],
    ['databaseName', 'other_database'],
    ['stableInstallation', 'expected-absent'],
    ['disposition', 'writes-another-reviewed-database'],
  ])('a changed %s is reported', (field, value) => {
    const msg = compareProducerSets([row()], [row({ [field]: value })])
    expect(msg).toBe(`${DAILY} came back with a different ${field}`)
  })

  it('a reordered or resized census is reported', () => {
    expect(compareProducerSets([row()], [])).toBe('the producer set has a different size')
    expect(compareProducerSets([row()], [row({ label: 'com.thanapol.ai-capital.worker' })]))
      .toMatch(/producer order changed/)
  })
})

describe('the identity comparison compares the stable topology, not the launchd state', () => {
  const bound = (stableInstallation: string, installation = 'installed-unloaded') => ({
    label: DAILY, plistPath: '/a/x.plist', plistSha256: 'a'.repeat(64),
    plistDeviceInode: '1:2', servedCheckout: '/checkout', installation, stableInstallation,
    credentialPath: '/c.url', credentialDeviceInode: '1:3',
    databaseHost: '/tmp/s', databasePort: '5432', databaseName: 'ai_capital',
    disposition: 'writes-copy-source',
  }) as never
  const now = (over: Record<string, unknown> = {}) => ({
    label: DAILY, presence: 'absent', installedUnloaded: true, disabled: false,
    running: false, pid: null, lastExitCode: null,
    plistPath: '/a/x.plist', plistSha256: 'a'.repeat(64), plistDeviceInode: '1:2',
    servedCheckout: '/checkout', credentialPath: '/c.url', plist: {}, ...over,
  }) as never

  it('an unchanged installed agent compares equal', () => {
    expect(compareIdentity(bound('installed'), now())).toBeNull()
  })

  it('THE INTENDED TRANSITION IS NOT DRIFT: installed-unloaded -> installed-loaded', () => {
    // The restoration the rehearsal exists to exercise. Before K5.3 this returned
    // 'an installed-unloaded label is now loaded' and stopped the chain dead.
    expect(compareIdentity(bound('installed'),
      now({ presence: 'loaded', installedUnloaded: false, running: true, pid: '42',
            lastExitCode: '0' }))).toBeNull()
  })

  it('installed-unloaded -> installed-disabled is not drift either', () => {
    expect(compareIdentity(bound('installed'),
      now({ presence: 'loaded', installedUnloaded: false, disabled: true }))).toBeNull()
  })

  it('an installed agent whose plist was REMOVED is reported', () => {
    expect(compareIdentity(bound('installed'),
      now({ installedUnloaded: false, plistPath: null, plistSha256: null })))
      .toBe('an installed label is no longer installed')
  })

  it('an expected-absent label that is now INSTALLED is reported', () => {
    // The dangerous direction, and the one launchctl presence alone cannot see:
    // launchd still holds no label, so presence is unchanged on both sides.
    expect(compareIdentity(bound('expected-absent', 'expected-absent'), now()))
      .toBe('an expected-absent label is now installed')
  })

  it('an expected-absent label that is now LOADED is reported', () => {
    expect(compareIdentity(bound('expected-absent', 'expected-absent'),
      now({ presence: 'loaded', installedUnloaded: false })))
      .toBe('an expected-absent label is now installed')
  })

  it('an expected-absent label that is still absent compares equal', () => {
    expect(compareIdentity(bound('expected-absent', 'expected-absent'),
      now({ installedUnloaded: false, plistPath: null, plistSha256: null }))).toBeNull()
  })

  it.each([
    ['plistSha256', 'the plist is not the one measured'],
    ['plistPath', 'the plist path has moved'],
    ['plistDeviceInode', 'the plist has been replaced'],
    ['servedCheckout', 'the served checkout has changed'],
    ['credentialPath', 'the credential container has changed'],
  ])('a changed %s is STILL reported across the transition', (field, message) => {
    // The transition is allowed; drift in the stable identity is not — including
    // when it arrives together with a legitimate load.
    expect(compareIdentity(bound('installed'),
      now({ presence: 'loaded', installedUnloaded: false,
            [field]: field === 'plistSha256' ? 'b'.repeat(64) : '/changed' }))).toBe(message)
  })

  it('a label absent from the binding is reported', () => {
    expect(compareIdentity(undefined, now()))
      .toBe('the label is not in the operational binding')
  })
})

// ── 12. The SHIPPED reviewed policy says what the current machine is ────────

describe('the reviewed destination policy on disk declares the post-cutover state', () => {
  const POLICY = new URL('../../../ops/pg-copy/destination-policy.json', import.meta.url).pathname

  it('is readable by the reviewed reader, in the reviewed order', () => {
    const rows = readDestinationPolicy(POLICY)
    expect(rows.map(r => r.label)).toEqual([...REVIEWED_PRODUCERS])
  })

  it('declares the four agents INSTALLED and writing the copy source', () => {
    const rows = readDestinationPolicy(POLICY)
    for (const r of rows.filter(r => r.label !== STRUCTURED)) {
      expect([r.label, r.installation, r.expected])
        .toEqual([r.label, 'installed', 'writes-copy-source'])
    }
  })

  it('declares the structured worker expected-absent in both columns', () => {
    const s = readDestinationPolicy(POLICY).find(r => r.label === STRUCTURED)
    expect([s?.installation, s?.expected]).toEqual(['expected-absent', 'expected-absent'])
  })

  it('prescribes NO launchd state: those are phase-specific and owned elsewhere', () => {
    for (const r of readDestinationPolicy(POLICY)) {
      expect(['installed', 'expected-absent']).toContain(r.installation)
      for (const transient of ['installed-loaded', 'installed-disabled', 'installed-unloaded']) {
        expect(r.installation).not.toBe(transient)
      }
    }
  })
})
