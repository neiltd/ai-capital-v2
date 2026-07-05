// Compress raw snapshots older than N days using gzip.
// Run weekly via cron or manually: npm run compress
//
// Compressed files: store/raw/{source}/YYYY-MM-DD.json.gz
// The pipeline only reads today's raw file, so old files are safe to compress.

import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { gzipSync } from 'zlib';
import { PATHS } from '../lib/paths.ts';
import { logger } from '../lib/logger.ts';

const COMPRESS_AFTER_DAYS = 7;
const cutoff = new Date(Date.now() - COMPRESS_AFTER_DAYS * 86_400_000).toISOString().slice(0, 10);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function main(): Promise<void> {
  const rawRoot = PATHS.store.rawRoot;
  if (!existsSync(rawRoot)) {
    logger.info('compress', 'No raw store found — nothing to compress');
    return;
  }

  const sources = readdirSync(rawRoot).filter(
    f => statSync(join(rawRoot, f)).isDirectory(),
  );

  let totalSaved = 0;
  let totalFiles = 0;

  for (const source of sources) {
    const dir   = join(rawRoot, source);
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const date = file.replace('.json', '');
      if (date >= cutoff) continue; // keep recent files uncompressed

      const jsonPath = join(dir, file);
      const gzPath   = join(dir, `${file}.gz`);

      if (existsSync(gzPath)) {
        // Already compressed — remove the uncompressed version if it still exists
        unlinkSync(jsonPath);
        continue;
      }

      const original = readFileSync(jsonPath);
      const compressed = gzipSync(original, { level: 6 });
      writeFileSync(gzPath, compressed);
      unlinkSync(jsonPath);

      const saved = original.length - compressed.length;
      totalSaved += saved;
      totalFiles++;

      logger.info('compress', `${source}/${file}: ${formatBytes(original.length)} → ${formatBytes(compressed.length)} (saved ${formatBytes(saved)})`);
    }
  }

  logger.info('compress', `Done: ${totalFiles} files compressed, ${formatBytes(totalSaved)} total saved`);
}

main().catch(err => {
  logger.error('compress', 'Fatal error', { error: String(err) });
  process.exit(1);
});
