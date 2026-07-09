// App — world-map-v2 shell. Native 3-panel layout (layer rail · map canvas ·
// inspector) using the host dashboard's real design tokens, replacing the old
// sub-app chrome verbatim: the branded "🌍 World Intelligence v2" header with
// GitHub link, the ImportStatus chip, the LayerToggle dropdown-that-covers-
// the-map, the HeatmapSelector dropdown, and the floating bottom-left
// ConflictCard (which the old h-[80vh]-in-h-screen wrapper clipped).
//
// The real MapLibre rendering engine (WorldMap.tsx) is unchanged underneath —
// only the chrome around it changed. See shell/LayerRail.tsx and
// shell/Inspector.tsx for the two new panels.

import { useEffect } from 'react'
import { useMapStore } from './store/useMapStore'
import { useIntelligenceStore } from './store/useIntelligenceStore'
import WorldMap from './components/Map/WorldMap'
import { LayerRail } from './shell/LayerRail'
import { Inspector } from './shell/Inspector'
import { ErrorBoundary } from './components/UI/ErrorBoundary'

export default function App() {
  const hasSelection = useMapStore(s => s.hasSelection)
  const clearAllSelection = useMapStore(s => s.clearAllSelection)
  const selectedCountryId = useMapStore(s => s.selectedCountryId)
  const selectedConflict = useMapStore(s => s.selectedConflict)
  const selectedEventId = useMapStore(s => s.selectedEventId)
  const selectedChokepoint = useMapStore(s => s.selectedChokepoint)
  const selectedFacility = useMapStore(s => s.selectedFacility)
  const loadImports = useIntelligenceStore(s => s.loadImports)

  // Load hub imports once on startup — non-blocking, fails gracefully
  useEffect(() => { loadImports() }, [loadImports])

  // Escape closes whichever selection kind is active — preserved from the
  // original App.tsx, now covers all five selection kinds via the store.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (hasSelection()) clearAllSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasSelection, clearAllSelection, selectedCountryId, selectedConflict, selectedEventId, selectedChokepoint, selectedFacility])

  return (
    <div className="relative flex h-full w-full flex-col bg-page lg:flex-row">
      <LayerRail />

      <div className="relative min-h-[320px] flex-1">
        <ErrorBoundary label="WorldMap">
          <WorldMap />
        </ErrorBoundary>
      </div>

      <Inspector />
    </div>
  )
}
