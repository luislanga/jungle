import { expect, test } from 'bun:test';
import {
  deliveryFailureKind,
  deliveryRetryDelay,
} from '@/modules/messaging/application/delivery-failure.policy';
import { readMessagingConfig } from '@/config/messaging';
import { DeliveryFailureKind } from '@/shared/enums/messaging.enum';
import { ApplicationError } from '@/shared/errors/application.error';
import { APPLICATION_ERRORS } from '@/shared/errors/errors.constant';

test('invalid deliveries conflict permanently while infrastructure and unknown errors remain retryable', () => {
  expect(deliveryFailureKind(new SyntaxError('bad JSON'))).toBe(DeliveryFailureKind.Permanent);
  expect(deliveryFailureKind(new ApplicationError(APPLICATION_ERRORS.IDEMPOTENCY_CONFLICT))).toBe(
    DeliveryFailureKind.Permanent,
  );
  expect(deliveryFailureKind({ code: '08006' })).toBe(DeliveryFailureKind.Transient);
  expect(deliveryFailureKind(new Error('unknown outage'))).toBe(DeliveryFailureKind.Transient);
  const config = readMessagingConfig({});
  expect([1, 2, 3, 8].map((count) => deliveryRetryDelay(count, config))).toEqual([1, 2, 4, 30]);
});
