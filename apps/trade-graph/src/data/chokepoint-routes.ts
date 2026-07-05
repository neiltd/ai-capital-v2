// Which (origin, dest) country pairs route through each chokepoint.
//
// Modeled by trade regions × destination regions, then expanded into concrete
// pairs. Both directions are emitted (Hormuz carries SAU→CHN oil AND CHN→SAU
// containers, even if oil dominates) — chokepoint closure hurts both flows, so
// the analysis is bidirectional.
//
// Approximate, not authoritative — meant to drive cascade analysis ("if Hormuz
// closes, who in my portfolio is exposed?") rather than be a complete atlas.
// Refine by overriding routesByChokepoint below.

import type { Chokepoint } from '../types.js'

const REGIONS = {
  persian_gulf:   ['SAU', 'IRN', 'QAT', 'ARE'] as const,
  east_asia:      ['CHN', 'JPN', 'KOR', 'TWN', 'HKG'] as const,
  se_asia:        ['VNM', 'THA', 'MYS', 'IDN', 'PHL', 'SGP'] as const,
  south_asia:     ['IND'] as const,
  europe_west:    ['GBR', 'FRA', 'DEU', 'NLD', 'ESP', 'ITA', 'IRL', 'CHE'] as const,
  europe_north:   ['NOR', 'SWE'] as const,
  europe_east:    ['POL', 'TUR'] as const,
  black_sea_exp:  ['RUS', 'KAZ'] as const,        // Black Sea exporters via Bosphorus
  americas_east:  ['USA', 'CAN', 'BRA'] as const, // east coast / Atlantic facing
  americas_west:  ['USA', 'CAN', 'MEX', 'CHL', 'PER', 'COL'] as const,
  southern_cone:  ['BRA', 'ARG', 'CHL'] as const,
  africa:         ['ZAF', 'NGA', 'EGY'] as const,
  middle_east:    ['SAU', 'IRN', 'QAT', 'ARE', 'TUR', 'ISR'] as const,
  oceania:        ['AUS', 'NZL'] as const,
} as const

type Iso3 = string

/** Cartesian product, both directions, no self-loops. */
function pairs(originsA: readonly Iso3[], originsB: readonly Iso3[]): Array<[Iso3, Iso3]> {
  const out: Array<[Iso3, Iso3]> = []
  for (const a of originsA) {
    for (const b of originsB) {
      if (a === b) continue
      out.push([a, b])
      out.push([b, a])
    }
  }
  return out
}

function dedupe(ps: Array<[Iso3, Iso3]>): Array<[Iso3, Iso3]> {
  const seen = new Set<string>()
  const out: Array<[Iso3, Iso3]> = []
  for (const [a, b] of ps) {
    const k = `${a}>${b}`
    if (seen.has(k)) continue
    seen.add(k); out.push([a, b])
  }
  return out
}

/**
 * Routes by chokepoint id (matches Chokepoint['id']). Each entry is an array
 * of (originIso3, destIso3) tuples — both directions.
 */
