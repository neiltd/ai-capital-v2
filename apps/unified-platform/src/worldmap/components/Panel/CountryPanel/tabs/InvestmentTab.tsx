import type { Country } from '../../../../types/country'
import { T, Sec } from '../tokens'

interface Props { country: Country }

export default function InvestmentTab({ country: c }: Props) {
  return (
    <>
      <Sec label="Strengths">
        <div className="flex flex-col gap-2">
          {(c.investmentNotes?.strengths ?? []).map((s, i) => (
            <div key={i} className="flex gap-2.5 min-w-0">
              <span className="flex-shrink-0 text-emerald-500 font-bold text-[12px] mt-0.5">✓</span>
              <p className={`${T.body} min-w-0`}>{s}</p>
            </div>
          ))}
        </div>
      </Sec>

      <Sec label="Risks">
        <div className="flex flex-col gap-2">
          {(c.investmentNotes?.risks ?? []).map((r, i) => (
            <div key={i} className="flex gap-2.5 min-w-0">
              <span className="flex-shrink-0 text-red-500 font-bold text-[12px] mt-0.5">⚠</span>
              <p className={`${T.body} min-w-0`}>{r}</p>
            </div>
          ))}
        </div>
      </Sec>

      <Sec label="Key Sectors">
        <div className="flex flex-wrap gap-1.5">
          {(c.investmentNotes?.sectors ?? []).map(s => (
            <span key={s}
              className="text-[11px] px-2.5 py-1 bg-blue-950/50 text-blue-300 rounded-full border border-blue-800/60 break-words">
              {s}
            </span>
          ))}
        </div>
      </Sec>

      <Sec label="Sources">
        <div className="flex flex-col gap-1.5">
          {(c.sources ?? []).map((s, i) => (
            <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
              className="text-[11px] text-blue-400 hover:text-blue-300 underline break-words leading-relaxed">
              {s.name} ↗
            </a>
          ))}
        </div>
      </Sec>
    </>
  )
}
