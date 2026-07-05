'use client'

import { useState } from 'react'
import type { TradeAction } from '@/types'
import { Card, CardHeader } from './ui/Card'
import { TradeSignalRow } from './TradeSignalRow'

const HIDE_BELOW_CONFIDENCE = 60

export function ShortSetupsTable({
  signals,
  sparkByTicker,
}: {
  signals: TradeAction[]
  sparkByTicker: Map<string, number[]>
}) {
  const [showAll, setShowAll] = useState(false)

  const hiddenCount = signals.filter(s => s.confidence < HIDE_BELOW_CONFIDENCE).length
  const visible = showAll ? signals : signals.filter(s => s.confidence >= HIDE_BELOW_CONFIDENCE)

  return (
    <Card>
      <CardHeader
        title="Short Setups"
        meta={`${signals.length} · showing ${visible.length}`}
      />
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-bg-subtle border-b border-border-subtle">
              {['Ticker', 'Signal', 'Wave', 'Confidence', 'R:R', 'Risk Geometry', 'Entry Zone', 'Stop', 'Target', '30D'].map(h => (
                <th key={h} className="text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive px-4 py-2.5 whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map(a => (
              <TradeSignalRow key={a.ticker} action={a} sparkValues={sparkByTicker.get(a.ticker)} />
            ))}
          </tbody>
        </table>
      </div>
      {!showAll && hiddenCount > 0 && (
        <div className="px-4 py-2.5 text-[11px] text-text-inactive border-t border-border-subtle">
          {hiddenCount} short setup{hiddenCount === 1 ? '' : 's'} below {HIDE_BELOW_CONFIDENCE}% confidence hidden
          {' · '}
          <button onClick={() => setShowAll(true)} className="text-indigo-active hover:underline">
            show all
          </button>
        </div>
      )}
    </Card>
  )
}
