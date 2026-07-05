// src/cli/cli-brainstorm.ts
import 'dotenv/config'
import { join } from 'path'
import * as readline from 'readline'
import Anthropic from '@anthropic-ai/sdk'
import { createThesisStore } from '../store/thesis-store.js'
import { createRetriever } from '../reasoning/retriever.js'
import { createManualThesis } from '../thesis/creator.js'

const DATA_DIR = join(process.cwd(), 'data')
const INGESTION_PATH = process.env.INGESTION_STORE_PATH
  ?? join(process.cwd(), '..', 'capital-intelligence-ingestion', 'data')

const args = process.argv.slice(2)
const get = (flag: string) => args.find(a => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=')

export function parseSynthesisLegs(text: string): string[] {
  if (!text.trim()) return []
  const parts = text.split(/(?=^Leg \d+:)/m).map(p => p.trim()).filter(Boolean)
  if (parts.length > 1) return parts
  return [text.trim()]
}

async function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve))
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1) }

  const ticker = get('--ticker')
  if (!ticker) { console.error('Usage: npm run brainstorm -- --ticker=ARM'); process.exit(1) }

  const client = new Anthropic({ apiKey })
  const store = createThesisStore(join(DATA_DIR, 'thesis.db'))
  const retriever = await createRetriever(INGESTION_PATH)

  console.log(`\nLoading ${ticker} context...`)
  const contextChunks = await retriever.search(ticker, ticker, 20)
  const contextText = contextChunks
    .map(c => `[${c.docType} ${c.publishedDate.slice(0, 10)}] ${c.content}`)
    .join('\n\n')
  console.log(`${contextChunks.length} document chunks loaded\n`)

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  console.log(`Thesis brainstorm for ${ticker}. Share your thinking — type freely.`)
  console.log(`Type 'done' to synthesize thesis legs. Ctrl+C to exit without saving.\n`)
  console.log('─'.repeat(62))

  const transcript: string[] = []

  process.on('SIGINT', () => {
    console.log('\n\nExiting without saving.')
    rl.close()
    // Fire-and-forget close before process.exit — pg pool will be torn down anyway.
    void store.close()
    process.exit(0)
  })

  while (true) {
    const input = await askQuestion(rl, '\nYou: ')
    const trimmed = input.trim()
    if (!trimmed) continue
    if (trimmed.toLowerCase() === 'done') break
    transcript.push(trimmed)
  }

  if (transcript.length === 0) {
    console.log('No input recorded. Exiting.')
    rl.close()
    await store.close()
    return
  }

  console.log('\nSynthesizing thesis legs from your conversation...\n')

  const transcriptText = transcript.map((t, i) => `[${i + 1}] ${t}`).join('\n\n')

  const systemPrompt = `You are a senior investment analyst. Extract 3-5 thesis legs from the investor's notes about ${ticker}.

Company context (from SEC filings, earnings transcripts, and news):
${contextText}

For each leg, structure it as:
Leg N: [Short title]
  Thesis: [One sentence core thesis statement]
  Evidence: [Specific quote or data point from the company context above]
  Weakens if: [Specific falsifiable condition]

Ground every leg in the company context above. Do not invent evidence.`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Here are my notes on ${ticker}:\n\n${transcriptText}\n\nExtract the thesis legs grounded in the company documents.`,
    }],
  })

  const block = response.content.find(b => b.type === 'text')
  if (!block || block.type !== 'text') {
    console.error('No text response from Claude')
    rl.close()
    await store.close()
    return
  }

  const synthesisText = block.text
  const legs = parseSynthesisLegs(synthesisText)

  console.log(`${ticker} Thesis Draft`)
  console.log('─'.repeat(62))
  console.log(synthesisText)
  console.log('─'.repeat(62))

  const save = await askQuestion(rl, `\nSave these ${legs.length} legs to thesis-memory? (y/n): `)
  rl.close()

  if (save.trim().toLowerCase() !== 'y') {
    console.log('Not saved.')
    await store.close()
    return
  }

  const existing = await store.getThesis(ticker)
  if (existing) {
    console.log(`\nThesis for ${ticker} already exists. Legs were NOT overwritten.`)
    console.log(`To update, run: npm run update -- --ticker=${ticker}`)
  } else {
    await createManualThesis(ticker, 'company', 'watchlist', legs, synthesisText, store)
    console.log(`\n✓ ${legs.length} legs saved to thesis-memory for ${ticker}`)
  }

  try {
    const { writeFileSync, mkdirSync } = await import('fs')
    const notesDir = join(INGESTION_PATH, '..', 'intake', 'personal-notes')
    mkdirSync(notesDir, { recursive: true })
    const today = new Date().toISOString().slice(0, 10)
    const noteFile = join(notesDir, `${ticker.toLowerCase()}-thesis_observation-${today}-brainstorm.md`)
    const noteContent = [
      '---',
      `ticker: ${ticker}`,
      'type: thesis_observation',
      `date: ${today}`,
      '---',
      '',
      `## Brainstorm Session — ${today}`,
      '',
      transcript.map((t, i) => `**[${i + 1}]** ${t}`).join('\n\n'),
      '',
      '## Synthesized Thesis',
      '',
      synthesisText,
    ].join('\n')
    writeFileSync(noteFile, noteContent, 'utf-8')
    console.log(`✓ Session transcript saved as personal note`)
  } catch {
    // non-fatal
  }

  await store.close()
}

main().catch(err => { console.error(err); process.exit(1) })
