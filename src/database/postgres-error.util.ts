import { QueryFailedError } from 'typeorm';

export function postgresCause(error: unknown): unknown {
  return error instanceof QueryFailedError ? error.driverError : error;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const cause = postgresCause(error);
  if (cause === null || typeof cause !== 'object' || !('code' in cause)) return false;
  return (
    cause.code === '23505' &&
    (constraint === undefined || ('constraint' in cause && cause.constraint === constraint))
  );
}
