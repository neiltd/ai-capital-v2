import type { DiscoveryExportCandidate } from '@/types'

interface Props {
  candidate: DiscoveryExportCandidate
}

export function DiscoveryCandidateRow({ candidate }: Props) {
  const scoreCls = candidate.score >= 80
    ? 'bg-green-signal/10 text-green-signal'
    : 'bg-amber-signal/10 text-amber-signal'

  const isBuy = candidate.action === 'buy'
  const actionCls = isBuy
    ? 'bg-green-signal/10 text-green-signal border border-green-signal/20'
    : 'bg-border-subtle text-text-muted border border-border-subtle'
  const actionLabel = isBuy ? '→ position' : '→ watch'

  const isNews = candidate.source === 'news_mention'
  const sourceCls = isNews
    ? 'bg-accent-primary/10 text-indigo-active border border-accent-primary/20'
    : 'bg-border-subtle text-text-muted border border-border-subtle'
  const sourceLabel = isNews ? 'news' : 'tracked'

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-bg-sidebar/40 transition-colors">
      {/* Ticker + source */}
      <div className="flex items-center gap-2 w-36 flex-shrink-0">
        <span className="text-xs font-semibold text-indigo-active w-12">{candidate.ticker}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${sourceCls}`}>{sourceLabel}</span>
      </div>

      {/* Rationale */}
      <div className="flex-1 text-[11px] text-text-muted truncate min-w-0">
        {candidate.rationale}
      </div>

      {/* Score + action */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${scoreCls}`}>
          {candidate.score}
        </span>
        <span className={`text-[10px] font-medium px-2 py-0.5 rounded ${actionCls}`}>
          {actionLabel}
        </span>
      </div>
    </div>
  )
}
