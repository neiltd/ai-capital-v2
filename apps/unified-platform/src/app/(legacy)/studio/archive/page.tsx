import { prisma } from '@/lib/studio/db'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { PageHeader, MetaDot } from '@/components/capital/ui/PageHeader'
import { Card } from '@/components/capital/ui/Card'
import { EmptyState } from '@/components/capital/ui/EmptyState'
import { Badge } from '@/components/capital/ui/Badge'

export const dynamic = 'force-dynamic'

export default async function ArchivePage() {
  let sessions: Awaited<ReturnType<typeof prisma.session.findMany>> = []
  let dbError: string | null = null

  try {
    sessions = await prisma.session.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  } catch (err: unknown) {
    dbError = err instanceof Error ? err.message : 'Database unavailable'
  }

  const parsed = sessions.map(s => ({
    ...s,
    topic: JSON.parse(s.topic) as { title: string; suggestedAngle: string },
    storyArc: s.storyArc ? JSON.parse(s.storyArc) as { hook: string; beats: string[]; personalAngle: string; cta: string } : null,
    visuals: JSON.parse(s.visuals) as { type: string; label: string }[],
  }))

  return (
    <div className="min-h-screen bg-bg-base text-text-primary px-4 py-8 max-w-2xl mx-auto">
      <PageHeader
        title="Archive"
        meta={
          <>
            <span>{parsed.length} session{parsed.length === 1 ? '' : 's'} saved</span>
            <MetaDot />
            <Link href="/" className="hover:text-text-secondary">← Back</Link>
          </>
        }
      />

      {dbError && (
        <div className="mb-6">
          <EmptyState
            tone="warning"
            title="Database not configured"
            description={
              <>
                Run <code className="font-mono text-indigo-active">npx prisma migrate dev</code> and set{' '}
                <code className="font-mono text-indigo-active">DATABASE_URL</code> to enable persistence.
              </>
            }
          />
        </div>
      )}

      {!dbError && parsed.length === 0 && (
        <EmptyState
          tone="neutral"
          title="No sessions saved yet"
          description="Chat with your topic and hit Save."
        />
      )}

      <ul className="space-y-4">
        {parsed.map(s => (
          <li key={s.id}>
            <Card padded>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-snug text-text-primary">{s.topic.title}</p>
                  <p className="text-xs text-text-muted mt-1">{s.topic.suggestedAngle}</p>
                </div>
                <span className="text-xs text-text-faint shrink-0">
                  {formatDistanceToNow(new Date(s.createdAt), { addSuffix: true })}
                </span>
              </div>

              {s.storyArc && (
                <div className="mt-3 border-t border-border-subtle pt-3 space-y-1">
                  <p className="text-xs text-indigo-active font-medium">Hook</p>
                  <p className="text-xs text-text-secondary">{s.storyArc.hook}</p>
                </div>
              )}

              {s.visuals.length > 0 && (
                <div className="mt-3 flex gap-2 flex-wrap">
                  {s.visuals.map((v, i) => (
                    <Badge key={i} tone="neutral" className="capitalize">
                      {v.type} · {v.label}
                    </Badge>
                  ))}
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  )
}
