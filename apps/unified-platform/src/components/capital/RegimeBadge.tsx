import { Badge, type BadgeTone } from './ui/Badge'

interface Props {
  regime: string
  confidence: string
}

const CONFIDENCE_TONE: Record<string, BadgeTone> = {
  high: 'success',
  medium: 'warning',
  low: 'danger',
}

export function RegimeBadge({ regime, confidence }: Props) {
  const key = confidence.toLowerCase().replace(/\s+/g, ' ')
  const matchKey = Object.keys(CONFIDENCE_TONE).find(k => key.includes(k))
  const tone: BadgeTone = matchKey ? CONFIDENCE_TONE[matchKey] : 'neutral'

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <Badge tone="accent" size="sm">{regime}</Badge>
      <Badge tone={tone} size="sm">{confidence}</Badge>
    </div>
  )
}
