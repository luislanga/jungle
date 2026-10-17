import { FailureCode } from '@/shared/enums/wager.enum';
import type { DomainError } from '@/shared/errors/domain.error';
import type { PendingReferenceConfig } from '@/config/pending-reference';

const FAILURE_CODES = new Map<string, FailureCode>(
  Object.values(FailureCode).map((code) => [code, code]),
);
export function businessFailureCode(error: DomainError): FailureCode {
  const code = FAILURE_CODES.get(error.code);
  if (code === undefined) throw error;
  return code;
}
export function nextReferenceAttempt(
  at: Date,
  attempts: number,
  config: PendingReferenceConfig,
): Date {
  const delay = Math.min(
    config.PENDING_REFERENCE_RETRY_MAX_MS,
    config.PENDING_REFERENCE_RETRY_BASE_MS * 2 ** attempts,
  );
  return new Date(at.getTime() + delay);
}
