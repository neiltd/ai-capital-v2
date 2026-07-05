import React, { useState } from 'react'
import type { EventAnalysis, AdminHumanIntelRecord, ActorGoal, BlocPerspective } from '../types'

interface Props {
  initialRecord:   AdminHumanIntelRecord
  initialAnalysis: EventAnalysis
  onPublish:       () => void
}

export default function Draft({ initialRecord, initialAnalysis, onPublish }: Props) {
  const [analysis, setAnalysis] = useState<EventAnalysis>(initialAnalysis)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [success,  setSuccess]  = useState('')

  function upd<K extends keyof EventAnalysis>(key: K, value: EventAnalysis[K]) {
    setAnalysis(prev => ({ ...prev, [key]: value, last_edited: new Date().toISOString() }))
  }

  function updActor(i: number, f: keyof ActorGoal, v: string) {
    const g = [...analysis.actor_goals]; g[i] = { ...g[i], [f]: v }; upd('actor_goals', g)
  }
  function addActor()             { upd('actor_goals', [...analysis.actor_goals, { name: '', stated_goal: '', real_goal: '', red_lines: '' }]) }
  function removeActor(i: number) { upd('actor_goals', analysis.actor_goals.filter((_, j) => j !== i)) }

  function updBloc(i: number, f: keyof BlocPerspective, v: string) {
    const b = [...analysis.bloc_perspectives]; b[i] = { ...b[i], [f]: v }; upd('bloc_perspectives', b)
  }
  function addBloc()             { upd('bloc_perspectives', [...analysis.bloc_perspectives, { bloc: '', how_they_see_it: '', their_interest: '', internal_tension: '' }]) }
  function removeBloc(i: number) { upd('bloc_perspectives', analysis.bloc_perspectives.filter((_, j) => j !== i)) }

  function updWatch(i: number, v: string) {
    const w = [...analysis.what_to_watch]; w[i] = v; upd('what_to_watch', w)
  }
  function addWatch()             { upd('what_to_watch', [...analysis.what_to_watch, '']) }
  function removeWatch(i: number) { upd('what_to_watch', analysis.what_to_watch.filter((_, j) => j !== i)) }

  async function regen(field: string) {
    try {
      const res = await fetch('/api/analyse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: initialRecord.raw_text, sourcePlatform: initialRecord.source_platform, sourceUrl: initialRecord.source_url }),
      })
      if (!res.ok) return
      const data = await res.json() as { record: AdminHumanIntelRecord; analysis: EventAnalysis }
      if (field in data.analysis) upd(field as keyof EventAnalysis, data.analysis[field as keyof EventAnalysis])
    } catch { /* silent fail */ }
  }

  async function handlePublish() {
    setLoading(true); setError('')
    try {
      const final = { ...analysis, reviewed: true, last_edited: new Date().toISOString() }
      const res = await fetch('/api/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: initialRecord, analysis: final }),
      })
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error)
      setSuccess('Published and exported to WorldMap.')
      setTimeout(onPublish, 1500)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const regenBtn = (field: string) => (
    <button className="btn btn-secondary" style={{ padding: '0.2rem 0.6rem', fontSize: '0.75rem' }} onClick={() => regen(field)}>↺</button>
  )

  const textSection = (title: string, field: keyof EventAnalysis, rows: number) => (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <span className="section-title">{title}</span>
        {regenBtn(field as string)}
      </div>
      <textarea rows={rows} value={analysis[field] as string} onChange={e => upd(field, e.target.value)} />
    </div>
  )

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
        <div>
          <h2 className="section-title">{initialRecord.extracted.title}</h2>
          <p style={{ color: '#8b949e', fontSize: '0.8rem', marginTop: '0.3rem' }}>
            {initialRecord.extracted.countries.join(', ')} · {initialRecord.source_platform}
          </p>
        </div>
        <button className="btn btn-primary" onClick={handlePublish} disabled={loading}>
          {loading ? '⟳ Publishing...' : '↑ Publish to WorldMap'}
        </button>
      </div>
      {error   && <p className="error"   style={{ marginBottom: '1rem' }}>{error}</p>}
      {success && <p className="success" style={{ marginBottom: '1rem' }}>{success}</p>}

      {textSection('What Happened',       'what_happened',      3)}
      {textSection('Historical Context',  'historical_context', 5)}
      {textSection('Political Analysis',  'political_analysis', 5)}
      {textSection('Social Analysis',     'social_analysis',    5)}

      {/* Actor Goals */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <span className="section-title">Actor Goals</span>
          <button className="btn btn-secondary" style={{ padding: '0.2rem 0.75rem', fontSize: '0.75rem' }} onClick={addActor}>+ Actor</button>
        </div>
        <table>
          <thead><tr><th>Actor</th><th>Stated Goal</th><th>Real Goal</th><th>Red Lines</th><th></th></tr></thead>
          <tbody>
            {analysis.actor_goals.map((g, i) => (
              <tr key={i}>
                <td><input type="text" value={g.name}        onChange={e => updActor(i, 'name',        e.target.value)} placeholder="Name" /></td>
                <td><textarea rows={2} value={g.stated_goal} onChange={e => updActor(i, 'stated_goal', e.target.value)} /></td>
                <td><textarea rows={2} value={g.real_goal}   onChange={e => updActor(i, 'real_goal',   e.target.value)} /></td>
                <td><textarea rows={2} value={g.red_lines}   onChange={e => updActor(i, 'red_lines',   e.target.value)} /></td>
                <td><button className="btn btn-secondary" style={{ padding: '0.2rem 0.4rem' }} onClick={() => removeActor(i)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Bloc Perspectives */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <span className="section-title">Bloc Perspectives</span>
          <button className="btn btn-secondary" style={{ padding: '0.2rem 0.75rem', fontSize: '0.75rem' }} onClick={addBloc}>+ Bloc</button>
        </div>
        {analysis.bloc_perspectives.map((b, i) => (
          <div key={i} className="bloc-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <input
                type="text" value={b.bloc}
                onChange={e => updBloc(i, 'bloc', e.target.value)}
                placeholder="Bloc name (e.g. US-led West)"
                style={{ fontWeight: 700, color: '#e3b341', background: 'none', border: 'none', borderBottom: '1px solid #30363d', borderRadius: 0, padding: '0 0 0.2rem 0', fontSize: '0.875rem', width: 'auto' }}
              />
              <button className="btn btn-secondary" style={{ padding: '0.2rem 0.4rem' }} onClick={() => removeBloc(i)}>✕</button>
            </div>
            {(['how_they_see_it', 'their_interest', 'internal_tension'] as const).map(f => (
              <div key={f} className="field" style={{ marginBottom: '0.5rem' }}>
                <label>{f.replace(/_/g, ' ')}</label>
                <textarea rows={2} value={b[f]} onChange={e => updBloc(i, f, e.target.value)} />
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* What to Watch */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <span className="section-title">What to Watch</span>
          <button className="btn btn-secondary" style={{ padding: '0.2rem 0.75rem', fontSize: '0.75rem' }} onClick={addWatch}>+ Signal</button>
        </div>
        {analysis.what_to_watch.map((item, i) => (
          <div key={i} className="watch-item">
            <span>{i + 1}.</span>
            <input type="text" value={item} onChange={e => updWatch(i, e.target.value)} placeholder="Specific signal to monitor..." />
            <button className="btn btn-secondary" style={{ padding: '0.2rem 0.4rem', minWidth: 28 }} onClick={() => removeWatch(i)}>✕</button>
          </div>
        ))}
      </div>

      {/* Confidence */}
      <div className="card">
        <span className="section-title" style={{ display: 'block', marginBottom: '0.75rem' }}>Confidence</span>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
          <div>
            <label>Score (0–1)</label>
            <input
              type="number" min={0} max={1} step={0.05}
              value={analysis.confidence.score}
              onChange={e => {
                const v = parseFloat(e.target.value)
                upd('confidence', { ...analysis.confidence, score: isNaN(v) ? analysis.confidence.score : v })
              }}
              style={{ width: 80 }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Reasoning — what is uncertain</label>
            <textarea rows={2} value={analysis.confidence.reasoning} onChange={e => upd('confidence', { ...analysis.confidence, reasoning: e.target.value })} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', paddingBottom: '2rem' }}>
        <button className="btn btn-primary" onClick={handlePublish} disabled={loading}>
          {loading ? '⟳ Publishing...' : '↑ Publish to WorldMap'}
        </button>
      </div>
    </div>
  )
}
