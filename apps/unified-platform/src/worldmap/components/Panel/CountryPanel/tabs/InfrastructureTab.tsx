import { T, Sec } from '../tokens'

// ── Infrastructure data shape — defined here, imported by index.tsx ───────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface InfraData {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  airports:    any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  seaports:    any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plants:      any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  railHubs:    any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  datacenters: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  foodSecurity: any | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aiAdoption:   any | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  utility:      any | null
}

// ── Color maps — match the corresponding map layer colors exactly ─────────────
const PLANT_COLOR: Record<string, string> = {
  nuclear: '#a78bfa', coal: '#78716c', gas: '#f59e0b', oil: '#92400e',
  hydro: '#0ea5e9', solar: '#fbbf24', wind: '#34d399', geothermal: '#f97316', other: '#64748b',
}
const PORT_COLOR: Record<string, string> = {
  container: '#06b6d4', oil: '#f59e0b', lng: '#f97316', bulk: '#8b5cf6',
  multipurpose: '#3b82f6', naval: '#ef4444', mixed: '#22c55e',
}
const DC_COLOR: Record<string, string> = {
  hyperscale: '#a78bfa', colocation: '#22d3ee', enterprise: '#64748b', government: '#ef4444',
}
const RAIL_COLOR: Record<string, string> = {
  passenger: '#60a5fa', freight: '#f59e0b', mixed: '#a78bfa',
  high_speed: '#22d3ee', border_crossing: '#f97316', port_interface: '#34d399',
}

function formatMW(mw?: number | null): string | null {
  if (!mw) return null
  return mw >= 1000 ? `${(mw / 1000).toFixed(1)} GW` : `${mw} MW`
}

function formatTEU(teu?: number | null, tonnes?: number | null): string | null {
  if (teu) return teu >= 1e6 ? `${(teu / 1e6).toFixed(1)}M TEU` : `${(teu / 1e3).toFixed(0)}K TEU`
  if (tonnes) return tonnes >= 1e6 ? `${(tonnes / 1e6).toFixed(1)}Mt` : `${(tonnes / 1e3).toFixed(0)}Kt`
  return null
}

interface Props { infra: InfraData }

