import { expect, test } from 'bun:test';
import { readMessagingConfig } from '@/config/messaging';

test('SQS defaults bound polling, visibility, concurrency and request duration', () => {
  expect(readMessagingConfig({})).toMatchObject({
    SQS_WAIT_TIME_SECONDS: 10,
    SQS_VISIBILITY_TIMEOUT_SECONDS: 30,
    SQS_MAX_IN_FLIGHT: 4,
    SQS_REQUEST_TIMEOUT_MS: 5000,
  });
  for (const env of [
    { SQS_MAX_IN_FLIGHT: '11' },
    { SQS_WAIT_TIME_SECONDS: '21' },
    { SQS_VISIBILITY_TIMEOUT_SECONDS: '0' },
    { AWS_ENDPOINT_URL: 'not-a-url' },
  ])
    expect(() => readMessagingConfig(env)).toThrow('Invalid messaging configuration');
});
