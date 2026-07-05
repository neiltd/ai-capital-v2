// src/cli/thesis.ts
import 'dotenv/config'
import { join } from 'path'
import { createThesisStore } from '../store/thesis-store.js'
import { createRetriever } from '../reasoning/retriever.js'
import { createAnalyzer } from '../reasoning/analyzer.js'
import { draftThesisFromIngestion, createManualThesis } from '../thesis/creator.js'
import { computeThemeConviction, convictionLabel, convictionBar } from '../thesis/rollup.js'
import type { PositionSize, ThesisType } from '../types.js'

const DATA_DIR = join(process.cwd(), 'data')
const INGESTION_PATH = process.env.INGESTION_STORE_PATH
  ?? join(process.cwd(), '..', 'capital-intelligence-ingestion', 'data')

const args = process.argv.slice(2)
const command = args[0]
const get = (flag: string) => args.find(a => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=')

async function main() {
  const store = createThesisStore(join(DATA_DIR, 'thesis.db'))

  try {
    if (command === 'list') {
      const theses = await store.listTheses()
      if (theses.length === 0) {
        console.log('No theses yet. Run: npm run thesis -- create --ticker=NVDA')
        return
      }
      console.log('\nYour Investment Theses:\n')
      for (const t of theses) {
        const assumptions = await store.getAssumptions(t.id)
        const statusWeights: Record<string, number> = { strengthening: 1, stable: 0.5, weakening: 0, broken: -0.5 }
        const scores = assumptions.map(a => statusWeights[a.status] ?? 0.5)
        const avg = scores.length ? scores.reduce((s, n) => s + n, 0) / scores.length : 0.5
        console.log(`  ${t.ticker.padEnd(12)} [${t.positionSize.padEnd(10)}] ${convictionBar(avg)} ${convictionLabel(avg)}`)
      }
      return
    }

    if (command === 'show') {
      const ticker = get('--ticker')
      const theme = get('--theme')

      if (ticker) {
        const thesis = await store.getThesis(ticker)
        if (!thesis) { console.error(`No thesis for ${ticker}`); process.exit(1) }
        const assumptions = await store.getAssumptions(thesis.id)
        const narrative = await store.getCurrentNarrative(thesis.id)
        console.log(`\n=== ${ticker} Thesis ===`)
        console.log(`Position: ${thesis.positionSize} | Updated: ${thesis.updatedAt.slice(0, 10)}\n`)
        console.log('Assumptions:')
        for (const a of assumptions) {
          console.log(`  [${a.status.padEnd(14)}] ${a.label}`)
          if (a.lastEvidenceSummary) console.log(`                 → ${a.lastEvidenceSummary}`)
        }
        console.log(`\nNarrative (v${narrative?.version ?? '?'}):\n${narrative?.content ?? 'No narrative.'}`)
        return
      }

      if (theme) {
        const thesis = await store.getThesis(theme)
        if (!thesis) { console.error(`No theme thesis for ${theme}`); process.exit(1) }
        const members = await store.getThemeMembers(thesis.id)
        const assumptionsByTicker: Record<string, Awaited<ReturnType<typeof store.getAssumptions>>> = {}
        for (const m of members) {
          const mt = await store.getThesis(m.ticker)
          if (mt) assumptionsByTicker[m.ticker] = await store.getAssumptions(mt.id)
        }
        const score = computeThemeConviction(members, assumptionsByTicker)
        console.log(`\n=== ${theme} Theme ===`)
        console.log(`Overall: ${convictionLabel(score).toUpperCase()} (score: ${score.toFixed(2)})\n`)
        for (const m of members) {
          const mt = await store.getThesis(m.ticker)
          if (!mt) continue
          const mas = assumptionsByTicker[m.ticker] ?? []
          const statusWeights: Record<string, number> = { strengthening: 1, stable: 0.5, weakening: 0, broken: -0.5 }
          const scores = mas.map(a => statusWeights[a.status] ?? 0.5)
          const avg = scores.length ? scores.reduce((s, n) => s + n, 0) / scores.length : 0.5
          console.log(`  ${m.ticker.padEnd(8)} ${convictionBar(avg)} ${convictionLabel(avg).padEnd(14)} (weight: ${m.weight})`)
        }
        return
      }

      console.error('Usage: npm run thesis -- show --ticker=NVDA  OR  --theme=ai-infrastructure')
      process.exit(1)
    }

    if (command === 'history') {
      const ticker = get('--ticker')
      if (!ticker) { console.error('Usage: npm run thesis -- history --ticker=NVDA'); process.exit(1) }
      const thesis = await store.getThesis(ticker)
      if (!thesis) { console.error(`No thesis for ${ticker}`); process.exit(1) }
      const history = await store.getNarrativeHistory(thesis.id)
      console.log(`\n=== ${ticker} Narrative History (${history.length} versions) ===\n`)
      for (const n of history) {
        console.log(`--- v${n.version} (${n.createdAt.slice(0, 10)}) ---`)
        console.log(n.content + '\n')
      }
      return
    }

    if (command === 'create') {
      const ticker = get('--ticker')
      const theme = get('--theme')
      const manual = args.includes('--manual')
      const positionSize = (get('--position') ?? 'watchlist') as PositionSize
      const target = ticker ?? theme
      const thesisType: ThesisType = theme ? 'theme' : 'company'

      if (!target) {
        console.error('Usage: npm run thesis -- create --ticker=NVDA [--position=core] [--manual]')
        process.exit(1)
      }

      const existing = await store.getThesis(target)
      if (existing) {
        console.error(`Thesis for ${target} already exists. Use npm run update.`)
        process.exit(1)
      }

      if (manual) {
        const readline = await import('readline')
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const question = (q: string) => new Promise<string>(resolve => rl.question(q, resolve))

        console.log(`Creating manual thesis for ${target}. Enter assumptions (one per line, blank line to finish):`)
        const assumptions: string[] = []
        while (true) {
          const line = await question('> ')
          if (!line.trim()) break
          assumptions.push(line.trim())
        }
        console.log('Enter narrative (single line):')
        const narrative = await question('> ')
        rl.close()
        await createManualThesis(target, thesisType, positionSize, assumptions, narrative, store)
      } else {
        const apiKey = process.env.ANTHROPIC_API_KEY
        if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1) }
        console.log(`Drafting thesis for ${target} from ingestion data...`)
        const retriever = await createRetriever(INGESTION_PATH)
        const analyzer = createAnalyzer(apiKey)
        await draftThesisFromIngestion(target, thesisType, positionSize, store, retriever, analyzer)
      }
      return
    }

    console.error('Usage: npm run thesis -- <create|show|list|history> [options]')
    process.exit(1)
  } finally {
    await store.close()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
