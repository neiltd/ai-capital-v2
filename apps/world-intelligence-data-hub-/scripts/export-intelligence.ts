// Intelligence export CLI.
// Usage:
//   npm run export                  — export today's intelligence
//   npm run export -- 2026-05-13   — specific date
//
// Writes stable JSON files to exports/ for downstream consumers.
// Also copies world-map/intelligence.json to the Worldmap frontend's
// public/data/ directory if it exists (local dev convenience).
//
// Downstream projects must read ONLY from exports/ — never from intelligence/.

import { runExports }              from '../intelligence/exports/run-exports.ts';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname }           from 'path';
import { PATHS }                   from '../lib/paths.ts';

// ── Args ──────────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date    = dateArg ?? new Date().toISOString().slice(0, 10);

// ── Colors ────────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const G  = (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const Y  = (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const R  = (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const D  = (s: string) => isTTY ? `\x1b[90m${s}\x1b[0m` : s;
const B  = (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m`  : s;
const C  = (s: string) => isTTY ? `\x1b[36m${s}\x1b[0m` : s;

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('');
console.log(B('World Intelligence — Export Runner'));
console.log(D(`Date: ${date}  |  Schema: 1.0`));
console.log('');

try {
  const result = runExports(date);

  // ── World Intelligence ─────────────────────────────────────────────────────
  console.log(B('▶ World Intelligence  ') + D('exports/world-map/intelligence.json'));
  console.log(`  ${G(String(result.world_intel.event_count))} events  ` +
              `${C(String(result.world_intel.story_count))} storylines  ` +
              `${D(String(result.world_intel.country_count))} country signals  ` +
              D(kb(result.world_intel.bytes)));
  console.log('');

  // ── Oil Project ────────────────────────────────────────────────────────────
  const hormuzColor = result.oil.hormuz_risk === 'critical' ? R
                    : result.oil.hormuz_risk === 'high'     ? R
                    : result.oil.hormuz_risk === 'elevated' ? Y
                    : G;
  console.log(B('▶ Oil Project         ') + D('exports/oil-project/intelligence.json'));
  console.log(`  ${G(String(result.oil.event_count))} energy events  ` +
              `Hormuz: ${hormuzColor(result.oil.hormuz_risk)}  ` +
              D(kb(result.oil.bytes)));
  console.log('');

  // ── Stock Project ──────────────────────────────────────────────────────────
  console.log(B('▶ Stock Project        ') + D('exports/stock-project/intelligence.json'));
  console.log(`  ${G(String(result.stock.event_count))} market events  ` +
              `${Y(String(result.stock.signal_count))} macro signals  ` +
              `${D(String(result.stock.sector_count))} sector exposures  ` +
              D(kb(result.stock.bytes)));
  console.log('');

  console.log(D('─'.repeat(70)));
  console.log(`Manifest updated → ${D('exports/manifest.json')}`);
  console.log('');
  console.log(D('Stable paths (do not change — downstream projects depend on these):'));
  console.log(D('  exports/world-map/intelligence.json    schema_version: 1.0'));
  console.log(D('  exports/oil-project/intelligence.json  schema_version: 1.0'));
  console.log(D('  exports/stock-project/intelligence.json schema_version: 1.0'));
  console.log('');

  // ── Copy to frontend public directory (local dev convenience) ──────────────
  // If the Worldmap frontend exists as a sibling project, copy the intelligence
  // export into its public/data/ directory so the dev server can serve it.
  // World-map frontends get the world-intelligence export
  const frontendTargets = [
    join(PATHS.root, '..', 'worldmaphistory_v1', 'public', 'data'),
    join(PATHS.root, '..', 'worldmaphistory_v2', 'public', 'data'),
    join(PATHS.root, '..', 'Worldmap',           'public', 'data'),
  ];
  const sourcePath = join(PATHS.exports.worldMap, 'intelligence.json');

  for (const target of frontendTargets) {
    const parentExists = existsSync(dirname(target));
    if (!parentExists) continue;
    try {
      mkdirSync(target, { recursive: true });
      const destPath = join(target, 'intelligence.json');
      copyFileSync(sourcePath, destPath);
      console.log(G(`✓ Copied world-map → ${target.replace(PATHS.root + '/..', '..')}/intelligence.json`));
    } catch {
      // Non-fatal — frontend may not be present in all environments
    }
  }

  // Oil frontend gets the oil-project export
  const oilFrontendTargets = [
    join(PATHS.root, '..', 'world-intelligence-oil', 'frontend', 'public', 'data'),
  ];
  const oilSourcePath = join(PATHS.exports.oilProject, 'intelligence.json');

  for (const target of oilFrontendTargets) {
    const parentExists = existsSync(dirname(target));
    if (!parentExists) continue;
    try {
      mkdirSync(target, { recursive: true });
      const destPath = join(target, 'intelligence.json');
      copyFileSync(oilSourcePath, destPath);
      console.log(G(`✓ Copied oil-project → ${target.replace(PATHS.root + '/..', '..')}/intelligence.json`));
    } catch {
      // Non-fatal
    }
  }

  console.log('');

} catch (err) {
  console.error(R(`Export failed: ${(err as Error).message}`));
  process.exit(1);
}
