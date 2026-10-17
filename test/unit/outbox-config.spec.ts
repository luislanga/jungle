import { expect, test } from 'bun:test';
import { readOutboxConfig } from '@/config/outbox';

test('outbox has bounded batch, lease and retry defaults with escalation rather than event deletion', () => {
  expect(readOutboxConfig({})).toMatchObject({
    OUTBOX_BATCH_SIZE: 20,
    OUTBOX_LEASE_MS: 30000,
    OUTBOX_ESCALATE_AFTER_ATTEMPTS: 10,
    OUTBOX_RETRY_MAX_MS: 60000,
  });
  expect(() =>
    readOutboxConfig({ OUTBOX_RETRY_BASE_MS: '100', OUTBOX_RETRY_MAX_MS: '50' }),
  ).toThrow();
});
