// /today — Daily Briefing. The home route of the redesign.
//
// Layout (12-col):
//   ┌──────────────────────────────────────────────────────────────┐
//   │ date · regime banner · confidence · calibration banner        │
//   ├───────────────────────────────────────────┬──────────────────┤
//   │ Recommended actions (8 cols)              │ Scenario outlook  │
//   │   ACT NOW / HOLD / DCA / LOCKED groups    │ Portfolio pulse   │
//   │   each row: badge · ticker · conviction   │ Wash-sale windows │
//   │   (calibrated) · rationale · tax chips    │ World top events  │
//   ├───────────────────────────────────────────┤ Things to watch   │
//   │ Full narrative (rendered markdown)        │                   │
//   └───────────────────────────────────────────┴──────────────────┘
//
// Adapted from design-redesign-2026-07/screens/briefing, now wired to the
// real briefings/YYYY-MM-DD.json envelope (backend gap #1, built alongside
// this screen) instead of a 5-envelope stitch of illustrative sample data.

export const dynamic = 'force-dynamic'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { loadBriefing } from './data'
import { DatePicker } from './date-picker'
import { listBriefingDates, todayLocal } from '@/lib/data'
import { SectionCard, Label, AsOf, ActionBadge, ConvictionBadge, AlertBanner } from '@/components/next/ui'
import { ProbBar } from '@/components/next/charts'
import { CoverageCallout, worldCoverageNotice } from '@/components/next/coverage-notice'
import { fmtUsd, fmtSignedUsd } from '@/lib/next/format'

const SCENARIO_ICON: Record<string, string> = { best: '◔', base: '◑', disruption: '◕' }
const CONFIDENCE_TONE: Record<string, string> = {
  high: 'text-gain',
  medium: 'text-status-warning',
  low: 'text-status-serious',
}

