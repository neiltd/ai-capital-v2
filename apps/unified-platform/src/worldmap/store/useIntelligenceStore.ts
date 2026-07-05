/**
 * Intelligence store — runtime state for hub-imported data.
 *
 * Separate from useMapStore intentionally:
 *   - useMapStore owns: map interaction, layer visibility, country selection
 *   - useIntelligenceStore owns: imported events, indicators, manifest
 *
 * The store loads data lazily (first call to loadImports() triggers fetch).
 * Subsequent calls return cached state — no redundant file reads.
 *
 * ─── Future agent integration point ──────────────────────────────────────────
 * When agents produce enriched events, they write updated import files.
 * Call refreshImports() to reload. The store propagates changes to all
 * subscribed components without requiring them to know about the hub.
 *
 * ─── Future real-time integration point ──────────────────────────────────────
 * If the hub eventually pushes via WebSocket, the WS handler calls
 * appendEvents(newEvents) — the store merges and deduplicates without
 * a full reload.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { create } from 'zustand'
import type { ImportedEvent, ImportManifest } from '../data/schemas/imports'
import { loadAllImports } from '../lib/adapters/imports'

interface IntelligenceStore {
  // Load state
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null

  // Imported data
  events:           ImportedEvent[]
  manifest:         ImportManifest | null
  // True if any loaded resource came from a *.example.json fallback
  // rather than real hub-produced data.
  isSample:         boolean

  // Derived lookups (built once on load, used for O(1) map queries)
  // ISO3 → events involving that country
  eventsByIso3:     Record<string, ImportedEvent[]>

  // Actions
  loadImports:    () => Promise<void>
  refreshImports: () => Promise<void>

  // Future: appendEvents(newEvents: ImportedEvent[]): void
  // Future: updateEnergyTick(key: string, value: number): void
}

// ── Derived index builders ────────────────────────────────────────────────────

function buildEventsByIso3(events: ImportedEvent[]): Record<string, ImportedEvent[]> {
  const index: Record<string, ImportedEvent[]> = {}
  for (const evt of events) {
    for (const iso3 of evt.iso3) {
      if (!index[iso3]) index[iso3] = []
      index[iso3].push(evt)
    }
  }
  return index
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useIntelligenceStore = create<IntelligenceStore>((set, get) => ({
  status: 'idle',
  error: null,

  events:           [],
  manifest:         null,
  isSample:         false,
  eventsByIso3:     {},

  loadImports: async () => {
    // Don't reload if already loaded
    if (get().status === 'ready' || get().status === 'loading') return

    set({ status: 'loading', error: null })
    try {
      const data = await loadAllImports()
      set({
        status:           'ready',
        events:           data.events,
        manifest:         data.manifest,
        isSample:         data.isSample,
        eventsByIso3:     buildEventsByIso3(data.events),
      })
    } catch (e) {
      set({ status: 'error', error: (e as Error).message })
    }
  },

  refreshImports: async () => {
    // Force a reload regardless of current state
    set({ status: 'idle' })
    await get().loadImports()
  },
}))
