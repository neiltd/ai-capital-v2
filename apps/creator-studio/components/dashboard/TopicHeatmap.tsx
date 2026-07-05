const TOPIC_TYPES = ['ai-news', 'personal-story', 'workforce']
const LABELS: Record<string, string> = {
  'ai-news': 'AI News',
  'personal-story': 'Personal Story',
  'workforce': 'Workforce',
}

interface VideoStat {
  topicType: string
  views: number
}

export function TopicHeatmap({ videos }: { videos: VideoStat[] }) {
  const stats = TOPIC_TYPES.map(type => {
    const matching = videos.filter(v => v.topicType === type)
    const avgViews =
      matching.length > 0
        ? Math.round(matching.reduce((s, v) => s + v.views, 0) / matching.length)
        : 0
    return { type, avgViews, count: matching.length }
  })

  const maxAvg = Math.max(...stats.map(s => s.avgViews), 1)

  return (
    <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
      <p className="text-xs text-zinc-400 mb-3">Topic Performance</p>
      <div className="space-y-3">
        {stats.map(s => (
          <div key={s.type}>
            <div className="flex justify-between text-xs mb-1">
              <span>{LABELS[s.type]}</span>
              <span className="text-zinc-400">{s.avgViews.toLocaleString()} avg views</span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-600 rounded-full transition-all"
                style={{ width: `${(s.avgViews / maxAvg) * 100}%` }}
              />
            </div>
            <p className="text-xs text-zinc-600 mt-0.5">{s.count} video{s.count !== 1 ? 's' : ''}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
