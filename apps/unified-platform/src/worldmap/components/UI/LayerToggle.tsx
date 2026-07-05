import { useState, useEffect, useRef } from 'react'
import { useMapStore } from '../../store/useMapStore'
import { LAYER_REGISTRY, LAYER_GROUPS, getLayersByGroup } from '../../layers/_core/registry'
import type { LayerMeta } from '../../layers/_core/types'

// ─── Group display config ────────────────────────────────────────────────────
const GROUP_META: Record<string, { label: string; color: string }> = {
  geopolitical:  { label: 'Geopolitical',  color: '#ef4444' },
  economic:      { label: 'Economic',       color: '#06b6d4' },
  infrastructure:{ label: 'Infrastructure', color: '#3b82f6' },
  utilities:     { label: 'Utilities',      color: '#f59e0b' },
  intelligence:  { label: 'Intelligence',   color: '#a78bfa' },
  environment:   { label: 'Environment',    color: '#22c55e' },
  investment:    { label: 'Investment',     color: '#34d399' },
}

// ─── Toggle switch ────────────────────────────────────────────────────────────
function ToggleSwitch({ on, disabled, onToggle }: {
  on: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={e => { e.stopPropagation(); if (!disabled) onToggle() }}
      disabled={disabled}
      aria-checked={on}
      role="switch"
      className={`relative inline-flex h-4 w-7 flex-shrink-0 rounded-full transition-colors duration-150 focus:outline-none ${
        disabled
          ? 'cursor-not-allowed opacity-30 bg-[#1E2D4A]'
          : on
            ? 'cursor-pointer bg-blue-600'
            : 'cursor-pointer bg-[#1E2D4A] hover:bg-[#2a3d5a]'
      }`}
    >
      <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform duration-150 mt-0.5 ${
        on && !disabled ? 'translate-x-3.5' : 'translate-x-0.5'
      }`} />
    </button>
  )
}

// ─── Single layer row ─────────────────────────────────────────────────────────
function LayerRow({ layer, visible, onToggle }: {
  layer: LayerMeta
  visible: boolean
  onToggle: () => void
}) {
  const [showDesc, setShowDesc] = useState(false)

  return (
    <div
      className={`flex items-start justify-between gap-3 px-3 py-2 transition-colors cursor-default ${
        layer.placeholder ? '' : 'hover:bg-[#0D1829]'
      }`}
      onClick={() => !layer.placeholder && onToggle()}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[12px] font-medium leading-tight ${
            layer.placeholder ? 'text-text-inactive' : visible ? 'text-text-primary' : 'text-text-muted'
          }`}>
            {layer.label}
          </span>
          {layer.placeholder && (
            <span className="text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider"
              style={{ background: '#1a2035', color: '#475569', border: '1px solid #1E2D4A' }}>
              SOON
            </span>
          )}
          {/* Legend dots inline when active */}
          {visible && !layer.placeholder && layer.legend && (
            <div className="flex items-center gap-1">
              {layer.legend.slice(0, 3).map(l => (
                <span key={l.label} className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: l.color }} />
              ))}
            </div>
          )}
        </div>

        {/* Description — show on hover or when active */}
        <p className={`text-[10px] leading-snug mt-0.5 transition-all ${
          showDesc || visible ? 'text-text-muted' : 'text-text-inactive'
        }`}
          onMouseEnter={() => setShowDesc(true)}
          onMouseLeave={() => setShowDesc(false)}>
          {layer.description}
        </p>
      </div>

      <div className="flex-shrink-0 mt-0.5" onClick={e => e.stopPropagation()}>
        <ToggleSwitch on={visible} disabled={!!layer.placeholder} onToggle={onToggle} />
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function LayerToggle() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const { layerVisibility, toggleLayerById } = useMapStore()

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Close on Escape
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // ── Visibility resolver ──
  // All layers now use a single source of truth: layerVisibility from the registry.
  // 'heatmap' is excluded here because it's controlled by HeatmapSelector, not this toggle.
  function isVisible(id: string): boolean {
    if (id === 'heatmap') return false
    return layerVisibility[id] ?? false
  }

  // ── Toggle dispatcher ──
  // All layers go through toggleLayerById — no special cases.
  // Future layers are automatically supported by adding them to registry.ts.
  function handleToggle(layer: LayerMeta) {
    if (layer.placeholder || layer.id === 'heatmap') return
    toggleLayerById(layer.id)
  }

  // ── Active layer count (excluding placeholders and heatmap) ──
  const activeLayers = LAYER_REGISTRY.filter(l =>
    !l.placeholder && l.id !== 'heatmap' && isVisible(l.id)
  )
  const activeCount = activeLayers.length

  // ── Available (non-placeholder) count ──
  const availableCount = LAYER_REGISTRY.filter(l => !l.placeholder && l.id !== 'heatmap').length

  return (
    <div ref={ref} className="relative">

      {/* ── Trigger button ── */}
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-medium border transition-all ${
          open
            ? 'border-blue-700 text-blue-300'
            : 'border-[#1E2D4A] text-text-muted hover:text-text-primary hover:border-border-strong'
        }`}
        style={{ background: open ? '#0c1a3a' : '#0E1525' }}
      >
        {/* Layer stack icon */}
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
          <path d="M8 1L15 5L8 9L1 5L8 1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M1 9L8 13L15 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span>Layers</span>
        {/* Active count badge */}
        {activeCount > 0 && (
          <span className="flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold bg-blue-600 text-white leading-none">
            {activeCount}
          </span>
        )}
        {/* Chevron */}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* ── Dropdown panel ── */}
      {open && (
        <div
          className="absolute top-full left-0 mt-1.5 rounded-xl overflow-hidden shadow-2xl z-[200]"
          style={{
            background: '#0A0F1E',
            border: '1px solid #1E2D4A',
            width: 300,
            maxHeight: 'calc(100vh - 80px)',
            overflowY: 'auto',
          }}
        >
          {/* Panel header */}
          <div className="px-3 py-2.5 border-b flex items-center justify-between"
            style={{ borderColor: '#1E2D4A' }}>
            <div>
              <p className="text-[11px] font-semibold text-text-primary">Map Layers</p>
              <p className="text-[10px] text-text-muted mt-0.5">
                {activeCount} active · {availableCount - activeCount} available · {LAYER_REGISTRY.filter(l => l.placeholder).length} coming soon
              </p>
            </div>
            <button onClick={() => setOpen(false)}
              className="text-text-muted hover:text-text-secondary text-base leading-none w-5 h-5 flex items-center justify-center">
              ×
            </button>
          </div>

          {/* Layer groups */}
          {LAYER_GROUPS.map(group => {
            const meta  = GROUP_META[group]
            const items = getLayersByGroup(group)
            if (items.length === 0) return null

            const groupActive = items.some(l => !l.placeholder && isVisible(l.id))

            return (
              <div key={group}>
                {/* Group header */}
                <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
                  <div className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: groupActive ? meta.color : '#334155' }} />
                  <p className="text-[10px] uppercase tracking-widest font-semibold"
                    style={{ color: groupActive ? meta.color : '#475569' }}>
                    {meta.label}
                  </p>
                  {items.every(l => l.placeholder) && (
                    <span className="text-[9px] text-text-faint ml-auto">all coming soon</span>
                  )}
                </div>

                {/* Layer rows */}
                {items.map(layer => (
                  <LayerRow
                    key={layer.id}
                    layer={layer}
                    visible={isVisible(layer.id)}
                    onToggle={() => handleToggle(layer)}
                  />
                ))}

                {/* Divider between groups */}
                <div className="mx-3 mt-1 mb-0" style={{ borderBottom: '1px solid #0d1626' }} />
              </div>
            )
          })}

          {/* Panel footer */}
          <div className="px-3 py-2.5">
            <p className="text-[10px] text-text-faint leading-relaxed">
              Layers marked <span className="text-text-muted font-medium">SOON</span> are schema-ready. Add Gemini data to activate them.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
