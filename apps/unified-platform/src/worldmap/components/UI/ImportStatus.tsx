/**
 * ImportStatus — small header badge showing hub import state.
 *
 * States:
 *   loading  — imports are being fetched (spinner)
 *   live     — manifest present, data < 24h old (green)
 *   stale    — manifest present, data > 24h old (amber)
 *   sample   — loaded from *.example.json, not real hub data (blue)
 *   offline  — no import files found (red)
 *   error    — schema validation failed (red)
 *
 * "Stale" is determined by manifest.generatedAt being more than 24 hours ago.
 * The UI is read-only — clicking does nothing. There is no refresh button
 * because this project does not own ingestion.
 */

import { useIntelligenceStore } from '../../store/useIntelligenceStore'

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000  // 24 hours

function ageLabel(generatedAt: string): string {
  const ageMs = Date.now() - new Date(generatedAt).getTime()
  const hours = Math.floor(ageMs / (60 * 60 * 1000))
  if (hours < 1)  return 'just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function ImportStatus() {
  // Separate selectors — each returns a primitive or stable reference.
  // Avoids re-rendering on every store change (e.g. country selection, layer toggle).
  const status    = useIntelligenceStore(s => s.status)
  const manifest  = useIntelligenceStore(s => s.manifest)
  const hasEvents = useIntelligenceStore(s => s.events.length > 0)
  const isSample  = useIntelligenceStore(s => s.isSample)

  // Determine state
  let state: 'loading' | 'live' | 'stale' | 'sample' | 'offline' | 'error'
  if (status === 'loading') {
    state = 'loading'
  } else if (status === 'error') {
    state = 'error'
  } else if (!hasEvents && !manifest) {
    state = 'offline'
  } else if (isSample) {
    // Takes precedence over live/stale — the data shown is placeholder
    // example data, not real hub output, regardless of its apparent age.
    state = 'sample'
  } else if (manifest) {
    const ageMs = Date.now() - new Date(manifest.generatedAt).getTime()
    state = ageMs > STALE_THRESHOLD_MS ? 'stale' : 'live'
  } else {
    state = 'live'
  }

  // Config per state
  const cfg = {
    loading: { dot: '#475569', text: 'Hub: loading…', detail: null },
    live:    {
      dot: '#22c55e',
      text: `Hub: live`,
      detail: manifest ? ageLabel(manifest.generatedAt) : null,
    },
    stale:   {
      dot: '#f59e0b',
      text: `Hub: stale`,
      detail: manifest ? ageLabel(manifest.generatedAt) : null,
    },
    sample:  { dot: '#3b82f6', text: 'Hub: sample data', detail: 'not real hub data' },
    offline: { dot: '#ef4444', text: 'Hub: offline', detail: 'no imports found' },
    error:   { dot: '#ef4444', text: 'Hub: error',   detail: 'schema mismatch' },
  }[state]

  return (
    <div className="flex items-center gap-1.5 hidden sm:flex" title={`Intelligence hub status: ${state}`}>
      {state === 'loading' ? (
        <div className="w-1.5 h-1.5 rounded-full border border-border-default border-t-transparent animate-spin" />
      ) : (
        <div className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: cfg.dot }} />
      )}
      <span className="text-[11px] hidden lg:block" style={{ color: '#475569' }}>
        {cfg.text}
        {cfg.detail && (
          <span className="ml-1" style={{ color: '#334155' }}>{cfg.detail}</span>
        )}
      </span>
      {/* Compact version for medium screens */}
      <span className="text-[11px] lg:hidden" style={{ color: '#475569' }}>
        Hub
      </span>
    </div>
  )
}
