import { z } from 'zod';
import type { EventRecord } from '../../lib/types.ts';
import { logger } from '../../lib/logger.ts';

const EventSchema = z.object({
  id:          z.string().min(1),
  source:      z.string().min(1),
  type:        z.enum(['conflict', 'disaster', 'political', 'economic', 'other']),
  title:       z.string().min(1).max(255),
  description: z.string(),
  country:     z.string().length(3),
  lat:         z.number().min(-90).max(90).nullable(),
  lng:         z.number().min(-180).max(180).nullable(),
  severity:    z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fetchedAt:   z.string().datetime(),
  rawHash:     z.string().min(1),
});

export interface ValidationResult<T> {
  valid: T[];
  rejectedCount: number;
  rejectionReasons: Array<{ id: string; reason: string }>;
}

export function validateEvents(records: EventRecord[]): ValidationResult<EventRecord> {
  const valid: EventRecord[] = [];
  const rejectionReasons: Array<{ id: string; reason: string }> = [];

  for (const record of records) {
    const result = EventSchema.safeParse(record);
    if (result.success) {
      valid.push(result.data as EventRecord);
    } else {
      const reason = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      logger.warn('validator', `Rejected event ${record.id ?? '?'}: ${reason}`);
      rejectionReasons.push({ id: record.id ?? '?', reason });
    }
  }

  logger.info('validator', `Events: ${valid.length} valid / ${rejectionReasons.length} rejected`);
  return { valid, rejectedCount: rejectionReasons.length, rejectionReasons };
}
