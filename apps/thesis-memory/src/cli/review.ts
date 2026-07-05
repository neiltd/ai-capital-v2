// src/cli/review.ts
import 'dotenv/config'
import { join } from 'path'
import * as readline from 'readline'
import { createThesisStore } from '../store/thesis-store.js'
import { applyApprovedChanges } from '../thesis/updater.js'

const DATA_DIR = join(process.cwd(), 'data')

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

async function main() {
  const store = createThesisStore(join(DATA_DIR, 'thesis.db'))
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    const proposals = await store.getPendingProposals()

    if (proposals.length === 0) {
      console.log('\nNo pending proposals. Run: npm run update')
      return
    }

    console.log(`\n=== Pending Proposals (${proposals.length}) ===`)

    for (let pi = 0; pi < proposals.length; pi++) {
      const proposal = proposals[pi]
      const allTheses = await store.listTheses()
      const thesis = allTheses.find(t => t.id === proposal.thesisId)
      const ticker = thesis?.ticker ?? proposal.thesisId
      const changes = await store.getProposalChanges(proposal.id)

      console.log(`\n[${pi + 1}/${proposals.length}] ${ticker} — generated ${proposal.createdAt.slice(0, 10)}\n`)

      const assumptionChanges = changes.filter(c => c.changeType === 'assumption_status')
      const narrativeChange = changes.find(c => c.changeType === 'narrative')
      const actionChange = changes.find(c => c.changeType === 'portfolio_action')

      if (assumptionChanges.length > 0) {
        console.log('  Assumption changes:')
        const assumptions = thesis ? await store.getAssumptions(thesis.id) : []
        assumptionChanges.forEach((c, i) => {
          const assumption = assumptions.find(a => a.id === c.assumptionId)
          const label = assumption?.label ?? c.assumptionId ?? 'unknown'
          console.log(`  [${i + 1}] "${label}"`)
          console.log(`      ${c.oldValue} → ${c.newValue.toUpperCase()}`)
          console.log(`      Reason: ${c.reasoning}`)
          if (c.evidenceQuotes.length > 0) {
            console.log(`      Evidence: "${c.evidenceQuotes[0].slice(0, 120)}"`)
          }
        })
      }

      if (narrativeChange) {
        console.log('\n  Narrative update:')
        console.log(`    OLD: ${narrativeChange.oldValue.slice(0, 100)}...`)
        console.log(`    NEW: ${narrativeChange.newValue.slice(0, 100)}...`)
      }

      if (actionChange) {
        const action = JSON.parse(actionChange.newValue) as { action: string; reasoning: string; conviction: number }
        console.log(`\n  Portfolio action (suggestion): ${action.action.toUpperCase()} — ${action.reasoning} (conviction: ${action.conviction}/10)`)
      }

      console.log('\n  [a] Approve all  [r] Reject all  [s] Skip  [q] Quit')
      const answer = (await prompt(rl, '  > ')).trim().toLowerCase()

      if (answer === 'q') break
      if (answer === 's') continue

      const approveAll = answer === 'a'

      for (const change of changes) {
        await store.approveProposalChange(change.id, approveAll)
      }

      if (approveAll) {
        await applyApprovedChanges(proposal.id, store)
        await store.updateProposalStatus(proposal.id, 'approved')
        console.log(`  ✓ Changes applied to ${ticker} thesis.`)
      } else {
        await store.updateProposalStatus(proposal.id, 'rejected')
        console.log(`  ✗ Proposal rejected.`)
      }
    }

    console.log('\nReview complete.')
  } finally {
    rl.close()
    await store.close()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
