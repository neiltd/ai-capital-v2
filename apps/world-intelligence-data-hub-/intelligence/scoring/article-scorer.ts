import type { ArticleRecord, ArticleScoringResult, ScoringCategoryBreakdown } from '../../lib/types.ts';
import { findKnownLocations } from './known-locations.ts';

// ── Thresholds ────────────────────────────────────────────────────────────────

// Main track: articles reaching this score are recommended for AI extraction.
// Lowered from 40 → 35 on 2026-05-13 to recover false negatives in the 35–39 band
// (EU sanctions, Trump-Xi summit, NATO exercises, Iran missile intelligence).
export const RECOMMENDATION_THRESHOLD = 35;

// Narrative monitoring track: Tier 3 state media articles reaching this score
// are flagged for AI extraction with cross_reference_required = true.
// These are not trusted as facts but are intelligence signals about what
// Beijing/Tehran/etc. is choosing to say and how they frame events.
export const NARRATIVE_THRESHOLD = 25;

// ── Keyword definition types ──────────────────────────────────────────────────

interface KeywordEntry {
  term:   string;
  points: number;
  re:     RegExp;       // pre-compiled at module load — never rebuilt per article
}

interface ScoringCategory {
  name:     string;
  entries:  KeywordEntry[];
  cap:      number;        // maximum contribution from this category
}

// ── Matcher factory ───────────────────────────────────────────────────────────
// Multi-word phrases and terms > 5 chars: substring match (fast, unambiguous).
// Short single words (≤ 5 chars): word-boundary match to avoid false positives
// e.g. 'war' must not match 'award', 'oil' must not match 'soil'.

function kw(term: string, points: number): KeywordEntry {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern  = (!term.includes(' ') && term.length <= 5)
    ? new RegExp(`\\b${escaped}\\b`, 'i')
    : new RegExp(escaped, 'i');
  return { term, points, re: pattern };
}

// ── Category definitions ──────────────────────────────────────────────────────

// Each category is scored independently then capped at its max.
// Total score = sum of capped categories + bonuses - penalties, clamped 0–100.

const GEO: ScoringCategory = {
  name: 'geopolitical',
  cap:  40,
  entries: [
    kw('war crimes',        13),
    kw('peace talks',       12),
    kw('nuclear deal',      12),
    kw('diplomatic crisis', 12),
    kw('border dispute',    11),
    kw('humanitarian crisis', 11),
    kw('annexation',        11),
    kw('ceasefire',         11),
    kw('revolution',        10),
    kw('coup',              10),
    kw('sanctions',          9),
    kw('referendum',         9),
    kw('sovereignty',        9),
    kw('war',                9),
    kw('rebellion',          8),
    kw('crackdown',          8),
    kw('embargo',            8),
    kw('regime',             7),
    kw('conflict',           7),
    kw('riot',               7),
    kw('treaty',             6),
    kw('refugee',            6),
    kw('diplomatic',         5),
    kw('protest',            5),
    kw('exile',              5),
    kw('peace deal',        11),
    kw('arms deal',         10),
    kw('nuclear talks',     12),
    kw('arms embargo',      11),
    kw('war criminal',      12),
  ],
};

const CONFLICT: ScoringCategory = {
  name: 'conflict',
  cap:  45,
  entries: [
    kw('chemical weapon',   15),
    kw('nuclear weapon',    15),
    kw('nuclear test',      15),
    kw('drone strike',      14),
    kw('airstrike',         14),
    kw('air strike',        14),
    kw('missile strike',    14),
    kw('missile launch',    14),
    kw('missile test',      13),
    kw('suicide bombing',   14),
    kw('car bomb',          13),
    kw('war crime',         13),
    kw('assassination',     13),
    kw('armed forces',      12),
    kw('casualties',        12),
    kw('terrorism',         12),
    kw('military drill',    11),
    kw('military exercise', 11),
    kw('war game',          10),
    kw('terrorist',         11),
    kw('bombing',           11),
    kw('explosion',         11),
    kw('missile',           11),
    kw('nuclear',           11),
    kw('blockade',          10),
    kw('offensive',         10),
    kw('insurgent',         10),
    kw('militant',          10),
    kw('siege',             10),
    kw('hostage',           10),
    kw('artillery',         10),
    kw('warship',           10),
    kw('armed drone',       12),
    kw('rebel',              9),
    kw('killed',             9),
    kw('wounded',            8),
    kw('troops',             8),
    kw('attack',             8),
    kw('gunfire',            8),
    kw('weapon',             7),
    kw('military',           7),
  ],
};

