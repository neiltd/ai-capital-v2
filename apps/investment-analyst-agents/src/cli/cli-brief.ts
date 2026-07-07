import 'dotenv/config'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { loadContext }         from '../context/loader.js'
import { generateBriefing }   from '../briefing/briefing-agent.js'
import { buildBriefingJson }  from '../briefing/briefing-extractor.js'
import { writeBriefing, writeBriefingJson } from '../briefing/briefing-writer.js'
import { archivePrediction }  from '../archive/prediction-archiver.js'
import type { PredictionEntry } from '../types.js'

const BRIEFINGS_DIR  = join(process.cwd(), 'briefings')
const ARCHIVE_PATH   = join(process.cwd(), 'archive', 'predictions.jsonl')

async function run() {
  // Local calendar date (en-CA formats as YYYY-MM-DD). The UTC date rolls to
  // tomorrow at 5pm PT, so an evening catch-up/--force run would write the
  // briefing under tomorrow's filename and every "today" reader would miss it.
  const today      = new Date().toLocaleDateString('en-CA')
  const force      = process.argv.includes('--force')
  // Re-runs only the (cheap) JSON extraction against the existing markdown —
  // use this to backfill/re-extract without paying for a full regeneration.
  const forceJson  = process.argv.includes('--force-json')
  const cached     = join(BRIEFINGS_DIR, `${today}.md`)
  const cachedJson = join(BRIEFINGS_DIR, `${today}.json`)

  console.log(`[${new Date().toISOString()}] Loading context...`)
  const ctx = loadContext(today)

  let briefing: string
  if (!force && existsSync(cached)) {
    console.log(`[cache] Briefing for ${today} already exists — printing cached version.`)
    console.log(`        Run with --force to regenerate.\n`)
    briefing = readFileSync(cached, 'utf-8')
    console.log(briefing)
  } else {
    console.log(`[${new Date().toISOString()}] Generating briefing...`)
    briefing = await generateBriefing(ctx)
    const outputPath = writeBriefing(today, briefing, BRIEFINGS_DIR)
    console.log(`\nBriefing written to: ${outputPath}\n`)
    console.log(briefing)
  }

  // Extract the structured JSON envelope FROM the (fresh or cached) markdown.
  // Backfills the JSON on a cache hit too, so re-running today after this
  // feature landed doesn't require --force to get the envelope. --force only
  // reruns extraction because it already regenerated fresh markdown above;
  // --force-json reruns extraction alone, against the existing markdown,
  // without paying for a second full-briefing generation.
  if (force || forceJson || !existsSync(cachedJson)) {
    console.log(`[${new Date().toISOString()}] Extracting structured briefing JSON...`)
    const envelope = await buildBriefingJson({
      date: today,
      briefingMarkdown: briefing,
      regime: {
        regime:        ctx.analysis.latestRegime.regime,
        confidence:    ctx.analysis.latestRegime.confidence,
        rationale:     ctx.analysis.latestRegime.rationale,
        keyIndicators: ctx.analysis.latestRegime.keyIndicators,
      },
      // whatif scenarios are the ad-hoc cli-whatif.ts feature, not part of
      // the daily 3-scenario (best/base/disruption) set the briefing covers.
      scenarios: ctx.simulation.scenarios
        .filter((s): s is typeof s & { scenarioType: 'best' | 'base' | 'disruption' } => s.scenarioType !== 'whatif')
        .map(s => ({
          id:           s.id,
          scenarioType: s.scenarioType,
          title:        s.title,
          probability:  s.probability,
          timeHorizon:  s.timeHorizon,
          narrative:    s.narrative,
        })),
      calibration: ctx.calibration,
      taxHarvest:  ctx.taxHarvest,
    })
    const jsonPath = writeBriefingJson(today, envelope, BRIEFINGS_DIR)
    console.log(`JSON envelope written to: ${jsonPath} (${envelope.recommendedActions.length} actions extracted)`)
  }

  // Always archive the prediction — derived from simulation data, not LLM output.
  // Runs on both fresh and cached briefings so backtest always has today's entry.
  const entry: PredictionEntry = {
    date:       today,
    regime:     ctx.analysis.latestRegime.regime,
    confidence: ctx.analysis.latestRegime.confidence,
    scenarios:  ctx.simulation.scenarios.map(s => ({
      scenarioType:     s.scenarioType,
      title:            s.title,
      probability:      s.probability,
      timeHorizon:      s.timeHorizon,
      regimeTransition: s.regimeTransition,
      triggers:         s.triggers,
    })),
    actions: ctx.simulation.actions.map(a => {
      const scenario = ctx.simulation.scenarios.find(s => s.id === a.scenarioId)
      return {
        ticker:              a.ticker,
        scenarioType:        scenario?.scenarioType ?? 'unknown',
        action:              a.action,
        conviction:          a.conviction,
        allocationChangePct: a.allocationChangePct,
      }
    }),
  }
  await archivePrediction(entry, ARCHIVE_PATH)
  console.log(`Prediction archived to: ${ARCHIVE_PATH}`)
}

run().catch(err => { console.error(err); process.exit(1) })
