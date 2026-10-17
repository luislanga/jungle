import { QueryFailedError } from 'typeorm';

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const cause: unknown = error instanceof QueryFailedError ? error.driverError : error;
  if (cause === null || typeof cause !== 'object' || !('code' in cause)) return false;
  return (
    cause.code === '23505' &&
    (constraint === undefined || ('constraint' in cause && cause.constraint === constraint))
  );
}
