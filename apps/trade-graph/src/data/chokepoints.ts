// 10 fixed maritime chokepoints. Static dataset — the trade routes flowing
// through each are seeded separately in routes.ts and refreshed by the
// ingest CLI when new flow data lands.
//
// Coordinates are approximate (degrees, WGS84) — sufficient for map rendering.

import type { Chokepoint } from '../types.js'

export const CHOKEPOINTS: Chokepoint[] = [
  {
    id: 'hormuz',
    name: 'Strait of Hormuz',
    lat: 26.566, lon: 56.250,
    description: '~20% of global oil + 25% LNG flows; primary Persian Gulf exit.',
  },
  {
    id: 'suez',
    name: 'Suez Canal',
    lat: 30.5852, lon: 32.2715,
    description: 'Mediterranean ↔ Red Sea; ~12% of world trade, including Asia–Europe container flows.',
  },
  {
    id: 'malacca',
    name: 'Strait of Malacca',
    lat:  2.5,  lon: 101.0,
    description: 'Primary Indian Ocean ↔ East Asia route; ~30% of global trade, 80% of China oil imports.',
  },
  {
    id: 'panama',
    name: 'Panama Canal',
    lat:  9.080, lon: -79.680,
    description: 'Atlantic ↔ Pacific shortcut; US East Coast ↔ Asia container + LNG flows.',
  },
  {
    id: 'bab_el_mandeb',
    name: 'Bab-el-Mandeb',
    lat: 12.583, lon: 43.333,
    description: 'Red Sea ↔ Gulf of Aden; gateway to Suez from the south, oil + container flows.',
  },
  {
    id: 'bosphorus',
    name: 'Bosphorus Strait',
    lat: 41.119, lon: 29.075,
    description: 'Black Sea ↔ Mediterranean; Russian/Ukrainian grain + Caspian oil flows.',
  },
  {
    id: 'cape_of_good_hope',
    name: 'Cape of Good Hope',
    lat: -34.357, lon: 18.477,
    description: 'Suez alternative for Asia–Europe; activated heavily during Red Sea attacks.',
  },
  {
    id: 'drake',
    name: 'Drake Passage',
    lat: -58.0, lon: -65.0,
    description: 'Atlantic ↔ Pacific south of Cape Horn; backup route when Panama is congested or closed.',
  },
  {
    id: 'taiwan_strait',
    name: 'Taiwan Strait',
    lat: 24.5, lon: 119.5,
    description: 'NE Asia ↔ SE Asia / Europe lane; carries most container flows past Taiwan; semiconductor exposure.',
  },
  {
    id: 'english_channel',
    name: 'English Channel',
    lat: 50.5, lon: 1.5,
    description: 'North Sea ↔ Atlantic; UK + Northern European container + chemicals + autos.',
  },
]
