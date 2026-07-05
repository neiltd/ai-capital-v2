// src/cli/update.ts
import 'dotenv/config'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import Database from 'better-sqlite3'
import { createThesisStore } from '../store/thesis-store.js'
import { createRetriever } from '../reasoning/retriever.js'
import { createAnalyzer } from '../reasoning/analyzer.js'
import { buildPrompt } from '../reasoning/prompter.js'
import type { EvidenceChunk } from '../types.js'

const DATA_DIR = join(process.cwd(), 'data')
const INGESTION_PATH = process.env.INGESTION_STORE_PATH
  ?? join(process.cwd(), '..', 'capital-intelligence-ingestion', 'data')

const args = process.argv.slice(2)
const get = (flag: string) => args.find(a => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=')
const tickerArg = get('--ticker')
const themeArg = get('--theme')

// Longest evidence lookback a single update run will request, regardless of
// how long a thesis has gone unreviewed.
const MAX_EVIDENCE_WINDOW_DAYS = 30

export function shouldUpdate(lastUpdatedIso: string, thesisUpdateDays: number): boolean {
  const daysSince = (Date.now() - new Date(lastUpdatedIso).getTime()) / 86_400_000
  return daysSince >= thesisUpdateDays
}

export function hasNewDocs(ingestionDataPath: string, ticker: string): boolean {
  const dbPath = join(ingestionDataPath, 'sqlite.db')
  if (!existsSync(dbPath)) return false
  try {
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare(
      `SELECT SUM(doc_count) as total FROM fetch_log
       WHERE ticker = ? AND fetched_at >= datetime('now', '-1 day')`
    ).get(ticker) as { total: number | null }
    db.close()
    return (row?.total ?? 0) > 0
  } catch {
    return false
  }
}

function loadIngestionFrequencies(ingestionDataPath: string): Map<string, number> {
  const dbPath = join(ingestionDataPath, 'sqlite.db')
  if (!existsSync(dbPath)) return new Map()
  try {
    const db = new Database(dbPath, { readonly: true })
    const rows = db.prepare(
      'SELECT ticker, thesis_update_days FROM watchlist WHERE active = 1'
    ).all() as Array<{ ticker: string; thesis_update_days: number | null }>
    db.close()
    return new Map(rows.map(r => [r.ticker, r.thesis_update_days ?? 1]))
  } catch {
    return new Map()
  }
}

async function generateProposal(
  ticker: string,
  store: ReturnType<typeof createThesisStore>,
  retriever: Awaited<ReturnType<typeof createRetriever>>,
  analyzer: ReturnType<typeof createAnalyzer>
): Promise<void> {
  const thesis = await store.getThesis(ticker)
  if (!thesis) { console.log(`  No thesis for ${ticker} — skipping`); return }

  const assumptions = await store.getAssumptions(thesis.id)
  const narrative = await store.getCurrentNarrative(thesis.id)
  if (!narrative) { console.log(`  No narrative for ${ticker} — skipping`); return }

  // Cap the evidence window — thesis.updatedAt only advances when a proposal
  // is approved (see updater.ts), so an un-reviewed thesis would otherwise
  // accumulate an ever-growing, ever more expensive lookback window forever.
  const cappedCursorMs = Math.max(
    new Date(thesis.updatedAt).getTime(),
    Date.now() - MAX_EVIDENCE_WINDOW_DAYS * 86_400_000
  )
  const lastUpdated = new Date(cappedCursorMs).toISOString().slice(0, 10)
  console.log(`  Retrieving evidence for ${ticker} since ${lastUpdated}...`)

  const allChunks: EvidenceChunk[] = []
  const seenIds = new Set<string>()
  for (const assumption of assumptions) {
    const chunks = await retriever.search(assumption.label, ticker, 8, lastUpdated)
    for (const c of chunks) {
      if (!seenIds.has(c.id)) { seenIds.add(c.id); allChunks.push(c) }
    }
  }

  if (allChunks.length === 0) {
    console.log(`  No new evidence for ${ticker} since ${lastUpdated} — skipping`)
    return
  }

  const chunks = allChunks.slice(0, 30)
  console.log(`  Analyzing ${chunks.length} evidence chunks with Claude...`)

  const prompt = buildPrompt(thesis, assumptions, narrative, chunks, lastUpdated)
  const response = await analyzer.analyze(prompt, ticker)

  if (response.assumption_changes.length === 0 && !response.portfolio_action) {
    console.log(`  No changes proposed for ${ticker}`)
    return
  }

  const proposalId = randomUUID()
  const now = new Date().toISOString()

  await store.createProposal({
    id: proposalId,
    thesisId: thesis.id,
    status: 'pending',
    chunkIdsUsed: chunks.map(c => c.id),
    claudeReasoning: JSON.stringify(response),
    createdAt: now,
    resolvedAt: null,
  })

  for (const change of response.assumption_changes) {
    const assumption = assumptions.find(a => a.label === change.label)
    await store.createProposalChange({
      id: randomUUID(),
      proposalId,
      changeType: 'assumption_status',
      assumptionId: assumption?.id ?? null,
      oldValue: change.old_status,
      newValue: change.new_status,
      reasoning: change.reasoning,
      evidenceQuotes: change.evidence_quotes,
      approved: null,
    })
  }

  if (response.narrative_update && response.narrative_update !== narrative.content) {
    await store.createProposalChange({
      id: randomUUID(),
      proposalId,
      changeType: 'narrative',
      assumptionId: null,
      oldValue: narrative.content,
      newValue: response.narrative_update,
      reasoning: 'Updated narrative based on new evidence',
      evidenceQuotes: [],
      approved: null,
    })
  }

  if (response.portfolio_action) {
    await store.createProposalChange({
      id: randomUUID(),
      proposalId,
      changeType: 'portfolio_action',
      assumptionId: null,
      oldValue: '',
      newValue: JSON.stringify(response.portfolio_action),
      reasoning: response.portfolio_action.reasoning,
      evidenceQuotes: [],
      approved: null,
    })
  }

  const changeCount = response.assumption_changes.length +
    (response.narrative_update !== narrative.content ? 1 : 0)
  console.log(`  ✓ Proposal created: ${changeCount} change(s)${response.portfolio_action ? ' + 1 action suggestion' : ''}`)
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1) }

  const store = createThesisStore(join(DATA_DIR, 'thesis.db'))
  const retriever = await createRetriever(INGESTION_PATH)
  const analyzer = createAnalyzer(apiKey)
  const frequencies = loadIngestionFrequencies(INGESTION_PATH)

  try {
    let tickers: string[] = []

    if (tickerArg) {
      tickers = [tickerArg]
    } else if (themeArg) {
      const themeTicker = await store.getThesis(themeArg)
      if (!themeTicker) { console.error(`No theme thesis for ${themeArg}`); process.exit(1) }
      tickers = (await store.getThemeMembers(themeTicker.id)).map(m => m.ticker)
    } else {
      tickers = (await store.listTheses()).filter(t => t.type === 'company').map(t => t.ticker)
    }

    if (tickers.length === 0) { console.log('No theses to update.'); return }

    // Thesis IDs that already have an un-reviewed proposal sitting in the
    // queue — generating another one on top would just compound the backlog
    // instead of surfacing that review is overdue.
    const pendingThesisIds = new Set((await store.getPendingProposals()).map(p => p.thesisId))

    console.log(`\nGenerating proposals for ${tickers.length} thesis(es)...\n`)
    for (const ticker of tickers) {
      const thesis = await store.getThesis(ticker)
      if (thesis) {
        if (pendingThesisIds.has(thesis.id)) {
          console.log(`  [skip] ${ticker}: already has a pending proposal — run npm run review first`)
          continue
        }
        const freq = frequencies.get(ticker) ?? 1
        if (!shouldUpdate(thesis.updatedAt, freq)) {
          const daysSince = (Date.now() - new Date(thesis.updatedAt).getTime()) / 86_400_000
          const daysUntil = freq - daysSince
          console.log(`  [skip] ${ticker}: updated ${daysSince.toFixed(1)}d ago, next in ${daysUntil.toFixed(1)}d`)
          continue
        }
      }
      if (!hasNewDocs(INGESTION_PATH, ticker)) {
        console.log(`  [skip] ${ticker}: no new documents in last 24h`)
        continue
      }
      await generateProposal(ticker, store, retriever, analyzer)
    }

    const pending = await store.getPendingProposals()
    console.log(`\nDone. ${pending.length} proposal(s) pending review. Run: npm run review`)
  } finally {
    await store.close()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
