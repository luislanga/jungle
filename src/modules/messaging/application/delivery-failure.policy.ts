import { ZodError } from 'zod';
import { ApplicationError } from '@/shared/errors/application.error';
import { DomainError } from '@/shared/errors/domain.error';
import { DeliveryFailureKind } from '@/shared/enums/messaging.enum';
import type { MessagingConfig } from '@/config/messaging';

export function deliveryFailureKind(error: unknown): DeliveryFailureKind {
  // Accepted business rejections resolve normally and are acknowledged. Exceptions
  // here represent invalid deliveries/conflicting identities or infrastructure failures.
  if (
    error instanceof SyntaxError ||
    error instanceof ZodError ||
    error instanceof ApplicationError ||
    error instanceof DomainError
  )
    return DeliveryFailureKind.Permanent;
  // An unknown outage must not turn an accepted wager into FAILED. The broker's
  // finite receive limit still sends persistent failures to DLQ for investigation.
  return DeliveryFailureKind.Transient;
}

export function deliveryRetryDelay(receiveCount: number, config: MessagingConfig): number {
  return Math.min(
    config.SQS_RETRY_MAX_SECONDS,
    config.SQS_RETRY_BASE_SECONDS * 2 ** (receiveCount - 1),
  );
}
