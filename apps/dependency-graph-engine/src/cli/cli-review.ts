import 'dotenv/config'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import { createGraphStore } from '../store/graph-store.js'
import type { Edge } from '../types.js'

const DATA_DIR = join(process.cwd(), 'data')

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

async function main() {
  const store = createGraphStore(join(DATA_DIR, 'graph.db'))
  const pending = await store.getPendingProposalEdges()

  if (pending.length === 0) {
    console.log('No pending proposals. Run npm run scan first.')
    await store.close()
    return
  }

  console.log(`\n${pending.length} pending proposal(s) to review\n`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let approved = 0
  let rejected = 0

  for (let i = 0; i < pending.length; i++) {
    const pe = pending[i]
    console.log(`\n[${i + 1}/${pending.length}] ${pe.from} → ${pe.to}  (${pe.type}, ${pe.strength})`)
    console.log(`Description: "${pe.description}"`)
    if (pe.evidenceQuote) console.log(`Evidence:    "${pe.evidenceQuote}"`)

    const answer = await prompt(rl, `\nApprove? [y/n/skip] `)

    if (answer.trim().toLowerCase() === 'y') {
      await store.resolveProposalEdge(pe.id, true)
      const now = new Date().toISOString()
      const edge: Edge = {
        id:             randomUUID(),
        from:           pe.from,
        to:             pe.to,
        type:           pe.type,
        strength:       pe.strength,
        description:    pe.description,
        status:         'confirmed',
        sourceChunkIds: [],
        evidenceQuote:  pe.evidenceQuote,
        createdAt:      now,
        updatedAt:      now,
      }
      await store.insertEdge(edge)
      console.log('  ✓ Approved and added to graph')
      approved++
    } else if (answer.trim().toLowerCase() === 'n') {
      await store.resolveProposalEdge(pe.id, false)
      console.log('  ✗ Rejected')
      rejected++
    } else {
      console.log('  → Skipped (will appear again next review)')
    }
  }

  rl.close()
  const skipped = pending.length - approved - rejected
  console.log(`\nDone: ${approved} approved, ${rejected} rejected, ${skipped} skipped`)
  await store.close()
}

main().catch(err => { console.error(err); process.exit(1) })
