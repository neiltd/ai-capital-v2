/**
 * CountryPanel — tab orchestrator.
 *
 * Responsibilities:
 *   - Read selection state from store
 *   - Compute infrastructure data index (useMemo, before any early returns)
 *   - Render loading / error / empty states
 *   - Render panel header (flag, name, close, CompareSearch)
 *   - Render tab bar with infrastructure count badge
 *   - Render the active tab component
 *
 * Contains NO business logic. Passes Country and InfraData as props to tabs.
 * Tab components are purely presentational — they do not read from the store.
 */

import { useState, useMemo } from 'react'
import { useMapStore } from '../../../store/useMapStore'
import { useIntelligenceStore } from '../../../store/useIntelligenceStore'
import type { ImportedEvent } from '../../../data/schemas/imports'
import type { Country } from '../../../types/country'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import airportsRaw     from '../../../data/validated/airports.json'
import seaportsRaw     from '../../../data/validated/seaports.json'
import powerPlantsRaw  from '../../../data/validated/power-plants.json'
import railHubsRaw     from '../../../data/validated/rail-hubs.json'
import datacentersRaw  from '../../../data/validated/datacenters.json'
import foodSecurityRaw from '../../../data/validated/food-security.json'
import aiAdoptionRaw   from '../../../data/validated/ai-adoption.json'
import utilitiesRaw    from '../../../data/validated/utilities.json'

import { T, flag } from './tokens'
import { CompareSearch } from './CompareSearch'
import OverviewTab        from './tabs/OverviewTab'
import IndicatorsTab      from './tabs/IndicatorsTab'
import RelationsTab       from './tabs/RelationsTab'
import PerspectivesTab    from './tabs/PerspectivesTab'
import HistoryTab         from './tabs/HistoryTab'
import InvestmentTab      from './tabs/InvestmentTab'
import InfrastructureTab  from './tabs/InfrastructureTab'
import type { InfraData } from './tabs/InfrastructureTab'

type Tab = 'overview' | 'indicators' | 'relationships' | 'perspectives' | 'history' | 'investment' | 'infrastructure'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview',       label: 'Overview'       },
  { id: 'indicators',     label: 'Indicators'     },
  { id: 'relationships',  label: 'Relations'      },
  { id: 'perspectives',   label: 'Perspectives'   },
  { id: 'history',        label: 'History'        },
  { id: 'investment',     label: 'Investment'     },
  { id: 'infrastructure', label: 'Infrastructure' },
]

