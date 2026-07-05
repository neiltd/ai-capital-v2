'use client'

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { format } from 'date-fns'

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
    <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
      <p className="text-xs text-zinc-400 mb-3">Follower Growth</p>
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={formatted}>
          <XAxis dataKey="date" tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis hide />
          <Tooltip
            contentStyle={{ background: '#18181b', border: 'none', borderRadius: 8 }}
            labelStyle={{ color: '#a1a1aa' }}
            itemStyle={{ color: '#ffffff' }}
          />
          <Line type="monotone" dataKey="followers" stroke="#6366f1" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
