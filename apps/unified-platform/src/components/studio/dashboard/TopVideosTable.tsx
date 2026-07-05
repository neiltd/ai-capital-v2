import { Card, CardHeader } from '@/components/capital/ui/Card'
import { Badge } from '@/components/capital/ui/Badge'

interface Video {
  id: string
  title: string
  views: number
  likes: number
  comments: number
  shares: number
  topicType: string
}

/** Engagement rate = (likes + comments + shares) / views. Null when views is 0. */
function engagementRate(v: Video): number | null {
  if (v.views <= 0) return null
  return ((v.likes + v.comments + v.shares) / v.views) * 100
}

export function TopVideosTable({ videos }: { videos: Video[] }) {
  return (
    <Card>
      <CardHeader title="Top Videos" />
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-bg-subtle border-b border-border-subtle">
              {['Title', 'Views', 'Likes', 'Comments', 'ER%', 'Topic'].map((h, i) => (
                <th
                  key={h}
                  className={`text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive px-4 py-2.5 ${
                    i === 0 ? 'text-left' : 'text-right'
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {videos.map((v, idx) => {
              const er = engagementRate(v)
              return (
                <tr
                  key={v.id}
                  className={`border-b border-border-subtle last:border-0 hover:bg-bg-card-hover/40 transition-colors ${
                    idx % 2 === 1 ? 'bg-bg-row-alt/30' : ''
                  }`}
                >
                  <td className="px-4 py-3 text-[13px] text-text-primary truncate max-w-[220px]">{v.title}</td>
                  <td className="px-4 py-3 text-[12px] text-text-secondary tabular-nums text-right">
                    {v.views.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-text-secondary tabular-nums text-right">
                    {v.likes.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-text-secondary tabular-nums text-right">
                    {v.comments.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-text-secondary tabular-nums text-right">
                    {er == null ? '—' : `${er.toFixed(1)}%`}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Badge tone="neutral" size="xs">{v.topicType}</Badge>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
