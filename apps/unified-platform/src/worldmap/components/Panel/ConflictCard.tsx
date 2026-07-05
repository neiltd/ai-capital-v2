import { useMapStore } from '../../store/useMapStore'
import type { ConflictParty } from '../../types/conflict'

const INTENSITY: Record<string, { badge: string; dot: string }> = {
  critical: { badge: 'bg-red-950/70 text-red-400 border-red-800',    dot: '#ef4444' },
  high:     { badge: 'bg-orange-950/70 text-orange-400 border-orange-800', dot: '#f97316' },
  medium:   { badge: 'bg-yellow-950/70 text-yellow-400 border-yellow-800', dot: '#eab308' },
  low:      { badge: 'bg-lime-950/70 text-lime-400 border-lime-800',  dot: '#84cc16' },
}

const STATUS_COL: Record<string, string> = {
  active: '#ef4444', escalating: '#f97316',
  'de-escalating': '#eab308', ceasefire: '#60a5fa',
}

const TYPE_LABEL: Record<string, string> = {
  armed_conflict:      'Armed Conflict',
  civil_war:           'Civil War',
  territorial_dispute: 'Territorial Dispute',
  naval_tension:       'Naval / Maritime Tension',
  frozen_conflict:     'Frozen Conflict',
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="text-[10px] uppercase tracking-widest font-semibold text-text-muted mb-1.5">{label}</p>
      {children}
    </div>
  )
}

export default function ConflictCard() {
  const { selectedConflict: c, clearConflict } = useMapStore()
  if (!c) return null

  const int = INTENSITY[c.intensity] ?? INTENSITY.high

  return (
    <div className="absolute bottom-5 left-4 z-30 w-[300px] bg-[#0A0F1E] border border-[#1E2D4A] rounded-xl shadow-2xl overflow-hidden"
      style={{ backdropFilter: 'blur(8px)' }}>

      {/* Header */}
      <div className="px-4 pt-3.5 pb-3 border-b border-[#1E2D4A]">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Intensity badge */}
            <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wide ${int.badge}`}>
              {c.intensity}
            </span>
            {/* Status */}
            <span className="flex items-center gap-1 text-[11px] font-medium" style={{ color: STATUS_COL[c.status] ?? '#94a3b8' }}>
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: STATUS_COL[c.status] ?? '#94a3b8' }} />
              {c.status.replace(/-/g, ' ')}
            </span>
          </div>
          <button onClick={clearConflict}
            className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-white hover:bg-[#1E2D4A] transition-colors text-base leading-none">
            ×
          </button>
        </div>
        <h3 className="text-[14px] font-bold text-white leading-snug break-words">{c.name}</h3>
        <p className="text-[11px] text-text-muted mt-1">
          {TYPE_LABEL[c.type] ?? c.type} · Since {c.startYear}
        </p>
      </div>

      {/* Scrollable body */}
      <div className="px-4 py-3 max-h-72 overflow-y-auto flex flex-col gap-3"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#1E2D4A transparent' }}>

        {/* Parties */}
        <Row label="Parties">
          <div className="flex flex-col gap-1">
            {c.parties.map((p: ConflictParty, i: number) => (
              <div key={i} className="flex items-start gap-2 min-w-0">
                <span className="text-[12px] font-semibold text-text-secondary flex-shrink-0">{p.countryName}</span>
                <span className="text-[11px] text-text-muted break-words">— {p.role}</span>
              </div>
            ))}
          </div>
        </Row>

        {/* Situation */}
        <Row label="Situation Now">
          <p className="text-[12px] text-text-secondary leading-relaxed break-words">{c.currentStatus}</p>
        </Row>

        {/* Casualties */}
        <Row label="Casualties">
          <div className="bg-red-950/30 border border-red-900/40 rounded-lg px-3 py-2">
            <p className="text-[12px] text-text-secondary leading-relaxed break-words">{c.casualties}</p>
          </div>
        </Row>

        {/* International */}
        <Row label="International Involvement">
          <p className="text-[12px] text-text-muted leading-relaxed break-words">{c.internationalInvolvement}</p>
        </Row>

        {/* Summary */}
        {c.summary && (
          <div className="pt-3 border-t border-[#1E2D4A]">
            <p className="text-[11px] text-text-muted leading-relaxed break-words">{c.summary}</p>
          </div>
        )}

      </div>
    </div>
  )
}
