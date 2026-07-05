'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function VideoForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ title: '', views: '', likes: '', comments: '', shares: '', tiktokId: '' })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    await fetch('/api/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: form.title,
        tiktokId: form.tiktokId || undefined,
        views: Number(form.views) || 0,
        likes: Number(form.likes) || 0,
        comments: Number(form.comments) || 0,
        shares: Number(form.shares) || 0,
      }),
    })
    setLoading(false)
    setOpen(false)
    setForm({ title: '', views: '', likes: '', comments: '', shares: '', tiktokId: '' })
    onSaved()
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="text-xs">
        + Add Video
      </Button>
    )
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
      <p className="text-xs font-medium text-zinc-400">Add video stats</p>
      <Input placeholder="Title" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} required className="bg-zinc-800 border-zinc-700 text-sm" />
      <Input placeholder="TikTok ID (optional)" value={form.tiktokId} onChange={e => setForm(f => ({ ...f, tiktokId: e.target.value }))} className="bg-zinc-800 border-zinc-700 text-sm" />
      <div className="grid grid-cols-4 gap-2">
        {(['views', 'likes', 'comments', 'shares'] as const).map(k => (
          <Input key={k} placeholder={k} type="number" value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} className="bg-zinc-800 border-zinc-700 text-sm" />
        ))}
      </div>
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
