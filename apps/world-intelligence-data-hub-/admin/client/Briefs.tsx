import React, { useState, useEffect } from 'react'
import type { CountryBrief } from '../types'

export default function Briefs() {
  const [briefs,    setBriefs]   = useState<CountryBrief[]>([])
  const [selected,  setSelected] = useState<CountryBrief | null>(null)
  const [iso3Input, setIso3]     = useState('')
  const [loading,   setLoading]  = useState(false)
  const [error,     setError]    = useState('')
  const [success,   setSuccess]  = useState('')

  useEffect(() => {
    fetch('/api/briefs')
      .then(r => r.json() as Promise<{ briefs: CountryBrief[] }>)
      .then(d => setBriefs(d.briefs))
      .catch(() => {})
  }, [])

  async function handleRefresh() {
    const iso3 = iso3Input.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(iso3)) { setError('Enter a valid 3-letter ISO country code (e.g. IRN, CHN)'); return }
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/brief/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ iso3 }),
      })
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error)
      const data = await res.json() as { brief: CountryBrief }
      setSelected(data.brief)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function handlePublish() {
    if (!selected) return
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/brief/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: selected }),
      })
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error)
      setSuccess('Brief published.')
      setBriefs(prev => {
        const idx = prev.findIndex(b => b.iso3 === selected.iso3)
        return idx >= 0 ? prev.map((b, i) => i === idx ? selected : b) : [...prev, selected]
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  function upd<K extends keyof CountryBrief>(key: K, value: CountryBrief[K]) {
    setSelected(prev => prev ? { ...prev, [key]: value } : prev)
  }

  const textField = (field: 'situation_overview' | 'key_dynamics' | 'historical_roots' | 'actor_map', rows: number) => (
    <div className="card" key={field}>
      <span className="section-title" style={{ display: 'block', marginBottom: '0.5rem' }}>
        {field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
      </span>
      <textarea rows={rows} value={selected![field]} onChange={e => upd(field, e.target.value)} />
    </div>
  )

  return (
    <div>
      <h2 className="section-title" style={{ marginBottom: '1.5rem' }}>Country Intelligence Briefs</h2>

      <div className="card" style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end' }}>
        <div className="field" style={{ marginBottom: 0, flex: 1 }}>
          <label>ISO3 Country Code</label>
          <input type="text" value={iso3Input} onChange={e => setIso3(e.target.value)} placeholder="e.g. IRN, CHN, THA" onKeyDown={e => e.key === 'Enter' && handleRefresh()} />
        </div>
        <button className="btn btn-primary" onClick={handleRefresh} disabled={loading}>
          {loading ? '⟳ Synthesising...' : '↻ Synthesise Brief'}
        </button>
      </div>

      {error && <p className="error" style={{ marginBottom: '1rem' }}>{error}</p>}

      {briefs.length > 0 && !selected && (
        <div className="card">
          <span className="section-title" style={{ display: 'block', marginBottom: '0.75rem' }}>Existing Briefs</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {briefs.map(b => (
              <button key={b.iso3} className="btn btn-secondary" onClick={() => setSelected(b)}>
                {b.iso3} <span style={{ color: '#8b949e', fontWeight: 400, fontSize: '0.75rem' }}>{b.last_reviewed}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <h3 style={{ color: '#e3b341', fontWeight: 700 }}>{selected.iso3} — Intelligence Brief</h3>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button className="btn btn-secondary" onClick={() => { setSelected(null); setSuccess('') }}>← Back</button>
              <button className="btn btn-primary" onClick={handlePublish} disabled={loading}>
                {loading ? '⟳ Publishing...' : '↑ Publish Brief'}
              </button>
            </div>
          </div>
          {success && <p className="success" style={{ marginBottom: '1rem' }}>{success}</p>}

          {textField('situation_overview', 3)}
          {textField('key_dynamics',       4)}
          {textField('historical_roots',   5)}
          {textField('actor_map',          4)}

          <div className="card">
            <span className="section-title" style={{ display: 'block', marginBottom: '0.75rem' }}>Alignment Map</span>
            {(['primary_alignment', 'secondary_ties', 'internal_factions', 'fault_lines'] as const).map(f => (
              <div key={f} className="field">
                <label>{f.replace(/_/g, ' ')}</label>
                <textarea rows={2} value={selected.alignment_map[f]} onChange={e => upd('alignment_map', { ...selected.alignment_map, [f]: e.target.value })} />
              </div>
            ))}
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <span className="section-title">Watchlist</span>
              <button className="btn btn-secondary" style={{ padding: '0.2rem 0.75rem', fontSize: '0.75rem' }} onClick={() => upd('watchlist', [...selected.watchlist, ''])}>+ Signal</button>
            </div>
            {selected.watchlist.map((item, i) => (
              <div key={i} className="watch-item">
                <span>{i + 1}.</span>
                <input type="text" value={item} onChange={e => {
                  const w = [...selected.watchlist]; w[i] = e.target.value; upd('watchlist', w)
                }} placeholder="Signal to monitor..." />
                <button className="btn btn-secondary" style={{ padding: '0.2rem 0.4rem', minWidth: 28 }} onClick={() => upd('watchlist', selected.watchlist.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: '2rem' }}>
            <button className="btn btn-primary" onClick={handlePublish} disabled={loading}>
              {loading ? '⟳ Publishing...' : '↑ Publish Brief'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
