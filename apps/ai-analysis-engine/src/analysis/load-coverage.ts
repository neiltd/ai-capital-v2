// World-intel source coverage, loaded from the provenance record.
//
// SIDE-EFFECT-FREE BY CONTRACT. Importing this module must do nothing: no
// analysis, no model call, no writes, no process exit, no scheduling. Only
// calling `loadCoverage()` touches the filesystem, and only to read.
//
// WHY IT LIVES HERE. This function used to sit in `cli-run.ts`, which is an
// executable entrypoint whose body ends in a bare `run().catch(… process.exit(1))`
// with no main guard. When `cli-schedule.ts` imported it, ESM evaluated that body
// — so merely STARTING the scheduler daemon ran a full unscheduled analysis,
// including a billable model call and writes to analysis.json/analysis.db and the
// daily report, before cron was ever consulted. A failure inside that import-time
// run then exited the daemon before it reached its own schedule.
//
// THE RULE: an executable entrypoint must never be imported by another module.
// Shared behaviour belongs in a library like this one.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  readProvenance, coverageIsComplete, absenceCaveat, type ProvenanceRecord,
} from '@common/types'
import type { WorldCoverage } from './regime-analyzer.js'

/**
 * How old a provenance record may be before its own observational facts (a
 * declared failure, say) may be obsolete. Note this does NOT gate source
 * classification — every time-dependent verdict is recomputed at read time
 * against that source's own freshness bound.
 */
export const PROVENANCE_MAX_AGE_HOURS = 30

/** Default location of the world-intel app, relative to an app-level cwd. */
export const DEFAULT_WORLD_INTEL_ROOT = join(process.cwd(), '../world-intelligence-data-hub-')

/**
 * Read source coverage. Never throws, and never reports "complete" on a guess:
 * an unreadable or absent record is UNKNOWN coverage, which consumers treat
 * exactly like degraded coverage.
 */
export function loadCoverage(
  worldIntelRoot: string = DEFAULT_WORLD_INTEL_ROOT,
  now: Date = new Date(),
): WorldCoverage {
  try {
    const p = join(worldIntelRoot, 'quota', 'freshness.json')
    const record = existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) as ProvenanceRecord : null
    const r = readProvenance(record, now, PROVENANCE_MAX_AGE_HOURS)
    return {
      complete: coverageIsComplete(r.sources),
      summary:  r.summary,
      caveat:   absenceCaveat(r.sources),
      sources:  r.sources,
    }
  } catch {
    return {
      complete: false,
      summary: 'world-intel coverage unknown: provenance record unreadable',
      caveat: 'events may be MISSING rather than absent — the provenance record could not be read',
      sources: [],
    }
  }
}
