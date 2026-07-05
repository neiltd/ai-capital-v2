export const dynamic = 'force-dynamic'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { RegimeBadge } from '@/components/capital/RegimeBadge'
import { ScenarioSummaryPills } from '@/components/capital/ScenarioSummaryPills'
import type { BriefingResponse } from '@/types'
import { readAnalysis, readBriefing, readSimulation } from '@/lib/data'
import { PageHeader, MetaDot } from '@/components/capital/ui/PageHeader'
import { EmptyState } from '@/components/capital/ui/EmptyState'

function getBriefingData(): BriefingResponse {
  const today = new Date().toISOString().split('T')[0]
  try {
    const analysis = readAnalysis()
    const simulation = readSimulation()
    const markdown = readBriefing(today)

    if (!markdown) {
      return {
        date: today,
        markdown: '',
        regime: analysis.latestRegime.regime,
        confidence: analysis.latestRegime.confidence,
        scenarios: simulation.scenarios.map(s => ({
          scenarioType: s.scenarioType,
          title: s.title,
          probability: s.probability,
          timeHorizon: s.timeHorizon,
        })),
        missing: true,
      }
    }

    return {
      date: today,
      markdown,
      regime: analysis.latestRegime.regime,
      confidence: analysis.latestRegime.confidence,
      scenarios: simulation.scenarios.map(s => ({
        scenarioType: s.scenarioType,
        title: s.title,
        probability: s.probability,
        timeHorizon: s.timeHorizon,
      })),
      missing: false,
    }
  } catch (err) {
    return { date: today, markdown: '', regime: '', confidence: '', scenarios: [], missing: true }
  }
}

export default async function BriefingPage() {
  let data: BriefingResponse
  let fetchError: string | null = null

  try {
    data = getBriefingData()
  } catch {
    fetchError = 'Could not load briefing data. Is DATA_ROOT set correctly?'
    data = { date: '', markdown: '', regime: '', confidence: '', scenarios: [], missing: true }
  }

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Investment Briefing"
        subtitle="Today's market regime, scenarios, and prepared narrative"
        meta={
          <>
            <span>{data.date || 'No date'}</span>
            {data.regime && <MetaDot />}
            {data.regime && <span>Regime: {data.regime}</span>}
          </>
        }
        actions={
          (data.regime || data.scenarios.length > 0) ? (
            <div className="flex flex-col items-end gap-2">
              {data.regime && <RegimeBadge regime={data.regime} confidence={data.confidence} />}
              {data.scenarios.length > 0 && <ScenarioSummaryPills scenarios={data.scenarios} />}
            </div>
          ) : null
        }
      />

      {fetchError && (
        <EmptyState
          tone="error"
          title="Could not load briefing"
          description={fetchError}
        />
      )}

      {data.missing && !fetchError && (
        <EmptyState
          icon="📋"
          title="No briefing for today"
          description="The daily briefing has not been generated yet."
          hint={
            <>
              Run <code className="font-mono text-indigo-active">npm run brief</code> in investment-analyst-agents
            </>
          }
        />
      )}

      {!data.missing && data.markdown && (
        <article className="bg-bg-card bg-gradient-card border border-border-subtle rounded-xl p-6 md:p-8 shadow-card prose-dark briefing-prose">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.markdown}</ReactMarkdown>
        </article>
      )}
    </div>
  )
}
