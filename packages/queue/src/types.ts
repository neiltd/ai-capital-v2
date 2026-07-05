// Job spec types — each daily.sh stage becomes a JobSpec.
//
// A JobSpec describes what to run (cmd + cwd + env) and how to retry. The
// queue runner (BullMQ) hands these specs to its worker; the worker spawns
// the child process, records start/end in pipeline_runs.db via @common/pipeline-runs,
// and reports success/failure back to the queue for retry semantics.

export interface JobSpec {
  /** Unique name — used as the BullMQ job name + as the `stage` in pipeline_runs. */
  name:        string

  /**
   * Command to spawn. First element is the binary, rest are args.
   * Example: ['npm', 'run', 'pipeline']
   */
  cmd:         string[]

  /**
   * Working directory relative to the workspace root.
   * Example: 'apps/capital-intelligence-ingestion'
   */
  cwd:         string

  /** Environment overrides. PATH + PIPELINE_RUNS_DB inherited from parent. */
  env?:        Record<string, string>

  /**
   * Optional dependency on one or more sibling jobs' success. The dependent
   * job is only submitted after all listed parents emit 'completed'. Supports
   * a single string (single dependency) or an array (multiple dependencies)
   * so we can model the real DAG rather than a linear chain.
   */
  dependsOn?:  string | string[]

  /**
   * Skip the job at submit time when this returns true. Used for the
   * Sunday-only stages (world-intelligence pipeline, scenario-discover,
   * people-tweets) so they no-op the rest of the week without burning a
   * queue slot.
   */
  skipIf?:     () => boolean

  /** Hard wall-clock limit for the spawn. Defaults to 1 hour. */
  timeoutMs?:  number

  /** Retry policy. Defaults to { attempts: 3, backoffMs: 60_000 } (exponential). */
  retry?: {
    attempts:  number      // total attempts including the first
    backoffMs: number      // base delay; exponential = backoffMs * 2^(attempt - 1)
  }
}

export interface JobResult {
  /** runId stored in pipeline_runs.db so the dashboard can link back. */
  runId:      string
  status:     'success' | 'failed'
  exitCode:   number | null
  signal:     string | null
  durationMs: number
}
