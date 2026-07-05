// Country geographic centroids — ISO 3166-1 alpha-3 → { lat, lng }.
//
// Used as a coordinate fallback when a source provides country-level data
// but no precise coordinates. Always label as coordinateQuality='country_centroid'.
//
// Source: UN geographic data / Natural Earth, approximate population centroids.
// Precision: ~1 decimal degree — sufficient for map marker placement, not
// for precise event location claims.
//
// Do NOT use these values to imply precision about where an event occurred.
// Frontend must distinguish marker types by coordinateQuality.

export interface Centroid {
  lat: number;
  lng: number;
}

const CENTROIDS: Record<string, Centroid> = {
  // ── Middle East & North Africa ─────────────────────────────────────────────
  AFG: { lat:  33.9,  lng:  67.7 },
  ARE: { lat:  24.5,  lng:  54.4 },
  BHR: { lat:  26.0,  lng:  50.6 },
  DZA: { lat:  28.0,  lng:   2.6 },
  EGY: { lat:  26.8,  lng:  30.8 },
  IRN: { lat:  32.4,  lng:  53.7 },
  IRQ: { lat:  33.2,  lng:  43.7 },
  ISR: { lat:  31.5,  lng:  34.8 },
  JOR: { lat:  30.6,  lng:  36.2 },
  KWT: { lat:  29.3,  lng:  47.7 },
  LBN: { lat:  33.9,  lng:  35.5 },
  LBY: { lat:  26.3,  lng:  17.2 },
  MAR: { lat:  31.8,  lng:  -7.1 },
  OMN: { lat:  21.5,  lng:  55.9 },
  PSE: { lat:  31.9,  lng:  35.2 },
  QAT: { lat:  25.4,  lng:  51.2 },
  SAU: { lat:  23.9,  lng:  45.1 },
  SYR: { lat:  34.8,  lng:  38.9 },
  TUN: { lat:  33.9,  lng:   9.6 },
  TUR: { lat:  38.9,  lng:  35.2 },
  YEM: { lat:  15.6,  lng:  48.5 },
  SDN: { lat:  12.9,  lng:  30.2 },
  SSD: { lat:   6.9,  lng:  31.3 },

  // ── Europe ─────────────────────────────────────────────────────────────────
  ALB: { lat:  41.2,  lng:  20.2 },
  AUT: { lat:  47.5,  lng:  14.6 },
  BEL: { lat:  50.6,  lng:   4.5 },
  BGR: { lat:  42.7,  lng:  25.5 },
  BLR: { lat:  53.7,  lng:  28.0 },
  BIH: { lat:  44.2,  lng:  17.9 },
  CHE: { lat:  46.8,  lng:   8.2 },
  CZE: { lat:  49.8,  lng:  15.5 },
  DEU: { lat:  51.2,  lng:  10.5 },
  DNK: { lat:  56.3,  lng:   9.5 },
  ESP: { lat:  40.2,  lng:  -3.7 },
  EST: { lat:  58.6,  lng:  25.0 },
  FIN: { lat:  64.0,  lng:  26.0 },
  FRA: { lat:  46.2,  lng:   2.2 },
  GBR: { lat:  54.4,  lng:  -2.1 },
  GRC: { lat:  39.1,  lng:  22.0 },
  HRV: { lat:  45.1,  lng:  15.2 },
  HUN: { lat:  47.2,  lng:  19.5 },
  IRL: { lat:  53.4,  lng:  -8.2 },
  ITA: { lat:  42.8,  lng:  12.7 },
  KOS: { lat:  42.6,  lng:  20.9 },
  LTU: { lat:  55.7,  lng:  23.8 },
  LUX: { lat:  49.8,  lng:   6.1 },
  LVA: { lat:  56.9,  lng:  24.6 },
  MDA: { lat:  47.0,  lng:  28.4 },
  MKD: { lat:  41.6,  lng:  21.7 },
  MNE: { lat:  42.7,  lng:  19.4 },
  NLD: { lat:  52.3,  lng:   5.3 },
  NOR: { lat:  64.6,  lng:  17.9 },
  POL: { lat:  52.1,  lng:  19.4 },
  PRT: { lat:  39.4,  lng:  -8.2 },
  ROU: { lat:  45.9,  lng:  24.9 },
  RUS: { lat:  61.5,  lng:  90.8 },
  SRB: { lat:  44.0,  lng:  21.0 },
  SVK: { lat:  48.7,  lng:  19.7 },
  SVN: { lat:  46.1,  lng:  14.8 },
  SWE: { lat:  60.1,  lng:  18.6 },
  UKR: { lat:  49.0,  lng:  31.5 },

  // ── Sub-Saharan Africa ──────────────────────────────────────────────────────
  AGO: { lat: -11.2,  lng:  17.9 },
  BFA: { lat:  12.4,  lng:  -1.6 },
  BDI: { lat:  -3.4,  lng:  29.9 },
  BEN: { lat:   9.3,  lng:   2.3 },
  BWA: { lat: -22.3,  lng:  24.7 },
  CAF: { lat:   6.6,  lng:  20.9 },
  CIV: { lat:   7.5,  lng:  -5.6 },
  CMR: { lat:   5.7,  lng:  12.4 },
  COD: { lat:  -4.0,  lng:  21.8 },
  COG: { lat:  -0.2,  lng:  15.8 },
  CPV: { lat:  16.0,  lng: -24.0 },
  ETH: { lat:   9.1,  lng:  40.5 },
  GAB: { lat:  -0.8,  lng:  11.6 },
  GHA: { lat:   7.9,  lng:  -1.0 },
  GIN: { lat:  10.7,  lng: -11.3 },
  GMB: { lat:  13.4,  lng: -15.3 },
  GNB: { lat:  11.8,  lng: -15.2 },
  KEN: { lat:  -0.0,  lng:  37.9 },
  LBR: { lat:   6.4,  lng:  -9.4 },
  LSO: { lat: -29.6,  lng:  28.2 },
  MDG: { lat: -18.8,  lng:  46.9 },
  MLI: { lat:  17.6,  lng:  -4.0 },
  MOZ: { lat: -18.7,  lng:  35.5 },
  MRT: { lat:  20.3,  lng: -10.9 },
  MWI: { lat: -13.2,  lng:  34.3 },
  NER: { lat:  17.6,  lng:   8.1 },
  NGA: { lat:   9.1,  lng:   8.7 },
  RWA: { lat:  -1.9,  lng:  29.9 },
  SEN: { lat:  14.5,  lng: -14.5 },
  SLE: { lat:   8.5,  lng: -11.8 },
  SOM: { lat:   5.2,  lng:  46.2 },
  SWZ: { lat: -26.5,  lng:  31.5 },
  TCD: { lat:  15.5,  lng:  18.7 },
  TGO: { lat:   8.6,  lng:   0.8 },
  TZA: { lat:  -6.4,  lng:  34.9 },
  UGA: { lat:   1.4,  lng:  32.3 },
  ZAF: { lat: -29.0,  lng:  25.1 },
  ZMB: { lat: -13.1,  lng:  27.8 },
  ZWE: { lat: -19.0,  lng:  29.9 },

  // ── Asia-Pacific ────────────────────────────────────────────────────────────
  ARM: { lat:  40.1,  lng:  45.0 },
  AUS: { lat: -25.3,  lng: 133.8 },
  AZE: { lat:  40.1,  lng:  47.6 },
  BGD: { lat:  23.7,  lng:  90.4 },
  BRN: { lat:   4.5,  lng: 114.7 },
  BTN: { lat:  27.5,  lng:  90.4 },
  CHN: { lat:  35.9,  lng: 104.2 },
  GEO: { lat:  42.3,  lng:  43.4 },
  IDN: { lat:  -0.8,  lng: 113.9 },
  IND: { lat:  20.6,  lng:  78.9 },
  JPN: { lat:  36.2,  lng: 138.3 },
  KAZ: { lat:  48.0,  lng:  66.9 },
  KGZ: { lat:  41.2,  lng:  74.8 },
  KHM: { lat:  12.6,  lng: 104.9 },
  KOR: { lat:  35.9,  lng: 127.8 },
  LAO: { lat:  17.9,  lng: 102.5 },
  LKA: { lat:   7.9,  lng:  80.8 },
  MMR: { lat:  19.2,  lng:  96.7 },
  MNG: { lat:  46.8,  lng: 103.8 },
  MYS: { lat:   4.2,  lng: 108.0 },
  NPL: { lat:  28.4,  lng:  84.1 },
  NZL: { lat: -41.5,  lng: 172.8 },
  PAK: { lat:  30.4,  lng:  69.3 },
  PHL: { lat:  12.8,  lng: 121.8 },
  PRK: { lat:  40.3,  lng: 127.5 },
  SGP: { lat:   1.3,  lng: 103.8 },
  THA: { lat:  15.9,  lng: 100.9 },
  TJK: { lat:  38.9,  lng:  71.3 },
  TKM: { lat:  39.0,  lng:  59.6 },
  TWN: { lat:  23.7,  lng: 120.9 },
  UZB: { lat:  41.4,  lng:  64.6 },
  VNM: { lat:  16.1,  lng: 107.9 },

  // ── Americas ────────────────────────────────────────────────────────────────
  ARG: { lat: -38.4,  lng: -63.6 },
  BOL: { lat: -16.3,  lng: -63.6 },
  BRA: { lat: -14.2,  lng: -51.9 },
  CAN: { lat:  56.1,  lng: -96.3 },
  CHL: { lat: -35.7,  lng: -71.5 },
  COL: { lat:   4.1,  lng: -72.9 },
  CUB: { lat:  21.5,  lng: -79.5 },
  DOM: { lat:  18.7,  lng: -70.2 },
  ECU: { lat:  -1.8,  lng: -78.2 },
  GTM: { lat:  15.8,  lng: -90.2 },
  GUY: { lat:   4.9,  lng: -59.0 },
  HND: { lat:  15.2,  lng: -86.2 },
  HTI: { lat:  18.9,  lng: -72.7 },
  JAM: { lat:  18.1,  lng: -77.3 },
  MEX: { lat:  23.6,  lng: -102.6 },
  NIC: { lat:  12.9,  lng: -85.2 },
  PAN: { lat:   8.5,  lng: -80.8 },
  PER: { lat:  -9.2,  lng: -75.0 },
  PRY: { lat: -23.4,  lng: -58.4 },
  SLV: { lat:  13.8,  lng: -88.9 },
  SUR: { lat:   3.9,  lng: -56.0 },
  TTO: { lat:  10.7,  lng: -61.2 },
  URY: { lat: -32.5,  lng: -55.8 },
  USA: { lat:  37.1,  lng: -95.7 },
  VEN: { lat:   6.4,  lng: -66.6 },

  // ── Global / special ────────────────────────────────────────────────────────
  // Used when an event is explicitly global in scope (e.g. UN resolutions)
  GLB: { lat:  0.0,   lng:   0.0 },
};

/**
 * Look up the geographic centroid for an ISO 3166-1 alpha-3 country code.
 * Returns null when the code is unknown or not in the lookup table.
 */
export function getCountryCentroid(iso3: string): Centroid | null {
  return CENTROIDS[iso3] ?? null;
}

/**
 * Return all country codes that have centroid data.
 * Used in validation checks.
 */
export function knownCountryCodes(): Set<string> {
  return new Set(Object.keys(CENTROIDS));
}

export default CENTROIDS;
