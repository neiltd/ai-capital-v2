import React, { useState } from 'react'
import type { EventAnalysis, AdminHumanIntelRecord, SourcePlatform } from '../types'

interface Props {
  onSuccess: (record: AdminHumanIntelRecord, analysis: EventAnalysis) => void
}

export default function Submit({ onSuccess }: Props) {
  const [rawText,        setRawText]        = useState('')
  const [sourcePlatform, setSourcePlatform] = useState<SourcePlatform>('web')
  const [sourceUrl,      setSourceUrl]      = useState('')
  const [loading,        setLoading]        = useState(false)
  const [error,          setError]          = useState('')

  async function handleAnalyse() {
    if (!rawText.trim()) { setError('Paste some news content first'); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/analyse', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ rawText, sourcePlatform, sourceUrl: sourceUrl.trim() || undefined }),
      })
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error)
      const data = await res.json() as { record: AdminHumanIntelRecord; analysis: EventAnalysis }
      onSuccess(data.record, data.analysis)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <h2 className="section-title" style={{ marginBottom: '1.5rem' }}>Submit Intelligence</h2>
      <div className="card">
        <div className="field">
          <label>Source Platform</label>
          <select value={sourcePlatform} onChange={e => setSourcePlatform(e.target.value as SourcePlatform)}>
            <option value="web">Web / News Article</option>
            <option value="youtube">YouTube</option>
            <option value="tiktok">TikTok</option>
            <option value="podcast">Podcast</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="field">
          <label>Source URL (optional)</label>
          <input type="text" placeholder="https://..." value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} />
        </div>
        <div className="field">
          <label>News Content — paste article, transcript, or write your summary</label>
          <textarea
            rows={14}
            placeholder="Paste a news article, video transcript, or write your own summary of what you observed..."
            value={rawText}
            onChange={e => setRawText(e.target.value)}
          />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" onClick={handleAnalyse} disabled={loading || !rawText.trim()}>
          {loading ? '⟳ Analysing...' : '→ Analyse'}
        </button>
        {loading && (
          <p className="loading" style={{ marginTop: '0.75rem' }}>
            Claude is running geopolitical analysis... (~15–30 seconds)
          </p>
        )}
      </div>
    </div>
  )
}
