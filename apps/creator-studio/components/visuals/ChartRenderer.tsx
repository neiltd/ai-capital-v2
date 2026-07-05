'use client'

import { useRef } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { toPng } from 'html-to-image'
import { Button } from '@/components/ui/button'
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
    const png = await toPng(ref.current, { backgroundColor: '#09090b' })
    const a = document.createElement('a')
    a.href = png
    a.download = `chart-${Date.now()}.png`
    a.click()
  }

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-zinc-700 max-w-[85%]">
      <div ref={ref} className="bg-zinc-900 p-4">
        <p className="text-xs text-zinc-400 mb-1">{config.label}</p>
        <p className="text-2xl font-bold text-white mb-4">{config.stat}</p>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={config.data}>
            <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis hide />
            <Tooltip
              contentStyle={{ background: '#18181b', border: 'none', borderRadius: 8 }}
              labelStyle={{ color: '#a1a1aa' }}
              itemStyle={{ color: '#ffffff' }}
            />
            <Bar dataKey="value" fill="#6366f1" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center justify-between bg-zinc-800 px-3 py-2">
        <span className="text-xs text-zinc-400">Chart · {config.label}</span>
        <Button size="sm" variant="ghost" onClick={handleDownload}>
          <Download className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
