export const dynamic = 'force-dynamic'

import { readStockIntel, readWorldIntel } from '@/lib/data'
import { StockEventCard, WorldEventCard } from '@/components/capital/WorldEventCard'
import { PageHeader, MetaDot, SectionTitle } from '@/components/capital/ui/PageHeader'
import { EmptyState } from '@/components/capital/ui/EmptyState'
import { SeverityHistogram } from '@/components/capital/ui/SeverityHistogram'
import { SeverityDistributionBar } from '@/components/capital/ui/SeverityDistributionBar'
import { PortfolioExposureList } from '@/components/capital/PortfolioExposureList'
import { HotRegionsCard } from '@/components/capital/HotRegionsCard'
import { CollapsibleGroup } from '@/components/capital/CollapsibleGroup'
import type { StockEvent, StockSectorExposure, WorldCountrySignal, WorldEvent } from '@/types'

function sortBySeverity<T extends { severity: number }>(events: T[]): T[] {
  return [...events].sort((a, b) => b.severity - a.severity)
}

// ─── kind-tagged card wrapper ──────────────────────────────────────────────
// Reuses StockEventCard / WorldEventCard as-is (they render the real
// headline/summary/severity-badge/country-tag fields) and just adds a small
// source label since Critical/Elevated/Monitoring groups interleave both
// market and geopolitical events.

type TaggedEvent =
  | { kind: 'world'; key: string; severity: number; event: WorldEvent }
  | { kind: 'stock'; key: string; severity: number; event: StockEvent }

function KindTag({ kind }: { kind: 'world' | 'stock' }) {
  return (
    <span className="text-[9px] uppercase tracking-[0.1em] text-text-inactive">
      {kind === 'world' ? 'World' : 'Market'}
    </span>
  )
}

function EventCard({ item }: { item: TaggedEvent }) {
  return (
    <div>
      <div className="mb-1">
        <KindTag kind={item.kind} />
      </div>
      {item.kind === 'world'
        ? <WorldEventCard {...item.event} />
        : <StockEventCard {...item.event} />}
    </div>
  )
}

function EventGroup({ items }: { items: TaggedEvent[] }) {
  return (
    <div className="space-y-3">
      {items.map(item => <EventCard key={`${item.kind}-${item.key}`} item={item} />)}
    </div>
  )
}

// ─── page ───────────────────────────────────────────────────────────────────

export default function WorldIntelPage() {
  let stockEvents: StockEvent[] = []
  let worldEvents: WorldEvent[] = []
  let sectorExposure: StockSectorExposure[] = []
  let countrySignals: WorldCountrySignal[] = []
  let asOf: string | undefined
  let error: string | null = null

  try {
    const stockIntel = readStockIntel()
    const worldIntel = readWorldIntel()
    stockEvents = sortBySeverity(stockIntel.marketEvents ?? [])
    worldEvents = sortBySeverity(worldIntel.events ?? [])
    sectorExposure = stockIntel.sectorExposure ?? []
    countrySignals = worldIntel.countrySignals ?? []
    asOf = worldIntel.date ?? stockIntel.date
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to load world intel'
  }

  if (error) {
    return (
      <div className="max-w-5xl">
        <PageHeader title="World Intel" subtitle="Geopolitical and market events, ranked by severity" />
        <EmptyState
          icon="⚠"
          title="Failed to load world intel"
          description={error}
          tone="error"
        />
      </div>
    )
  }

  const totalEvents = stockEvents.length + worldEvents.length

  if (totalEvents === 0) {
    return (
      <div className="max-w-5xl">
        <PageHeader title="World Intel" subtitle="Geopolitical and market events, ranked by severity" />
        <EmptyState
          icon="✦"
          title="No events recorded"
          description="The world-intel pipeline hasn't produced any market or geopolitical events yet."
        />
      </div>
    )
  }

  const tagged: TaggedEvent[] = [
    ...worldEvents.map((e): TaggedEvent => ({ kind: 'world', key: e.eventId, severity: e.severity, event: e })),
    ...stockEvents.map((e): TaggedEvent => ({ kind: 'stock', key: e.eventId, severity: e.severity, event: e })),
  ]

  // Bands follow lib/severity's severityLabel thresholds (1-5 scale):
  // Critical = 5, Elevated = 4 (severityLabel "High"), Monitoring = 1-3.
  const critical = tagged.filter(t => t.severity >= 5).sort((a, b) => b.severity - a.severity)
  const elevated = tagged.filter(t => t.severity === 4).sort((a, b) => b.severity - a.severity)
  const monitoring = tagged.filter(t => t.severity <= 3).sort((a, b) => b.severity - a.severity)

  const chartEvents = [
    ...worldEvents.map(e => ({ severity: e.severity, firstSeenAt: e.firstSeenAt })),
    ...stockEvents.map(e => ({ severity: e.severity, firstSeenAt: e.firstSeenAt })),
  ]

  return (
    <div className="max-w-7xl">
      <PageHeader
        title="World Intel"
        subtitle="Geopolitical and market events, ranked by severity"
        meta={
          <>
            <span>{worldEvents.length} world</span>
            <MetaDot />
            <span>{stockEvents.length} market</span>
            {asOf && (
              <>
                <MetaDot />
                <span>as of {asOf}</span>
              </>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6 items-start">
        {/* Main content — severity-tiered event groups */}
        <div className="space-y-6 min-w-0">
          {critical.length > 0 && (
            <section>
              <SectionTitle count={critical.length}>Critical</SectionTitle>
              <EventGroup items={critical} />
            </section>
          )}

          {elevated.length > 0 && (
            <section>
              <SectionTitle count={elevated.length}>Elevated</SectionTitle>
              <EventGroup items={elevated} />
            </section>
          )}

          {monitoring.length > 0 && (
            <CollapsibleGroup title="Monitoring" count={monitoring.length}>
              <EventGroup items={monitoring} />
            </CollapsibleGroup>
          )}
        </div>

        {/* Sidebar — aggregate views over the same real event data */}
        <div className="space-y-6">
          <SeverityHistogram events={chartEvents} />
          <SeverityDistributionBar events={chartEvents} />
          <PortfolioExposureList rows={sectorExposure} />
          <HotRegionsCard countries={countrySignals} />
        </div>
      </div>
    </div>
  )
}
