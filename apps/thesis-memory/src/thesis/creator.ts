// src/thesis/creator.ts
import { randomUUID } from 'crypto'
import type { ThesisStore } from '../store/thesis-store.js'
import type { Retriever } from '../reasoning/retriever.js'
import type { Analyzer } from '../reasoning/analyzer.js'
import type { PositionSize, ThesisType } from '../types.js'

export async function draftThesisFromIngestion(
  ticker: string,
  thesisType: ThesisType,
  positionSize: PositionSize,
  store: ThesisStore,
  retriever: Retriever,
  analyzer: Analyzer
): Promise<void> {
  const thesisId = randomUUID()
  const now = new Date().toISOString()

  const chunks = await retriever.search(
    `${ticker} business model revenue drivers competitive advantage risks`,
    ticker,
    20
  )

  if (chunks.length === 0) {
    throw new Error(`No ingestion data found for ${ticker}. Run the ingestion pipeline first.`)
  }

  const chunkSummaries = chunks
    .map(c => `[${c.source} ${c.publishedDate}, ${c.section}]\n"${c.content.slice(0, 400)}"`)
    .join('\n\n')

  const prompt = `You are creating an initial investment thesis for ${ticker}.

Based on the following evidence from SEC filings, earnings transcripts, and news, create:
1. A list of 4-6 key investment assumptions (the things that must be true for this to be a good investment)
2. A concise thesis narrative (3-5 sentences)
3. An initial portfolio action recommendation

EVIDENCE:
${chunkSummaries}

Use the propose_thesis_update tool. For assumption_changes, treat all assumptions as NEW (old_status = 'stable', new_status = their initial status based on evidence). The narrative_update should be the initial thesis narrative.`

  const response = await analyzer.analyze(prompt, ticker)

  store.createThesis({
    id: thesisId,
    ticker,
    type: thesisType,
    positionSize,
    createdAt: now,
    updatedAt: now,
  })

  for (const change of response.assumption_changes) {
    store.createAssumption({
      id: randomUUID(),
      thesisId,
      label: change.label,
      status: change.new_status,
      lastEvidenceSummary: change.reasoning,
      createdAt: now,
      updatedAt: now,
    })
  }

  store.createNarrative({
    id: randomUUID(),
    thesisId,
    content: response.narrative_update,
    version: 1,
    createdAt: now,
  })

  console.log(`\nThesis created for ${ticker} with ${response.assumption_changes.length} assumptions.`)
}

export function createManualThesis(
  ticker: string,
  thesisType: ThesisType,
  positionSize: PositionSize,
  assumptions: string[],
  narrative: string,
  store: ThesisStore
): void {
  const thesisId = randomUUID()
  const now = new Date().toISOString()

  store.createThesis({ id: thesisId, ticker, type: thesisType, positionSize, createdAt: now, updatedAt: now })

  for (const label of assumptions) {
    store.createAssumption({
      id: randomUUID(), thesisId, label, status: 'stable',
      lastEvidenceSummary: null, createdAt: now, updatedAt: now,
    })
  }

  store.createNarrative({ id: randomUUID(), thesisId, content: narrative, version: 1, createdAt: now })
  console.log(`\nManual thesis created for ${ticker} with ${assumptions.length} assumptions.`)
}