const ECONOMIC: ScoringCategory = {
  name: 'economic',
  cap:  35,
  entries: [
    kw('financial crisis',   12),
    kw('economic crisis',    12),
    kw('stock market crash', 12),
    kw('currency crisis',    12),
    kw('debt crisis',        12),
    kw('interest rate hike', 12),
    kw('federal reserve',    11),
    kw('central bank',       11),
    kw('export ban',         11),
    kw('trade war',          11),
    kw('market crash',       11),
    kw('budget deficit',     10),
    kw('trade deficit',      10),
    kw('inflation rate',     10),
    kw('monetary policy',     9),
    kw('fiscal policy',       9),
    kw('interest rate',       9),
    kw('recession',           9),
    kw('tariff',              9),
    kw('devaluation',         9),
    kw('default',             9),
    kw('supply chain',        8),
    kw('world bank',          8),
    kw('imf',                 8),
    kw('gdp',                 8),
    kw('inflation',           8),
    kw('unemployment',        7),
    kw('defense budget',     11),
    kw('military spending',  11),
    kw('military budget',    11),
    kw('arms sale',          10),
    kw('trade ban',          10),
    kw('import ban',         10),
    kw('export control',     10),
    kw('currency',            6),
  ],
};

const COMMODITY: ScoringCategory = {
  name: 'commodity',
  cap:  35,
  entries: [
    kw('crude oil price',    14),
    kw('opec production',    14),
    kw('energy crisis',      13),
    kw('oil supply',         13),
    kw('supply disruption',  12),
    kw('pipeline attack',    13),
    kw('oil price',          12),
    kw('natural gas',        12),
    kw('crude oil',          12),
    kw('grain shortage',     11),
    kw('food security',      10),
    kw('opec',               12),
    kw('lng',                10),
    kw('brent',              10),
    kw('wti',                10),
    kw('refinery',            9),
    kw('pipeline',            9),
    kw('barrel',              9),
    kw('wheat',               8),
    kw('grain',               8),
    kw('oil',                 8),
    kw('copper',              7),
    kw('gold',                7),
    kw('energy',              6),
  ],
};

// ── Country relevance ─────────────────────────────────────────────────────────
// Tier A: highest strategic priority (+10 each)
// Tier B: significant but secondary (+5 each)
// Cap applies across both tiers combined.

const COUNTRY_CAP = 25;

const COUNTRIES_A: KeywordEntry[] = [
  // Middle East & energy
  kw('iraq',          10), kw('iraqi',       10),
  kw('iran',          10), kw('iranian',      10),
  kw('saudi arabia',  10), kw('saudi',        10),
  kw('israel',        10), kw('israeli',      10),
  kw('syria',         10), kw('syrian',       10),
  kw('yemen',         10), kw('yemeni',       10),
  kw('libya',         10), kw('libyan',       10),
  // Major powers
  kw('russia',        10), kw('russian',      10),
  kw('ukraine',       10), kw('ukrainian',    10),
  kw('china',         10), kw('chinese',      10),
  kw('north korea',   10), kw('dprk',         10),
  // Other critical
  kw('pakistan',      10), kw('pakistani',    10),
  kw('afghanistan',   10), kw('afghan',       10),
  kw('venezuela',     10), kw('venezuelan',   10),
  kw('myanmar',       10), kw('burmese',      10),
];

const COUNTRIES_B: KeywordEntry[] = [
  kw('taiwan',         5), kw('taiwanese',    5),
  kw('turkey',         5), kw('turkish',      5),
  kw('india',          5), kw('indian',       5),
  kw('egypt',          5), kw('egyptian',     5),
  kw('ethiopia',       5), kw('ethiopian',    5),
  kw('sudan',          5), kw('sudanese',     5),
  kw('nigeria',        5), kw('nigerian',     5),
  kw('somalia',        5), kw('somali',       5),
  kw('mali',           5), kw('malian',       5),
  kw('belarus',        5), kw('belarusian',   5),
  kw('azerbaijan',     5), kw('azerbaijani',  5),
  kw('armenia',        5), kw('armenian',     5),
  kw('haiti',          5), kw('haitian',      5),
  kw('cuba',           5), kw('cuban',        5),
  kw('kazakhstan',     5), kw('kazakh',       5),
  kw('japan',          5), kw('japanese',     5),
  kw('south korea',    5), kw('korean',       5),
  kw('indonesia',      5), kw('indonesian',   5),
  kw('algeria',        5), kw('algerian',     5),
];

// ── Noise penalties ────────────────────────────────────────────────────────────

