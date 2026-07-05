import type { EventType, Severity } from './types.ts';
import { knownCountryCodes } from './geocoding/country-centroids.ts';
import { logger } from './logger.ts';

// ── Country keyword → ISO 3166-1 alpha-3 ─────────────────────────────────────
// Checked in order; first match wins. Longer/more specific strings before
// shorter ones to avoid substring collisions (e.g. 'nigeria'/'nigerian' must
// be checked before 'nigerien', 'guinea-bissau' before bare 'guinea').
//
// Coverage is meant to track geocoding/country-centroids.ts's CENTROIDS table
// (the canonical list of countries this system can place on a map) — every
// ISO3 code used below should exist in CENTROIDS. Codes are validated against
// CENTROIDS at module load (see below); a mismatch logs a warning rather than
// throwing, since a keyword pointing at a code with no centroid is a data bug,
// not something that should crash ingestion.

const COUNTRY_MAP: Array<[string, string]> = [
  // Middle East & North Africa
  ['saudi arabia', 'SAU'], ['saudi', 'SAU'],
  ['united arab emirates', 'ARE'], ['uae', 'ARE'], ['dubai', 'ARE'], ['abu dhabi', 'ARE'],
  ['iraqi', 'IRQ'], ['iraq', 'IRQ'],
  ['iranian', 'IRN'], ['iran', 'IRN'],
  ['israeli', 'ISR'], ['israel', 'ISR'],
  ['palestinian', 'PSE'], ['palestine', 'PSE'], ['west bank', 'PSE'], ['gaza', 'PSE'],
  ['lebanese', 'LBN'], ['lebanon', 'LBN'],
  ['syrian', 'SYR'], ['syria', 'SYR'],
  ['yemeni', 'YEM'], ['yemen', 'YEM'],
  ['jordanian', 'JOR'], ['jordan', 'JOR'],
  ['turkish', 'TUR'], ['turkey', 'TUR'],
  ['qatari', 'QAT'], ['qatar', 'QAT'],
  ['kuwaiti', 'KWT'], ['kuwait', 'KWT'],
  ['omani', 'OMN'], ['oman', 'OMN'],
  ['bahraini', 'BHR'], ['bahrain', 'BHR'],
  ['algerian', 'DZA'], ['algeria', 'DZA'],
  ['moroccan', 'MAR'], ['morocco', 'MAR'],
  ['tunisian', 'TUN'], ['tunisia', 'TUN'],
  // Africa
  ['nigerian', 'NGA'], ['nigeria', 'NGA'],
  ['libyan', 'LBY'], ['libya', 'LBY'],
  ['egyptian', 'EGY'], ['egypt', 'EGY'],
  ['ethiopian', 'ETH'], ['ethiopia', 'ETH'],
  ['somali', 'SOM'], ['somalia', 'SOM'],
  ['sudanese', 'SDN'], ['sudan', 'SDN'],
  ['south sudan', 'SSD'],
  ['malian', 'MLI'], ['mali', 'MLI'],
  ['nigerien', 'NER'],
  ['burkina faso', 'BFA'],
  ['democratic republic of the congo', 'COD'], ['drc', 'COD'], ['congo-kinshasa', 'COD'],
  ['republic of the congo', 'COG'], ['congo-brazzaville', 'COG'],
  ['congo', 'COD'],
  ['mozambican', 'MOZ'], ['mozambique', 'MOZ'],
  ['kenyan', 'KEN'], ['kenya', 'KEN'],
  ['south african', 'ZAF'], ['south africa', 'ZAF'],
  ['angolan', 'AGO'], ['angola', 'AGO'],
  ['ghanaian', 'GHA'], ['ghana', 'GHA'],
  ['senegalese', 'SEN'], ['senegal', 'SEN'],
  ['cameroonian', 'CMR'], ['cameroon', 'CMR'],
  ['burundian', 'BDI'], ['burundi', 'BDI'],
  ['beninese', 'BEN'], ['benin', 'BEN'],
  ['botswanan', 'BWA'], ['botswana', 'BWA'],
  ['central african republic', 'CAF'],
  ['ivorian', 'CIV'], ['ivory coast', 'CIV'], ["cote d'ivoire", 'CIV'], ['côte d’ivoire', 'CIV'],
  ['cape verdean', 'CPV'], ['cape verde', 'CPV'],
  ['gabonese', 'GAB'], ['gabon', 'GAB'],
  ['guinea-bissau', 'GNB'], ['guinea bissau', 'GNB'],
  ['guinean', 'GIN'], ['guinea', 'GIN'],
  ['gambian', 'GMB'], ['gambia', 'GMB'],
  ['liberian', 'LBR'], ['liberia', 'LBR'],
  ['lesotho', 'LSO'],
  ['malagasy', 'MDG'], ['madagascar', 'MDG'],
  ['mauritanian', 'MRT'], ['mauritania', 'MRT'],
  ['malawian', 'MWI'], ['malawi', 'MWI'],
  ['rwandan', 'RWA'], ['rwanda', 'RWA'],
  ['sierra leonean', 'SLE'], ['sierra leone', 'SLE'],
  ['swazi', 'SWZ'], ['eswatini', 'SWZ'], ['swaziland', 'SWZ'],
  ['chadian', 'TCD'], ['chad', 'TCD'],
  ['togolese', 'TGO'], ['togo', 'TGO'],
  ['tanzanian', 'TZA'], ['tanzania', 'TZA'],
  ['ugandan', 'UGA'], ['uganda', 'UGA'],
  ['zambian', 'ZMB'], ['zambia', 'ZMB'],
  ['zimbabwean', 'ZWE'], ['zimbabwe', 'ZWE'],
  // Europe
  ['russian', 'RUS'], ['russia', 'RUS'],
  ['ukrainian', 'UKR'], ['ukraine', 'UKR'],
  ['german', 'DEU'], ['germany', 'DEU'],
  ['french', 'FRA'], ['france', 'FRA'],
  ['british', 'GBR'], ['united kingdom', 'GBR'], ['britain', 'GBR'], [' uk ', 'GBR'],
  ['polish', 'POL'], ['poland', 'POL'],
  ['serbian', 'SRB'], ['serbia', 'SRB'],
  ['kosovar', 'KOS'], ['kosovo', 'KOS'],
  ['belarusian', 'BLR'], ['belarus', 'BLR'],
  ['moldovan', 'MDA'], ['moldova', 'MDA'],
  ['armenian', 'ARM'], ['armenia', 'ARM'],
  ['azerbaijani', 'AZE'], ['azerbaijan', 'AZE'],
  ['georgian', 'GEO'], ['georgia', 'GEO'],
  ['albanian', 'ALB'], ['albania', 'ALB'],
  ['austrian', 'AUT'], ['austria', 'AUT'],
  ['belgian', 'BEL'], ['belgium', 'BEL'],
  ['bulgarian', 'BGR'], ['bulgaria', 'BGR'],
  ['bosnia and herzegovina', 'BIH'], ['bosnian', 'BIH'], ['bosnia', 'BIH'],
  ['swiss', 'CHE'], ['switzerland', 'CHE'],
  ['czech republic', 'CZE'], ['czechia', 'CZE'], ['czech', 'CZE'],
  ['danish', 'DNK'], ['denmark', 'DNK'],
  ['spanish', 'ESP'], ['spain', 'ESP'],
  ['estonian', 'EST'], ['estonia', 'EST'],
  ['finnish', 'FIN'], ['finland', 'FIN'],
  ['greek', 'GRC'], ['greece', 'GRC'],
  ['croatian', 'HRV'], ['croatia', 'HRV'],
  ['hungarian', 'HUN'], ['hungary', 'HUN'],
  ['irish', 'IRL'], ['ireland', 'IRL'],
  ['italian', 'ITA'], ['italy', 'ITA'],
  ['lithuanian', 'LTU'], ['lithuania', 'LTU'],
  ['luxembourg', 'LUX'],
  ['latvian', 'LVA'], ['latvia', 'LVA'],
  ['macedonian', 'MKD'], ['north macedonia', 'MKD'], ['macedonia', 'MKD'],
  ['montenegrin', 'MNE'], ['montenegro', 'MNE'],
  ['dutch', 'NLD'], ['netherlands', 'NLD'], ['holland', 'NLD'],
  ['norwegian', 'NOR'], ['norway', 'NOR'],
  ['portuguese', 'PRT'], ['portugal', 'PRT'],
  ['romanian', 'ROU'], ['romania', 'ROU'],
  ['slovakian', 'SVK'], ['slovakia', 'SVK'],
  ['slovenian', 'SVN'], ['slovenia', 'SVN'],
  ['swedish', 'SWE'], ['sweden', 'SWE'],
  // Asia-Pacific
  ['chinese', 'CHN'], ['china', 'CHN'],
  ['taiwanese', 'TWN'], ['taiwan', 'TWN'],
  ['north korea', 'PRK'], ['dprk', 'PRK'],
  ['south korean', 'KOR'], ['south korea', 'KOR'],
  ['japanese', 'JPN'], ['japan', 'JPN'],
  ['indian', 'IND'], ['india', 'IND'],
  ['pakistani', 'PAK'], ['pakistan', 'PAK'],
  ['afghan', 'AFG'], ['afghanistan', 'AFG'],
  ['myanmar', 'MMR'], ['burmese', 'MMR'], ['burma', 'MMR'],
  ['bangladeshi', 'BGD'], ['bangladesh', 'BGD'],
  ['indonesian', 'IDN'], ['indonesia', 'IDN'],
  ['filipino', 'PHL'], ['philippines', 'PHL'],
  ['vietnamese', 'VNM'], ['vietnam', 'VNM'],
  ['thai', 'THA'], ['thailand', 'THA'],
  ['cambodian', 'KHM'], ['cambodia', 'KHM'],
  ['malaysian', 'MYS'], ['malaysia', 'MYS'],
  ['singaporean', 'SGP'], ['singapore', 'SGP'],
  ['kazakh', 'KAZ'], ['kazakhstan', 'KAZ'],
  ['australian', 'AUS'], ['australia', 'AUS'],
  ['bruneian', 'BRN'], ['brunei', 'BRN'],
  ['bhutanese', 'BTN'], ['bhutan', 'BTN'],
  ['kyrgyz', 'KGZ'], ['kyrgyzstan', 'KGZ'],
  ['laotian', 'LAO'], ['laos', 'LAO'],
  ['sri lankan', 'LKA'], ['sri lanka', 'LKA'],
  ['mongolian', 'MNG'], ['mongolia', 'MNG'],
  ['nepalese', 'NPL'], ['nepali', 'NPL'], ['nepal', 'NPL'],
  ['new zealand', 'NZL'],
  ['tajik', 'TJK'], ['tajikistan', 'TJK'],
  ['turkmen', 'TKM'], ['turkmenistan', 'TKM'],
  ['uzbek', 'UZB'], ['uzbekistan', 'UZB'],
  // Americas
  ['american', 'USA'], ['united states', 'USA'],
  ['canadian', 'CAN'], ['canada', 'CAN'],
  ['mexican', 'MEX'], ['mexico', 'MEX'],
  ['brazilian', 'BRA'], ['brazil', 'BRA'],
  ['venezuelan', 'VEN'], ['venezuela', 'VEN'],
  ['colombian', 'COL'], ['colombia', 'COL'],
  ['argentinian', 'ARG'], ['argentine', 'ARG'], ['argentina', 'ARG'],
  ['chilean', 'CHL'], ['chile', 'CHL'],
  ['peruvian', 'PER'], ['peru', 'PER'],
  ['haitian', 'HTI'], ['haiti', 'HTI'],
  ['cuban', 'CUB'], ['cuba', 'CUB'],
  ['nicaraguan', 'NIC'], ['nicaragua', 'NIC'],
  ['bolivian', 'BOL'], ['bolivia', 'BOL'],
  ['dominican republic', 'DOM'],
  ['ecuadorian', 'ECU'], ['ecuador', 'ECU'],
  ['guatemalan', 'GTM'], ['guatemala', 'GTM'],
  ['guyanese', 'GUY'], ['guyana', 'GUY'],
  ['honduran', 'HND'], ['honduras', 'HND'],
  ['jamaican', 'JAM'], ['jamaica', 'JAM'],
  ['panamanian', 'PAN'], ['panama', 'PAN'],
  ['paraguayan', 'PRY'], ['paraguay', 'PRY'],
  ['salvadoran', 'SLV'], ['el salvador', 'SLV'],
  ['surinamese', 'SUR'], ['suriname', 'SUR'],
  ['trinidad and tobago', 'TTO'], ['trinidadian', 'TTO'],
  ['uruguayan', 'URY'], ['uruguay', 'URY'],
];

