import { useState } from 'react'
import type { ReactNode } from 'react'
import type { EventAnalysis } from '../../data/schemas/imports'

interface Props {
  analysis: EventAnalysis
}

export function AnalysisCard({ analysis }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: '0.75rem', paddingTop: '0.75rem' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#58a6ff', fontSize: '0.75rem', fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.06em', padding: 0,
          width: '100%',
        }}
      >
        <span style={{ fontSize: '0.65rem' }}>{open ? '▼' : '▶'}</span>
        Intelligence Analysis
        <span style={{ marginLeft: 'auto', color: '#8b949e', fontWeight: 400 }}>
          {(analysis.confidence.score * 100).toFixed(0)}% confidence
        </span>
      </button>

      {open && (
        <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>

          <Section title="What Happened">
            <p>{analysis.what_happened}</p>
          </Section>

          <Section title="Historical Context">
            <p>{analysis.historical_context}</p>
          </Section>

          <Section title="Political Analysis">
            <p>{analysis.political_analysis}</p>
          </Section>

          <Section title="Social Analysis">
            <p>{analysis.social_analysis}</p>
          </Section>

          {analysis.actor_goals.length > 0 && (
            <Section title="Actor Goals">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {analysis.actor_goals.map((actor, i) => (
                  <div key={i} style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 4, padding: '0.5rem 0.75rem' }}>
                    <div style={{ color: '#e3b341', fontWeight: 700, fontSize: '0.8rem', marginBottom: '0.3rem' }}>{actor.name}</div>
                    <div style={{ fontSize: '0.78rem', color: '#8b949e', marginBottom: '0.2rem' }}>
                      <span style={{ color: '#58a6ff' }}>Stated:</span> {actor.stated_goal}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: '#8b949e', marginBottom: '0.2rem' }}>
                      <span style={{ color: '#58a6ff' }}>Real:</span> {actor.real_goal}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: '#8b949e' }}>
                      <span style={{ color: '#f85149' }}>Red lines:</span> {actor.red_lines}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {analysis.bloc_perspectives.length > 0 && (
            <Section title="Bloc Perspectives">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {analysis.bloc_perspectives.map((bloc, i) => (
                  <div key={i} style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 4, padding: '0.5rem 0.75rem' }}>
                    <div style={{ color: '#e3b341', fontWeight: 700, fontSize: '0.8rem', marginBottom: '0.3rem' }}>{bloc.bloc}</div>
                    <div style={{ fontSize: '0.78rem', color: '#8b949e', marginBottom: '0.2rem' }}>
                      <span style={{ color: '#c9d1d9' }}>View:</span> {bloc.how_they_see_it}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: '#8b949e', marginBottom: '0.2rem' }}>
                      <span style={{ color: '#c9d1d9' }}>Interest:</span> {bloc.their_interest}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: '#8b949e' }}>
                      <span style={{ color: '#e3b341' }}>Internal tension:</span> {bloc.internal_tension}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {analysis.what_to_watch.length > 0 && (
            <Section title="What to Watch">
              <ol style={{ paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {analysis.what_to_watch.map((item, i) => (
                  <li key={i} style={{ fontSize: '0.8rem', color: '#c9d1d9' }}>{item}</li>
                ))}
              </ol>
            </Section>
          )}

          <div style={{ fontSize: '0.75rem', color: '#8b949e', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.5rem' }}>
            Confidence {(analysis.confidence.score * 100).toFixed(0)}% — {analysis.confidence.reasoning}
          </div>

        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#58a6ff', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>
        {title}
      </div>
      <div style={{ fontSize: '0.82rem', color: '#c9d1d9', lineHeight: 1.55 }}>
        {children}
      </div>
    </div>
  )
}
