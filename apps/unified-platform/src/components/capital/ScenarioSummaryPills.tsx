import { Badge, type BadgeTone } from './ui/Badge'

interface Scenario {
  scenarioType: string
  title: string
  probability: number
  timeHorizon: string
}

interface Props {
  scenarios: Scenario[]
}

const TYPE_TONE: Record<string, BadgeTone> = {
  best: 'success',
  base: 'warning',
  disruption: 'danger',
}

export function ScenarioSummaryPills({ scenarios }: Props) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap justify-end">
      {scenarios.map(s => {
        const tone = TYPE_TONE[s.scenarioType] ?? 'neutral'
        const label = s.scenarioType.charAt(0).toUpperCase() + s.scenarioType.slice(1)
        return (
          <Badge key={s.scenarioType} tone={tone} size="sm">
            {label} {Math.round(s.probability)}%
          </Badge>
        )
      })}
    </div>
  )
}