// Guard against drift between this keyword map and the centroid table it's
// meant to track — logs once at load time rather than failing ingestion.
{
  const known = knownCountryCodes();
  const unknownCodes = new Set(COUNTRY_MAP.map(([, iso3]) => iso3).filter(iso3 => !known.has(iso3)));
  for (const iso3 of unknownCodes) {
    logger.warn('inference', `COUNTRY_MAP references ISO3 '${iso3}' with no entry in country-centroids CENTROIDS table`);
  }
}

export function inferCountry(text: string): string {
  const lower = ' ' + text.toLowerCase() + ' ';
  for (const [keyword, iso3] of COUNTRY_MAP) {
    if (lower.includes(keyword)) return iso3;
  }
  logger.warn('inference', 'inferCountry: no country match found', { text: text.slice(0, 160) });
  return 'UNK';
}

// ── Event type inference ──────────────────────────────────────────────────────

const EVENT_TYPE_KEYWORDS: Record<Exclude<EventType, 'other'>, string[]> = {
  conflict: [
    'war', 'battle', 'attack', 'airstrike', 'bombing', 'explosion', 'gunfire',
    'clash', 'troops', 'military', 'soldier', 'fighter', 'militant', 'insurgent',
    'shelling', 'missile', 'rocket', 'drone strike', 'casualt', 'killed', 'dead',
    'wounded', 'hostage', 'siege', 'offensive', 'ceasefire',
  ],
  disaster: [
    'earthquake', 'flood', 'hurricane', 'typhoon', 'cyclone', 'tornado',
    'tsunami', 'drought', 'wildfire', 'volcanic', 'landslide', 'famine',
    'epidemic', 'pandemic', 'disease outbreak',
  ],
  political: [
    'election', 'coup', 'president', 'prime minister', 'parliament', 'government',
    'protest', 'demonstration', 'riot', 'sanction', 'diplomatic', 'treaty',
    'ceasefire', 'negotiation', 'arrest', 'opposition',
  ],
  economic: [
    'oil price', 'crude', 'inflation', 'gdp', 'recession', 'tariff',
    'trade war', 'currency', 'economy', 'market crash', 'supply chain',
    'export ban', 'import', 'debt',
  ],
};