const SPORTS_NOISE: ScoringCategory = {
  name: 'sports',
  cap:  -40,
  entries: [
    kw('premier league',  -12),
    kw('champions league',-12),
    kw('super bowl',      -12),
    kw('nfl playoffs',    -12),
    kw('nba finals',      -12),
    kw('march madness',   -12),
    kw('world cup',       -11),
    kw('grand prix',      -10),
    kw('formula 1',       -10),
    kw('wimbledon',       -10),
    kw('tennis open',     -10),
    kw('match result',    -10),
    kw('league table',    -10),
    kw('fifa',            -10),
    kw('golf tournament', -10),
    kw('olympic games',    -9),
    kw('championship',     -7),
    kw('football',         -8),
    kw('basketball',       -8),
    kw('baseball',         -8),
    kw('cricket',          -7),
    kw('rugby',            -7),
    kw('soccer',           -8),
    kw('tennis',           -7),
    kw('golf',             -7),
    kw('nba',              -9),
    kw('nfl',              -9),
  ],
};

const ENTERTAINMENT_NOISE: ScoringCategory = {
  name: 'entertainment',
  cap:  -40,
  entries: [
    kw('oscar winner',     -12),
    kw('grammy award',     -12),
    kw('celebrity divorce',-12),
    kw('box office',       -11),
    kw('movie premiere',   -11),
    kw('reality show',     -11),
    kw('reality tv',       -11),
    kw('netflix series',   -10),
    kw('marvel movie',     -10),
    kw('emmy award',       -10),
    kw('concert tour',     -10),
    kw('new album',        -10),
    kw('pop star',         -10),
    kw('new single',        -9),
    kw('music video',       -9),
    kw('talk show',         -9),
    kw('celebrity',         -9),
    kw('hollywood',         -9),
    kw('bafta',             -9),
    kw('box office',        -9),
  ],
};

const LIFESTYLE_NOISE: ScoringCategory = {
  name: 'lifestyle',
  cap:  -20,
  entries: [
    kw('fashion week',     -10),
    kw('horoscope',        -10),
    kw('zodiac sign',       -9),
    kw('recipe',            -8),
    kw('beauty tips',       -9),
    kw('weight loss',       -9),
    kw('dating advice',     -9),
    kw('home decor',        -9),
    kw('travel guide',      -8),
    kw('wellness tips',     -8),
    kw('cooking tips',      -8),
    kw('vacation',          -6),
    kw('wedding',           -6),
  ],
};

// ── Score a single category ───────────────────────────────────────────────────

function scoreCategory(
  text:     string,
  category: ScoringCategory,
): { raw: number; matched: string[] } {
  let raw     = 0;
  const matched: string[] = [];

  for (const entry of category.entries) {
    if (entry.re.test(text)) {
      raw += entry.points;
      matched.push(entry.term);
    }
  }

  return {
    raw:     category.cap >= 0
               ? Math.min(raw, category.cap)   // positive: don't exceed cap
               : Math.max(raw, category.cap),  // negative: don't go below noise floor
    matched,
  };
}

// ── Country scoring ───────────────────────────────────────────────────────────

function scoreCountry(text: string): { score: number; matched: string[] } {
  let raw     = 0;
  const seen  = new Set<string>();

  for (const entry of [...COUNTRIES_A, ...COUNTRIES_B]) {
    if (entry.re.test(text) && !seen.has(entry.term)) {
      raw += entry.points;
      seen.add(entry.term);
    }
  }

  return {
    score:   Math.min(raw, COUNTRY_CAP),
    matched: [...seen],
  };
}

// ── Tier bonus ────────────────────────────────────────────────────────────────
// Tier 1 sources get a small boost — higher journalistic standards.
// Tier 3 (state media) gets no penalty — their coverage is valuable for
// narrative analysis; it just needs to be labelled.

function tierBonus(tier: 1 | 2 | 3): number {
  return tier === 1 ? 8 : 0;
}

// ── Multi-category bonus ──────────────────────────────────────────────────────
// Strong articles typically touch multiple signal domains.
// A missile strike on an oil facility hits conflict + commodity + country.

function multiCategoryBonus(activeCats: number): number {
  if (activeCats >= 3) return 20;
  if (activeCats >= 2) return 10;
  return 0;
}

// ── Public scoring API ────────────────────────────────────────────────────────

