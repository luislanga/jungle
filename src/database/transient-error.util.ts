import { postgresCause } from '@/database/postgres-error.util';

import { isRetryablePostgresError } from '@/shared/utils/postgres.util';

const DATABASE_UNAVAILABLE_CODES = new Set([
  '57014',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '25P04',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);

// An interrupted COMMIT may already have succeeded. HTTP callers must retry the
// same key; only the transaction helper decides which SQL failures can be retried internally.
export function isTransientDatabaseError(error: unknown): boolean {
  const cause = postgresCause(error);
  if (
    typeof cause !== 'object' ||
    cause === null ||
    !('code' in cause) ||
    typeof cause.code !== 'string'
  )
    return false;
  return (
    isRetryablePostgresError(cause) ||
    cause.code.startsWith('08') ||
    DATABASE_UNAVAILABLE_CODES.has(cause.code)
  );
}
