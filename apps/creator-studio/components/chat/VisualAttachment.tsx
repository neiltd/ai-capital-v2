'use client'

import { Button } from '@/components/ui/button'
import { Download } from 'lucide-react'
import { ChartRenderer } from '@/components/visuals/ChartRenderer'

interface Props {
  type: 'chart' | 'card' | 'illustration'
  url?: string
  chartConfig?: object
  label: string
}

export function VisualAttachment({ type, url, chartConfig, label }: Props) {
  if (type === 'chart' && chartConfig) {
    return <ChartRenderer config={chartConfig as any} />
  }

  const handleDownload = () => {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = `${type}-${Date.now()}.png`
    a.click()
  }

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-zinc-700 max-w-[85%]">
      <img src={url} alt={label} className="w-full object-cover" />
      <div className="flex items-center justify-between bg-zinc-800 px-3 py-2">
        <span className="text-xs text-zinc-400 capitalize">{type} · {label}</span>
        <Button size="sm" variant="ghost" onClick={handleDownload}>
          <Download className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
