import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { PATHS } from '../../lib/paths.ts';

export interface HumanIntelRecord {
  id:               string;   // 'human-<8-char-hash>'
  submitted_at:     string;   // ISO-8601
  source_platform:  'tiktok' | 'youtube' | 'podcast' | 'web' | 'other';
  source_url?:      string;
  raw_text:         string;
  extracted: {
    title:      string;
    topic:      'geopolitical' | 'economic' | 'technology' | 'social' | 'energy' | 'other';
    countries:  string[];     // ISO alpha-3
    actors:     string[];
    event_type: string | null;
    confidence: number;       // 0–1
    tags:       string[];
  };
  credibility: {
    source_tier:      'unverified' | 'social' | 'news' | 'primary';
    bias_flags:       string[];
    cross_references: string[];   // storyline_id or event_id from exports
    assessment:       string;
  };
  follow_up_requests:       string[];
  economist_quick_analysis: string;
  exported:                 boolean;
}

export function generateHumanIntelId(rawText: string, submittedAt: string): string {
  return 'human-' + createHash('sha256').update(rawText + submittedAt).digest('hex').slice(0, 8);
}

export function loadHumanStore(): HumanIntelRecord[] {
  if (!existsSync(PATHS.intelligence.human.store)) return [];
  try {
    return JSON.parse(readFileSync(PATHS.intelligence.human.store, 'utf-8')) as HumanIntelRecord[];
  } catch {
    return [];
  }
}

export function saveHumanStore(records: HumanIntelRecord[]): void {
  mkdirSync(PATHS.intelligence.human.root, { recursive: true });
  writeFileSync(PATHS.intelligence.human.store, JSON.stringify(records, null, 2));
}

export function appendHumanRecord(record: HumanIntelRecord): void {
  const store = loadHumanStore();
  store.push(record);
  saveHumanStore(store);
}

export function markExported(ids: string[]): void {
  const store = loadHumanStore();
  const idSet = new Set(ids);
  for (const r of store) {
    if (idSet.has(r.id)) r.exported = true;
  }
  saveHumanStore(store);
}

export function loadPendingRecords(): HumanIntelRecord[] {
  return loadHumanStore().filter(r => !r.exported);
}
