// Loader contract for /studio/dashboard — Creator Studio growth analytics.
//
// Source: unified-platform's own Prisma DB (src/generated/prisma via
// @/lib/studio/db) — models GrowthSnapshot, Video, Session. No investment-
// pipeline envelopes here.
//
// Real field mapping (all three tables are EMPTY in production today —
// the empty branch in page.tsx is what renders first):
//
//   snapshots[]   ← prisma.growthSnapshot.findMany({ orderBy: { date: 'asc' } })
//                   .date → ISO string, .followers, .profileViews, .source
//   videos[]      ← prisma.video.findMany({ orderBy: { views: 'desc' } })
//                   .title, .topicType, .postedAt (nullable!), .views,
//                   .likes, .comments, .shares
//   sessionCount  ← prisma.session.count()
//
// Derived in page.tsx (same formulas as the legacy dashboard):
//   engagement    = (likes + comments + shares) / views      — per video & overall
//   followerDelta = last snapshot − snapshot ≥7 days earlier — needs ≥2 rows
//   viewsByTopic  = group videos by topicType, sum views     — derive labels
//                   from data, never a hardcoded topic list
//
// GrowthSnapshot is the only genuine time series — Video counters are
// lifetime totals per clip, so only Followers gets a line/sparkline.

export interface GrowthPoint {
  date: string // ISO — GrowthSnapshot.date
  followers: number
  profileViews: number
  source: 'api' | 'manual' | 'screenshot' | string
}

export interface VideoRow {
  id: string
  title: string
  topicType: string // free-form; 'ai-news' | 'personal-story' | 'workforce' seen so far
  postedAt: string | null // null = logged but not posted yet
  views: number
  likes: number
  comments: number
  shares: number
}

export interface StudioDashboardVM {
  generatedAt: string
  snapshots: GrowthPoint[]
  videos: VideoRow[]
  sessionCount: number
}

/** Flip to preview the production-day-one state (all tables empty). */
export const SHOW_EMPTY = false

export async function loadStudioDashboard(): Promise<StudioDashboardVM> {
  if (SHOW_EMPTY) {
    return { generatedAt: new Date().toISOString(), snapshots: [], videos: [], sessionCount: 0 }
  }
  return {
    generatedAt: '2026-07-07T09:10:00+07:00',
    // 14 manual snapshots — realistic for a just-started account
    snapshots: [
      { date: '2026-06-24', followers: 128, profileViews: 210, source: 'manual' },
      { date: '2026-06-25', followers: 131, profileViews: 188, source: 'manual' },
      { date: '2026-06-26', followers: 133, profileViews: 240, source: 'manual' },
      { date: '2026-06-27', followers: 139, profileViews: 305, source: 'manual' },
      { date: '2026-06-28', followers: 152, profileViews: 640, source: 'manual' },
      { date: '2026-06-29', followers: 158, profileViews: 410, source: 'manual' },
      { date: '2026-06-30', followers: 171, profileViews: 980, source: 'manual' },
      { date: '2026-07-01', followers: 186, profileViews: 760, source: 'manual' },
      { date: '2026-07-02', followers: 190, profileViews: 350, source: 'manual' },
      { date: '2026-07-03', followers: 197, profileViews: 520, source: 'manual' },
      { date: '2026-07-04', followers: 201, profileViews: 290, source: 'manual' },
      { date: '2026-07-05', followers: 204, profileViews: 260, source: 'manual' },
      { date: '2026-07-06', followers: 209, profileViews: 330, source: 'manual' },
      { date: '2026-07-07', followers: 214, profileViews: 285, source: 'manual' },
    ],
    videos: [
      { id: 'v1', title: 'One FX bug inflated my net worth 7x', topicType: 'personal-story', postedAt: '2026-06-30', views: 5240, likes: 412, comments: 38, shares: 51 },
      { id: 'v2', title: 'What a wash-sale is (and how it bit me)', topicType: 'ai-news', postedAt: '2026-07-03', views: 1810, likes: 96, comments: 12, shares: 9 },
      { id: 'v3', title: 'My AI reads 70 world events before breakfast', topicType: 'ai-news', postedAt: '2026-06-26', views: 940, likes: 61, comments: 7, shares: 4 },
      { id: 'v4', title: 'Will AI take the analyst jobs first?', topicType: 'workforce', postedAt: '2026-06-24', views: 420, likes: 18, comments: 3, shares: 1 },
      { id: 'v5', title: 'Bangkok desk tour: trading on a Mac Mini', topicType: 'personal-story', postedAt: null, views: 0, likes: 0, comments: 0, shares: 0 },
    ],
    sessionCount: 6,
  }
}
