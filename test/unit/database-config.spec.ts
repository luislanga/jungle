import { describe, expect, test } from 'bun:test';
import { readDatabaseConfig } from '@/config/database';

const APPLICATION_URL = 'postgresql://app_user:local@localhost:5432/wagering';

describe('database configuration', () => {
  test('runtime configuration needs only its own connection URL', () => {
    expect(readDatabaseConfig({ DATABASE_URL: APPLICATION_URL }).DATABASE_URL).toBe(
      APPLICATION_URL,
    );
    expect(() => readDatabaseConfig({})).toThrow('Invalid database configuration: DATABASE_URL');
  });

  test('provides defaults and converts environment settings to integers', () => {
    const config = readDatabaseConfig({
      DATABASE_URL: APPLICATION_URL,
      DATABASE_LOCK_TIMEOUT_MS: '3000',
    });
    expect(config.DATABASE_POOL_SIZE).toBe(10);
    expect(config).toMatchObject({
      DATABASE_LOCK_TIMEOUT_MS: 3000,
      DATABASE_TRANSACTION_TIMEOUT_MS: 5000,
      DATABASE_TRANSACTION_MAX_ATTEMPTS: 3,
      DATABASE_RETRY_BASE_DELAY_MS: 25,
      DATABASE_RETRY_MAX_DELAY_MS: 250,
    });
  });

  test.each(['', 'not-a-url', 'https://user:secret@host/db'])(
    'rejects invalid connection configuration without exposing credentials: %s',
    (url) => {
      expect(() => readDatabaseConfig({ DATABASE_URL: url })).toThrow(
        'Invalid database configuration: DATABASE_URL',
      );
    },
  );

  test.each(['0', '-1', 'Infinity', '1.5'])('rejects invalid timeout: %s', (timeout) => {
    expect(() =>
      readDatabaseConfig({
        DATABASE_URL: APPLICATION_URL,
        DATABASE_LOCK_TIMEOUT_MS: timeout,
      }),
    ).toThrow();
  });

  test('rejects unbounded attempts and inverted retry delays', () => {
    expect(() =>
      readDatabaseConfig({
        DATABASE_URL: APPLICATION_URL,
        DATABASE_TRANSACTION_MAX_ATTEMPTS: '11',
      }),
    ).toThrow();
    expect(() =>
      readDatabaseConfig({
        DATABASE_URL: APPLICATION_URL,
        DATABASE_RETRY_BASE_DELAY_MS: '50',
        DATABASE_RETRY_MAX_DELAY_MS: '10',
      }),
    ).toThrow();
  });
});
