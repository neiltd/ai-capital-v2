import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { NewsSource, TopicTag, SourceType, AccessType } from '../../lib/types.ts';
import { logger } from '../../lib/logger.ts';

// ── Zod schema (mirrors source.schema.json — keeps validation in-process) ─────

const NewSourceSchema = z.object({
  id:               z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  name:             z.string().min(1),
  country:          z.string().regex(/^[A-Z]{2}$/),
  language:         z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  region_focus:     z.array(z.string()).default([]),
  source_type:      z.enum(['wire_agency', 'newspaper', 'broadcaster', 'financial', 'government', 'think_tank', 'aggregator']),
  access_type:      z.enum(['rss', 'api', 'rss_and_api']),
  rss_url:          z.string().url().optional(),
  api_url:          z.string().url().optional(),
  topics:           z.array(z.enum(['politics', 'conflict', 'economy', 'energy', 'diplomacy', 'markets', 'society', 'technology', 'general'])).min(1),
  reliability_tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  bias_note:        z.string().optional(),
  usage_notes:      z.string().optional(),
  enabled:          z.boolean(),
}).refine(
  s => s.rss_url !== undefined || s.api_url !== undefined,
  { message: 'At least one of rss_url or api_url must be present' },
);

// ── Loader ────────────────────────────────────────────────────────────────────

const REGISTRY_PATH = join(import.meta.dirname, 'sources.json');

let _cache: NewsSource[] | null = null;

export function loadRegistry(): NewsSource[] {
  if (_cache) return _cache;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to read source registry: ${(err as Error).message}`);
  }

  if (!Array.isArray(raw)) {
    throw new Error('sources.json must be a JSON array');
  }

  const sources: NewsSource[] = [];
  let rejected = 0;

  for (const entry of raw) {
    const result = NewSourceSchema.safeParse(entry);
    if (result.success) {
      sources.push(result.data as NewsSource);
    } else {
      const id = (entry as Record<string, unknown>)?.id ?? '?';
      const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      logger.warn('registry', `Source "${id}" failed validation — skipped: ${issues}`);
      rejected++;
    }
  }

  logger.info('registry', `Loaded ${sources.length} sources (${rejected} rejected)`);
  _cache = sources;
  return sources;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export function enabledSources(): NewsSource[] {
  return loadRegistry().filter(s => s.enabled);
}

export function sourcesByCountry(countryCode: string): NewsSource[] {
  return loadRegistry().filter(s => s.country === countryCode && s.enabled);
}

export function sourcesByTopic(topic: TopicTag): NewsSource[] {
  return loadRegistry().filter(s => s.enabled && s.topics.includes(topic));
}

export function sourcesByTier(tier: 1 | 2 | 3): NewsSource[] {
  return loadRegistry().filter(s => s.enabled && s.reliability_tier === tier);
}

export function sourcesByType(type: SourceType): NewsSource[] {
  return loadRegistry().filter(s => s.enabled && s.source_type === type);
}

export function sourcesByLanguage(lang: string): NewsSource[] {
  return loadRegistry().filter(s => s.enabled && s.language === lang);
}

export function rssSources(): NewsSource[] {
  return loadRegistry().filter(
    s => s.enabled && (s.access_type === 'rss' || s.access_type === 'rss_and_api') && !!s.rss_url,
  );
}

export function clearRegistryCache(): void {
  _cache = null;
}
