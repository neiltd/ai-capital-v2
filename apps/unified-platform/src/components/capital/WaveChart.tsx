'use client'
import { useEffect, useRef } from 'react'
import type { WaveAsset } from '@/types'

export function WaveChart({ asset }: { asset: WaveAsset }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current || asset.candles.length === 0) return

    let chart: any
    let resizeCleanup: (() => void) | undefined

    ;(async () => {
      const { createChart } = await import('lightweight-charts')
      if (!containerRef.current) return

      chart = createChart(containerRef.current, {
        width:  containerRef.current.clientWidth,
        height: 480,
        layout: {
          background: { color: '#0a0b0d' },
          textColor: '#8a8f98',
        },
        grid: {
          vertLines: { color: '#1a1c20' },
          horzLines: { color: '#1a1c20' },
        },
        timeScale:       { borderColor: '#23252a' },
        rightPriceScale: { borderColor: '#23252a' },
      })

      const candleSeries = chart.addCandlestickSeries({
        upColor:     '#22c55e',
        downColor:   '#ef4444',
        borderVisible: false,
        wickUpColor: '#22c55e',
        wickDownColor: '#ef4444',
      })
      candleSeries.setData(asset.candles.map(c => ({
        time: c.date, open: c.open, high: c.high, low: c.low, close: c.close,
      })))

      if (asset.wavePivots.length >= 2) {
        const lineSeries = chart.addLineSeries({
          color: '#5e6ad2', lineWidth: 1, lineStyle: 2,
        })
        lineSeries.setData(asset.wavePivots.map(p => ({ time: p.date, value: p.price })))

        candleSeries.setMarkers(asset.wavePivots.map(p => {
          const isOddLabel = ['1', '3', '5', 'A', 'C'].includes(p.label)
          const position = asset.waveDirection === 'up'
            ? (isOddLabel ? 'aboveBar' : 'belowBar')
            : (isOddLabel ? 'belowBar' : 'aboveBar')
          return {
            time:     p.date as any,
            position,
            color:    ['2', '4', 'B'].includes(p.label) ? '#f59e0b' : '#5e6ad2',
            shape:    'circle',
            text:     p.label,
            size:     1,
          }
        }))
      }

      const resize = () => {
        if (containerRef.current) chart?.applyOptions({ width: containerRef.current.clientWidth })
      }
      window.addEventListener('resize', resize)
      resizeCleanup = () => window.removeEventListener('resize', resize)
    })()

    return () => {
      chart?.remove()
      resizeCleanup?.()
    }
  }, [asset])

  if (asset.candles.length === 0) {
    return (
      <div className="w-full bg-[#0a0b0d] rounded-[8px] border border-[#23252a] flex items-center justify-center"
        style={{ height: 480 }}>
        <span className="text-sm text-[#8a8f98]">No chart data</span>
      </div>
    )
  }

  return (
    <div ref={containerRef}
      className="w-full rounded-[8px] overflow-hidden border border-[#23252a]"
      style={{ height: 480 }} />
  )
}
