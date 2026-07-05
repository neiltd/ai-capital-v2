'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function GrowthForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [followers, setFollowers] = useState('')
  const [profileViews, setProfileViews] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    await fetch('/api/growth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ followers: Number(followers), profileViews: Number(profileViews) || 0 }),
    })
    setLoading(false)
    setOpen(false)
    setFollowers('')
    setProfileViews('')
    onSaved()
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="text-xs">
        + Log Followers
      </Button>
    )
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
      <p className="text-xs font-medium text-zinc-400">Log today's follower count</p>
      <Input placeholder="Followers" type="number" value={followers} onChange={e => setFollowers(e.target.value)} required className="bg-zinc-800 border-zinc-700 text-sm" />
      <Input placeholder="Profile views (optional)" type="number" value={profileViews} onChange={e => setProfileViews(e.target.value)} className="bg-zinc-800 border-zinc-700 text-sm" />
      <div className="flex gap-2">
        <Button type="submit" disabled={loading} size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-xs">
          {loading ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} className="text-xs">
          Cancel
        </Button>
      </div>
    </form>
  )
}
