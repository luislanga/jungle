import { readConfig } from '@/config/config.util';
import { z } from 'zod';

const WORKER_CONFIG_SCHEMA = z.object({
  WORKERS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().positive().default(20000),
});

export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  return readConfig(WORKER_CONFIG_SCHEMA, 'worker', env);
}
export type WorkerConfig = z.infer<typeof WORKER_CONFIG_SCHEMA>;
