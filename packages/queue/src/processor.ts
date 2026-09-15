// Worker processor — the function BullMQ calls for each job.
//
// Reads the JobSpec out of the job payload, spawns the command, records
// the start/end in pipeline_runs.db via @common/pipeline-runs, and lets
// BullMQ handle retry semantics by throwing on failure.

import { spawn } from 'child_process'
import { join } from 'path'
import type { Job } from 'bullmq'
import { recordStart, recordEnd } from '@common/pipeline-runs'
import { workspaceRoot } from './env.js'
import type { JobSpec, JobResult } from './types.js'
import { buildPipelineChildEnv } from './child-env.js'

interface JobPayload {
  spec: JobSpec
  /** ID of the parent pipeline-runs row (the daily.sh-level row) so all jobs
   * nest under it for the dashboard's hierarchy. */
  parentRunId: string | null
  /** Marks the BullMQ root job — the final stage in the flow. The processor
   * closes the parent pipeline_runs row when this one finishes successfully. */
  isRoot?: boolean
}

function spawnChild(
  cmd: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  runId: string,
): Promise<{ exitCode: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    // shell:true so /bin/sh resolves `npm` / `npx` / `tsx` via the env.PATH we
    // built. Node's spawn() lookup ignores options.env when shell:false, so
    // without the shell we'd hit ENOENT for `npm` whenever the worker was
    // launched from a process (cron/launchd/nohup) with a stripped PATH.
    const shellCmd = cmd.map(arg => /[\s"'$`\\]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg).join(' ')
    const child = spawn(shellCmd, [], {
      stdio: 'inherit',
      env:   { ...env, PIPELINE_RUN_ID: runId, PIPELINE_PARENT_RUN_ID: runId },
      cwd,
      shell: true,
    })

    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGTERM')
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, 10_000)
    }, timeoutMs)

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ exitCode: code, signal })
    })
  })
}

/**
 * Execute one stage.
 *
 * @param pipelineCredential the validated PIPELINE_DATABASE_URL, captured by the
 *   worker entrypoint at startup and passed in explicitly. It is NOT re-read
 *   from process.env here: a credential that could change under a running worker
 *   would make "which database did that stage write" unanswerable after the
 *   fact. Rotation requires an intentional restart.
 */
export async function processJob(
  job: Job<JobPayload>,
  pipelineCredential: string,
): Promise<JobResult> {
  const { spec, parentRunId, isRoot } = job.data

  // Skip via spec.skipIf() — fast path that doesn't even record a run.
  if (spec.skipIf && spec.skipIf()) {
    return {
      runId:      '',
      status:     'success',
      exitCode:   0,
      signal:     null,
      durationMs: 0,
    }
  }

  const root = workspaceRoot()
  const cwd  = join(root, spec.cwd)
  // Prepend Homebrew + standard system paths so `npm` / `npx` / `tsx` resolve
  // even when the worker was spawned with a stripped PATH (nohup/launchd often
  // hand the child a near-empty env).
  const STANDARD_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
  // One builder, shared with bin/run-stage.ts. It strips every database, PG* and
  // authority variable AFTER spec.env and the additions below are applied, then
  // assigns DATABASE_URL from the validated credential last — so neither a
  // JobSpec nor a future addition can redirect a stage's destination.
  const env = buildPipelineChildEnv(process.env, spec.env, pipelineCredential, {
    PATH: process.env.PATH
      ? `${STANDARD_PATH}:${process.env.PATH}`
      : STANDARD_PATH,
    // Make sure DATA_ROOT propagates so apps that use cross-project paths
    // (unified-platform, capital-intel notebooklm, scenario refresh export,
    // gov-flow exporter) resolve correctly.
    DATA_ROOT: process.env.DATA_ROOT ?? join(root, 'apps'),
  })

  const startedAt = Date.now()
  const runId = recordStart({
    stage:        spec.name,
    parentRunId,
    metadata:     {
      cwd:           spec.cwd,
      cmd:           spec.cmd,
      attemptNumber: job.attemptsMade + 1,
      attemptsMax:   spec.retry?.attempts ?? job.opts.attempts ?? 1,
    },
  })

  const timeoutMs = spec.timeoutMs ?? 60 * 60 * 1000  // default 1h hard cap
  const result    = await spawnChild(spec.cmd, cwd, env, timeoutMs, runId)
  const durationMs = Date.now() - startedAt

  const success = result.exitCode === 0 && result.signal === null
  recordEnd(runId, {
    status: success
      ? 'success'
      : result.signal
        ? 'killed'
        : 'failed',
    error: success ? null : {
      message: result.signal
        ? `Killed by ${result.signal}`
        : `Exit code ${result.exitCode}`,
    },
    metadata: { exitCode: result.exitCode, signal: result.signal },
  })

  if (!success) {
    // If this attempt exhausted the retry budget, the whole flow is dead — the
    // remaining stages won't run, so nobody else will close the parent
    // pipeline_runs row. Close it here as failed before throwing.
    const attemptsMax = spec.retry?.attempts ?? job.opts.attempts ?? 1
    if (parentRunId && (job.attemptsMade + 1) >= attemptsMax) {
      recordEnd(parentRunId, {
        status: 'failed',
        error:  { message: `${spec.name} exhausted ${attemptsMax} attempts: ${result.signal ? `signal ${result.signal}` : `exit ${result.exitCode}`}` },
        metadata: { failedStage: spec.name, failedRunId: runId },
      })
    }
    // Throwing tells BullMQ to retry per the job's attempts/backoff policy.
    throw new Error(
      `${spec.name}: ${result.signal ? `signal ${result.signal}` : `exit ${result.exitCode}`}`,
    )
  }

  // Root job (final stage in the flow) just finished — close the parent
  // pipeline_runs row so the dashboard sees the whole run as terminated.
  if (isRoot && parentRunId) {
    recordEnd(parentRunId, {
      status:   'success',
      error:    null,
      metadata: { finalStage: spec.name, finalRunId: runId },
    })
  }

  return {
    runId,
    status: 'success',
    exitCode: result.exitCode,
    signal:   result.signal,
    durationMs,
  }
}
