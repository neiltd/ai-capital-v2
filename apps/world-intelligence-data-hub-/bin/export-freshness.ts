// Writes quota/freshness.json from the current quota state.
//
// The pipeline exports this every run; this exists so the surface can be
// refreshed without a full pipeline run — useful while the daily scheduler is
// frozen, and for verifying the surface end to end.
import { QuotaTracker } from '../quota/quota-tracker.ts';
import { writeProvenance, FRESHNESS_PATH } from '../quota/freshness.ts';

const file = writeProvenance(new QuotaTracker());
const stale = file.sources.filter(s => s.availability !== 'current');
console.log(`[freshness] ${file.sources.length} sources, ${stale.length} degraded → ${FRESHNESS_PATH}`);
for (const s of file.sources) {
  console.log(`  ${s.availability.toUpperCase().padEnd(12)} ${s.source.padEnd(12)} ${s.reason}`);
}
