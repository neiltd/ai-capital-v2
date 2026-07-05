'use client'

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { format } from 'date-fns'
import { Card } from '@/components/capital/ui/Card'

interface Snapshot {
  date: string
  followers: number
}

export function FollowerChart({ data }: { data: Snapshot[] }) {
  const formatted = data.map(d => ({
    ...d,
    date: format(new Date(d.date), 'MMM d'),
  }))

  return (
    <Card padded>
      <p className="text-xs text-text-muted mb-3">Follower Growth</p>
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={formatted}>
          <XAxis dataKey="date" tick={{ fill: '#8a8f98', fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis hide />
          <Tooltip
            contentStyle={{ background: '#18191a', border: '1px solid #23252a', borderRadius: 8 }}
            labelStyle={{ color: '#8a8f98' }}
            itemStyle={{ color: '#f7f8f8' }}
          />
          <Line type="monotone" dataKey="followers" stroke="#828fff" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </Card>
  )
}
