import { useMapStore, INDICATOR_GROUPS, INDICATOR_LABELS, type IndicatorKey } from '../../store/useMapStore'
import { INVERTED_INDICATORS } from '../../lib/geo/indicators'

export default function HeatmapSelector() {
  const { heatmapIndicator, setHeatmapIndicator } = useMapStore()
  const isInverted = INVERTED_INDICATORS.has(heatmapIndicator)
  const isActive   = heatmapIndicator !== 'none'

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-muted hidden lg:block">Heatmap</span>

      <select
        value={heatmapIndicator}
        onChange={e => setHeatmapIndicator(e.target.value as IndicatorKey)}
        className="bg-[#0E1525] border border-[#1E2D4A] text-xs text-text-secondary rounded-lg px-2 py-1.5 outline-none cursor-pointer hover:border-blue-700 transition-colors"
      >
        <option value="none">No heatmap</option>

        {INDICATOR_GROUPS.map(group => (
          <optgroup key={group.label} label={`── ${group.label}`}>
            {group.keys.map(key => (
              <option key={key} value={key}>{INDICATOR_LABELS[key]}</option>
            ))}
          </optgroup>
        ))}
      </select>

      {/* Legend bar — flips direction for inverted indicators */}
      {isActive && (
        <div className="flex items-center gap-1">
          <div
            className="w-12 h-2 rounded-full"
            style={{
              background: isInverted
                ? 'linear-gradient(to right, #16a34a, #d97706, #dc2626)'  // green→red (high = bad)
                : 'linear-gradient(to right, #dc2626, #d97706, #16a34a)', // red→green (high = good)
            }}
          />
          <span className="text-[10px] text-text-muted">
            {isInverted ? 'Low→High ↓' : 'Low→High'}
          </span>
        </div>
      )}
    </div>
  )
}
