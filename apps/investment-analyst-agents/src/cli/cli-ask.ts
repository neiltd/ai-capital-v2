import 'dotenv/config'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import * as readline from 'readline'
import { askQuestion } from '../qa/qa-agent.js'
import { archiveQA }   from '../archive/qa-archiver.js'
import type { SimulationJSON, GraphJSON, QAEntry } from '../types.js'

const BRIEFINGS_DIR   = join(process.cwd(), 'briefings')
const SIMULATION_PATH = join(process.cwd(), '../scenario-simulator/data/simulation.json')
const GRAPH_PATH      = join(process.cwd(), '../dependency-graph-engine/data/graph.json')
const PROFILE_PATH    = join(process.cwd(), 'knowledge/profile.md')
const QA_ARCHIVE_PATH = join(process.cwd(), 'archive', 'qa.jsonl')

const today        = new Date().toISOString().slice(0, 10)
const briefingPath = join(BRIEFINGS_DIR, `${today}.md`)

if (!existsSync(briefingPath)) {
  console.error(`No briefing for today (${today}). Run: npm run brief`)
  process.exit(1)
}

const briefing:    string          = readFileSync(briefingPath, 'utf-8')
const simulation:  SimulationJSON  = JSON.parse(readFileSync(SIMULATION_PATH, 'utf-8'))
const graph:       GraphJSON       = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))
const profile:     string          = existsSync(PROFILE_PATH) ? readFileSync(PROFILE_PATH, 'utf-8') : ''
const context = { simulation, graph, profile }

const question = process.argv.slice(2).join(' ').trim()

async function runSingle() {
  const answer = await askQuestion(question, briefing, context, [])
  console.log(`\n${answer}\n`)
  const entry: QAEntry = {
    date:      today,
    timestamp: new Date().toISOString(),
    mode:      'single',
    exchanges: [{ question, answer }],
  }
  await archiveQA(entry, QA_ARCHIVE_PATH)
}

async function runLoop() {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
  const exchanges: Array<{ question: string; answer: string }>           = []

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log("Investment Analyst ready. Type your question (or 'exit' to quit).\n")

  const prompt = () => {
    rl.question('You: ', async (input) => {
      const q = input.trim()
      if (!q || q.toLowerCase() === 'exit') {
        rl.close()
        if (exchanges.length > 0) {
          await archiveQA({ date: today, timestamp: new Date().toISOString(), mode: 'loop', exchanges }, QA_ARCHIVE_PATH)
          console.log(`\nSession archived to: ${QA_ARCHIVE_PATH}`)
        }
        return
      }
      try {
        const answer = await askQuestion(q, briefing, context, history)
        console.log(`\nAnalyst: ${answer}\n`)
        history.push({ role: 'user',      content: q })
        history.push({ role: 'assistant', content: answer })
        exchanges.push({ question: q, answer })
      } catch (err) {
        console.error('Error:', err)
      }
      prompt()
    })
  }
  prompt()
}

if (question) {
  runSingle().catch(err => { console.error(err); process.exit(1) })
} else {
  runLoop().catch(err => { console.error(err); process.exit(1) })
}
