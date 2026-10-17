import { expect, test } from 'bun:test';
import { DataSource } from 'typeorm';
import { startHttpTest } from '@test/support/http.util';

test('the application graph boots without opening dependencies when providers are overridden', async () => {
  // This only checks Nest wiring. Real HTTP/financial tests use a migrated PostgreSQL container.
  const dataSource = new DataSource({
    type: 'postgres',
    url: 'postgresql://wager_app:test@localhost/wagering',
    synchronize: false,
  });
  const http = await startHttpTest(dataSource);
  try {
    const response = await http.request('/');
    expect(response.status).toBe(404);
    expect(await response.json()).toHaveProperty('code', 'NOT_FOUND');
  } finally {
    await http.app.close();
  }
});
