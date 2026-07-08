// Loader for /studio/archive. Real Prisma reads (no fetch — server
// component), per docs/frontend-migration-plan-2026-07-07.md §1.5.
//
// storyArc/notes come back null on most real rows — the chat save endpoint
// only sends { topic, visuals } today (backend gap, see studio-v2/README.md
// #2). video is joined app-side: Session.videoId has no Prisma @relation to
// Video (studio-v2/README.md #3), so it's null unless the session's videoId
// resolves to a real row.

import { prisma } from '@/lib/studio/db'

export interface ArchiveTopic {
  eventId?: string
  title: string
  summary: string
  suggestedAngle: string
  suggestedVisualType: string
}

export interface ArchiveStoryArc {
  hook: string
  beats: string[]
  personalAngle: string
  cta: string
}

export interface ArchiveVisual {
  type: string
  label: string
  url?: string
}

export interface ArchiveSession {
  id: string
  createdAt: string
  topic: ArchiveTopic
  storyArc: ArchiveStoryArc | null
  visuals: ArchiveVisual[]
  notes: string | null
  video: { id: string; title: string; postedAt: string | null; views: number; likes: number } | null
}

export interface StudioArchiveVM {
  generatedAt: string
  sessions: ArchiveSession[]
}

function safeParseTopic(raw: string): ArchiveTopic {
  try {
    const t = JSON.parse(raw) as Partial<ArchiveTopic>
    return {
      eventId: t.eventId,
      title: t.title ?? 'Untitled',
      summary: t.summary ?? '',
      suggestedAngle: t.suggestedAngle ?? '',
      suggestedVisualType: t.suggestedVisualType ?? 'card',
    }
  } catch {
    return { title: 'Untitled', summary: '', suggestedAngle: '', suggestedVisualType: 'card' }
  }
}

function safeParseStoryArc(raw: string | null): ArchiveStoryArc | null {
  if (!raw) return null
  try {
    const a = JSON.parse(raw) as Partial<ArchiveStoryArc>
    if (!a.hook) return null
    return { hook: a.hook, beats: a.beats ?? [], personalAngle: a.personalAngle ?? '', cta: a.cta ?? '' }
  } catch {
    return null
  }
}

function safeParseVisuals(raw: string): ArchiveVisual[] {
  try {
    const v = JSON.parse(raw) as ArchiveVisual[]
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export async function loadStudioArchive(): Promise<StudioArchiveVM | null> {
  try {
    const sessions = await prisma.session.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })

    const videoIds = sessions.map((s) => s.videoId).filter((id): id is string => id != null)
    const videos = videoIds.length > 0
      ? await prisma.video.findMany({ where: { id: { in: videoIds } } })
      : []
    const videoById = new Map(videos.map((v) => [v.id, v]))

    return {
      generatedAt: new Date().toISOString(),
      sessions: sessions.map((s) => {
        const video = s.videoId ? videoById.get(s.videoId) : null
        return {
          id: s.id,
          createdAt: s.createdAt.toISOString(),
          topic: safeParseTopic(s.topic),
          storyArc: safeParseStoryArc(s.storyArc),
          visuals: safeParseVisuals(s.visuals),
          notes: s.notes,
          video: video
            ? { id: video.id, title: video.title, postedAt: video.postedAt?.toISOString().slice(0, 10) ?? null, views: video.views, likes: video.likes }
            : null,
        }
      }),
    }
  } catch {
    return null
  }
}
