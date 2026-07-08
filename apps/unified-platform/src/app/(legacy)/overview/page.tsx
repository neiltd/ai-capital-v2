export const dynamic = 'force-dynamic'

import { readWaveActions, readWavePortfolio, readSimulation, readStockIntel, readWorldIntel } from '@/lib/data'
import { prisma } from '@/lib/studio/db'
import { DomainSummaryCard, type PreviewItem, type SmallStat } from '@/components/DomainSummaryCard'
import { Badge, signalTone } from '@/components/capital/ui/Badge'
import { Sparkline } from '@/components/capital/ui/Sparkline'
import { MetaDot } from '@/components/capital/ui/PageHeader'
import { severityLabel, severityTone } from '@/lib/severity'
import type { PortfolioPosition, TradeAction } from '@/types'

// ─── Capital Intel: same readers/formulas as /capital/trade and /capital/portfolio ──

/** Convert a position's value/cost/pnl into USD using the supplied THB→USD rate.
 *  Identical to the helper in /capital/portfolio/page.tsx. */
function inUsd(value: number, currency: PortfolioPosition['currency'], usdThb: number | null): number {
  if (currency !== 'THB') return value
  if (!usdThb || usdThb <= 0) return 0
  return value / usdThb
}

interface CapitalCardData {
  topSignals: TradeAction[]
  signalCount: number
  openCount: number
  closedCount: number
  closedPnl: number
  totalValueUsd: number
  positionCount: number
  pnlPct: number | null
}

function loadCapitalCard(): { data: CapitalCardData | null; error: string | null } {
  try {
    const waveActions = readWaveActions()
    const wavePortfolio = readWavePortfolio()
    const simulation = readSimulation()

    const signals = (waveActions?.actions ?? [])
      .filter(a => a.signal !== 'no-signal')
      .sort((a, b) => b.confidence - a.confidence || (b.riskReward ?? 0) - (a.riskReward ?? 0))

    const openPositions = wavePortfolio?.openPositions ?? []
    const closedPositions = wavePortfolio?.closedPositions ?? []
    const closedPnl = wavePortfolio?.totalPnl ?? 0

    const positions = simulation.portfolio ?? []
    const usdThb = simulation.usdThb ?? null
    const nonCash = positions.filter(p => (p.assetClass ?? 'us_equity') !== 'cash')

    const totalValueUsd = positions.reduce((s, p) => {
      const cls = p.assetClass ?? 'us_equity'
      if (cls === 'cash') return s + inUsd(p.shares, p.currency, usdThb)
      const price = p.currentPrice > 0 ? p.currentPrice : p.avgCost
      return s + inUsd(price * p.shares, p.currency, usdThb)
    }, 0)

    const totalCostUsd = nonCash.reduce((s, p) => s + inUsd(p.avgCost * p.shares, p.currency, usdThb), 0)
    const totalUnrealizedUsd = nonCash.reduce((s, p) => s + inUsd(p.unrealizedPnl ?? 0, p.currency, usdThb), 0)
    const pnlPct = totalCostUsd > 0 ? (totalUnrealizedUsd / totalCostUsd) * 100 : null

    return {
      data: {
        topSignals: signals.slice(0, 3),
        signalCount: signals.length,
        openCount: openPositions.length,
        closedCount: closedPositions.length,
        closedPnl,
        totalValueUsd,
        positionCount: positions.length,
        pnlPct,
      },
      error: null,
    }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : 'Failed to load capital data' }
  }
}

// ─── World Intelligence: same readers/banding as /world/intel ──────────────────

interface TopEvent {
  key: string
  title: string
  severity: number
}

interface WorldCardData {
  topEvents: TopEvent[]
  totalEvents: number
  highSeverityCount: number
  countryCount: number
  sectorCount: number
  asOf: string | undefined
}

