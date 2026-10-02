// WHAT ONE CONTAINED HOLD-CAPABLE CASE IS, AS DATA.
//
// WHY DATA AND NOT A CALLBACK. The case runs in a different process, so what it
// needs cannot be a function: nothing closes over the parent's variables across
// a `spawn`. The alternative to a declared spec is one bespoke child entry per
// case, which is one more place for the two sides to disagree about what "this
// world" means - the thing that made the fixture shared in the first place.
//
// EVERY FIELD DESCRIBES A STUB, NOT A CEILING. Nothing here can end a hold. The
// hold ends when the fence is proved resolved, and nothing else; a spec that
// does not resolve is a spec whose whole subject is that a hold does not end on
// its own, and its container is what stops it.

/** What the world is built with. Mirrors `world()`'s own options. */
export interface SpecWorld {
  readonly restorationRequired?: string
  readonly loaded?: boolean
  readonly lastExit?: string
  readonly structuredAbsent?: boolean
  readonly disabled?: boolean
}

export interface HoldSpec {
  readonly world?: SpecWorld
  /** Extra argv for the rehearsal. */
  readonly rehearseExtra?: readonly string[]
  /** How the supervisor session behaves. A failed release is what reaches a hold. */
  readonly supervisor?: {
    readonly releaseError?: boolean
    readonly releaseThrows?: boolean
  }
  /**
   * How the independent prover answers.
   *
   * `gone-after-release` - fine while the fence is proved, backend GONE once the
   *   release has been attempted. Resolves the first attempt terminally. A prover
   *   that reported the backend gone from the START would refuse the GATE, and
   *   the run would never reach a release at all.
   * `gone` - gone from the outset. For the cases that are ABOUT the gate.
   * `locks-until` - a PARTIAL lock set, which is a live fence and therefore not a
   *   resolution, for the first `resolveAfter` censuses; zero locks after that.
   *   `resolveAfter: -1` means never - the hold is meant to be killed.
   * `reaped-on-terminate` - alive holding the complete fence until it is
   *   terminated, gone afterwards. What a real backend does between the
   *   `pg_terminate_backend` call and the reaping, and the only shape in which the
   *   post-termination census means anything.
   * `partial-then-gone` - ONE advisory lock and nothing else, which is neither a
   *   complete fence nor zero reviewed locks; the backend goes once the operator
   *   has been asked `resolveAfter` times.
   * `gone-after-first-decision` - K8-E3. The COMPLETE fence until the operator has
   *   been asked once, and gone afterwards. This is the shape a hold entered from
   *   a FAILED GATE needs: no release was ever attempted, so `gone-after-release`
   *   never fires and `CENSUS_ONLY` finds a live fence for ever. The complete
   *   fence up front is what lets the gate's own fence proof pass, so the refusal
   *   under test is the queue or the census and not the proof.
   */
  readonly prover?: {
    readonly kind: 'gone-after-release' | 'gone' | 'locks-until'
      | 'reaped-on-terminate' | 'partial-then-gone' | 'gone-after-first-decision'
    readonly resolveAfter?: number
    readonly terminateRefused?: boolean
    readonly observedStart?: string | null
  }
  /**
   * Make the FENCED destination census disagree with the pre-fence one.
   *
   * The pre-fence census answers "where do these agents write" while they could
   * still be running; the fenced one answers it frozen. A difference is a
   * producer that moved under the fence, and the rehearsal must refuse.
   */
  readonly destinationsDrifted?: boolean
  /**
   * THE RESOLVING SCRIPT, WHICH EVERY NORMAL CASE SUPPLIES.
   *
   * `script`   - these actions, in order, the last repeating. What a person at a
   *              terminal does.
   * `refuse`   - the first `refusals` requests throw `OpsRefused`, as a wrong
   *              token does, then the script takes over. A refused resolution is
   *              an unresolved attempt, never an exit.
   * `forbidden` - no script at all. The default, so reaching a hold unscripted is
   *              a recorded fact rather than a silent one.
   * `channel`  - K8-E3: NOT a replacement hold at all. The child passes
   *              `hold: undefined` so `runRehearsal` builds the PRODUCTION
   *              `processHold`, and injects only its TRANSPORT through
   *              `deps.operatorChannel`. That is the only way to observe what an
   *              operator actually meets - the reviewed grammar, the per-attempt
   *              token, the intent and outcome bundles - rather than a stub's
   *              imitation of it. `actions` is the reply script, as for `script`.
   */
  readonly hold?: {
    readonly kind: 'script' | 'refuse' | 'forbidden' | 'channel'
    readonly actions?: readonly string[]
    readonly refusals?: number
    /** Freeze the evidence root at the first request, so nothing can publish. */
    readonly freezeEvidence?: boolean
  }
  /**
   * MAKE ONE PHASE'S PUBLICATION FAIL, DELIBERATELY AND PRECISELY.
   *
   * The reviewed evidence prefix whose no-replace rename fails, and how many
   * times before one is allowed through; `failures: -1` means none ever is. A
   * permission change cannot do this: intent and outcome are written into the
   * same root, and which phase fails is the whole question.
   */
  readonly ops?: {
    readonly failRename: string
    readonly failures: number
    /**
     * FAIL EVERY FILE `fsync` INSIDE THAT RECORD'S SCRATCH DIRECTORY.
     *
     * The failure lands at step 9, AFTER the bytes are written and frozen - so
     * what it leaves behind is a directory that holds the complete record and
     * verifies. That is the state requirement 6 is about: the rename is the only
     * thing left to do, and rebuilding would mean unfreezing 0400 files for
     * bytes that are already correct.
     */
    readonly failFsync?: boolean
    /**
     * FAIL EVERY FILE `chmod` INSIDE THAT RECORD'S SCRATCH DIRECTORY.
     *
     * The failure lands at step 7, so the files are never frozen and the
     * directory can NEVER verify - the permanent-incomplete case, where every
     * retry has to clear the retry scratch and rebuild it. Directory chmods are
     * left working, because clearing a scratch directory needs one.
     */
    readonly failFileChmod?: boolean
    /**
     * MAKE THE RENAME REPORT NOTHING, AND THEN MAKE THE PATHS BRIEFLY UNREADABLE.
     *
     * The only way to reach a genuinely indeterminate publication: the helper does
     * not report, and the two paths that would resolve it cannot be examined
     * either. Nothing may be deleted and nothing may be renamed again from there -
     * a second rename could publish twice, and a removal could remove something
     * that is already evidence under another name.
     *
     * AND THE UNREADABILITY IS TRANSIENT, DELIBERATELY. A fixture that kept those
     * paths unreadable for ever would prevent a second rename BY ITSELF, whatever
     * the code did - it would mask the very property under test, and a mutation
     * that removed the latch would survive. Measured: it did. So readability comes
     * back a few calls later, and any second rename is then the code's own doing.
     */
    readonly renameIndeterminate?: boolean
  }
  /**
   * MAKE ONE REVIEWED QUEUE NON-EMPTY IN THE FENCED GATE'S SAMPLES.
   *
   * All queue sampling happens inside the operational gate, which runs AFTER the
   * fence is acquired - so a non-empty depth here is a refusal discovered while
   * the source is frozen, which is a HOLD and not an exit-2 refusal. That
   * distinction is the whole subject of T1.
   */
  readonly fencedQueueBusy?: string
  /**
   * MAKE ONE REVIEWED PRODUCER VISIBLE AS RUNNING ONLY ONCE THE FENCE IS HELD.
   *
   * Models a producer somebody started during the window: the pre-fence world was
   * quiescent, and the fenced census is the one that finds it. The child flips
   * this on in its `acquireFence` stub, which is the exact moment the fence
   * exists, so nothing before the gate can see it.
   */
  readonly producerRunningUnderFence?: string
  /** Make the run-id minter throw, so the derived attempt name is exercised. */
  readonly runIdMinterThrows?: boolean
  /** Record the pause durations the hold asks for, instead of ignoring them. */
  readonly recordSleeps?: boolean
  /**
   * PLANT A HALF-BUILT RETRY SCRATCH DIRECTORY BEFORE THE HOLD BEGINS.
   *
   * The named prefix's retry scratch is created, half-filled and frozen by the
   * child at start-up - so it is owned by this user, on this device, under the
   * exact reviewed name, and NOT created by the hold. That is the one thing
   * ownership and device cannot distinguish, and it must never be cleared: it is
   * the leftovers of an earlier run of this same command against this same record.
   */
  readonly plantRetryScratch?: string
}

