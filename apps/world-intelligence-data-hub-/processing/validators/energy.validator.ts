import { z } from 'zod';
import type { EnergyIndicator, MacroIndicator } from '../../lib/types.ts';
import { logger } from '../../lib/logger.ts';

const EnergySchema = z.object({
  id:        z.string().min(1),
  source:    z.string().min(1),
  metric:    z.string().min(1),
  value:     z.number().finite(),
  unit:      z.string().min(1),
  country:   z.string().min(2),
  date:      z.string().min(4),
  fetchedAt: z.string().datetime(),
  rawHash:   z.string().min(1),
});

const MacroSchema = EnergySchema; // same shape

export interface ValidationResult<T> {
  valid: T[];
  rejectedCount: number;
}

export function validateEnergyIndicators(records: EnergyIndicator[]): ValidationResult<EnergyIndicator> {
  const valid: EnergyIndicator[] = [];
  let rejectedCount = 0;

  for (const record of records) {
    const result = EnergySchema.safeParse(record);
    if (result.success) {
      valid.push(result.data as EnergyIndicator);
    } else {
      const reason = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      logger.warn('validator', `Rejected energy record ${record.id}: ${reason}`);
      rejectedCount++;
    }
  }

  logger.info('validator', `Energy: ${valid.length} valid / ${rejectedCount} rejected`);
  return { valid, rejectedCount };
}

export function validateMacroIndicators(records: MacroIndicator[]): ValidationResult<MacroIndicator> {
  const valid: MacroIndicator[] = [];
  let rejectedCount = 0;

  for (const record of records) {
    const result = MacroSchema.safeParse(record);
    if (result.success) {
      valid.push(result.data as MacroIndicator);
    } else {
      rejectedCount++;
    }
  }

  logger.info('validator', `Macro: ${valid.length} valid / ${rejectedCount} rejected`);
  return { valid, rejectedCount };
}
