import { expect, test } from 'bun:test';
import { readWorkerConfig } from '@/config/workers';
import { readMessagingConfig } from '@/config/messaging';

test('worker switches and shutdown budgets are explicit; heartbeat must precede visibility expiry', () => {
  expect(readWorkerConfig({})).toEqual({ WORKERS_ENABLED: true, SHUTDOWN_DRAIN_MS: 20000 });
  expect(readWorkerConfig({ WORKERS_ENABLED: 'false' }).WORKERS_ENABLED).toBe(false);
  expect(() => readWorkerConfig({ SHUTDOWN_DRAIN_MS: '0' })).toThrow();
  expect(() => readMessagingConfig({ SQS_HEARTBEAT_INTERVAL_MS: '30000' })).toThrow();
});
