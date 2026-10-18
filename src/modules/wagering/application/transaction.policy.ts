import { FailureCode } from '@/shared/enums/wager.enum';
import type { DomainError } from '@/shared/errors/domain.error';
import type { PendingReferenceConfig } from '@/config/pending-reference';

export function businessFailureCode(error: DomainError): FailureCode {
  const code = Object.values(FailureCode).find((code) => code === error.code);
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
