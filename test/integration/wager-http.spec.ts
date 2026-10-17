import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startPostgresTest } from '@test/support/postgres.util';
import { startHttpTest, jsonRequest } from '@test/support/http.util';
import {
  assertWalletLedger,
  financialServices,
  openTestWallet,
  TEST_CONTEXT,
  wagerCommand,
  waitFor,
} from '@test/support/financial.util';
import { PendingReferenceWorkRepository } from '@/modules/messaging/infrastructure/persistence/repositories/pending-reference-work.repository';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '@/shared/enums/wager.enum';
import type {
  WagerCommand,
  WagerProcessingResult,
} from '@/shared/interfaces/wager-command.interface';

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

async function submit(command: WagerCommand) {
  const init = jsonRequest(command.data);
  const response = await http.request('/wagering/transactions', {
    ...init,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': command.idempotencyKey,
      'x-correlation-id': 'wager-http',
    },
  });
  const result = (await response.json()) as WagerProcessingResult;
  return { response, result };
}

test('HTTP processes all kinds, both WIN payloads and returns the original balance on replay', async () => {
  const wallet = await openTestWallet(db.app);
  const bet = wagerCommand(wallet);
  const first = await submit(bet);
  expect(first.response.status).toBe(200);
  expect(first.result.balance.amount).toBe('75.00');
  for (const command of [
    wagerCommand(wallet, { kind: Kind.Win, money: { amount: '5', currency: 'BRL' } }),
    wagerCommand(wallet, {
      kind: Kind.Win,
      money: { amount: '10', currency: 'BRL' },
      referenceExternalTransactionId: bet.data.externalTransactionId,
    }),
    wagerCommand(wallet, { kind: Kind.Loss, money: { amount: '0', currency: 'BRL' } }),
    wagerCommand(wallet, {
      kind: Kind.Refund,
      referenceExternalTransactionId: bet.data.externalTransactionId,
    }),
    wagerCommand(wallet, {
      kind: Kind.Rollback,
      referenceExternalTransactionId: bet.data.externalTransactionId,
    }),
  ]) {
    const { response, result } = await submit(command);
    expect(response.status).toBe(200);
    expect(result.status).toBe(Status.Processed);
  }
  expect((await submit(bet)).result).toEqual({ ...first.result, idempotentReplay: true });
  const lookup = await http.request('/wagering/transactions/' + first.result.transactionId);
  const external = await http.request(
    `/providers/${bet.data.providerId}/wagering/transactions/${bet.data.externalTransactionId}`,
  );
  expect(lookup.status).toBe(200);
  expect(external.status).toBe(200);
  expect(await lookup.json()).toEqual(await external.json());
  await assertWalletLedger(db.app, wallet.id, '140.00');
});

test('HTTP distinguishes validation, identity conflicts, business rejection and missing resources', async () => {
  const wallet = await openTestWallet(db.app);
  const command = wagerCommand(wallet);
  expect((await http.request('/wagering/transactions', jsonRequest(command.data))).status).toBe(
    400,
  );
  expect(
    (
      await http.request('/wagering/transactions', {
        ...jsonRequest({ ...command.data, kind: 'OPENING' }),
        headers: { 'content-type': 'application/json', 'idempotency-key': command.idempotencyKey },
      })
    ).status,
  ).toBe(400);
  await submit(command);
  const changed: WagerCommand = {
    ...command,
    data: { ...command.data, money: { amount: '26', currency: 'BRL' } },
  };
  expect((await submit(changed)).response.status).toBe(409);
  expect((await submit({ ...command, idempotencyKey: crypto.randomUUID() })).response.status).toBe(
    409,
  );
  const rejected = await submit(
    wagerCommand(wallet, { money: { amount: '500', currency: 'BRL' } }),
  );
  expect(rejected.response.status).toBe(422);
  expect(rejected.result.failureCode).toBe(FailureCode.InsufficientFunds);
  expect((await http.request('/wagering/transactions/' + crypto.randomUUID())).status).toBe(404);
  expect((await http.request('/wagering/transactions/invalid')).status).toBe(400);
  expect((await http.request('/providers/unknown/wagering/transactions/unknown')).status).toBe(404);
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('pending HTTP replay is read-only and returns the terminal outcome after explicit resume', async () => {
  const wallet = await openTestWallet(db.app);
  const bet = wagerCommand(wallet);
  const refund = wagerCommand(wallet, {
    kind: Kind.Refund,
    referenceExternalTransactionId: bet.data.externalTransactionId,
  });
  const pending = await submit(refund);
  expect(pending.response.status).toBe(202);
  expect(pending.result.status).toBe(Status.PendingReference);
  const replay = await submit(refund);
  expect(replay.response.status).toBe(202);
  expect(replay.result.idempotentReplay).toBe(true);
  await submit(bet);
  await db.owner.query(
    'UPDATE wagering.pending_reference_work SET next_attempt_at=now() WHERE transaction_id=$1',
    [pending.result.transactionId],
  );
  const claims = await db.app.transaction((manager) =>
    new PendingReferenceWorkRepository(manager).claimDue({
      owner: 'http-test',
      limit: 20,
      leaseMs: 30000,
    }),
  );
  const claim = claims.find((item) => item.transactionId === pending.result.transactionId)!;
  await financialServices(db.app).process.resume(claim.transactionId, claim.token, TEST_CONTEXT);
  const terminal = await submit(refund);
  expect(terminal.response.status).toBe(200);
  expect(terminal.result.status).toBe(Status.Processed);
  expect(terminal.result.idempotentReplay).toBe(true);
  await assertWalletLedger(db.app, wallet.id, '100.00');
});

test('database connection exhaustion returns 503 without exposing driver details and recovers', async () => {
  const wallet = await openTestWallet(db.app);
  const command = wagerCommand(wallet);
  try {
    // A real PostgreSQL role connection limit makes the runtime database unavailable
    // without changing Docker's randomly assigned host port when the container restarts.
    await db.run([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'wagering',
      '-c',
      "ALTER ROLE wager_app CONNECTION LIMIT 0; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='wager_app';",
    ]);
    const { response, result } = await submit(command);
    expect(response.status).toBe(503);
    expect(result).toHaveProperty('code', 'SERVICE_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('postgresql://');
  } finally {
    await db.run([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'wagering',
      '-c',
      'ALTER ROLE wager_app CONNECTION LIMIT -1;',
    ]);
  }
  // The pool discards the connections that PostgreSQL terminated.
  // The provider retries the SAME key after 503, so recovery cannot duplicate a debit.
  await waitFor(async () => {
    const { response } = await submit(command);
    if (response.status === 503) return false;
    expect(response.status).toBe(200);
    return true;
  });
  await assertWalletLedger(db.app, wallet.id, '75.00');
}, 30_000);
