// REQUIRED RUNTIME SEEDS, CHECKED BEFORE THE DAILY FLOW IS CREATED.
//
// `requireSubmissionKeys` already refuses a submission that cannot finish for
// want of a credential. This is the same guard for the other class of
// precondition: an input file that is deliberately gitignored, so a fresh
// checkout has the code that reads it and none of the data.
//
// WHY THIS EXISTS. The 2026-09-29 relocation left
// `apps/dependency-graph-engine/data/graph.json` behind. `ai-analysis-engine`
// opens it unconditionally, so the flow ran twenty stages, failed terminally on
// an ENOENT, and parked six parents in `waiting-children` behind a scheduled row
// that then had to be retired by hand. None of that work was recoverable and
// none of it needed to start.
//
// WHY ONLY THIS FILE. `dependency-graph-engine` is a manual/monthly producer and
// is not a DAG stage, so nothing in the flow can create this input; it must
// already be there. Everything else the DAG needs is either produced by an
// earlier stage of the same run (analysis.json, simulation.json, the
// world-intelligence exports, tax and risk outputs), read from Postgres under
// the worker's DATABASE_URL (backtest history, tax, risk), or explicitly
// optional (profile.md, thesis.db, people events, calibration, correlation).
// Demanding any of those would refuse runs that are fine.

import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Refusal raised before anything is enqueued or recorded. */
export class SeedArtifactRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedArtifactRefused'
  }
}

/**
 * THE CHECKOUT THIS CODE IS ACTUALLY RUNNING FROM.
 *
 * Derived from this module's own location, never from `process.cwd()` and never
 * from a remembered absolute path. The whole defect was a file that existed in
 * one checkout and not the one being served, so a preflight that resolved
 * against the wrong root would answer for the wrong tree.
 */
export function checkoutRoot(moduleUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..', '..')
}

/** The reviewed seed: path relative to the checkout root. */
export const GRAPH_SEED_PATH = join('apps', 'dependency-graph-engine', 'data', 'graph.json')

/** The schemaVersion this pipeline reads. */
export const GRAPH_SEED_SCHEMA_VERSION = '1.0'

/**
 * Prove the dependency graph seed is present and usable.
 *
 * NOTHING FROM THE FILE REACHES THE MESSAGE. The graph names real holdings and
 * their relationships, and a refusal string reaches launchd logs and run
 * records. Messages say which property failed, never the content.
 *
 * NOT A SYMLINK, AND A REAL FILE. `lstatSync` so a link is seen as a link: a
 * symlink here would let the stage read a file outside the checkout, which is a
 * different input than the one this preflight claims to have checked.
 */
export function requireDailySeedArtifacts(root: string = checkoutRoot()): void {
  const path = join(root, GRAPH_SEED_PATH)
  const refuse = (why: string): never => {
    throw new SeedArtifactRefused(
      `@common/queue: refusing to submit the daily pipeline — ${GRAPH_SEED_PATH} ${why}. ` +
      'It is required by ai-analysis-engine, is deliberately untracked, and is produced ' +
      'only by the manual monthly dependency-graph run (scripts/dep-graph-scan.sh). ' +
      'No job was enqueued and no run was recorded.',
    )
  }

  let st
  try {
    st = lstatSync(path)
  } catch {
    refuse('is absent from this checkout')
    return
  }
  if (st.isSymbolicLink()) refuse('is a symlink, not a regular file')
  if (!st.isFile()) refuse('is not a regular file')

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    refuse('is not valid JSON')
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    refuse('does not contain a JSON object')
    return
  }
  const g = parsed as Record<string, unknown>
  if (g.schemaVersion !== GRAPH_SEED_SCHEMA_VERSION) {
    refuse(`does not declare schemaVersion ${GRAPH_SEED_SCHEMA_VERSION}`)
  }
  if (!Array.isArray(g.nodes) || g.nodes.length === 0) refuse('has no nodes')
  if (!Array.isArray(g.edges) || g.edges.length === 0) refuse('has no edges')
}
