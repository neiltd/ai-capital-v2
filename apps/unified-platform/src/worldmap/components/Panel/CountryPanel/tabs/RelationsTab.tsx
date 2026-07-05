import type { Country } from '../../../../types/country'
import { T } from '../tokens'

const REL_BORDER: Record<string, string> = {
  ally: 'border-emerald-600', treaty_ally: 'border-emerald-600',
  strategic_partner: 'border-blue-600', trade_partner: 'border-sky-600',
  neutral: 'border-slate-600', contested: 'border-amber-600',
  rival: 'border-orange-600', enemy: 'border-red-600',
}
const REL_BADGE: Record<string, string> = {
  ally:             'bg-emerald-900/60 text-emerald-300 border-emerald-700',
  treaty_ally:      'bg-emerald-900/60 text-emerald-300 border-emerald-700',
  strategic_partner:'bg-blue-900/60 text-blue-300 border-blue-700',
  trade_partner:    'bg-sky-900/60 text-sky-300 border-sky-700',
  neutral:          'bg-slate-800 text-slate-400 border-slate-600',
  contested:        'bg-amber-900/60 text-amber-300 border-amber-700',
  rival:            'bg-orange-900/60 text-orange-300 border-orange-700',
  enemy:            'bg-red-900/60 text-red-300 border-red-700',
}

interface Props { country: Country }

export default function RelationsTab({ country: c }: Props) {
  return (
    <>
      <p className={T.label}>{c.relationships?.length ?? 0} key bilateral relationships</p>
      {(c.relationships ?? []).map((r, i) => (
        <div key={i}
          className={`${T.card} p-3 border-l-2 ${REL_BORDER[r.type] ?? 'border-slate-600'}`}
          style={{ borderLeftWidth: 3 }}>
          <div className="flex items-start justify-between gap-2 mb-1.5 min-w-0">
            <span className="text-[13px] font-semibold text-text-primary break-words min-w-0 flex-1 leading-snug">
              {r.countryName}
            </span>
            <span className={`flex-shrink-0 text-[10px] px-2 py-0.5 rounded-full border font-medium whitespace-nowrap ${REL_BADGE[r.type] ?? REL_BADGE.neutral}`}>
              {r.type.replace(/_/g, ' ')}
            </span>
          </div>
          <p className={`${T.body} text-text-muted`}>{r.summary}</p>
        </div>
      ))}
    </>
  )
}