function loadWorldCard(): { data: WorldCardData | null; error: string | null } {
  try {
    const stockIntel = readStockIntel()
    const worldIntel = readWorldIntel()

    // Some events are cross-tagged into both the world and stock/market exports
    // (a single geopolitical event relevant to both domains) — dedupe by
    // eventId so it doesn't count/render twice here.
    const byEventId = new Map<string, TopEvent>()
    for (const e of [...(worldIntel.events ?? []), ...(stockIntel.marketEvents ?? [])]) {
      if (!byEventId.has(e.eventId)) {
        byEventId.set(e.eventId, { key: e.eventId, title: e.title, severity: e.severity })
      }
    }
    const tagged: TopEvent[] = Array.from(byEventId.values()).sort((a, b) => b.severity - a.severity)

    // Bands match /world/intel/page.tsx: Critical = 5, Elevated/"High" = 4.
    // "High severity" here is the combined top band (severity >= 4).
    const highSeverityCount = tagged.filter(t => t.severity >= 4).length

    return {
      data: {
        topEvents: tagged.slice(0, 3),
        totalEvents: tagged.length,
        highSeverityCount,
        countryCount: worldIntel.countrySignals?.length ?? 0,
        sectorCount: stockIntel.sectorExposure?.length ?? 0,
        asOf: worldIntel.date ?? stockIntel.date,
      },
      error: null,
    }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : 'Failed to load world intel' }
  }
}

// ─── Creator Studio: same Prisma reads as /studio/dashboard ─────────────────────

interface StudioCardData {
  latestFollowers: number | null
  snapshotCount: number
  followerSeries: number[]
  videoCount: number
  avgEngagementPct: number | null
  sessionCount: number
  latestVideos: { id: string; title: string }[]
}

async function loadStudioCard(): Promise<{ data: StudioCardData | null; error: string | null }> {
  try {
    const [snapshots, videos, latestVideos, sessionCount] = await Promise.all([
      prisma.growthSnapshot.findMany({ orderBy: { date: 'asc' }, take: 30 }),
      prisma.video.findMany({ orderBy: { views: 'desc' }, take: 20 }),
      prisma.video.findMany({ orderBy: { createdAt: 'desc' }, take: 3 }),
      prisma.session.count(),
    ])

    const totalViews = videos.reduce((s, v) => s + v.views, 0)
    const totalLikes = videos.reduce((s, v) => s + v.likes, 0)
    const totalComments = videos.reduce((s, v) => s + v.comments, 0)
    const totalShares = videos.reduce((s, v) => s + v.shares, 0)
    const avgEngagementPct = totalViews > 0 ? ((totalLikes + totalComments + totalShares) / totalViews) * 100 : null

    return {
      data: {
        latestFollowers: snapshots.at(-1)?.followers ?? null,
        snapshotCount: snapshots.length,
        followerSeries: snapshots.map(s => s.followers),
        videoCount: videos.length,
        avgEngagementPct,
        sessionCount,
        latestVideos: latestVideos.map(v => ({ id: v.id, title: v.title })),
      },
      error: null,
    }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : 'Database unavailable' }
  }
}

// ─── page ───────────────────────────────────────────────────────────────────────