export function scoreArticle(article: ArticleRecord): ArticleScoringResult {
  // Score on combined title + description for richer signal surface.
  const text = [article.title, article.description ?? ''].join(' ');

  const geo     = scoreCategory(text, GEO);
  const conf    = scoreCategory(text, CONFLICT);
  const econ    = scoreCategory(text, ECONOMIC);
  const comm    = scoreCategory(text, COMMODITY);
  const country = scoreCountry(text);

  const bonus   = tierBonus(article.reliability_tier);
  const sports  = scoreCategory(text, SPORTS_NOISE);
  const entert  = scoreCategory(text, ENTERTAINMENT_NOISE);
  const life    = scoreCategory(text, LIFESTYLE_NOISE);

  const noiseTotal = sports.raw + entert.raw + life.raw;

  // Known-location bonus: +8 per chokepoint match (rare, high signal), +5
  // per facility match. Capped at 20 to keep proportion vs other categories.
  // The same matcher feeds the events API tagging, so an article that scores
  // high here is also likely to surface as an affectedFacility downstream.
  const locations = findKnownLocations(text);
  const chokeMatches    = locations.filter(l => l.type === 'chokepoint').length;
  const facilityMatches = locations.filter(l => l.type === 'facility').length;
  const locationRaw     = chokeMatches * 8 + facilityMatches * 5;
  const locationBonus   = Math.min(20, locationRaw);

  // Count categories with meaningful positive signal
  const posCategories = [geo.raw, conf.raw, econ.raw, comm.raw]
    .filter(s => s >= 8).length;
  const multiBonus = multiCategoryBonus(posCategories);

  const rawTotal = geo.raw + conf.raw + econ.raw + comm.raw
                 + country.score + bonus + multiBonus + locationBonus + noiseTotal;

  const relevance_score = Math.min(100, Math.max(0, rawTotal));

  // Standard track: score meets the main threshold
  const standard_recommended = relevance_score >= RECOMMENDATION_THRESHOLD;

  // Narrative monitoring track: Tier 3 state media that reaches a lower bar.
  // Captures how Beijing, Global Times, Xinhua frame geopolitical events —
  // valuable for narrative comparison even when factual reliability is lower.
  const is_narrative_track = article.reliability_tier === 3
                           && relevance_score >= NARRATIVE_THRESHOLD
                           && !standard_recommended;

  const recommended_for_ai       = standard_recommended || is_narrative_track;
  const narrative_source         = is_narrative_track;
  const cross_reference_required = is_narrative_track;

  // Build human-readable reasons
  const reasons: string[] = [];
  if (conf.matched.length)    reasons.push(`conflict signals: ${conf.matched.slice(0, 4).join(', ')} (+${conf.raw})`);
  if (geo.matched.length)     reasons.push(`geopolitical: ${geo.matched.slice(0, 3).join(', ')} (+${geo.raw})`);
  if (comm.matched.length)    reasons.push(`commodity: ${comm.matched.slice(0, 3).join(', ')} (+${comm.raw})`);
  if (econ.matched.length)    reasons.push(`economic: ${econ.matched.slice(0, 3).join(', ')} (+${econ.raw})`);
  if (country.matched.length) reasons.push(`country: ${country.matched.slice(0, 4).join(', ')} (+${country.score})`);
  if (bonus > 0)              reasons.push(`tier-${article.reliability_tier} source (+${bonus})`);
  if (locationBonus > 0)      reasons.push(`known locations: ${locations.slice(0, 4).map(l => `${l.category}/${l.id}`).join(', ')} (+${locationBonus})`);
  if (multiBonus > 0)         reasons.push(`multi-category: ${posCategories} active (+${multiBonus})`);
  if (sports.matched.length)  reasons.push(`sports noise: ${sports.matched.slice(0, 2).join(', ')} (${sports.raw})`);
  if (entert.matched.length)  reasons.push(`entertainment noise: ${entert.matched.slice(0, 2).join(', ')} (${entert.raw})`);
  if (life.matched.length)    reasons.push(`lifestyle noise: ${life.matched.slice(0, 2).join(', ')} (${life.raw})`);
  if (narrative_source)       reasons.push(`narrative-track: tier-3 state media >= ${NARRATIVE_THRESHOLD} (cross-reference required)`);

  const category_breakdown: import('../../lib/types.ts').ScoringCategoryBreakdown = {
    geopolitical:         geo.raw,
    conflict:             conf.raw,
    economic:             econ.raw,
    commodity:            comm.raw,
    country:              country.score,
    tier_bonus:           bonus,
    multi_category_bonus: multiBonus,
    noise_penalty:        noiseTotal,
  };

  return {
    relevance_score,
    relevance_reasons:        reasons,
    recommended_for_ai,
    narrative_source,
    cross_reference_required,
    scored_at:                new Date().toISOString(),
    category_breakdown,
  };
}

// ── Bulk scoring with lifecycle update ───────────────────────────────────────

export function scoreArticles(articles: ArticleRecord[]): ArticleRecord[] {
  return articles.map(article => {
    const scoring = scoreArticle(article);

    return {
      ...article,
      scoring,
      lifecycle: {
        ...article.lifecycle,
        // Only gate on recommendation — exact_duplicate stays 'skipped' regardless
        ai_status: article.lifecycle.dedup_status === 'exact_duplicate'
          ? 'skipped'
          : scoring.recommended_for_ai
            ? 'pending'
            : 'skipped',
      },
    };
  });
}
