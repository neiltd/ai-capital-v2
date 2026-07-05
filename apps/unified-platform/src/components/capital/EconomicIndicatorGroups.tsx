'use client'
import { useState } from 'react'
import type { EconomicIndicator } from '@/types'
import { Card } from './ui/Card'
import { Badge, signalTone } from './ui/Badge'
import { SectionTitle } from './ui/PageHeader'

type Mode = 'yoy' | 'qoq'

const CATEGORY_ORDER = ['inflation', 'labour', 'consumer', 'credit']
const CATEGORY_LABEL: Record<string, string> = {
  inflation: 'Inflation',
  labour:    'Labour',
  consumer:  'Consumer',
  credit:    'Credit',
}

function alertColor(ind: EconomicIndicator): string {
  if (ind.seriesId === 'DRCCLACBS'  && ind.value > 2.5) return 'text-amber-signal'
  if (ind.seriesId === 'DRSFRMACBS' && ind.value > 1.5) return 'text-amber-signal'
  if (ind.seriesId === 'UNRATE'     && ind.value > 4.5) return 'text-amber-signal'
  return 'text-text-primary'
}

function formatValue(ind: EconomicIndicator): string {
  const v = ind.value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (ind.unit === 'Percent') return `${v}%`
  if (ind.unit === 'Thousands') return `${v}K`
  return v
}

function formatChange(pct: number | null): { text: string; color: string; arrow: string } {
  if (pct == null) return { text: '—', color: 'text-text-faint', arrow: '' }
  const sign = pct >= 0 ? '+' : ''
  const color = pct > 0 ? 'text-green-signal' : pct < 0 ? 'text-red-signal' : 'text-text-muted'
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '◆'
  return { text: `${sign}${pct.toFixed(1)}%`, color, arrow }
}

function IndicatorRow({ ind, mode }: { ind: EconomicIndicator; mode: Mode }) {
  const change = formatChange(mode === 'yoy' ? ind.changeYoY : ind.changeQoQ)

  return (
    <div className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-[12px] text-text-secondary truncate">{ind.label}</div>
        <div className="text-[10px] text-text-inactive tabular-nums mt-0.5">released {ind.releaseDate}</div>
      </div>
      <div className="flex items-center gap-2.5 flex-shrink-0">
        <div className="text-right">
          <div className={`text-[13px] font-semibold tabular-nums ${alertColor(ind)}`}>{formatValue(ind)}</div>
          <div className={`text-[10px] font-medium tabular-nums inline-flex items-center gap-0.5 justify-end ${change.color}`}>
            {change.arrow && <span className="text-[8px]">{change.arrow}</span>}
            {change.text}
          </div>
        </div>
        <Badge tone={signalTone(ind.trend)} size="xs">
          {ind.trend}
        </Badge>
      </div>
    </div>
  )
}

export function EconomicIndicatorGroups({ indicators }: { indicators: EconomicIndicator[] }) {
  const [mode, setMode] = useState<Mode>('yoy')
  if (!indicators?.length) return null

  const byCategory = new Map<string, EconomicIndicator[]>()
  for (const ind of indicators) {
    const list = byCategory.get(ind.category) ?? []
    list.push(ind)
    byCategory.set(ind.category, list)
  }
  const categories = Array.from(byCategory.keys()).sort(
    (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)
  )

  return (
    <section>
      <SectionTitle
        count={indicators.length}
        action={
          <div className="inline-flex bg-bg-elevated border border-border-subtle rounded-md p-0.5">
            {(['yoy', 'qoq'] as Mode[]).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider rounded transition-all ${
                  mode === m
                    ? 'bg-bg-card text-text-primary shadow-sm'
                    : 'text-text-inactive hover:text-text-secondary'
                }`}
              >
                {m === 'yoy' ? 'YoY' : 'QoQ'}
              </button>
            ))}
          </div>
        }
      >
        Economic Indicators
      </SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {categories.map(cat => {
          const group = byCategory.get(cat)!
          return (
            <Card key={cat} padded>
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-block w-1 h-3 bg-accent-primary/70 rounded-full" />
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">
                  {CATEGORY_LABEL[cat] ?? cat}
                </h3>
              </div>
              <div className="divide-y divide-border-subtle">
                {group.map(ind => (
                  <IndicatorRow key={ind.seriesId} ind={ind} mode={mode} />
                ))}
              </div>
            </Card>
          )
        })}
      </div>
    </section>
  )
}
