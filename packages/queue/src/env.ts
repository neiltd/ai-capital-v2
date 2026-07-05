// Shared env setup — keeps the queue's view of paths consistent with daily.sh.
//
// daily.sh exports:
//   PIPELINE_RUNS_DB="$ROOT/data/pipeline-runs.db"
//   DATA_ROOT="$ROOT/apps"
//
// Both bins (submit, worker, smoke) need the same anchoring so parent and
// child pipeline_runs rows land in the same SQLite file.

import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'

/** Absolute path to the monorepo root (the dir that holds pnpm-workspace.yaml). */
export function workspaceRoot(): string {
  // packages/queue/src/env.ts → ../../../ = repo root
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', '..')
}

/**
 * Set PIPELINE_RUNS_DB and DATA_ROOT to the monorepo defaults unless the caller
 * already set them. Called once at the top of each bin entry point.
 */
export function ensurePipelineEnv(): void {
  const root = workspaceRoot()

  // The worker is long-running (launchd/manual background process), so unlike
  // a one-off script it never inherits shell-sourced .env values. Load the
  // root .env once at startup; process.loadEnvFile does not clobber vars the
  // real environment (launchd EnvironmentVariables, shell export) already set.
  const envPath = join(root, '.env')
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath)
  }

  if (!process.env.PIPELINE_RUNS_DB) {
    process.env.PIPELINE_RUNS_DB = join(root, 'data', 'pipeline-runs.db')
  }
  if (!process.env.DATA_ROOT) {
    process.env.DATA_ROOT = join(root, 'apps')
  }
}