export default function InfrastructureTab({ infra }: Props) {
  const infraCount = infra.airports.length + infra.seaports.length + infra.plants.length +
                     infra.railHubs.length + infra.datacenters.length

  if (infraCount === 0) {
    return <p className={T.label}>No infrastructure data available for this country yet.</p>
  }

  return (
    <>
      {/* Airports */}
      {infra.airports.length > 0 && (
        <Sec label={`Airports (${infra.airports.length})`}>
          <div className="flex flex-col gap-2">
            {infra.airports.map((a: any) => (
              <div key={a.id} className={`${T.card} px-3 py-2 flex items-start justify-between gap-2`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    {a.iata && <span className="text-[10px] font-mono text-text-inactive">{a.iata}</span>}
                    <span className="text-[12px] font-medium text-text-secondary truncate">{a.name}</span>
                  </div>
                  {a.geopoliticalNotes && (
                    <p className="text-[10px] text-text-faint mt-0.5 leading-snug line-clamp-2">{a.geopoliticalNotes}</p>
                  )}
                </div>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 font-semibold uppercase"
                  style={{ background: '#1E2D4A', color: a.strategicImportance === 'critical' ? '#f97316' : a.strategicImportance === 'high' ? '#3b82f6' : '#64748b' }}>
                  {a.strategicImportance}
                </span>
              </div>
            ))}
          </div>
        </Sec>
      )}

      {/* Seaports */}
      {infra.seaports.length > 0 && (
        <Sec label={`Seaports (${infra.seaports.length})`}>
          <div className="flex flex-col gap-2">
            {infra.seaports.map((p: any) => (
              <div key={p.id} className={`${T.card} px-3 py-2 flex items-start justify-between gap-2`}>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium text-text-secondary truncate">{p.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px]" style={{ color: PORT_COLOR[p.type] ?? '#64748b' }}>{p.type}</span>
                    {formatTEU(p.annualThroughputTEU, p.annualThroughputTonnes) && (
                      <span className="text-[10px] text-text-faint">
                        {formatTEU(p.annualThroughputTEU, p.annualThroughputTonnes)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Sec>
      )}

      {/* Power Plants */}
      {infra.plants.length > 0 && (
        <Sec label={`Power Plants (${infra.plants.length})`}>
          <div className="flex flex-col gap-2">
            {infra.plants.map((p: any) => (
              <div key={p.id} className={`${T.card} px-3 py-2 flex items-start justify-between gap-2`}>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium text-text-secondary truncate">{p.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px]" style={{ color: PLANT_COLOR[p.type] ?? '#64748b' }}>{p.type}</span>
                    {formatMW(p.capacityMW) && (
                      <span className="text-[10px] text-text-faint">{formatMW(p.capacityMW)}</span>
                    )}
                  </div>
                </div>
                {p.status !== 'operating' && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 bg-bg-elevated text-text-inactive uppercase">
                    {p.status}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Sec>
      )}

      {/* Datacenters */}
      {infra.datacenters.length > 0 && (
        <Sec label={`Datacenters (${infra.datacenters.length})`}>
          <div className="flex flex-col gap-2">
            {infra.datacenters.map((d: any) => (
              <div key={d.id} className={`${T.card} px-3 py-2 flex items-start justify-between gap-2`}>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium text-text-secondary truncate">{d.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px]" style={{ color: DC_COLOR[d.type] ?? '#64748b' }}>{d.type}</span>
                    {d.operator && <span className="text-[10px] text-text-faint truncate">{d.operator}</span>}
                  </div>
                </div>
                {d.cloudRegion && (
                  <span className="text-[9px] font-mono text-text-faint flex-shrink-0">{d.cloudRegion}</span>
                )}
              </div>
            ))}
          </div>
        </Sec>
      )}

      {/* Rail Hubs */}
      {infra.railHubs.length > 0 && (
        <Sec label={`Rail Hubs (${infra.railHubs.length})`}>
          <div className="flex flex-col gap-2">
            {infra.railHubs.map((r: any) => (
              <div key={r.id} className={`${T.card} px-3 py-2 flex items-start justify-between gap-2`}>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium text-text-secondary truncate">{r.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px]" style={{ color: RAIL_COLOR[r.type] ?? '#64748b' }}>
                      {r.type.replace(/_/g, ' ')}
                    </span>
                  </div>
                </div>
                {r.isPartOfBRI && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 font-semibold"
                    style={{ background: '#7f1d1d44', color: '#f87171', border: '1px solid #7f1d1d' }}>BRI</span>
                )}
              </div>
            ))}
          </div>
        </Sec>
      )}

      {/* Country-level indicators: Food Security, AI Readiness, Energy Mix */}
      {(infra.foodSecurity || infra.aiAdoption || infra.utility) && (
        <Sec label="Country Indicators">
          <div className="flex flex-col gap-2">
            {infra.foodSecurity && (
              <div className={`${T.card} px-3 py-2 flex justify-between items-center`}>
                <span className={T.label}>Food Security (GFSI)</span>
                <span className="text-[13px] font-bold tabular-nums"
                  style={{ color: infra.foodSecurity.overallScore >= 60 ? '#22c55e' : infra.foodSecurity.overallScore >= 40 ? '#f59e0b' : '#ef4444' }}>
                  {infra.foodSecurity.overallScore?.toFixed(1)}<span className="text-[10px] text-text-faint">/100</span>
                </span>
              </div>
            )}
            {infra.aiAdoption?.aiReadinessScore && (
              <div className={`${T.card} px-3 py-2 flex justify-between items-center`}>
                <span className={T.label}>AI Readiness</span>
                <span className="text-[13px] font-bold text-violet-400 tabular-nums">
                  {infra.aiAdoption.aiReadinessScore.toFixed(1)}<span className="text-[10px] text-text-faint">/100</span>
                </span>
              </div>
            )}
            {infra.utility?.electricityMix && (
              <div className={`${T.card} px-3 py-2`}>
                <p className={`${T.label} mb-2`}>Energy Mix ({infra.utility.year})</p>
                <div className="flex flex-col gap-1.5">
                  {Object.entries(infra.utility.electricityMix as Record<string, number>)
                    .filter(([, v]) => v != null && (v as number) > 0)
                    .sort(([, a], [, b]) => (b as number) - (a as number))
                    .slice(0, 5)
                    .map(([src, pct]) => (
                      <div key={src} className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] text-text-inactive w-14 flex-shrink-0 capitalize">{src}</span>
                        <div className="flex-1 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                          <div className="h-full rounded-full"
                            style={{ width: `${pct}%`, background: PLANT_COLOR[src] ?? '#3b82f6' }} />
                        </div>
                        <span className="text-[10px] text-text-muted tabular-nums w-8 text-right">{pct}%</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        </Sec>
      )}
    </>
  )
}
