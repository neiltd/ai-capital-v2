// SET-listed Thai construction/infrastructure contractors mapped to their
// juristic registration number (ACT Ai `companyId`). Resolved 2026-08-13 via
// admin-procurement.actai.co/company/search (matched by name, picked the entity
// with the dominant contract value = the listed company).
//
// These are the names that dominate Thai government PROCUREMENT (e-GP): civil
// works, goods, services. Deliberately EXCLUDED: power producers (GULF, RATCH,
// GPSC, BGRIM, EGCO) and concession operators (AOT, BEM) — their state money
// flows through EGAT PPAs / concessions, NOT procurement, so they read
// near-zero in this dataset (verified: GULF ~฿0, BEM ~฿0.1bn). Track those via
// EGAT PPA disclosures instead, not here.

export interface ThaiWatchEntry {
  ticker: string
  regId:  string   // 13-digit juristic person registration number
  name:   string
}

export const THAI_GOV_WATCHLIST: ThaiWatchEntry[] = [
  { ticker: 'ITD',    regId: '0107537000939', name: 'Italian-Thai Development' },
  { ticker: 'STECON', regId: '0107536001001', name: 'Sino-Thai Engineering & Construction' },
  { ticker: 'CK',     regId: '0107537002575', name: 'Ch. Karnchang' },
  { ticker: 'NWR',    regId: '0107538000096', name: 'Nawarat Patanakarn' },
  { ticker: 'UNIQ',   regId: '0107548000447', name: 'Unique Engineering & Construction' },
  { ticker: 'SEAFCO', regId: '0107547000257', name: 'Seafco' },
]
