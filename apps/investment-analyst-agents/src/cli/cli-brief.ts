import 'dotenv/config'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { loadContext }         from '../context/loader.js'
import { generateBriefing }   from '../briefing/briefing-agent.js'
import { writeBriefing }      from '../briefing/briefing-writer.js'
import { archivePrediction }  from '../archive/prediction-archiver.js'
import type { PredictionEntry } from '../types.js'

const BRIEFINGS_DIR  = join(process.cwd(), 'briefings')
const ARCHIVE_PATH   = join(process.cwd(), 'archive', 'predictions.jsonl')

async function run() {
  const today    = new Date().toISOString().slice(0, 10)
  const force    = process.argv.includes('--force')
  const cached   = join(BRIEFINGS_DIR, `${today}.md`)

  console.log(`[${new Date().toISOString()}] Loading context...`)
  const ctx = loadContext(today)

  if (!force && existsSync(cached)) {
    console.log(`[cache] Briefing for ${today} already exists — printing cached version.`)
    console.log(`        Run with --force to regenerate.\n`)
    console.log(readFileSync(cached, 'utf-8'))
  } else {
    console.log(`[${new Date().toISOString()}] Generating briefing...`)
    const briefing = await generateBriefing(ctx)
    const outputPath = writeBriefing(today, briefing, BRIEFINGS_DIR)
    console.log(`\nBriefing written to: ${outputPath}\n`)
    console.log(briefing)
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
