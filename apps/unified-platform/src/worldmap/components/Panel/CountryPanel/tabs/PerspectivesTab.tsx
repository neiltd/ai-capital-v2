import type { Country } from '../../../../types/country'
import { T } from '../tokens'

interface Props { country: Country }

export default function PerspectivesTab({ country: c }: Props) {
  return (
    <>
      <div className="px-3 py-2.5 bg-bg-card border border-border-subtle rounded-lg">
        <p className={`${T.label} leading-relaxed`}>
          Competing narratives presented without endorsement.<br />
          Read all views before drawing conclusions.
        </p>
      </div>
      {(c.perspectives ?? []).map((p, i) => (
        <div key={i} className={`${T.card} p-3`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2">
            <span className="text-[12px] font-semibold text-blue-300 break-words">{p.source}</span>
            <span className="text-[10px] px-2 py-0.5 bg-bg-elevated rounded text-text-inactive">{p.bias}</span>
          </div>
          <p className={T.body}>{p.view}</p>
        </div>
      ))}
    </>
  )
}
