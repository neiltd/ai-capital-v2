// Loader contract for /studio — Creator Studio pipeline board.
//
// Source: apps/creator-studio's own Prisma DB (separate deploy target, ZERO
// coupling to the investment pipeline — no envelope reads here, ever).
// GAP #26: schema needs a board `status` column, post-performance entries
// (manual first, TikTok API later), and media attachments.

export type Stage = 'idea' | 'scripted' | 'filmed' | 'edited' | 'posted'
export type Platform = 'tiktok' | 'reels' | 'shorts'

export interface StudioCard {
  id: string
  title: string
  hook: string
  platforms: Platform[]
  stage: Stage
  /** days in current stage — staleness signal on the board */
  stageAgeDays: number
  thumbnail: string | null // emoji placeholder; real app: media attachment
  scheduledFor: string | null // YYYY-MM-DD when planned/posted
}

export interface PostPerformance {
  cardId: string
  title: string
  platform: Platform
  postedAt: string
  views: number
  likes: number
  saves: number
}

export interface CalendarDay {
  date: string // YYYY-MM-DD
  weekday: string
  cards: Array<{ id: string; title: string; platform: Platform }>
}

export interface StudioViewModel {
  stages: Array<{ id: Stage; title: string }>
  cards: StudioCard[]
  week: CalendarDay[]
  performance: PostPerformance[]
}

export async function loadStudio(): Promise<StudioViewModel> {
  return {
    stages: [
      { id: 'idea', title: 'Idea' },
      { id: 'scripted', title: 'Scripted' },
      { id: 'filmed', title: 'Filmed' },
      { id: 'edited', title: 'Edited' },
      { id: 'posted', title: 'Posted' },
    ],
    cards: CARDS,
    week: WEEK,
    performance: PERFORMANCE,
  }
}

const CARDS: StudioCard[] = [
  { id: 'c1', title: 'My AI reads 70 world events before breakfast', hook: 'POV: your portfolio has its own intelligence agency', platforms: ['tiktok', 'shorts'], stage: 'idea', stageAgeDays: 2, thumbnail: '🌍', scheduledFor: null },
  { id: 'c2', title: 'I let Claude pick a stock every Sunday', hook: 'Week 5: the AI found a power company', platforms: ['tiktok'], stage: 'idea', stageAgeDays: 5, thumbnail: '⚡', scheduledFor: null },
  { id: 'c3', title: 'Why my AI argues with itself before buying', hook: 'Every buy gets a bear lawyer. Here’s the cross-examination.', platforms: ['tiktok', 'reels'], stage: 'scripted', stageAgeDays: 1, thumbnail: '⚖️', scheduledFor: '2026-07-09' },
  { id: 'c4', title: 'The 20% rule that stops my bot going all-in', hook: 'Cash reserve math in 45 seconds', platforms: ['shorts'], stage: 'scripted', stageAgeDays: 3, thumbnail: '🧮', scheduledFor: '2026-07-11' },
  { id: 'c5', title: 'Bangkok desk tour: trading setup on a Mac Mini', hook: 'No Bloomberg terminal. One tiny computer.', platforms: ['reels', 'tiktok'], stage: 'filmed', stageAgeDays: 2, thumbnail: '🖥️', scheduledFor: '2026-07-08' },
  { id: 'c6', title: 'My AI called the gold top (kind of)', hook: 'Elliott waves vs vibes — who wins?', platforms: ['tiktok'], stage: 'edited', stageAgeDays: 1, thumbnail: '🌊', scheduledFor: '2026-07-07' },
  { id: 'c7', title: 'What a wash-sale is (and how it bit me)', hook: 'The IRS rule my bot now checks before every trade', platforms: ['tiktok', 'shorts'], stage: 'posted', stageAgeDays: 3, thumbnail: '🧾', scheduledFor: '2026-07-03' },
  { id: 'c8', title: 'One FX bug inflated my net worth 7x', hook: 'The day I was a fake millionaire for 6 hours', platforms: ['tiktok'], stage: 'posted', stageAgeDays: 6, thumbnail: '💸', scheduledFor: '2026-06-30' },
]

const WEEK: CalendarDay[] = [
  { date: '2026-07-06', weekday: 'Mon', cards: [] },
  { date: '2026-07-07', weekday: 'Tue', cards: [{ id: 'c6', title: 'AI called the gold top', platform: 'tiktok' }] },
  { date: '2026-07-08', weekday: 'Wed', cards: [{ id: 'c5', title: 'Bangkok desk tour', platform: 'reels' }] },
  { date: '2026-07-09', weekday: 'Thu', cards: [{ id: 'c3', title: 'AI argues with itself', platform: 'tiktok' }] },
  { date: '2026-07-10', weekday: 'Fri', cards: [] },
  { date: '2026-07-11', weekday: 'Sat', cards: [{ id: 'c4', title: '20% rule', platform: 'shorts' }] },
  { date: '2026-07-12', weekday: 'Sun', cards: [] },
]

const PERFORMANCE: PostPerformance[] = [
  { cardId: 'c8', title: 'One FX bug inflated my net worth 7x', platform: 'tiktok', postedAt: '2026-06-30', views: 48200, likes: 5400, saves: 890 },
  { cardId: 'c7', title: 'What a wash-sale is', platform: 'tiktok', postedAt: '2026-07-03', views: 12100, likes: 980, saves: 410 },
  { cardId: 'c7', title: 'What a wash-sale is', platform: 'shorts', postedAt: '2026-07-03', views: 6800, likes: 350, saves: 120 },
]
