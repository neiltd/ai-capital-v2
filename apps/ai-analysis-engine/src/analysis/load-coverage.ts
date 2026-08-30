// World-intel ARTICLE coverage, derived from the collector's own feed registry,
// health store and daily metrics.
//
// DOMAIN-CORRECT: the regime analyzer reads article-derived intelligence
// (world-map/intelligence.json, 12 RSS feeds). It previously took coverage from
// quota/freshness.json, which describes gdelt/acled/eia/worldbank/ucdp — sources
// it does not consume. That warned about irrelevant evidence while real feed
// degradation stayed invisible. Structured/energy provenance still exists for
// its own consumers; it is simply not this one's dependency.
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

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  coverageIsComplete, absenceCaveat, classifyArticleSources, withDomain,
  type FeedRegistryEntry, type FeedHealthEntry, type CollectionMetrics,
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

export function loadCoverage(
  worldIntelRoot: string = DEFAULT_WORLD_INTEL_ROOT,
  now: Date = new Date(),
): WorldCoverage {
  try {
    const sourcesDir = join(worldIntelRoot, 'intelligence', 'sources')
    const registryPath = join(sourcesDir, 'sources.json')
    if (!existsSync(registryPath)) {
      return unknownCoverage('article source registry not found')
    }
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8')) as unknown
    const registry = (Array.isArray(raw) ? raw : (raw as { sources?: unknown[] })?.sources ?? []) as FeedRegistryEntry[]
    if (!Array.isArray(registry) || registry.length === 0) {
      return unknownCoverage('article source registry is empty or malformed')
    }

    const healthPath = join(sourcesDir, 'source-health.json')
    const health = existsSync(healthPath)
      ? JSON.parse(readFileSync(healthPath, 'utf-8')) as Record<string, FeedHealthEntry>
      : {}

    // Latest daily collection record. Absent means unknown, never healthy.
    let metrics: CollectionMetrics | null = null
    const metricsDir = join(worldIntelRoot, 'intelligence', 'metrics')
    if (existsSync(metricsDir)) {
      const days = readdirSync(metricsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
      const latest = days[days.length - 1]
      if (latest) {
        const rec = JSON.parse(readFileSync(join(metricsDir, latest), 'utf-8')) as { collection?: CollectionMetrics }
        metrics = rec?.collection ?? null
      }
    }

    const sources = withDomain(
      classifyArticleSources({ registry, health, metrics, now }),
      'article_intelligence',
    )
    if (sources.length === 0) return unknownCoverage('no enabled article feeds in the registry')

    const degraded = sources.filter(s => s.availability !== 'current')
    return {
      complete: coverageIsComplete(sources),
      summary: degraded.length === 0
        ? 'article coverage complete'
        : `article coverage degraded: ${degraded.map(s => `${s.source} ${s.availability}`).join(', ')}`,
      caveat: absenceCaveat(sources),
      sources,
    }
  } catch {
    return unknownCoverage('article coverage records unreadable')
  }
}

function unknownCoverage(why: string): WorldCoverage {
  return {
    complete: false,
    summary: `world-intel article coverage unknown: ${why}`,
    caveat: 'events may be MISSING rather than absent — article feed health could not be established',
    sources: [],
  }
}