export default function CountryPanel() {
  const { countryData, compareData, loading, error, clearSelection } = useMapStore()
  const [tab, setTab] = useState<Tab>('overview')

  // ── Events for selected country — read from intelligence store ────────────
  // Hooks must be called before any early returns.
  // eventsByIso3 is a stable reference; only changes when imports are refreshed.
  const eventsByIso3 = useIntelligenceStore(s => s.eventsByIso3)
  const countryEvents: ImportedEvent[] = useMemo(() => {
    if (!countryData?.id) return []
    return (eventsByIso3[countryData.id] ?? [])
      .slice()
      .sort((a, b) => b.eventDate.localeCompare(a.eventDate))
  }, [eventsByIso3, countryData?.id])

  // ── Infrastructure data index — filtered per selected country ─────────────
  // MUST be called before any early returns (Rules of Hooks).
  // Filters are O(n) over static arrays; runs only when countryData.id changes.
  //
  // Future: when infrastructure datasets grow beyond ~5000 records each,
  // replace the filter pass with a pre-built ISO3-keyed index built at module load.
  const infra = useMemo((): InfraData => {
    const id = countryData?.id
    if (!id) {
      return { airports: [], seaports: [], plants: [], railHubs: [], datacenters: [],
               foodSecurity: null, aiAdoption: null, utility: null }
    }
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      airports:    (airportsRaw    as any[]).filter(d => d.countryId === id),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      seaports:    (seaportsRaw    as any[]).filter(d => d.countryId === id),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plants:      (powerPlantsRaw as any[]).filter(d => d.countryId === id && d.status !== 'decommissioned'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      railHubs:    (railHubsRaw    as any[]).filter(d => d.countryId === id),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      datacenters: (datacentersRaw as any[]).filter(d => d.countryId === id),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      foodSecurity:(foodSecurityRaw as any[]).find(d => d.countryId === id) ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiAdoption:  (aiAdoptionRaw  as any[]).find(d => d.countryId === id) ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      utility:     (utilitiesRaw   as any[]).find(d => d.countryId === id) ?? null,
    }
  }, [countryData?.id])

  // ── Loading / error / empty states ────────────────────────────────────────
  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <div className="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-[12px] text-text-inactive">Loading intelligence data…</p>
      </div>
    </div>
  )

  if (error) return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
      <span className="text-4xl">🗺️</span>
      <p className={`${T.body} text-text-inactive`}>{error}</p>
      <button onClick={clearSelection} className="text-[11px] text-blue-400 hover:text-blue-300 underline">Back to map</button>
    </div>
  )

  if (!countryData) return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-6 text-center">
      <span className="text-5xl">🌍</span>
      <div>
        <p className="text-[13px] font-medium text-text-muted mb-1.5">Click any country</p>
        <p className={`${T.label} leading-relaxed`}>
          214 countries with geopolitical context, relationships,<br />competing perspectives, and investment intelligence.
        </p>
      </div>
    </div>
  )

  const c: Country = countryData
  const infraCount = infra.airports.length + infra.seaports.length + infra.plants.length +
                     infra.railHubs.length + infra.datacenters.length

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-base">

      {/* ── Header — never scrolls ───────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-5 pt-4 pb-3 border-b border-border-subtle">
        <div className="flex items-start gap-3 min-w-0">
          <span className="text-3xl flex-shrink-0 leading-none mt-0.5">{flag(c.iso2)}</span>
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-bold text-text-primary leading-tight break-words">{c.name}</h2>
            <p className={`${T.label} mt-1 break-words`}>{c.subregion} · {c.capital}</p>
            <p className="text-[10px] text-text-faint mt-0.5">Updated {c.lastUpdated}</p>
          </div>
          <button onClick={clearSelection}
            className="flex-shrink-0 w-7 h-7 flex items-center justify-center text-text-inactive hover:text-text-primary hover:bg-bg-elevated rounded transition-colors text-lg leading-none">
            ×
          </button>
        </div>
        <CompareSearch />
      </div>

      {/* ── Tab bar — never scrolls, never wraps ────────────────────────────── */}
      <div className="flex-shrink-0 flex overflow-x-auto border-b border-border-subtle"
        style={{ scrollbarWidth: 'none' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-shrink-0 px-4 py-2.5 text-[11px] font-medium whitespace-nowrap
              transition-colors border-b-2 flex items-center gap-1.5 ${
              tab === t.id
                ? 'text-blue-400 border-blue-500'
                : 'text-text-inactive hover:text-text-secondary border-transparent'
            }`}>
            {t.label}
            {t.id === 'infrastructure' && infraCount > 0 && (
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold leading-none ${
                tab === 'infrastructure' ? 'bg-blue-signal/20 text-blue-signal' : 'bg-bg-elevated text-text-inactive'
              }`}>
                {infraCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tab body — only this scrolls ────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0 px-5 py-4 flex flex-col gap-5">
        {tab === 'overview'       && <OverviewTab       country={c} events={countryEvents} />}
        {tab === 'indicators'     && <IndicatorsTab     country={c} compare={compareData} />}
        {tab === 'relationships'  && <RelationsTab      country={c} />}
        {tab === 'perspectives'   && <PerspectivesTab   country={c} />}
        {tab === 'history'        && <HistoryTab        country={c} />}
        {tab === 'investment'     && <InvestmentTab     country={c} />}
        {tab === 'infrastructure' && <InfrastructureTab infra={infra} />}
      </div>
    </div>
  )
}