export function inferEventType(text: string): EventType {
  const lower = text.toLowerCase();
  for (const [type, keywords] of Object.entries(EVENT_TYPE_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return type as EventType;
  }
  return 'other';
}

// ── Severity inference ────────────────────────────────────────────────────────

const SEVERITY_TIERS: Array<{ severity: Severity; keywords: string[] }> = [
  {
    severity: 5,
    keywords: ['war', 'invasion', 'nuclear', 'mass casualt', 'genocide', 'coup', 'chemical weapon'],
  },
  {
    severity: 4,
    keywords: ['airstrike', 'explosion', 'killed', 'dead', 'fatalities', 'battle', 'offensive', 'missile strike'],
  },
  {
    severity: 3,
    keywords: ['protest', 'riot', 'clash', 'arrest', 'armed', 'sanction', 'attack', 'wounded'],
  },
  {
    severity: 2,
    keywords: ['tension', 'dispute', 'crisis', 'threat', 'warning', 'concern', 'emergency'],
  },
];

export function inferSeverity(text: string, fatalities?: number): Severity {
  if (fatalities !== undefined) {
    if (fatalities > 100) return 5;
    if (fatalities > 20)  return 4;
    if (fatalities > 5)   return 3;
    if (fatalities > 0)   return 2;
  }
  const lower = text.toLowerCase();
  for (const { severity, keywords } of SEVERITY_TIERS) {
    if (keywords.some(k => lower.includes(k))) return severity;
  }
  return 1;
}
