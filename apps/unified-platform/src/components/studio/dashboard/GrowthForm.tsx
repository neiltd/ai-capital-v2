'use client'

import { useState } from 'react'
import { Button } from '@/components/studio/ui/button'
import { Input } from '@/components/studio/ui/input'

export function GrowthForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [followers, setFollowers] = useState('')
  const [profileViews, setProfileViews] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    await fetch('/api/studio/growth', {
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
    <form onSubmit={submit} className="rounded-xl border border-border-subtle bg-bg-card p-4 space-y-3">
      <p className="text-xs font-medium text-text-muted">Log today's follower count</p>
      <Input placeholder="Followers" type="number" value={followers} onChange={e => setFollowers(e.target.value)} required className="bg-bg-elevated border-border-default text-sm text-text-primary placeholder:text-text-faint" />
      <Input placeholder="Profile views (optional)" type="number" value={profileViews} onChange={e => setProfileViews(e.target.value)} className="bg-bg-elevated border-border-default text-sm text-text-primary placeholder:text-text-faint" />
      <div className="flex gap-2">
        <Button type="submit" disabled={loading} size="sm" className="bg-accent-primary hover:bg-indigo-soft text-xs">
          {loading ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} className="text-xs">
          Cancel
        </Button>
      </div>
    </form>
  )
}
