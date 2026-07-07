// /today — Daily Briefing. The home route.
//
// Layout (12-col):
//   ┌──────────────────────────────────────────────────────────────┐
//   │ date · regime banner · confidence · calibration chip          │
//   ├───────────────────────────────────────────┬──────────────────┤
//   │ Recommended actions (8 cols)              │ Scenario outlook  │
//   │   ACT NOW / HOLD / DCA / LOCKED groups    │ Portfolio pulse   │
//   │   each row: badge · ticker · conviction   │ Wash-sale windows │
//   │   (calibrated) · rationale · tax chips    │ World top events  │
//   ├───────────────────────────────────────────┤ Things to watch   │
//   │ Full narrative (rendered markdown)        │                   │
//   └───────────────────────────────────────────┴──────────────────┘
//
// Server component; the only client piece is the expandable action rows.

import { loadBriefing } from './data'
import {
  SectionCard,
  Label,
  AsOf,
  ActionBadge,
  ConvictionBadge,
  AlertBanner,
} from '../_shared/ui'
import { ProbBar } from '../_shared/charts'
import { fmtUsd, fmtSignedUsd } from '../_shared/format'

const SCENARIO_ICON: Record<string, string> = { best: '◔', base: '◑', disruption: '◕', whatif: '○' }
const CONFIDENCE_TONE: Record<string, string> = {
  high: 'text-gain',
  medium: 'text-status-warning',
  low: 'text-status-serious',
}
const TRIM_ACCURACY = { pct: 76.5, horizon: '7d' } // from calibration.json (gap #1: join per-action)

export default async function BriefingPage() {
  const b = await loadBriefing()

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      {/* ------------------------------- header ------------------------------ */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Label>Daily briefing · {b.date}</Label>
          <h1 className="mt-1 text-[20px] font-semibold leading-7 text-ink">
            {b.regime.regime}
            <span className={`ml-3 text-[13px] font-medium uppercase ${CONFIDENCE_TONE[b.regime.confidence]}`}>
              {b.regime.confidence} confidence
            </span>
          </h1>
          <p className="mt-1 max-w-[72ch] text-[14px] leading-[21px] text-ink-2">{b.regime.rationale}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {b.regime.keyIndicators.map((k) => (
              <span key={k} className="tnum rounded-chip bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3">
                {k}
              </span>
            ))}
          </div>
        </div>
        <AsOf iso={b.generatedAt} />
      </header>

      {/* Calibration honesty — always visible above the recommendations. */}
      <AlertBanner level="info" title="Calibration" detail={b.calibrationNote} />

      <div className="grid grid-cols-12 gap-6">
        {/* --------------------------- left: actions --------------------------- */}
        <div className="col-span-12 space-y-6 xl:col-span-8">
          {b.actionGroups.map((g) => (
            <SectionCard
              key={g.group}
              title={
                <span className={g.group === 'act' ? 'text-status-serious' : undefined}>{g.title}</span>
              }
            >
              <ul className="divide-y divide-hairline">
                {g.actions.map((a) => (
                  <li key={a.id} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <ActionBadge action={g.group === 'dca' ? 'dca' : a.action} />
                      {/* ticker = universal link → position side panel */}
                      <a href={`/portfolio?ticker=${a.ticker}`} className="text-[14px] font-semibold text-ink hover:text-accent">
                        {a.ticker}
                      </a>
                      {a.allocationChangePct !== 0 && (
                        <span className="tnum text-[13px] text-ink-3">{a.allocationChangePct > 0 ? '+' : ''}{a.allocationChangePct}%</span>
                      )}
                      <ConvictionBadge
                        conviction={a.conviction}
                        downgraded={a.convictionDowngraded}
                        accuracy={a.action === 'trim' ? TRIM_ACCURACY : undefined}
                      />
                      {a.harvestableUsd != null && (
                        <span className="rounded-chip border border-hairline px-1.5 py-0.5 text-[11px] text-ink-2" title="Loss offsets YTD taxable gains">
                          harvestable {fmtSignedUsd(a.harvestableUsd)}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[13px] leading-5 text-ink-2">{a.rationale}</p>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ))}

          {/* Full narrative markdown lives below the fold; anchor-linked from
              the sections above. Render with the app's markdown pipeline. */}
          <SectionCard title="Full narrative">
            <p className="text-[13px] text-ink-3">
              Rendered briefing markdown (world-intel table, thesis status, key people, scenario
              narratives) — same document as <code>briefings/{b.date}.md</code>, with tickers
              auto-linked to their position panels.
            </p>
          </SectionCard>
        </div>

        {/* ---------------------------- right rail ----------------------------- */}
        <div className="col-span-12 space-y-6 xl:col-span-4">
          <SectionCard title="Scenario outlook">
            {b.scenarios.map((s) => (
              <ProbBar
                key={s.id}
                title={s.title}
                probability={s.probability}
                horizon={s.timeHorizon}
                icon={SCENARIO_ICON[s.scenarioType]}
              />
            ))}
            <p className="mt-2 text-[11px] leading-4 text-ink-3">
              Probabilities from today&apos;s scenario-simulator run. Icons denote best / base /
              disruption — identity is never bar color.
            </p>
          </SectionCard>

          <SectionCard title="Portfolio pulse" actions={<a href="/portfolio/risk" className="text-[12px] text-accent">Risk →</a>}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              {(
                [
                  ['Net worth', fmtUsd(b.pulse.netWorthUsd)],
                  ['Sharpe 90d', b.pulse.sharpe.toFixed(2)],
                  ['1d VaR 95%', fmtUsd(b.pulse.oneDayVAR95)],
                  ['β vs VOO', b.pulse.beta.toFixed(2)],
                  ['Max DD', (b.pulse.maxDrawdown * 100).toFixed(1) + '%'],
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
            <SectionCard title="Wash-sale windows">
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

          <SectionCard title="World — top events" actions={<a href="/world" className="text-[12px] text-accent">Map →</a>}>
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

          <SectionCard title="Things to watch">
            <ul className="space-y-2.5">
              {b.watchItems.map((w) => (
                <li key={w.trigger} className="flex items-start gap-2">
                  <span
                    className={`mt-0.5 text-[11px] font-semibold uppercase ${
                      w.kind === 'bull' ? 'text-gain' : w.kind === 'bear' ? 'text-loss' : 'text-ink-3'
                    }`}
                  >
                    {w.kind === 'bull' ? '▲' : w.kind === 'bear' ? '▼' : '•'}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] leading-5 text-ink">
                      {w.trigger}
                      <span className="ml-2 text-ink-3">{w.tickers.join(' ')}</span>
                    </div>
                    <p className="text-[12px] leading-4 text-ink-3">{w.why}</p>
                  </div>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      </div>
    </main>
  )
}

/** Severity 1–5 → status color + numeric label (never color alone). */
function SeverityPip({ severity }: { severity: number }) {
  const color =
    severity >= 5 ? '#d03b3b' : severity >= 4 ? '#ec835a' : severity >= 3 ? '#fab219' : '#898781'
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
