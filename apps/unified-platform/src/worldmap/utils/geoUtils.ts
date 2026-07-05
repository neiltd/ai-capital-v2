/**
 * Re-export shim — the implementation has moved to src/lib/geo/antimeridian.ts.
 * Existing imports of utils/geoUtils continue to work without changes.
 * New code should import directly from lib/geo/antimeridian.
 */
export * from '../lib/geo/antimeridian'
