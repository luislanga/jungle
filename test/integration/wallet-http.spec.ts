import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startPostgresTest } from '@test/support/postgres.util';
import { startHttpTest, jsonRequest } from '@test/support/http.util';
import { assertWalletLedger } from '@test/support/financial.util';

let db: Awaited<ReturnType<typeof startPostgresTest>>,
  http: Awaited<ReturnType<typeof startHttpTest>>;
beforeAll(async () => {
  db = await startPostgresTest();
  http = await startHttpTest(db.app);
}, 120_000);
afterAll(async () => {
  await http?.app.close();
  await db?.close();
}, 30_000);

interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}
const requestBody = (amount: unknown = '100') => ({
  playerId: crypto.randomUUID(),
  initialBalance: { amount, currency: 'BRL' },
});

test('POST and GET match the README, preserve decimal strings and commit OPENING', async () => {
  const body = requestBody();
  const response = await http.request('/wallets', jsonRequest(body));
  expect(response.status).toBe(201);
  const wallet = (await response.json()) as WalletResponse;
  expect(wallet).toEqual({
    id: wallet.id,
    playerId: body.playerId,
    balance: { amount: '100.00', currency: 'BRL' },
    version: 1,
  });
  expect(typeof wallet.id).toBe('string');
  const found = await http.request('/wallets/' + wallet.id);
  expect(found.status).toBe(200);
  expect(await found.json()).toEqual(wallet);
  await assertWalletLedger(db.app, wallet.id, '100.00');
});

test('zero opening is accepted and parallel duplicate wallets conflict', async () => {
  const body = requestBody('0');
  const results = await Promise.all([
    http.request('/wallets', jsonRequest(body)),
    http.request('/wallets', jsonRequest(body)),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  const wallet = (await results.find((r) => r.status === 201)!.json()) as WalletResponse;
  await assertWalletLedger(db.app, wallet.id, '0.00');
  const [counts] = await db.app.query<Array<{ count: number }>>(
    'SELECT count(*)::int AS count FROM wagering.wallet_ledger_entries WHERE wallet_id=$1',
    [wallet.id],
  );
  expect(counts?.count).toBe(0);
});

test('invalid inputs return 400, missing wallets 404, and errors carry correlation IDs', async () => {
  for (const amount of [1, '-1', '1.001', '1e2', 'NaN', '']) {
    const response = await http.request('/wallets', jsonRequest(requestBody(amount)));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'INVALID_REQUEST',
      correlationId: response.headers.get('x-correlation-id'),
    });
  }
  expect(
    (await http.request('/wallets', jsonRequest({ ...requestBody(), extra: true }))).status,
  ).toBe(400);
  expect(
    (
      await http.request(
        '/wallets',
        jsonRequest({ ...requestBody(), initialBalance: { amount: '1', currency: 'USD' } }),
      )
    ).status,
  ).toBe(400);
  expect((await http.request('/wallets/not-a-uuid')).status).toBe(400);
  const missing = await http.request('/wallets/' + crypto.randomUUID(), {
    headers: { 'x-correlation-id': 'wallet-http-test' },
  });
  expect(missing.status).toBe(404);
  expect(missing.headers.get('x-correlation-id')).toBe('wallet-http-test');
  expect(await missing.json()).toMatchObject({
    code: 'WALLET_NOT_FOUND',
    correlationId: 'wallet-http-test',
  });
});
