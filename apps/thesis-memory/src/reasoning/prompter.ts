// src/reasoning/prompter.ts
import type { Thesis, Assumption, Narrative, EvidenceChunk } from '../types.js'

export function buildPrompt(
  thesis: Thesis,
  assumptions: Assumption[],
  narrative: Narrative,
  chunks: EvidenceChunk[],
  lastUpdated: string
): string {
  const today = new Date().toISOString().slice(0, 10)

  const assumptionLines = assumptions
    .map(a => `  [${a.status}]  ${a.label}`)
    .join('\n')

  const chunkLines = chunks
    .map(c => `[${c.source} ${c.publishedDate}, ${c.section}]\n"${c.content.slice(0, 500)}"`)
    .join('\n\n')

  return `You are analyzing whether new evidence changes an investment thesis.

CURRENT THESIS: ${thesis.ticker} (as of ${lastUpdated})
Position size: ${thesis.positionSize}

Narrative:
${narrative.content}

Assumptions:
${assumptionLines}

NEW EVIDENCE (${lastUpdated} → ${today}):
${chunkLines}

Analyze each assumption. For each one, determine whether the new evidence:
- STRENGTHENS it (more confidence it will hold)
- WEAKENS it (less confidence, but thesis still intact)
- BREAKS it (assumption is no longer valid)
- Leaves it UNCHANGED (no relevant evidence)

Only include assumptions where the status should CHANGE. Do not include unchanged assumptions.

Then propose an updated narrative reflecting the new evidence. Keep the narrative concise (2-4 sentences).

If conviction has shifted significantly (multiple assumptions changed, or a core assumption broke), suggest a portfolio action.

Use the propose_thesis_update tool to respond.`
}
