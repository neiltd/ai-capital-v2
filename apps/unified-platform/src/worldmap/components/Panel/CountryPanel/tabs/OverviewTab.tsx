import type { Country } from '../../../../types/country'
import type { ImportedEvent } from '../../../../data/schemas/imports'
import { T, Sec } from '../tokens'
import { AnalysisCard } from '../../AnalysisCard'

function pop(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  return n.toLocaleString()
}

// ── Event type → display label + color ───────────────────────────────────────
const EVENT_TYPE_META: Partial<Record<string, { label: string; color: string }>> = {
  'conflict.armed':          { label: 'Armed conflict',    color: '#ef4444' },
  'conflict.protest':        { label: 'Protest',           color: '#f97316' },
  'conflict.riot':           { label: 'Riot',              color: '#f59e0b' },
  'conflict.cyberattack':    { label: 'Cyberattack',       color: '#a78bfa' },
  'diplomatic.cooperation':  { label: 'Cooperation',       color: '#22c55e' },
  'diplomatic.dispute':      { label: 'Diplomatic dispute',color: '#06b6d4' },
  'economic.sanctions':      { label: 'Sanctions',         color: '#fbbf24' },
  'economic.trade':          { label: 'Trade',             color: '#34d399' },
  'energy.disruption':       { label: 'Energy disruption', color: '#f97316' },
  'political.election':      { label: 'Election',          color: '#8b5cf6' },
  'political.coup':          { label: 'Coup',              color: '#ef4444' },
  'political.policy':        { label: 'Policy',            color: '#60a5fa' },
  'humanitarian.disaster':   { label: 'Disaster',          color: '#fb7185' },
  'humanitarian.crisis':     { label: 'Crisis',            color: '#f43f5e' },
}

const CONF_COLOR: Record<string, string> = { high: '#4ade80', medium: '#f59e0b', low: '#f87171' }
const TIER_LABEL: Record<number, string>  = { 1: 'Global', 2: 'Regional', 3: 'Local' }

const COORD_QUALITY_COLOR: Record<string, string> = {
  source_exact:     '#4ade80',
  source_approx:    '#f59e0b',
  country_centroid: '#64748b',
}
const COORD_QUALITY_LABEL: Record<string, string> = {
  source_exact:     'exact location',
  source_approx:    'approx. location',
  country_centroid: 'country centroid',
}

// ── Events section ────────────────────────────────────────────────────────────
function EventsSection({ events }: { events: ImportedEvent[] }) {
  if (events.length === 0) return null
  const shown = events.slice(0, 5)

  return (
    <Sec label={`Intelligence Events · ${events.length}`}>
      <div className="flex flex-col gap-2">
        {shown.map(evt => {
          const meta = EVENT_TYPE_META[evt.eventType]
          const typeColor = meta?.color ?? '#64748b'
          const typeLabel = meta?.label ?? evt.eventType

          return (
            <div key={evt.id} className={`${T.card} px-3 py-2.5`}>
              {/* Type + date row */}
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: typeColor }}>
                  {typeLabel}
                </span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {evt.tier && (
                    <span className="text-[9px] text-text-faint">{TIER_LABEL[evt.tier]}</span>
                  )}
                  <span className="text-[10px] text-text-faint tabular-nums">{evt.eventDate}</span>
                </div>
              </div>

              {/* Headline */}
              <p className="text-[12px] text-text-secondary leading-snug break-words">{evt.headline}</p>

              {/* Summary (if present) */}
              {evt.summary && (
                <p className="text-[11px] text-text-faint leading-snug mt-1.5 line-clamp-2">
                  {evt.summary}
                </p>
              )}

              {/* Footer: confidence + coord quality + fatalities + source */}
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <span className="text-[10px]" style={{ color: CONF_COLOR[evt.confidenceLabel] }}>
                  {evt.confidenceLabel} conf.
                </span>
                {evt.coordinateQuality && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded"
                    style={{
                      color:      COORD_QUALITY_COLOR[evt.coordinateQuality] ?? '#64748b',
                      background: '#0f1011',
                      border:     `1px solid ${(COORD_QUALITY_COLOR[evt.coordinateQuality] ?? '#64748b')}44`,
                    }}
                    title={evt.coordinateSource ? `Source: ${evt.coordinateSource}` : undefined}>
                    {COORD_QUALITY_LABEL[evt.coordinateQuality] ?? evt.coordinateQuality}
                  </span>
                )}
                {evt.fatalities !== undefined && evt.fatalities > 0 && (
                  <span className="text-[10px] text-red-500">{evt.fatalities} fatalities</span>
                )}
                {evt.sourceUrl && (
                  <a href={evt.sourceUrl} target="_blank" rel="noopener noreferrer"
                    className="text-[10px] text-blue-500 hover:text-blue-400 ml-auto flex-shrink-0">
                    source ↗
                  </a>
                )}
              </div>

              {/* Intelligence analysis — collapsible, shown only when analysis is present */}
              {evt.analysis && <AnalysisCard analysis={evt.analysis} />}
            </div>
          )
        })}

        {events.length > 5 && (
          <p className="text-[10px] text-text-faint text-center">
            +{events.length - 5} more events not shown
          </p>
        )}
      </div>
    </Sec>
  )
}

// ── Main tab ──────────────────────────────────────────────────────────────────
interface Props {
  country: Country
  events: ImportedEvent[]
}

export default function OverviewTab({ country: c, events }: Props) {
  return (
    <>
      {/* Intelligence events — shown first, time-sensitive */}
      <EventsSection events={events} />

      <p className={T.body}>{c.summary}</p>

      <Sec label="Demographics">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
          {[
            ['Population', pop(c.demographics.population)],
            ['Median Age', `${c.demographics.medianAge} yrs`],
            ['Urban',      `${c.demographics.urbanizationRate}%`],
            ['Alliances',  `${c.alliances.length}`],
          ].map(([lbl, val]) => (
            <div key={lbl} className={`${T.card} p-3 flex flex-col gap-1.5`}>
              <span className={T.section}>{lbl}</span>
              <span className="text-[14px] font-bold text-text-primary leading-none break-words">{val}</span>
            </div>
          ))}
        </div>
      </Sec>

      <Sec label="Religion">
        <div className="flex flex-col gap-2.5">
          {c.demographics.religions.map(r => (
            <div key={r.name} className="flex items-center gap-3 min-w-0">
              <div className="flex-1 min-w-0 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${r.percent}%` }} />
              </div>
              <span className="flex-shrink-0 text-[11px] text-text-muted text-right tabular-nums"
                style={{ minWidth: '8rem' }}>
                {r.name} <span className="text-text-secondary font-medium">{r.percent}%</span>
              </span>
            </div>
          ))}
        </div>
      </Sec>

      <Sec label="Alliances & Memberships">
        <div className="flex flex-wrap gap-1.5">
          {c.alliances.map(a => (
            <span key={a}
              className="text-[11px] px-2.5 py-1 bg-bg-card border border-border-subtle rounded-full text-text-muted break-words">
              {a}
            </span>
          ))}
        </div>
      </Sec>
    </>
  )
}
