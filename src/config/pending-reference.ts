import { z } from 'zod';

// These are configurable demo limits. Production values need a provider/SLA review:
// for example 24 hours with 20 attempts capped at 2-hour delays, or 72 hours with
// 40 attempts capped at 4 hours. Those are discussion examples, not measured recommendations.
// Attempts and TTL are separate ceilings; the attempt limit may be reached first.
const PENDING_REFERENCE_CONFIG_SCHEMA = z
  .object({
    PENDING_REFERENCE_TTL_MS: z.coerce.number().int().positive().default(300_000),
    PENDING_REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    PENDING_REFERENCE_RETRY_BASE_MS: z.coerce.number().int().positive().default(1_000),
    PENDING_REFERENCE_RETRY_MAX_MS: z.coerce.number().int().positive().default(30_000),
  })
  .refine(
    (config) => config.PENDING_REFERENCE_RETRY_MAX_MS >= config.PENDING_REFERENCE_RETRY_BASE_MS,
  );

export function readPendingReferenceConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = PENDING_REFERENCE_CONFIG_SCHEMA.safeParse(env);
  if (!parsed.success) throw new Error('Invalid pending-reference configuration');
  return parsed.data;
}
export type PendingReferenceConfig = z.infer<typeof PENDING_REFERENCE_CONFIG_SCHEMA>;
