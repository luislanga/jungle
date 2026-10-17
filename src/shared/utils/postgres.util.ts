const POSTGRES_PROTOCOLS = ['postgres:', 'postgresql:'];

export function isPostgresUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return POSTGRES_PROTOCOLS.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const RETRYABLE_POSTGRES_CODES = [
  '40001', // Another transaction changed data we relied on.
  '40P01', // PostgreSQL stopped the transaction to break a deadlock.
  '55P03', // A required lock was unavailable or timed out.
];

export function isRetryablePostgresError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    RETRYABLE_POSTGRES_CODES.includes(error.code)
  );
}
