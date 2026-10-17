import { z } from 'zod';
import { isPostgresUrl } from '@/shared/utils/postgres.util';

const DATABASE_CONFIG_SCHEMA = z
  .object({
    DATABASE_URL: z.string().refine(isPostgresUrl, 'Must be a PostgreSQL URL'),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
    DATABASE_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    DATABASE_TRANSACTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    DATABASE_RETRY_BASE_DELAY_MS: z.coerce.number().int().nonnegative().default(25),
    DATABASE_RETRY_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(250),
  })
  .refine((env) => env.DATABASE_RETRY_MAX_DELAY_MS >= env.DATABASE_RETRY_BASE_DELAY_MS, {
    message: 'Maximum retry delay must be at least the base delay',
    path: ['DATABASE_RETRY_MAX_DELAY_MS'],
  });

export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = DATABASE_CONFIG_SCHEMA.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid database configuration: ${fields}`);
  }
  return result.data;
}

export type DatabaseConfig = z.infer<typeof DATABASE_CONFIG_SCHEMA>;
