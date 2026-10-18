import { readConfig } from '@/config/config.util';
import { z } from 'zod';

const OUTBOX_CONFIG_SCHEMA = z
  .object({
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    OUTBOX_LEASE_MS: z.coerce.number().int().positive().default(30000),
    OUTBOX_RETRY_BASE_MS: z.coerce.number().int().positive().default(1000),
    OUTBOX_RETRY_MAX_MS: z.coerce.number().int().positive().default(60000),
    OUTBOX_ESCALATE_AFTER_ATTEMPTS: z.coerce.number().int().positive().default(10),
  })
  .refine((config) => config.OUTBOX_RETRY_MAX_MS >= config.OUTBOX_RETRY_BASE_MS, {
    message: 'Maximum outbox delay must be at least the base delay',
  });

export function readOutboxConfig(env: NodeJS.ProcessEnv = process.env) {
  return readConfig(OUTBOX_CONFIG_SCHEMA, 'outbox', env);
}
export type OutboxConfig = z.infer<typeof OUTBOX_CONFIG_SCHEMA>;