/** Everything a contained case reports back. Written as it happens. */
export interface HoldReport {
  readonly exitCode: number | null
  readonly lines: readonly string[]
  /** The world's root and evidence directory, so the parent can read bundles. */
  readonly root: string | null
  readonly evidence: string | null
  readonly supervisorSql: readonly string[]
  readonly supervisorClosed: number
  readonly proverSql: readonly string[]
  readonly proverClosed: number
  readonly armed: number
  readonly disarmed: number
  /** One entry per resolution request, in order. */
  readonly requests: readonly {
    readonly state: string
    readonly actions: readonly string[]
    readonly token: string
    /** How many of each record existed AT THE MOMENT this request was made. */
    readonly intentsOnDisk: number
    readonly outcomesOnDisk: number
    /**
     * How many times the supervisor had been closed when this request was made.
     *
     * Must be zero at every prompt: closing it is what would release the fence,
     * and the hold owns it until a terminal record is durable.
     */
    readonly supervisorClosedSoFar: number
    /** How many operations had run when this request was made. */
    readonly performedSoFar: number
    /**
     * Arm and disarm counts at this request.
     *
     * Armed exactly once at the start and NOT YET disarmed at any prompt.
     * Disarming after an attempt that resolved nothing hands the terminal back
     * the power to end a process that is holding a fence.
     */
    readonly armedSoFar: number
    readonly disarmedSoFar: number
  }[]
  /**
   * `decide` and `perform` in the order they happened.
   *
   * The ordering IS the guarantee - the intent is published between them - so it
   * is recorded rather than inferred from two counts.
   */
  readonly order: readonly string[]
  /** What the evidence root held at each `perform`, in order. */
  readonly evidenceAtPerform: readonly (readonly string[])[]
  /** Prover censuses asked AFTER a release: the `CENSUS_ONLY` operation itself. */
  readonly performed: number
  readonly sleeps: readonly number[]
  /**
   * WHEN THE HOLD ITSELF BEGAN, as epoch milliseconds, or null if it never did.
   *
   * The parent's wall-clock ceiling counts from HERE rather than from `spawn`,
   * because everything before the hold - opening the sessions, the operational gate,
   * the release attempt - takes a variable few seconds that get longer the busier
   * the machine is. A ceiling measured from spawn is therefore partly a measurement
   * of machine load: controls that assert "thousands of retries happened" passed
   * alone and failed under a full suite. Measured, three times.
   */
  readonly holdStartedAt: number | null
  /** Set when a hold was entered with no scripted resolver. */
  readonly unscripted: string | null
  /**
   * Did the planted pre-existing retry scratch survive, byte for byte?
   *
   * `null` when nothing was planted. The marker file's exact bytes are re-read at
   * the end of every sampling cycle, so a run that was killed still reports it.
   */
  readonly plantedSurvived: boolean | null
  /** How many no-replace renames the injected ops saw for the named prefix. */
  readonly renames: number
  /**
   * WHAT THE EVIDENCE ROOT HELD AT EACH FAILED PUBLICATION ATTEMPT.
   *
   * One sample per attempt: how many reviewed TEMPORARY directories exist and how
   * many bytes the whole root occupies. This is what proves the bound - not that
   * the hold stops, which it must not, but that its filesystem consumption does.
   */
  readonly scratchCensus: readonly {
    readonly attempt: number
    readonly temporaryDirs: number
    readonly temporaryNames: readonly string[]
    /** Entries that are NOT temporary: the published bundles. */
    readonly publishedDirs: number
    readonly bytes: number
  }[]
  /** Every entry in the evidence root at the end, or at the moment of a kill. */
  readonly evidenceEntries: readonly string[]
  /**
   * EVERY LINE THE RUN STREAMED, in the order the sink received it.
   *
   * K8-E3: separate from `lines`, which is what `runOpsCli` RETURNED. Keeping
   * both is the point - a build that buffers has an empty sink and a full
   * `lines`, and a build that duplicates has a `lines` longer than its sink.
   */
  readonly sink: readonly string[]
  /**
   * WHAT HAD ALREADY BEEN STREAMED EACH TIME THE OPERATOR WAS ASKED.
   *
   * One entry per `nextLine`, recorded BEFORE the reply is computed. This is the
   * evidence that the prompt and its token were visible at the moment the process
   * blocked, rather than after it stopped waiting.
   */
  readonly channelSnapshots: readonly {
    readonly sinkLength: number
    readonly hadIntervention: boolean
    readonly hadFenceState: boolean
    readonly hadReplyWith: boolean
    /** The token taken from the latest `Reply with:` line, or null if none. */
    readonly tokenFromSink: string | null
    /** The exact reply sent back. */
    readonly replied: string
  }[]
  /**
   * HOW MANY TIMES A SCRATCH DIRECTORY FOR THAT RECORD WAS CREATED.
   *
   * The retry-cycle count the bound is stated over. It counts rebuilds whether
   * the failure happened at the rename or long before it, which a rename counter
   * cannot.
   */
  readonly publishAttempts: number
}
