import { expect, test } from 'bun:test';
import { readPendingReferenceConfig } from '@/config/pending-reference';
import { nextReferenceAttempt } from '@/modules/wagering/application/transaction.policy';

test('pending demo limits are configurable independent ceilings with capped exponential backoff', () => {
  const config = readPendingReferenceConfig({});
  expect(config.PENDING_REFERENCE_TTL_MS).toBe(300_000);
  expect(config.PENDING_REFERENCE_MAX_ATTEMPTS).toBe(10);
  const at = new Date(0);
  expect(nextReferenceAttempt(at, 0, config).getTime()).toBe(1_000);
  expect(nextReferenceAttempt(at, 3, config).getTime()).toBe(8_000);
  expect(nextReferenceAttempt(at, 10, config).getTime()).toBe(30_000);
  const changed = readPendingReferenceConfig({
    PENDING_REFERENCE_TTL_MS: '500',
    PENDING_REFERENCE_MAX_ATTEMPTS: '2',
  });
  expect(changed.PENDING_REFERENCE_TTL_MS).toBe(500);
  expect(changed.PENDING_REFERENCE_MAX_ATTEMPTS).toBe(2);
  for (const env of [
    { PENDING_REFERENCE_TTL_MS: '0' },
    { PENDING_REFERENCE_MAX_ATTEMPTS: '0' },
    { PENDING_REFERENCE_RETRY_BASE_MS: '30001' },
  ])
    expect(() => readPendingReferenceConfig(env)).toThrow(
      'Invalid pending-reference configuration',
    );
});
