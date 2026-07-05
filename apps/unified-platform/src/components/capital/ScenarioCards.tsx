import type { SimulationScenario, ScenarioAction } from '@/types'
import { Badge, type BadgeTone } from './ui/Badge'

interface Props {
  scenarios: SimulationScenario[]
  actions: ScenarioAction[]
}

const SCENARIO_STYLES: Record<string, { tone: BadgeTone; label: string; accent: string; tint: string }> = {
  best:       { tone: 'success', label: 'Best',       accent: 'from-green-signal',  tint: 'bg-green-signal/[0.03]' },
  base:       { tone: 'warning', label: 'Base',       accent: 'from-amber-signal',  tint: 'bg-amber-signal/[0.03]' },
  disruption: { tone: 'danger',  label: 'Disruption', accent: 'from-red-signal',    tint: 'bg-red-signal/[0.03]'   },
}

export function ScenarioCards({ scenarios, actions }: Props) {
  const ORDER = ['best', 'base', 'disruption']
  const sorted = [...scenarios].sort(
    (a, b) => ORDER.indexOf(a.scenarioType) - ORDER.indexOf(b.scenarioType)
  )

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {sorted.map(scenario => {
        const style = SCENARIO_STYLES[scenario.scenarioType] ?? {
          tone: 'neutral' as BadgeTone, label: scenario.scenarioType, accent: 'from-text-muted', tint: '',
        }
        const scenarioActions = actions.filter(a => a.scenarioId === scenario.id)

        return (
          <div
            key={scenario.id}
            className={`relative bg-bg-card ${style.tint} border border-border-subtle rounded-xl overflow-hidden shadow-card transition-all hover:border-border-default hover:shadow-card-hover`}
          >
            {/* Top accent gradient */}
            <div className={`h-[2px] bg-gradient-to-r ${style.accent} to-transparent`} />

            <div className="p-4">
              <div className="flex items-center justify-between mb-2">
                <Badge tone={style.tone} size="sm" uppercase>
                  {style.label}
                </Badge>
                <span className="text-[20px] font-bold text-text-primary tabular-nums leading-none">
                  {Math.round(scenario.probability)}%
                </span>
              </div>
              <div className="text-[13px] font-semibold text-text-primary mb-1.5 leading-snug">
                {scenario.title}
              </div>
              <div className="text-[11px] text-text-muted mb-3 line-clamp-3 leading-relaxed">
                {scenario.narrative}
              </div>
              {scenarioActions.length > 0 && (
                <div className="border-t border-border-subtle pt-3 mt-3 space-y-1.5">
                  <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-text-inactive mb-1.5">
                    Recommended actions
                  </div>
                  {scenarioActions.map((a, i) => (
                    <div key={i} className="text-[11px] text-text-secondary flex items-baseline gap-2">
                      <span className="font-semibold text-indigo-active min-w-[3rem]">{a.ticker}</span>
                      <span className="text-text-muted">{a.action}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
