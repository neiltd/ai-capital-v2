import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PATHS }          from '../../lib/paths.ts';
import { logger }         from '../../lib/logger.ts';
import { checkAndRecord } from '../sources/fingerprint.ts';
import type { ArticleRecord, ArticleLifecycle, TranslationMetadata } from '../../lib/types.ts';
import type { CollectionResult } from '../sources/collector.ts';

// ── Account types ─────────────────────────────────────────────────────────────

export interface TwitterAccount {
  username:         string;
  display_name:     string;
  category:         'analyst' | 'reporter' | 'official' | 'executive' | 'entrepreneur' | 'investor';
  reliability_tier: 1 | 2 | 3;
  region_focus:     string[];
  topics:           string[];
  notes:            string;
  enabled:          boolean;
}

// ── twitterapi.io response types ──────────────────────────────────────────────

interface TweetAuthor {
  userName: string;
  name:     string;
}

interface TweetItem {
  id:               string;
  url:              string;
  text:             string;
  createdAt:        string;
  lang:             string;
  isReply:          boolean;
  author:           TweetAuthor;
  retweeted_tweet:  TweetItem | null;
  quoted_tweet:     TweetItem | null;
}

interface TwitterApiResponse {
  status:  string;
  code:    number;
  msg:     string;
  message?: string;
  data: {
    pin_tweet: TweetItem | null;
    tweets:    TweetItem[];
  };
}

