// Layer components
export { default as ConflictZoneLayer } from './geopolitical/ConflictZoneLayer'
export { default as TradeRouteLayer }   from './economic/TradeRouteLayer'
export { default as AirportLayer }      from './infrastructure/AirportLayer'
export { default as PortLayer }         from './infrastructure/PortLayer'
export { default as SubmarineCableLayer } from './infrastructure/SubmarineCableLayer'
export { default as PowerLayer }        from './utilities/PowerLayer'

// Registry
export { LAYER_REGISTRY, LAYER_GROUPS, getLayer, getLayersByGroup } from './_core/registry'

// Core types
export type { LayerMeta, LayerProps, LayerGroup, LegendEntry } from './_core/types'

// Layer-specific types (named to avoid ambiguity)
export type * from './geopolitical/types'
export type * from './economic/types'
export type * from './infrastructure/types'
export type * from './utilities/types'
export type { NewsArticle, IntelligenceEvent, EventType, EventStatus, ImpactTier } from './intelligence/types'
export type { CountryEnvironmentProfile } from './environment/types'
export type { InvestmentSignal, InvestmentThesis } from './investment/types'
