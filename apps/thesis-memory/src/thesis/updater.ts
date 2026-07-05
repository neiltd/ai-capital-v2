// src/thesis/updater.ts
import { randomUUID } from 'crypto'
import type { ThesisStore } from '../store/thesis-store.js'
import type { AssumptionStatus } from '../types.js'

export async function applyApprovedChanges(proposalId: string, store: ThesisStore): Promise<void> {
  const changes = await store.getProposalChanges(proposalId)
  const proposal = await store.getProposal(proposalId)
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`)

  for (const change of changes) {
    if (!change.approved) continue

    if (change.changeType === 'assumption_status' && change.assumptionId) {
      await store.updateAssumptionStatus(
        change.assumptionId,
        change.newValue as AssumptionStatus,
        change.reasoning
      )
    }

    if (change.changeType === 'narrative') {
      const current = await store.getCurrentNarrative(proposal.thesisId)
      const nextVersion = (current?.version ?? 0) + 1
      await store.createNarrative({
        id: randomUUID(),
        thesisId: proposal.thesisId,
        content: change.newValue,
        version: nextVersion,
        createdAt: new Date().toISOString(),
      })
    }
  }

  await store.updateThesisUpdatedAt(proposal.thesisId, new Date().toISOString())
}