export const ROUTES_BY_CHOKEPOINT: Record<Chokepoint['id'], Array<[Iso3, Iso3]>> = {
  // Persian Gulf exit — energy heading to Asia, Europe, Americas; manufactured
  // goods returning the other direction.
  hormuz: dedupe([
    ...pairs(REGIONS.persian_gulf, REGIONS.east_asia),
    ...pairs(REGIONS.persian_gulf, REGIONS.south_asia),
    ...pairs(REGIONS.persian_gulf, REGIONS.europe_west),
    ...pairs(REGIONS.persian_gulf, REGIONS.americas_east),
    ...pairs(REGIONS.persian_gulf, REGIONS.americas_west),
  ]),

  // Mediterranean ↔ Red Sea. Primary Europe–Asia container artery.
  suez: dedupe([
    ...pairs(REGIONS.europe_west, REGIONS.east_asia),
    ...pairs(REGIONS.europe_west, REGIONS.se_asia),
    ...pairs(REGIONS.europe_west, REGIONS.south_asia),
    ...pairs(REGIONS.europe_north, REGIONS.east_asia),
    ...pairs(REGIONS.middle_east, REGIONS.europe_west),
  ]),

  // Indian Ocean ↔ East Asia. ~30% of global trade, dominated by China energy
  // imports and Europe–Asia containers.
  malacca: dedupe([
    ...pairs(REGIONS.persian_gulf, REGIONS.east_asia),
    ...pairs(REGIONS.middle_east, REGIONS.east_asia),
    ...pairs(REGIONS.africa, REGIONS.east_asia),
    ...pairs(REGIONS.europe_west, REGIONS.east_asia),
    ...pairs(REGIONS.europe_west, REGIONS.se_asia),
    ...pairs(REGIONS.south_asia, REGIONS.east_asia),
  ]),

  // Atlantic ↔ Pacific. US East Coast ↔ Asia; growing LNG exports west to east.
  panama: dedupe([
    ...pairs(REGIONS.americas_east, REGIONS.east_asia),
    ...pairs(REGIONS.americas_east, REGIONS.se_asia),
    ...pairs(REGIONS.americas_east, REGIONS.oceania),
    ...pairs(['USA'], REGIONS.americas_west),
  ]),

  // Red Sea ↔ Gulf of Aden. Almost everything that goes through Suez southbound
  // also crosses Bab-el-Mandeb. Houthi attacks in 2024-25 made this a separate
  // risk than Suez per se.
  bab_el_mandeb: dedupe([
    ...pairs(REGIONS.europe_west, REGIONS.east_asia),
    ...pairs(REGIONS.europe_west, REGIONS.south_asia),
    ...pairs(REGIONS.persian_gulf, REGIONS.europe_west),
  ]),

  // Black Sea exit. Russian/Ukrainian grain + Caspian oil flowing to Med/EU.
  bosphorus: dedupe([
    ...pairs(REGIONS.black_sea_exp, REGIONS.europe_west),
    ...pairs(REGIONS.black_sea_exp, REGIONS.middle_east),
    ...pairs(REGIONS.black_sea_exp, REGIONS.africa),
  ]),

  // Suez alternative. When Bab-el-Mandeb is unsafe (Red Sea attacks), Asia–
  // Europe containers reroute around Cape of Good Hope. Same (origin, dest)
  // set as Suez; analysis logic should treat them as substitutes, not additive.
  cape_of_good_hope: dedupe([
    ...pairs(REGIONS.europe_west, REGIONS.east_asia),
    ...pairs(REGIONS.europe_west, REGIONS.se_asia),
    ...pairs(REGIONS.europe_west, REGIONS.south_asia),
  ]),

  // Panama alternative. South American grain/copper around Cape Horn when
  // Panama is congested or restricted. Mostly southern cone ↔ Asia/West Coast.
  drake: dedupe([
    ...pairs(REGIONS.southern_cone, REGIONS.east_asia),
    ...pairs(REGIONS.southern_cone, REGIONS.americas_west),
  ]),

  // ~88% of Korea + Japan container traffic to/from Europe passes here. Semis
  // exposure is the killer story for the portfolio.
  taiwan_strait: dedupe([
    ...pairs(['JPN', 'KOR', 'TWN'], REGIONS.se_asia),
    ...pairs(['JPN', 'KOR', 'TWN'], REGIONS.europe_west),
    ...pairs(['JPN', 'KOR', 'TWN'], REGIONS.americas_west),
    ...pairs(['JPN', 'KOR', 'TWN'], REGIONS.persian_gulf),
  ]),

  // North Sea exit. UK, NL, DE, BE ports to/from Atlantic & North America.
  english_channel: dedupe([
    ...pairs(REGIONS.europe_west, REGIONS.americas_east),
    ...pairs(REGIONS.europe_west, REGIONS.americas_west),
    ...pairs(REGIONS.europe_north, REGIONS.americas_east),
    ...pairs(REGIONS.europe_west, REGIONS.africa),
  ]),
}