export default async function HomePage() {
  const { data: capital } = loadCapitalCard()
  const { data: world } = loadWorldCard()
  const { data: studio } = await loadStudioCard()

  // Hero meta — only real, derivable numbers. Anything a domain couldn't
  // back with a live field is dropped rather than hardcoded.
  const metaItems: string[] = []
  if (world?.asOf) metaItems.push(`world-intel as of ${world.asOf}`)
  if (capital) metaItems.push(`${capital.positionCount} portfolio position${capital.positionCount === 1 ? '' : 's'} tracked`)
  if (world) metaItems.push(`${world.countryCount} countries monitored`)

  const capitalPreview: PreviewItem[] = (capital?.topSignals ?? []).map(a => ({
    key: a.ticker,
    primary: a.ticker,
    secondary: `${a.confidence}% confidence${a.riskReward != null ? ` · ${a.riskReward.toFixed(1)}× R:R` : ''}`,
    badge: (
      <Badge tone={signalTone(a.signal)} size="xs" uppercase>
        {a.signal}
      </Badge>
    ),
  }))

  const capitalSmallStats: SmallStat[] = capital
    ? [
        { label: 'Active Signals', value: capital.signalCount },
        { label: 'Open Positions', value: capital.openCount },
        {
          label: 'Closed P&L',
          value: `${capital.closedPnl >= 0 ? '+' : ''}$${Math.abs(capital.closedPnl).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        },
      ]
    : []

  const worldPreview: PreviewItem[] = (world?.topEvents ?? []).map(e => ({
    key: e.key,
    primary: e.title,
    badge: (
      <Badge tone={severityTone(e.severity)} size="xs">
        {severityLabel(e.severity)}
      </Badge>
    ),
  }))

  const worldSmallStats: SmallStat[] = world
    ? [
        { label: 'Events Today', value: world.totalEvents },
        { label: 'Countries', value: world.countryCount },
        { label: 'Sectors Flagged', value: world.sectorCount },
      ]
    : []

  const studioPreview: PreviewItem[] = (studio?.latestVideos ?? []).map(v => ({
    key: v.id,
    primary: v.title,
  }))

  const studioSmallStats: SmallStat[] = studio
    ? [
        { label: 'Videos', value: studio.videoCount },
        { label: 'Avg Engagement', value: studio.avgEngagementPct != null ? `${studio.avgEngagementPct.toFixed(1)}%` : '—' },
        { label: 'Sessions', value: studio.sessionCount },
      ]
    : []

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-10 md:px-8 md:py-12 space-y-10">
        {/* Hero */}
        <section className="border-b border-border-subtle pb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo-active mb-3">
            Unified Platform
          </p>
          <h1 className="text-[32px] md:text-[38px] font-semibold tracking-tight text-text-primary leading-[1.1]">
            Capital, world, and content. One console.
          </h1>
          <p className="text-[14px] text-text-muted mt-3 max-w-2xl leading-relaxed">
            Three intelligence pipelines feeding each other — market analysis, geopolitical events, and the content
            built on top of both.
          </p>
          {metaItems.length > 0 && (
            <div className="text-[11px] text-text-inactive mt-4 flex items-center gap-2 flex-wrap">
              {metaItems.map((item, i) => (
                <span key={item} className="flex items-center gap-2">
                  {i > 0 && <MetaDot />}
                  <span>{item}</span>
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Domain cards */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-stretch">
          <DomainSummaryCard
            eyebrow="Capital Intel"
            title="Trade signals & portfolio"
            subtitle="Elliott Wave signals, open positions, multi-asset portfolio value"
            preview={capitalPreview}
            bigStatLabel="Total Portfolio Value"
            bigStatValue={capital ? `$${capital.totalValueUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
            bigStatSub={
              capital?.pnlPct != null
                ? `${capital.pnlPct >= 0 ? '+' : ''}${capital.pnlPct.toFixed(1)}% unrealized`
                : undefined
            }
            bigStatTone={capital?.pnlPct != null ? (capital.pnlPct >= 0 ? 'positive' : 'negative') : 'accent'}
            smallStats={capitalSmallStats}
            ctaHref="/capital/briefing"
            ctaLabel="Open Capital Intel"
            empty={
              !capital
                ? {
                    icon: '⚡',
                    title: 'Capital data unavailable',
                    description: 'Wave signals and portfolio data haven’t been generated yet.',
                  }
                : undefined
            }
          />

          <DomainSummaryCard
            eyebrow="World Intelligence"
            title="Geopolitical & market events"
            subtitle="Ranked by severity across world and market intel feeds"
            preview={worldPreview}
            bigStatLabel="High Severity Events"
            bigStatValue={world ? world.highSeverityCount : '—'}
            bigStatSub={world ? 'severity 4-5 of 5' : undefined}
            bigStatTone={world && world.highSeverityCount > 0 ? 'negative' : 'accent'}
            smallStats={worldSmallStats}
            ctaHref="/world/intel"
            ctaLabel="Open World Intel"
            empty={
              !world
                ? {
                    icon: '✦',
                    title: 'No events recorded',
                    description: 'The world-intel pipeline hasn’t produced any events yet.',
                  }
                : undefined
            }
          />

          <DomainSummaryCard
            eyebrow="Creator Studio"
            title="Growth & content performance"
            subtitle="Follower growth, video engagement, and saved sessions"
            preview={studioPreview}
            headerAccessory={
              studio && studio.followerSeries.length >= 2 ? (
                <Sparkline values={studio.followerSeries} width={56} height={20} />
              ) : undefined
            }
            bigStatLabel="Followers"
            bigStatValue={studio?.latestFollowers != null ? studio.latestFollowers.toLocaleString() : '—'}
            bigStatSub={studio ? `${studio.snapshotCount} day${studio.snapshotCount === 1 ? '' : 's'} logged` : undefined}
            smallStats={studioSmallStats}
            ctaHref="/studio"
            ctaLabel="Open Creator Studio"
            empty={
              !studio
                ? {
                    icon: '🎬',
                    title: 'Studio database not configured',
                    description: 'Run npx prisma migrate dev and set DATABASE_URL to enable persistence.',
                  }
                : undefined
            }
          />
        </section>
      </div>
    </div>
  )
}
