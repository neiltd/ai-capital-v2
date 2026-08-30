// Compact ARTICLE-coverage callout. Server component, read-only. Reports on the
// RSS feeds these pages actually consume — not the structured/energy sources,
// which have their own consumers and their own surface at /system. Renders
// NOTHING when every enabled feed is current.
import { readArticleCoverage } from '@/lib/data'
import { buildCoverageNotice, type CoverageNotice } from '@/lib/coverage-notice'

/** Callers that must also branch on presence can compute once and pass it in. */
export function worldCoverageNotice(): CoverageNotice | null {
  return buildCoverageNotice(readArticleCoverage())
}

const TONE = {
  warning: 'border-amber-400/60 bg-amber-50/50 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200',
  error:   'border-red-400/60 bg-red-50/50 dark:bg-red-950/20 text-red-900 dark:text-red-200',
} as const

/** `where` names the section this qualifies, so it never reads as a global banner. */
export function CoverageCallout({ where, notice: given }: { where: string; notice?: CoverageNotice | null }) {
  const notice = given === undefined ? worldCoverageNotice() : given
  if (!notice) return null      // materiality: quiet when coverage is complete

  return (
    <div className={`rounded-lg border px-3 py-2 text-[12px] leading-5 ${TONE[notice.level]}`} role="status">
      <div className="font-semibold">{notice.headline}</div>
      <p className="mt-0.5">{notice.detail}</p>
      {notice.sources.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {notice.sources.map(s => (
            <li key={s.source}>
              <span className="font-medium">{s.source}</span> — {s.reason}
              {s.availability === 'restricted' && ' (not fixable by retry — requires a subscription change)'}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 opacity-80">Applies to {where}. Full feed status: <a className="underline" href="/system">/system</a></p>
    </div>
  )
}
