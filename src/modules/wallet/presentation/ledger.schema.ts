import { z } from 'zod';
import {
  DEFAULT_LEDGER_LIMIT,
  MAX_LEDGER_LIMIT,
  MAX_LEDGER_CURSOR_LENGTH,
} from '@/shared/consts/ledger.constant';

export const LEDGER_QUERY_SCHEMA = z.strictObject({
  cursor: z.string().min(1).max(MAX_LEDGER_CURSOR_LENGTH).optional(),
  limit: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_LEDGER_LIMIT))
    .default(DEFAULT_LEDGER_LIMIT),
});
