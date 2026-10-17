import { z } from 'zod';

const WORKER_CONFIG_SCHEMA = z.object({
  WORKERS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().positive().default(20000),
});

export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = WORKER_CONFIG_SCHEMA.safeParse(env);
  if (!result.success) throw new Error('Invalid worker configuration');
  return result.data;
}
export type WorkerConfig = z.infer<typeof WORKER_CONFIG_SCHEMA>;
