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

// New selection kinds (world-map-v2) — event/chokepoint/facility. Country and
// conflict selection remain the pre-existing fields (selectedCountryId,
// selectedConflict) to minimize churn on their many existing consumers
// (CountryPanel, ConflictZoneLayer, useMapInteraction). All five selection
// kinds are mutually exclusive — selecting one clears the other four so the
// Inspector shell always renders exactly one panel.
export interface ChokepointSelection {
  id: string
  name: string
  description: string | null
  lanesThrough: string[]
  exposedTickers: string[]
}

export interface FacilitySelection {
  layerId: string
  name: string
  subtitle: string
  importance: string
  note: string
  tags: { label: string; value: string }[]
}

export type FacilityDensity = 'key' | 'all'

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

  // Intelligence event — click-to-pin (new capability; hover tooltip is unchanged)
  selectedEventId: string | null
  selectEvent: (id: string) => void
  clearEvent: () => void

  // Chokepoint — fed by PortfolioTradeLayer / TradeRouteLayer click handlers
  selectedChokepoint: ChokepointSelection | null
  selectChokepoint: (c: ChokepointSelection) => void
  clearChokepoint: () => void

  // Generic facility (any infrastructure point layer without its own richer panel)
  selectedFacility: FacilitySelection | null
  selectFacility: (f: FacilitySelection) => void
  clearFacility: () => void

  /** True if any of the five selection kinds is active. */
  hasSelection: () => boolean
  /** Clears whichever selection kind is currently active — used by Esc. */
  clearAllSelection: () => void

  // Facility detail control (world-map-v2 round 3) — global Key/All density,
  // read by each point-facility layer's MapLibre filter/paint expressions.
  facilityDensity: FacilityDensity
  setFacilityDensity: (d: FacilityDensity) => void

  // Extensible layer visibility for future layers (keyed by layer registry ID)
  layerVisibility: Record<string, boolean>
  setLayerVisible: (id: string, visible: boolean) => void
  toggleLayerById: (id: string) => void
  isLayerVisible: (id: string) => boolean
  /** Replaces the whole visibility map at once — used by lenses. */
  setLayerVisibility: (v: Record<string, boolean>) => void
}

export const useMapStore = create<MapStore>((set, get) => ({
  selectedCountryId: null,
  countryData: null,
  loading: false,
  error: null,

  selectCountry: async (id: string) => {
    set({
      selectedCountryId: id, loading: true, error: null, countryData: null,
      selectedConflict: null, selectedEventId: null, selectedChokepoint: null, selectedFacility: null,
    })
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
  selectConflict: (conflict) => set({
    selectedConflict: conflict, selectedCountryId: null, countryData: null,
    selectedEventId: null, selectedChokepoint: null, selectedFacility: null,
  }),
  clearConflict: () => set({ selectedConflict: null }),

  selectedEventId: null,
  selectEvent: (id) => set({
    selectedEventId: id,
    selectedCountryId: null, countryData: null, selectedConflict: null,
    selectedChokepoint: null, selectedFacility: null,
  }),
  clearEvent: () => set({ selectedEventId: null }),

  selectedChokepoint: null,
  selectChokepoint: (c) => set({
    selectedChokepoint: c,
    selectedCountryId: null, countryData: null, selectedConflict: null,
    selectedEventId: null, selectedFacility: null,
  }),
  clearChokepoint: () => set({ selectedChokepoint: null }),

  selectedFacility: null,
  selectFacility: (f) => set({
    selectedFacility: f,
    selectedCountryId: null, countryData: null, selectedConflict: null,
    selectedEventId: null, selectedChokepoint: null,
  }),
  clearFacility: () => set({ selectedFacility: null }),

  hasSelection: () => {
    const s = get()
    return !!(s.selectedCountryId || s.selectedConflict || s.selectedEventId || s.selectedChokepoint || s.selectedFacility)
  },
  clearAllSelection: () => set({
    selectedCountryId: null, countryData: null, error: null,
    selectedConflict: null, selectedEventId: null, selectedChokepoint: null, selectedFacility: null,
  }),

  facilityDensity: 'key',
  setFacilityDensity: (d) => set({ facilityDensity: d }),

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
  setLayerVisibility: (v) => set({ layerVisibility: v }),
}))