export default function BriefingPage({ searchParams }: { searchParams?: { date?: string } }) {
  const today = todayLocal()
  const dates = listBriefingDates()
  const selectedDate = searchParams?.date || today
  const b = loadBriefing(selectedDate)
  const worldNotice = worldCoverageNotice()

  if (!b) {
    return (
      <main className="mx-auto max-w-[1520px] space-y-sec-gap p-page-pad">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Label>Daily briefing</Label>
          {dates.length > 0 && <DatePicker dates={dates} selected={selectedDate} today={today} />}
        </div>
        <AlertBanner
          level="warning"
          title="Briefing unavailable"
          detail={
            selectedDate === today
              ? "No structured briefing.json for today — has today's pipeline run?"
              : `No archived briefing.json for ${selectedDate}.`
          }
        />
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-[1520px] space-y-sec-gap p-page-pad">
      {/* ------------------------------- header ------------------------------ */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <Label>Daily briefing · {b.date}</Label>
            <DatePicker dates={dates} selected={selectedDate} today={today} />
          </div>
          <h1 className="mt-1 text-[20px] font-semibold leading-7 text-ink">
            {b.regime.regime}
            <span className={`ml-3 text-[13px] font-medium uppercase ${CONFIDENCE_TONE[b.regime.confidence] ?? 'text-ink-3'}`}>
              {b.regime.confidence} confidence
            </span>
          </h1>
          <p className="mt-1 max-w-[72ch] text-[14px] leading-[21px] text-ink-2">{b.regime.rationale}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {b.regime.keyIndicators.map((k) => (
              <span key={k} className="rounded-chip bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3">{k}</span>
            ))}
          </div>
        </div>
        <AsOf iso={b.generatedAt} />
      </header>

      {/* Point-in-time vs. live disclosure — the right-rail panels below
          (pulse/risk, wash-sale, world events) always read today's live
          state, never the viewed date's, since none of those have a
          per-date archive yet. Say so plainly rather than let a past-date
          view imply they're historical too. */}
      {!b.isToday && (
        <AlertBanner
          level="serious"
          title={`Viewing ${b.date}`}
          detail="Narrative and recommended actions are archived from that date. Portfolio pulse, wash-sale windows, and world events on the right are today's live state, not this date's — there's no historical snapshot of those yet."
        />
      )}

      {/* Calibration honesty — always visible above the recommendations. */}
      {b.calibrationNote && <AlertBanner level="info" title="Calibration" detail={b.calibrationNote} />}

      <div className="grid grid-cols-12 gap-sec-gap">
        {/* --------------------------- left: actions --------------------------- */}
        <div className="col-span-12 space-y-6 xl:col-span-8">
          {b.actionGroups.map((g) => (
            <SectionCard key={g.group} title={<span className={g.group === 'act' ? 'text-status-serious' : undefined}>{g.title}</span>}>
              <ul className="divide-y divide-hairline">
                {g.actions.map((a) => (
                  <li key={a.id} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <ActionBadge action={g.group === 'dca' ? 'dca' : a.action} />
                      <a href={`/portfolio?ticker=${a.ticker}`} className="text-[14px] font-semibold text-ink hover:text-accent">
                        {a.ticker}
                      </a>
                      {a.allocationChangePct !== 0 && (
                        <span className="tnum text-[13px] text-ink-3">
                          {a.allocationChangePct > 0 ? '+' : ''}{a.allocationChangePct}%
                        </span>
                      )}
                      <ConvictionBadge conviction={a.conviction} downgraded={a.convictionDowngraded} />
                      {a.harvestableUsd != null && (
                        <span className="rounded-chip border border-hairline px-1.5 py-0.5 text-[11px] text-ink-2" title="Loss offsets YTD taxable gains">
                          harvestable {fmtSignedUsd(-a.harvestableUsd)}
                        </span>
                      )}
                      {a.washSaleNote && (
                        <span className="rounded-chip border border-status-warning px-1.5 py-0.5 text-[11px] text-status-warning">
                          {a.washSaleNote}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[13px] leading-5 text-ink-2">{a.rationale}</p>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ))}

          {b.narrativeMd && (
            <SectionCard title="Full narrative">
              <article className="briefing-prose">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{b.narrativeMd}</ReactMarkdown>
              </article>
            </SectionCard>
          )}
        </div>

        {/* ---------------------------- right rail ----------------------------- */}
        <div className="col-span-12 space-y-6 xl:col-span-4">
          <SectionCard title="Scenario outlook">
            {b.scenarios.map((s) => (
              <ProbBar key={s.id} title={s.title} probability={s.probability / 100} horizon={s.timeHorizon} icon={SCENARIO_ICON[s.scenarioType]} />
            ))}
            <p className="mt-2 text-[11px] leading-4 text-ink-3">
              Probabilities from {b.isToday ? "today's" : "that date's"} scenario-simulator run, archived with the briefing. Icons denote best / base / disruption — identity is never bar color.
            </p>
          </SectionCard>

          <SectionCard title="Portfolio pulse (today)" actions={<a href="/portfolio/risk" className="text-[12px] text-accent">Risk →</a>}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              {(
                [
                  ['Net worth', b.pulse.netWorthUsd != null ? fmtUsd(b.pulse.netWorthUsd) : '—'],
                  ['Sharpe 90d', b.pulse.sharpe != null ? b.pulse.sharpe.toFixed(2) : '—'],
                  ['1d VaR 95%', b.pulse.oneDayVAR95 != null ? fmtUsd(b.pulse.oneDayVAR95) : '—'],
                  ['β vs VOO', b.pulse.beta != null ? b.pulse.beta.toFixed(2) : '—'],
                  ['Max DD', b.pulse.maxDrawdown != null ? (b.pulse.maxDrawdown * 100).toFixed(1) + '%' : '—'],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <Label>{k}</Label>
                  <div className="tnum text-[16px] font-semibold text-ink">{v}</div>
                </div>
              ))}
            </dl>
          </SectionCard>

          {b.washSale.length > 0 && (
            <SectionCard title="Wash-sale windows (today)">
              <ul className="space-y-2">
                {b.washSale.map((w) => (
                  <li key={w.ticker + w.doNotRebuyBefore}>
                    <AlertBanner
                      level={w.daysRemaining <= 2 ? 'critical' : 'warning'}
                      title={w.ticker}
                      detail={`do not rebuy before ${w.doNotRebuyBefore}`}
                      trailing={<span className="tnum text-[13px] font-semibold text-ink">{w.daysRemaining}d</span>}
                    />
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          {/* The section used to vanish entirely when the list was empty, which
              is the quietest possible way to say "nothing happened". It now also
              renders when coverage is degraded, so an empty world feed cannot
              silently read as a calm day. */}
          {(b.worldTop.length > 0 || worldNotice) && (
            <SectionCard title="World — top events (today)" actions={<a href="/world/intel" className="text-[12px] text-accent">More →</a>}>
              {worldNotice && <div className="mb-2"><CoverageCallout where="today's world events" notice={worldNotice} /></div>}
              {b.worldTop.length === 0 && (
                <p className="text-[12px] leading-5 text-ink-3">
                  Cannot establish whether significant events occurred — coverage above is incomplete.
                </p>
              )}
              <ul className="divide-y divide-hairline">
                {b.worldTop.map((e) => (
                  <li key={e.eventId} className="py-2 first:pt-0 last:pb-0">
                    <div className="flex items-start gap-2">
                      <SeverityPip severity={e.severity} />
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium leading-5 text-ink">{e.title}</div>
                        <p className="mt-0.5 text-[12px] leading-4 text-ink-3">{e.summary}</p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          {b.watchItems.length > 0 && (
            <SectionCard title="Things to watch">
              <ul className="space-y-2.5">
                {b.watchItems.map((w) => (
                  <li key={w.trigger} className="flex items-start gap-2">
                    <span className={`mt-0.5 text-[11px] font-semibold uppercase ${
                      w.kind === 'bull' ? 'text-gain' : w.kind === 'bear' ? 'text-loss' : 'text-ink-3'
                    }`}>
                      {w.kind === 'bull' ? '▲' : w.kind === 'bear' ? '▼' : '•'}
                    </span>
                    <div className="min-w-0">
                      <div className="text-[13px] leading-5 text-ink">
                        {w.trigger}
                        {w.tickers.length > 0 && <span className="ml-2 text-ink-3">{w.tickers.join(' ')}</span>}
                      </div>
                      <p className="text-[12px] leading-4 text-ink-3">{w.why}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}
        </div>
      </div>
    </main>
  )
}

/** Severity 1-5 → status color + numeric label (never color alone). */
function SeverityPip({ severity }: { severity: number }) {
  const color = severity >= 5 ? '#d03b3b' : severity >= 4 ? '#ec835a' : severity >= 3 ? '#fab219' : '#898781'
  return (
    <span
      className="tnum mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
      style={{ backgroundColor: color }}
      title={`Severity ${severity}/5`}
    >
      {severity}
    </span>
  )
}
