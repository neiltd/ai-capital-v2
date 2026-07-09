// Loader contract for /studio/archive — session history.
//
// Source: prisma.session.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })
// with the three JSON string columns parsed:
//
//   topic     ← JSON.parse(Session.topic)
//               { eventId, title, summary, suggestedAngle, suggestedVisualType }
//   storyArc  ← Session.storyArc ? JSON.parse(...) : null
//               { hook, beats: string[], personalAngle, cta }
//   visuals   ← JSON.parse(Session.visuals)  — [{ type, url?, label }]
//   notes     ← Session.notes (nullable)
//   video     ← Session.videoId ? prisma.video.findUnique({ where: { id: videoId } }) : null
//               (join done app-side; there is no Prisma relation between
//               Session.videoId and Video — see README gap #3)
//
// Production has ZERO sessions today — the empty branch renders first.
//
// GAPS surfaced here (details in ../README.md):
// - storyArc is never written by the current chat save endpoint (topic +
//   visuals only), so expect storyArc = null on real rows until that's fixed.
// - The chat transcript is not persisted at all — the archive can show what
//   a session PRODUCED (topic/arc/visuals/notes), not the conversation.

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
  type: 'chart' | 'card' | 'illustration' | string
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
  /** Joined via Session.videoId — null when the idea was never filmed. */
  video: { id: string; title: string; postedAt: string | null; views: number; likes: number } | null
}

export interface StudioArchiveVM {
  generatedAt: string
  sessions: ArchiveSession[]
}

/** Flip to preview the production-day-one state (zero sessions). */
export const SHOW_EMPTY = false

export async function loadStudioArchive(): Promise<StudioArchiveVM> {
  if (SHOW_EMPTY) return { generatedAt: new Date().toISOString(), sessions: [] }
  return {
    generatedAt: '2026-07-07T09:10:00+07:00',
    sessions: [
      {
        id: 's6',
        createdAt: '2026-07-06T08:42:00+07:00',
        topic: {
          eventId: 'gdelt-2026-07-05-1182',
          title: 'EU AI Act enforcement hits first US model provider',
          summary: 'Brussels opened its first formal enforcement action against a US frontier-model provider over transparency obligations, with fines up to 3% of global revenue on the table.',
          suggestedAngle: 'What this means for the AI tools you already use daily',
          suggestedVisualType: 'chart',
        },
        storyArc: {
          hook: 'The EU just fined the AI you talked to this morning.',
          beats: [
            'What the AI Act actually requires (30-second version)',
            'Why a US company is first in the crosshairs',
            'The compliance cost cascade — who ends up paying',
          ],
          personalAngle: 'My own pipeline runs on these models — here is my exposure',
          cta: 'Follow for the ruling breakdown when it lands',
        },
        visuals: [
          { type: 'chart', label: 'Fine ceiling vs. annual revenue, top 5 providers' },
          { type: 'card', label: 'AI Act obligations checklist' },
        ],
        notes: 'Film before the appeal window closes — topical decay ~1 week.',
        video: null,
      },
      {
        id: 's5',
        createdAt: '2026-07-03T09:05:00+07:00',
        topic: {
          eventId: 'gdelt-2026-07-02-0847',
          title: 'IRS wash-sale rules and automated trading',
          summary: 'Retail brokers flag a spike in wash-sale violations as bot-driven retail trading grows; the IRS reiterated guidance.',
          suggestedAngle: 'The rule my own trading bot now checks before every order',
          suggestedVisualType: 'card',
        },
        storyArc: {
          hook: 'The IRS rule my bot broke before I taught it better.',
          beats: ['What a wash-sale is in one sentence', 'How my bot tripped it', 'The 3-line check that fixed it'],
          personalAngle: 'Real loss from my own account, real fix in my own code',
          cta: 'Comment BOT for the checklist',
        },
        visuals: [{ type: 'card', label: '30-day wash-sale window diagram' }],
        notes: null,
        video: { id: 'v2', title: 'What a wash-sale is (and how it bit me)', postedAt: '2026-07-03', views: 1810, likes: 96 },
      },
      {
        id: 's4',
        createdAt: '2026-06-29T08:57:00+07:00',
        topic: {
          eventId: 'acled-2026-06-28-0231',
          title: 'Strait of Hormuz insurance premiums triple',
          summary: 'War-risk premiums for tankers transiting Hormuz tripled week-over-week after drone incidents, feeding directly into Asian energy import costs.',
          suggestedAngle: 'How a strait you cannot find on a map sets your electricity bill',
          suggestedVisualType: 'illustration',
        },
        storyArc: null, // arc never extracted — the common case today (README gap #2)
        visuals: [],
        notes: 'Went with the FX-bug story instead this week.',
        video: null,
      },
      {
        id: 's3',
        createdAt: '2026-06-26T09:20:00+07:00',
        topic: {
          eventId: 'worldbank-2026-06-25-0012',
          title: 'AI capex now exceeds global telecom buildout peak',
          summary: 'Combined hyperscaler AI capital expenditure passed the inflation-adjusted peak of the 2000 telecom buildout, per new World Bank infrastructure data.',
          suggestedAngle: 'My AI reads 70 world events before breakfast — this one made it blink',
          suggestedVisualType: 'chart',
        },
        storyArc: {
          hook: 'POV: your portfolio has its own intelligence agency.',
          beats: ['The pipeline in 15 seconds', 'The one number that stopped it today', 'Bubble or buildout — the 2000 comparison'],
          personalAngle: 'Screen recording of my actual morning briefing',
          cta: 'Follow for tomorrow’s briefing',
        },
        visuals: [
          { type: 'chart', label: 'AI capex vs. 2000 telecom buildout (inflation-adjusted)' },
          { type: 'illustration', label: 'Pipeline DAG hero shot' },
        ],
        notes: null,
        video: { id: 'v3', title: 'My AI reads 70 world events before breakfast', postedAt: '2026-06-26', views: 940, likes: 61 },
      },
    ],
  }
}
