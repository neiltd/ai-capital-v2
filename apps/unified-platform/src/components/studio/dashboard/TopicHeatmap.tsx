import { Card, CardHeader } from '@/components/capital/ui/Card'
import { EmptyState } from '@/components/capital/ui/EmptyState'

const LABELS: Record<string, string> = {
  'ai-news': 'AI News',
  'personal-story': 'Personal Story',
  'workforce': 'Workforce',
}

function labelFor(type: string) {
  return LABELS[type] ?? type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

interface VideoStat {
  topicType: string
  views: number
}

/**
 * Views by Topic — total views per topicType, bar width proportional to
 * that topic's share of all logged views. Topics are derived from the
 * actual data (not a hardcoded list) so any topicType value renders.
 */
export function TopicHeatmap({ videos }: { videos: VideoStat[] }) {
  const totalViews = videos.reduce((s, v) => s + v.views, 0)

  const byTopic = new Map<string, { views: number; count: number }>()
  for (const v of videos) {
    const entry = byTopic.get(v.topicType) ?? { views: 0, count: 0 }
    entry.views += v.views
    entry.count += 1
    byTopic.set(v.topicType, entry)
  }

  const stats = Array.from(byTopic.entries())
    .map(([type, { views, count }]) => ({
      type,
      views,
      count,
      pct: totalViews > 0 ? (views / totalViews) * 100 : 0,
    }))
    .sort((a, b) => b.views - a.views)

  return (
    <Card>
      <CardHeader
        title="Views by Topic"
        meta={totalViews > 0 ? `${totalViews.toLocaleString()} total views` : undefined}
      />
      <div className="p-4">
        {stats.length === 0 ? (
          <EmptyState
            icon="📊"
            title="No videos logged yet"
            description="Log a video to see the views-by-topic breakdown."
          />
        ) : (
          <div className="space-y-3">
            {stats.map(s => (
              <div key={s.type}>
                <div className="flex justify-between text-xs mb-1 text-text-secondary">
                  <span>{labelFor(s.type)}</span>
                  <span className="text-text-muted tabular-nums">
                    {s.views.toLocaleString()} · {s.pct.toFixed(1)}%
                  </span>
                </div>
                <div className="h-2 bg-bg-elevated rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent-primary rounded-full transition-all"
                    style={{ width: `${s.pct}%` }}
                  />
                </div>
                <p className="text-xs text-text-faint mt-0.5">{s.count} video{s.count !== 1 ? 's' : ''}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}
