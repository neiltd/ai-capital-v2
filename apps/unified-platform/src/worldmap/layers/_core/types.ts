export type LayerGroup =
  | 'geopolitical'
  | 'economic'
  | 'infrastructure'
  | 'utilities'
  | 'intelligence'
  | 'environment'
  | 'investment'

/**
 * Thematic scopes group layers by geopolitical relevance domain.
 * A layer may belong to multiple scopes.
 *
 * Future: a thematic view mode activates only layers tagged with the active scope,
 * reducing cognitive load and improving analytical focus.
 *
 * Matches ThematicScopeSchema in src/data/schemas/_shared.ts.
 */
export type ThematicScope =
  | 'energy-security'
  | 'logistics-fragility'
  | 'digital-sovereignty'
  | 'semiconductor-supply-chain'
  | 'maritime-chokepoints'

export interface LegendEntry {
  color: string
  label: string
  shape?: 'square' | 'circle' | 'diamond' | 'line'
}

export interface LayerMeta {
  id: string
  label: string
  /** One sentence answering: "Why does this matter for geopolitical analysis?" */
  description: string
  group: LayerGroup
  defaultEnabled: boolean
  legend?: LegendEntry[]
  /** Set to true for layers with no data yet */
  placeholder?: boolean

  /**
   * Thematic scopes this layer participates in.
   * Used for future thematic view filtering — no UI behavior today.
   * A layer with no themes entry is general-purpose / cross-scope.
   */
  themes?: ThematicScope[]

  /**
   * Infrastructure tier range this layer covers when rendering.
   * [minTier, maxTier] where 1=critical, 4=background.
   * Placeholder for future render registry — no behavior today.
   * When zoom-aware filtering is implemented, this controls which tier
   * cutoff applies to this layer.
   */
  tierRange?: [1 | 2 | 3 | 4, 1 | 2 | 3 | 4]
}

export interface LayerProps {
  visible: boolean
  labelLayerId?: string
  /**
   * True once per-layer icon images are registered with the map via
   * useLayerIcons. Layers should gate `type="symbol"` rendering on this
   * flag — referencing an icon-image that doesn't yet exist generates
   * console warnings from MapLibre.
   */
  iconsReady?: boolean
}
