import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useMapStore } from './store/useMapStore'
import { useIntelligenceStore } from './store/useIntelligenceStore'
import WorldMap from './components/Map/WorldMap'
import CountryPanel from './components/Panel/CountryPanel'
import ConflictCard from './components/Panel/ConflictCard'
import SearchBar from './components/UI/SearchBar'
import LayerToggle from './components/UI/LayerToggle'
import HeatmapSelector from './components/UI/HeatmapSelector'
import ImportStatus from './components/UI/ImportStatus'
import { ErrorBoundary } from './components/UI/ErrorBoundary'

export default function App() {
  const { selectedCountryId, selectedConflict, clearSelection, clearConflict } = useMapStore()
  const loadImports = useIntelligenceStore(s => s.loadImports)
  const showPanel = !!selectedCountryId

  // Load hub imports once on startup — non-blocking, fails gracefully
  useEffect(() => { loadImports() }, [loadImports])

  // Escape closes panel or conflict card
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (selectedCountryId) clearSelection()
      else if (selectedConflict) clearConflict()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedCountryId, selectedConflict, clearSelection, clearConflict])

  return (
    <div className="flex flex-col h-screen" style={{ background: '#070B14' }}>

      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-2 border-b flex-shrink-0 z-[100]"
        style={{ background: '#0A0F1E', borderColor: '#1E2D4A' }}>

        {/* Brand */}
        <div className="flex items-center gap-2.5 flex-shrink-0">
          <span className="text-lg">🌍</span>
          <div className="hidden sm:block">
            <p className="text-xs font-bold text-white leading-none">World Intelligence</p>
            <p className="text-xs leading-none mt-0.5" style={{ color: '#334155' }}>v2</p>
          </div>
        </div>

        <div className="w-px h-5 mx-1 hidden sm:block" style={{ background: '#1E2D4A' }} />

        {/* Search */}
        <SearchBar />

        <div className="w-px h-5 mx-1 hidden md:block" style={{ background: '#1E2D4A' }} />

        {/* Layer toggles */}
        <div className="hidden md:flex">
          <LayerToggle />
        </div>

        <div className="w-px h-5 mx-1 hidden lg:block" style={{ background: '#1E2D4A' }} />

        {/* Heatmap */}
        <div className="hidden lg:flex">
          <HeatmapSelector />
        </div>

        <div className="flex-1" />

        {/* Hub import status — read-only, no ingestion in this project */}
        <ImportStatus />

        <div className="w-px h-5 mx-1 hidden sm:block" style={{ background: '#1E2D4A' }} />

        <a href="https://github.com/neiltd/worldmaphistory_v2" target="_blank" rel="noopener noreferrer"
          className="text-xs hover:text-text-secondary transition-colors hidden sm:block" style={{ color: '#334155' }}>
          GitHub ↗
        </a>
      </header>

      {/* Map + Panel */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* Map fills available space */}
        <div className="flex-1 relative">
          <ErrorBoundary label="WorldMap">
            <WorldMap />
          </ErrorBoundary>

          {/* Conflict card — bottom left over map */}
          <AnimatePresence>
            {selectedConflict && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                transition={{ duration: 0.2 }}
                className="absolute bottom-0 left-0 w-full pointer-events-none"
              >
                <div className="pointer-events-auto">
                  <ConflictCard />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Empty state hint */}
          {!selectedCountryId && !selectedConflict && (
            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 pointer-events-none text-center">
              <p className="text-xs px-3 py-1.5 rounded-full" style={{ background: '#0E1525CC', color: '#475569', border: '1px solid #1E2D4A' }}>
                Click any country · Toggle layers above · Scroll to zoom
              </p>
            </div>
          )}
        </div>

        {/* Side panel — slides in */}
        <AnimatePresence>
          {showPanel && (
            <motion.div
              initial={{ x: '100%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '100%', opacity: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="w-[400px] xl:w-[460px] min-w-[360px] flex-shrink-0 flex flex-col overflow-hidden border-l"
              style={{ background: '#0A0F1E', borderColor: '#1E2D4A' }}
            >
              <ErrorBoundary label="CountryPanel">
                <CountryPanel />
              </ErrorBoundary>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