interface SourceOutputFile {
  source_id:    string;
  date:         string;
  generated_at: string;
  stats: {
    total:             number;
    new_articles:      number;
    exact_duplicates:  number;
    syndicated:        number;
    stale_skipped:     number;
  };
  articles: ArticleRecord[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ARTICLE_AGE_MS = 30 * 86_400_000; // 30 days — matches RSS collector
const API_BASE           = 'https://api.twitterapi.io';

// ── Account loader ────────────────────────────────────────────────────────────

export function loadAccounts(): TwitterAccount[] {
  const p = PATHS.intelligence.twitter.accounts;
  if (!existsSync(p)) {
    logger.warn('twitter', 'accounts.json not found');
    return [];
  }
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as TwitterAccount[];
  } catch {
    logger.warn('twitter', 'Failed to parse accounts.json');
    return [];
  }
}

// ── API ───────────────────────────────────────────────────────────────────────

async function fetchTweets(username: string, apiKey: string): Promise<TweetItem[]> {
  const url = `${API_BASE}/twitter/user/last_tweets?userName=${encodeURIComponent(username)}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      signal:  AbortSignal.timeout(20_000),
      headers: { 'x-api-key': apiKey },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '5');
      const wait = Math.max(retryAfter, 5) * 1000;
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw new Error('HTTP 429 — rate limit exceeded after 3 attempts');
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as TwitterApiResponse;
    if (data.status !== 'success') throw new Error(`API error: ${data.status} — ${data.message ?? data.msg ?? ''}`);
    return Array.isArray(data.data?.tweets) ? data.data.tweets : [];
  }

  throw new Error('HTTP 429 — rate limit exceeded after 3 attempts');
}

// ── ArticleRecord builder ─────────────────────────────────────────────────────

function defaultLifecycle(): ArticleLifecycle {
  return {
    ingestion_status:  'fetched',
    processing_status: 'normalized',
    dedup_status:      'new',
    ai_status:         'pending',
  };
}

function defaultTranslation(lang: string): TranslationMetadata {
  const isEnglish = !lang || lang === 'en';
  return {
    original_language:  lang || 'en',
    translation_status: isEnglish ? 'not_required' : 'pending',
  };
}

function tweetToArticleRecord(
  tweet:     TweetItem,
  account:   TwitterAccount,
  fetchedAt: string,
): ArticleRecord | null {
  if (!tweet.text?.trim() || !tweet.url?.trim()) return null;

  const description = tweet.quoted_tweet
    ? `${tweet.text}\n\nQuoting @${tweet.quoted_tweet.author?.userName ?? 'unknown'}: ${tweet.quoted_tweet.text}`
    : tweet.text;

  const fullText = tweet.text.replace(/\n/g, ' ');
  const title    = fullText.slice(0, 100);
  const sourceId = `twitter-${account.username}`;
  const fp       = checkAndRecord(fullText, sourceId, tweet.createdAt, tweet.url);

  const lifecycle = defaultLifecycle();
  lifecycle.dedup_status = fp.is_exact_duplicate ? 'exact_duplicate'
                         : fp.is_syndicated      ? 'syndicated'
                         : 'new';
  if (fp.is_exact_duplicate) lifecycle.ai_status = 'skipped';

  return {
    id:               fp.fingerprint.exact,
    source_id:        sourceId,
    source_name:      account.display_name,
    reliability_tier: account.reliability_tier,
    title,
    url:              tweet.url,
    published_at:     tweet.createdAt,
    fetched_at:       fetchedAt,
    description,
    author:           tweet.author?.userName ?? account.username,
    fingerprint:      fp.fingerprint.exact,
    syndication_key:  fp.fingerprint.syndication_key,
    translation:      defaultTranslation(tweet.lang),
    lifecycle,
  };
}

// ── Output helpers ────────────────────────────────────────────────────────────

function outputPath(username: string, date: string): string {
  return join(PATHS.intelligence.outputArticles, date, `twitter-${username}.json`);
}

function loadExistingOutput(username: string, date: string): ArticleRecord[] {
  const p = outputPath(username, date);
  if (!existsSync(p)) return [];
  try {
    const f = JSON.parse(readFileSync(p, 'utf-8')) as SourceOutputFile;
    return f.articles ?? [];
  } catch { return []; }
}

function saveOutput(
  username: string,
  date:     string,
  articles: ArticleRecord[],
  stats:    SourceOutputFile['stats'],
): void {
  const dir = join(PATHS.intelligence.outputArticles, date);
  mkdirSync(dir, { recursive: true });
  const file: SourceOutputFile = {
    source_id:    `twitter-${username}`,
    date,
    generated_at: new Date().toISOString(),
    stats,
    articles,
  };
  writeFileSync(outputPath(username, date), JSON.stringify(file, null, 2));
}

// ── Per-account collection ────────────────────────────────────────────────────

async function collectAccount(
  account:  TwitterAccount,
  apiKey:   string,
  date:     string,
): Promise<CollectionResult> {
  const t0        = Date.now();
  const fetchedAt = new Date().toISOString();
  const sourceId  = `twitter-${account.username}`;

  let raw: TweetItem[];
  try {
    logger.info('twitter', `${sourceId}: fetching timeline`);
    raw = await fetchTweets(account.username, apiKey);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('twitter', `${sourceId}: fetch failed — ${msg}`);
    return {
      source_id: sourceId, status: 'failed',
      new_articles: 0, exact_duplicates: 0, syndicated: 0, stale_skipped: 0,
      avg_age_hours: 0, oldest_age_days: 0, stale_feed: false,
      duration_ms: Date.now() - t0, error: msg,
    };
  }

  const existingIds = new Set(loadExistingOutput(account.username, date).map(a => a.id));
  const articles: ArticleRecord[] = [];
  let newCount   = 0;
  let dupeCount  = 0;
  let syndCount  = 0;
  let staleCount = 0;

  for (const tweet of raw) {
    // Skip retweets (retweeted_tweet present) and replies
    if (tweet.retweeted_tweet !== null || tweet.isReply) continue;

    // Recency filter — same 30-day window as RSS collector
    if (tweet.createdAt) {
      const ageMs = Date.now() - new Date(tweet.createdAt).getTime();
      if (!isNaN(ageMs) && ageMs > MAX_ARTICLE_AGE_MS) { staleCount++; continue; }
    }

    const record = tweetToArticleRecord(tweet, account, fetchedAt);
    if (!record) continue;

    // Skip articles already in today's output (idempotent re-runs)
    if (existingIds.has(record.id)) { dupeCount++; continue; }

    if (record.lifecycle.dedup_status === 'exact_duplicate') { dupeCount++; continue; }
    if (record.lifecycle.dedup_status === 'syndicated') syndCount++;
    else newCount++;

    articles.push(record);
  }

  // Merge with any previously saved articles from earlier runs today
  const previous = loadExistingOutput(account.username, date)
    .filter(a => !articles.some(n => n.id === a.id));
  const merged = [...previous, ...articles];

  saveOutput(account.username, date, merged, {
    total: merged.length, new_articles: newCount,
    exact_duplicates: dupeCount, syndicated: syndCount, stale_skipped: staleCount,
  });

  const duration_ms = Date.now() - t0;
  logger.info('twitter', `${sourceId}: ${newCount} new / ${dupeCount} dupes / ${staleCount} stale (${duration_ms}ms)`);

  return {
    source_id: sourceId, status: 'ok',
    new_articles: newCount, exact_duplicates: dupeCount,
    syndicated: syndCount, stale_skipped: staleCount,
    avg_age_hours: 0, oldest_age_days: 0, stale_feed: false, duration_ms,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runTwitterCollector(date: string): Promise<CollectionResult[]> {
  const apiKey = process.env.TWITTERAPI_IO_KEY;
  if (!apiKey) {
    logger.warn('twitter', 'TWITTERAPI_IO_KEY not set — skipping Twitter collection');
    return [];
  }
  const accounts = loadAccounts().filter(a => a.enabled);

  if (!accounts.length) {
    logger.warn('twitter', 'No enabled accounts in accounts.json — skipping');
    return [];
  }

  // Sequential — one account at a time to respect rate limits
  const results: CollectionResult[] = [];
  for (let i = 0; i < accounts.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1500));
    results.push(await collectAccount(accounts[i], apiKey, date));
  }

  const totalNew = results.reduce((s, r) => s + r.new_articles, 0);
  const ok       = results.filter(r => r.status === 'ok').length;
  logger.info('twitter', `Done — ${totalNew} new tweets from ${ok}/${accounts.length} accounts`);
  return results;
}
