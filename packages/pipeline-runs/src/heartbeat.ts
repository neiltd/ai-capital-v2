import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Scheduler liveness heartbeats.
 *
 * This is the ONE piece of state pipeline_runs cannot supply. pipeline_runs
 * records what the pipeline did; it cannot record that the machine was AWAKE
 * and chose not to run anything — which is exactly the distinction between
 * "asleep through 07:00, nothing wrong" and "awake since 07:00, scheduler dead".
 *
 * Deliberately a flat file, not a table: it must be writable when the database
 * is unreachable, since a dead database is one of the conditions the watchdog
 * has to survive in order to report.
 */

const KEEP = 400   // ~4 days at one heartbeat per 15 minutes

export function recordHeartbeat(path: string, now = new Date()): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${now.toISOString()}\n`)
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean)
  if (lines.length > KEEP) writeFileSync(path, `${lines.slice(-KEEP).join('\n')}\n`)
}

export function readHeartbeats(path: string): Date[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(l => new Date(l.trim()))
    .filter(d => !Number.isNaN(d.getTime()))
}
