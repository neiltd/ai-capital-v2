import type { Country } from '../../../../types/country'
import { T, Sec } from '../tokens'

interface Props { country: Country }

export default function HistoryTab({ country: c }: Props) {
  return (
    <>
      <p className={T.body}>{c.historicalContext?.summary}</p>
      <Sec label="Key Events">
        <div className="relative flex flex-col gap-3.5">
          {/* Vertical timeline line */}
          <div className="absolute left-[3.25rem] top-1 bottom-1 w-px bg-[#1E2D4A]" />
          {(c.historicalContext?.keyEvents ?? []).map((e, i) => (
            <div key={i} className="flex items-start gap-3 min-w-0">
              <span className={`flex-shrink-0 w-11 text-right text-[11px] ${T.mono} pt-0.5 tabular-nums`}>
                {e.year}
              </span>
              <div className="flex-shrink-0 w-2.5 h-2.5 rounded-full bg-[#0A0F1E] border-2 border-blue-500 mt-1 relative z-10" />
              <p className={`${T.body} min-w-0 flex-1`}>{e.event}</p>
            </div>
          ))}
        </div>
      </Sec>
    </>
  )
}
