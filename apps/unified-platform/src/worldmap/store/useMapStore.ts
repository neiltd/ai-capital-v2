import { create } from 'zustand'
import type { Country } from '../types/country'
import type { Conflict } from '../types/conflict'
import { LAYER_REGISTRY } from '../layers/_core/registry'
import type { IndicatorKey } from '../lib/geo/indicators'

// IndicatorKey, INDICATOR_LABELS, INDICATOR_GROUPS live in lib/geo/indicators.ts.
// Re-exported here for backward compatibility with any future code that
// instinctively imports indicator constants from the store.
export type { IndicatorKey } from '../lib/geo/indicators'
export { INDICATOR_LABELS, INDICATOR_GROUPS } from '../lib/geo/indicators'

// Build default visibility from the registry so every layer has one source of truth.
// Adding a new layer to registry.ts automatically gives it the correct initial state here.
// Future: when AI agents push real-time layer data, they will toggle visibility through
// this same map rather than hardcoded booleans — keeping the interface stable.
const DEFAULT_LAYER_VISIBILITY: Record<string, boolean> = Object.fromEntries(
  LAYER_REGISTRY.map(l => [l.id, l.defaultEnabled])
)

// Note: INVERTED_INDICATORS also lives in lib/geo/indicators.ts — pure domain
// knowledge, not UI state. Import it from there, not from the store.

interface MapStore {
  // Country selection
  selectedCountryId: string | null
  countryData: Country | null
  loading: boolean
  error: string | null
  selectCountry: (id: string) => Promise<void>
  clearSelection: () => void

  // Comparison (second country)
  compareCountryId: string | null
  compareData: Country | null
  compareLoading: boolean
  setCompare: (id: string) => Promise<void>
  clearCompare: () => void

  // Heatmap
  heatmapIndicator: IndicatorKey
  setHeatmapIndicator: (key: IndicatorKey) => void

  // Conflict popup
  selectedConflict: Conflict | null
  selectConflict: (conflict: Conflict) => void
  clearConflict: () => void

  // Extensible layer visibility for future layers (keyed by layer registry ID)
  layerVisibility: Record<string, boolean>
  setLayerVisible: (id: string, visible: boolean) => void
  toggleLayerById: (id: string) => void
  isLayerVisible: (id: string) => boolean
}

export const useMapStore = create<MapStore>((set) => ({
  selectedCountryId: null,
  countryData: null,
  loading: false,
  error: null,

  selectCountry: async (id: string) => {
    set({ selectedCountryId: id, loading: true, error: null, countryData: null, selectedConflict: null })
    try {
      const module = await import(`../data/countries/${id}.json`)
      set({ countryData: module.default as Country, loading: false })
    } catch {
      set({ error: 'No detailed data available for this country yet.', loading: false })
    }
  },

  clearSelection: () => set({ selectedCountryId: null, countryData: null, error: null }),

  compareCountryId: null,
  compareData: null,
  compareLoading: false,

  setCompare: async (id: string) => {
    set({ compareCountryId: id, compareLoading: true, compareData: null })
    try {
      const module = await import(`../data/countries/${id}.json`)
      set({ compareData: module.default as Country, compareLoading: false })
    } catch {
      set({ compareLoading: false })
    }
  },

  clearCompare: () => set({ compareCountryId: null, compareData: null }),

  heatmapIndicator: 'none',
  setHeatmapIndicator: (key) => set({ heatmapIndicator: key }),

  selectedConflict: null,
  selectConflict: (conflict) => set({ selectedConflict: conflict, selectedCountryId: null, countryData: null }),
  clearConflict: () => set({ selectedConflict: null }),

  // All layers initialized from registry defaults — no special cases needed.
  // To add a new layer: register it in layers/_core/registry.ts with defaultEnabled.
  layerVisibility: DEFAULT_LAYER_VISIBILITY,
  setLayerVisible: (id, visible) =>
    set(s => ({ layerVisibility: { ...s.layerVisibility, [id]: visible } })),
  toggleLayerById: (id) =>
    set(s => ({ layerVisibility: { ...s.layerVisibility, [id]: !s.layerVisibility[id] } })),
  isLayerVisible: (id: string): boolean => {
    return useMapStore.getState().layerVisibility[id] ?? false
  },
}))
