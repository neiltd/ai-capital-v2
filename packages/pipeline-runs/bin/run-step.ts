#!/usr/bin/env node
// Wrapper around any pipeline command — records a pipeline_runs row,
// spawns the actual command with PIPELINE_RUN_ID in its env, and updates
// the row with the final status when the child exits.
//
// Usage:
//   run-step --stage <stage-name> [--source <source>] -- <cmd> [args...]
//
// Exits with the child's exit code. Designed to be called from daily.sh so
// every step gets a row in pipeline_runs.db even if the inner command never
// reaches its own withRun() block (e.g. crash before main() runs).

import { spawn } from 'child_process'
import { recordStart, recordEnd } from '../src/index.js'

function parseArgs(argv: string[]): { stage: string; source: string | null; cmd: string[] } {
  const sep = argv.indexOf('--')
  if (sep < 0) {
    console.error('run-step: missing "--" separator before command. Usage: run-step --stage <name> -- <cmd> [args...]')
    process.exit(2)
  }
  const flags = argv.slice(0, sep)
  const cmd   = argv.slice(sep + 1)

  let stage: string | null = null
  let source: string | null = null
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]
    if (f === '--stage')       { stage  = flags[++i] ?? null; continue }
    if (f === '--source')      { source = flags[++i] ?? null; continue }
    if (f.startsWith('--stage=')) { stage  = f.slice('--stage='.length); continue }
    if (f.startsWith('--source=')) { source = f.slice('--source='.length); continue }
  }
  if (!stage)       { console.error('run-step: --stage required'); process.exit(2) }
  if (cmd.length === 0) { console.error('run-step: no command after "--"'); process.exit(2) }
  return { stage, source, cmd }
}

const { stage, source, cmd } = parseArgs(process.argv.slice(2))
const parentRunId = process.env.PIPELINE_PARENT_RUN_ID || null

const runId = recordStart({
  stage,
  source,
  parentRunId,
  metadata: { argv: cmd, cwd: process.cwd() },
})

// Forward PIPELINE_RUN_ID + PIPELINE_PARENT_RUN_ID down to the child so it can
// record sub-stages (e.g. capital-ingestion's per-client clients) under us.
const childEnv = {
  ...process.env,
  PIPELINE_RUN_ID:        runId,
  PIPELINE_PARENT_RUN_ID: runId,
}

const child = spawn(cmd[0], cmd.slice(1), {
  stdio:  'inherit',
  env:    childEnv,
  shell:  false,
})

let signaled: string | null = null
child.on('exit', (code, signal) => {
  signaled = signal
  const status = signal
    ? 'killed'
    : code === 0
      ? 'success'
      : 'failed'
  recordEnd(runId, {
    status,
    error: status === 'success' ? null : {
      message: signal ? `Killed by ${signal}` : `Exit code ${code}`,
      stack:   undefined,
    },
    metadata: { exitCode: code, signal },
  })
  process.exit(code ?? (signaled ? 1 : 1))
})

// Forward SIGTERM/SIGINT so killing the wrapper cascades to the child.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig)
  })
}
