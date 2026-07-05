'use client'

import { useRef } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { toPng } from 'html-to-image'
import { Button } from '@/components/studio/ui/button'
import { Download } from 'lucide-react'

interface ChartConfig {
  type: string
  label: string
  stat: string
  data: { name: string; value: number }[]
}

export function ChartRenderer({ config }: { config: ChartConfig }) {
  const ref = useRef<HTMLDivElement>(null)

  const handleDownload = async () => {
    if (!ref.current) return
    const png = await toPng(ref.current, { backgroundColor: '#0f1011' })
    const a = document.createElement('a')
    a.href = png
    a.download = `chart-${Date.now()}.png`
    a.click()
  }

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-border-subtle max-w-[85%]">
      <div ref={ref} className="bg-bg-card p-4">
        <p className="text-xs text-text-muted mb-1">{config.label}</p>
        <p className="text-2xl font-bold text-text-primary mb-4">{config.stat}</p>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={config.data}>
            <XAxis dataKey="name" tick={{ fill: '#8a8f98', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis hide />
            <Tooltip
              contentStyle={{ background: '#18191a', border: '1px solid #23252a', borderRadius: 8 }}
              labelStyle={{ color: '#8a8f98' }}
              itemStyle={{ color: '#f7f8f8' }}
            />
            <Bar dataKey="value" fill="#5e6ad2" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center justify-between bg-bg-elevated px-3 py-2">
        <span className="text-xs text-text-muted">Chart · {config.label}</span>
        <Button size="sm" variant="ghost" onClick={handleDownload}>
          <Download className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
