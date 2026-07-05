import { prisma } from '@/lib/db'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'

export const dynamic = 'force-dynamic'

export default async function ArchivePage() {
  const sessions = await prisma.session.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  const parsed = sessions.map(s => ({
    ...s,
    topic: JSON.parse(s.topic) as { title: string; suggestedAngle: string },
    storyArc: s.storyArc ? JSON.parse(s.storyArc) as { hook: string; beats: string[]; personalAngle: string; cta: string } : null,
    visuals: JSON.parse(s.visuals) as { type: string; label: string }[],
  }))

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 px-4 py-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-lg font-semibold">Archive</h1>
        <Link href="/" className="text-xs text-zinc-500 hover:text-zinc-300">← Back</Link>
      </div>

      {parsed.length === 0 && (
        <p className="text-sm text-zinc-500">No sessions saved yet. Chat with your topic and hit Save.</p>
      )}

      <ul className="space-y-4">
        {parsed.map(s => (
          <li key={s.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium leading-snug">{s.topic.title}</p>
                <p className="text-xs text-zinc-500 mt-1">{s.topic.suggestedAngle}</p>
              </div>
              <span className="text-xs text-zinc-600 shrink-0">
                {formatDistanceToNow(new Date(s.createdAt), { addSuffix: true })}
              </span>
            </div>

            {s.storyArc && (
              <div className="mt-3 border-t border-zinc-800 pt-3 space-y-1">
                <p className="text-xs text-indigo-400 font-medium">Hook</p>
                <p className="text-xs text-zinc-300">{s.storyArc.hook}</p>
              </div>
            )}

            {s.visuals.length > 0 && (
              <div className="mt-3 flex gap-2 flex-wrap">
                {s.visuals.map((v, i) => (
                  <span key={i} className="text-[10px] bg-zinc-800 text-zinc-400 rounded px-2 py-0.5 capitalize">
                    {v.type} · {v.label}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
