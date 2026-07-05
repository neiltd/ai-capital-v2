interface Video {
  id: string
  title: string
  views: number
  likes: number
  comments: number
  shares: number
  topicType: string
}

export function TopVideosTable({ videos }: { videos: Video[] }) {
  return (
    <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
      <p className="text-xs text-zinc-400 mb-3">Top Videos</p>
      <div className="space-y-3">
        {videos.map(v => (
          <div key={v.id} className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm truncate">{v.title}</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {v.views.toLocaleString()} views · {v.likes} likes · {v.comments} comments
              </p>
            </div>
            <span className="text-xs bg-zinc-800 px-2 py-0.5 rounded-full whitespace-nowrap">
              {v.topicType}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
