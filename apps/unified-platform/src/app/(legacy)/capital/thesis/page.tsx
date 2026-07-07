export const dynamic = 'force-dynamic'

import type { ThesisRow, AssumptionRow } from '@/lib/thesis-db'
import { readTheses } from '@/lib/thesis-db'
import { ThesisProposals } from '@/components/capital/ThesisProposals'
import { PageHeader, MetaDot } from '@/components/capital/ui/PageHeader'
import { Card } from '@/components/capital/ui/Card'
import { EmptyState } from '@/components/capital/ui/EmptyState'
import { Badge, type BadgeTone } from '@/components/capital/ui/Badge'

const STATUS_TONE: Record<string, BadgeTone> = {
  strengthening: 'success',
  stable:        'neutral',
  weakening:     'warning',
  broken:        'danger',
}

const STATUS_DOT: Record<string, string> = {
  strengthening: 'bg-green-signal',
  stable:        'bg-text-muted',
  weakening:     'bg-amber-signal',
  broken:        'bg-red-signal',
}

export default function ThesisPage() {
  let data: { theses: ThesisRow[]; assumptions: AssumptionRow[] } | null = null
  let error: string | null = null

  try {
    data = readTheses()
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to load thesis data'
  }

  if (error || !data) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Thesis Memory" subtitle="Active investment theses and tracked assumptions" />
        <EmptyState
          tone="error"
          title="No thesis data"
          description={error ?? 'Could not load thesis database.'}
          hint={<>Run <code className="font-mono text-indigo-active">npm run thesis</code> in thesis-memory.</>}
        />
      </div>
    )
  }

  const assumptionsByThesis = data.assumptions.reduce<Record<string, AssumptionRow[]>>((acc, a) => {
    ;(acc[a.thesisId] ??= []).push(a)
    return acc
  }, {})

  const totalAssumptions = data.assumptions.length
  const strengthening = data.assumptions.filter(a => a.status === 'strengthening').length
  const weakening = data.assumptions.filter(a => a.status === 'weakening' || a.status === 'broken').length

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Thesis Memory"
        subtitle="Active investment theses and tracked assumptions"
        meta={
          <>
            <span>{data.theses.length} thesis{data.theses.length === 1 ? '' : 'es'}</span>
            <MetaDot />
            <span>{totalAssumptions} assumption{totalAssumptions === 1 ? '' : 's'}</span>
            {strengthening > 0 && <><MetaDot /><span className="text-green-signal">{strengthening} strengthening</span></>}
            {weakening > 0 && <><MetaDot /><span className="text-amber-signal">{weakening} weakening</span></>}
          </>
        }
      />

      {data.theses.length > 0 && <ThesisProposals />}

      {data.theses.length === 0 && (
        <EmptyState
          icon="🧠"
          title="No theses yet"
          description="Build your first thesis to start tracking key assumptions and evidence."
          hint={<>Run <code className="font-mono text-indigo-active">npm run thesis</code> in thesis-memory.</>}
        />
      )}

      <div className="space-y-4">
        {data.theses.map(thesis => {
          const assumptions = assumptionsByThesis[thesis.id] ?? []
          return (
            <Card key={thesis.id}>
              <div className="px-4 py-3 border-b border-border-subtle bg-bg-subtle/40">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-[15px] font-bold text-indigo-active tracking-tight">{thesis.ticker}</span>
                  <Badge tone="neutral" size="xs" uppercase>{thesis.type}</Badge>
                  <Badge tone="accent" size="xs" uppercase>{thesis.positionSize}</Badge>
                  <span className="ml-auto text-[10px] text-text-inactive tabular-nums">
                    {thesis.updatedAt.slice(0, 10)}
                  </span>
                </div>
              </div>
              <div className="p-4">
                {assumptions.length === 0 ? (
                  <p className="text-[11px] text-text-faint">No assumptions recorded.</p>
                ) : (
                  <div className="space-y-2.5">
                    {assumptions.map(a => (
                      <div key={a.id} className="flex gap-3 items-start">
                        <span className={`flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full ${STATUS_DOT[a.status] ?? 'bg-text-muted'}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge tone={STATUS_TONE[a.status] ?? 'neutral'} size="xs" uppercase>
                              {a.status}
                            </Badge>
                            <span className="text-[12px] text-text-secondary leading-snug">{a.label}</span>
                          </div>
                          {a.lastEvidenceSummary && (
                            <p className="text-[11px] text-text-muted mt-1 leading-relaxed">{a.lastEvidenceSummary}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
