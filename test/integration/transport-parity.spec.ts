import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startMessagingTest, enqueueWager } from '@test/support/messaging.util';
import { startHttpTest, jsonRequest } from '@test/support/http.util';
import {
  assertWalletLedger,
  financialServices,
  openTestWallet,
  wagerCommand,
} from '@test/support/financial.util';
import { SqsWagerConsumer } from '@/modules/messaging/application/sqs-wager.consumer';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '@/shared/enums/wager.enum';
import type {
  WagerBusinessData,
  WagerCommand,
  WagerProcessingResult,
} from '@/shared/interfaces/wager-command.interface';

interface Step {
  kind: WagerBusinessData['kind'];
  amount?: string;
  reference?: number | 'missing';
  roundId?: string;
  gameId?: string;
}
interface Scenario extends Step {
  title: string;
  prepare?: readonly Step[];
  balance: string;
  entries: number;
  status?: Status;
  failure?: FailureCode;
}
type Reply = Omit<WagerProcessingResult, 'idempotentReplay'> & { idempotentReplay?: boolean };
const TRANSPORTS = ['HTTP', 'SQS'] as const;
const SCENARIOS: readonly Scenario[] = [
  {
    title: 'BET',
    kind: Kind.Bet,
    balance: '75.00',
    entries: 2,
  },
  {
    title: 'unreferenced WIN',
    kind: Kind.Win,
    balance: '125.00',
    entries: 2,
  },
  {
    title: 'referenced WIN',
    prepare: [{ kind: Kind.Bet }],
    kind: Kind.Win,
    reference: 0,
    balance: '100.00',
    entries: 3,
  },
  {
    title: 'same round with a different game is allowed',
    prepare: [{ kind: Kind.Bet }],
    kind: Kind.Win,
    reference: 0,
    gameId: 'another-game',
    balance: '100.00',
    entries: 3,
  },
  {
    title: 'zero LOSS',
    kind: Kind.Loss,
    amount: '0',
    balance: '100.00',
    entries: 1,
  },
  {
    title: 'positive LOSS',
    kind: Kind.Loss,
    balance: '100.00',
    entries: 1,
  },
  {
    title: 'REFUND',
    prepare: [{ kind: Kind.Bet }],
    kind: Kind.Refund,
    reference: 0,
    balance: '100.00',
    entries: 3,
  },
  {
    title: 'ROLLBACK BET',
    prepare: [{ kind: Kind.Bet }],
    kind: Kind.Rollback,
    reference: 0,
    balance: '100.00',
    entries: 3,
  },
  {
    title: 'ROLLBACK WIN',
    prepare: [{ kind: Kind.Win }],
    kind: Kind.Rollback,
    reference: 0,
    balance: '100.00',
    entries: 3,
  },
  {
    title: 'ROLLBACK REFUND',
    prepare: [{ kind: Kind.Bet }, { kind: Kind.Refund, reference: 0 }],
    kind: Kind.Rollback,
    reference: 1,
    balance: '75.00',
    entries: 4,
  },
  {
    title: 'BET insufficient funds',
    kind: Kind.Bet,
    amount: '150',
    balance: '100.00',
    entries: 1,
    status: Status.Rejected,
    failure: FailureCode.InsufficientFunds,
  },
  {
    title: 'reversal insufficient funds',
    prepare: [{ kind: Kind.Win }, { kind: Kind.Bet, amount: '125' }],
    kind: Kind.Rollback,
    reference: 0,
    balance: '0.00',
    entries: 3,
    status: Status.Rejected,
    failure: FailureCode.ReversalInsufficientFunds,
  },
  {
    title: 'partial reversal rejected',
    prepare: [{ kind: Kind.Bet }],
    kind: Kind.Refund,
    reference: 0,
    amount: '24',
    balance: '75.00',
    entries: 2,
    status: Status.Rejected,
    failure: FailureCode.ReferenceAmountMismatch,
  },
  {
    title: 'REFUND cannot reference WIN',
    prepare: [{ kind: Kind.Win }],
    kind: Kind.Refund,
    reference: 0,
    balance: '125.00',
    entries: 2,
    status: Status.Rejected,
    failure: FailureCode.InvalidReferenceKind,
  },
  {
    title: 'ROLLBACK cannot reference LOSS',
    prepare: [{ kind: Kind.Loss, amount: '0' }],
    kind: Kind.Rollback,
    reference: 0,
    balance: '100.00',
    entries: 1,
    status: Status.Rejected,
    failure: FailureCode.InvalidReferenceKind,
  },
  {
    title: 'rejected reference stays rejected',
    prepare: [{ kind: Kind.Bet, amount: '150' }],
    kind: Kind.Refund,
    reference: 0,
    balance: '100.00',
    entries: 1,
    status: Status.Rejected,
    failure: FailureCode.ReferenceNotProcessed,
  },
  {
    title: 'reference round mismatch',
    prepare: [{ kind: Kind.Bet, roundId: 'another-round' }],
    kind: Kind.Refund,
    reference: 0,
    balance: '75.00',
    entries: 2,
    status: Status.Rejected,
    failure: FailureCode.ReferenceContextMismatch,
  },
  {
    title: 'missing mandatory reference deferred',
    kind: Kind.Refund,
    reference: 'missing',
    balance: '100.00',
    entries: 1,
    status: Status.PendingReference,
  },
  {
    title: 'missing supplied WIN reference deferred',
    kind: Kind.Win,
    reference: 'missing',
    balance: '100.00',
    entries: 1,
    status: Status.PendingReference,
  },
  {
    title: 'same-kind reversal rejected',
    prepare: [{ kind: Kind.Bet }, { kind: Kind.Refund, reference: 0 }],
    kind: Kind.Refund,
    reference: 0,
    balance: '100.00',
    entries: 3,
    status: Status.Rejected,
    failure: FailureCode.ReferenceAlreadyReversed,
  },
  {
    title: 'one reversal per kind follows the literal README',
    prepare: [{ kind: Kind.Bet }, { kind: Kind.Refund, reference: 0 }],
    kind: Kind.Rollback,
    reference: 0,
    balance: '125.00',
    entries: 4,
  },
];
let db: Awaited<ReturnType<typeof startMessagingTest>>,
  http: Awaited<ReturnType<typeof startHttpTest>>,
  consumer: SqsWagerConsumer;
beforeAll(async () => {
  db = await startMessagingTest();
  http = await startHttpTest(db.app, db.sqs);
  consumer = new SqsWagerConsumer(db.sqs, financialServices(db.app).process, db.config);
}, 180_000);
afterAll(async () => {
  await http?.app.close();
  await db?.close();
}, 30_000);

async function submit(
  transport: (typeof TRANSPORTS)[number],
  command: WagerCommand,
  envelopes: string[],
): Promise<Reply> {
  if (transport === 'HTTP') {
    const response = await http.request('/wagering/transactions', {
      ...jsonRequest(command.data),
      headers: { 'content-type': 'application/json', 'idempotency-key': command.idempotencyKey },
    });
    const body = (await response.json()) as Reply;
    expect(response.status).toBe(
      body.status === Status.Processed ? 200 : body.status === Status.PendingReference ? 202 : 422,
    );
    return body;
  }
  const messageId = crypto.randomUUID();
  envelopes.push(messageId);
  await enqueueWager(db, command, messageId);
  expect((await consumer.pollOnce()).acknowledged).toBe(1);
  const response = await http.request(
    `/providers/${command.data.providerId}/wagering/transactions/${command.data.externalTransactionId}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Reply;
}

for (const transport of TRANSPORTS)
  for (const scenario of SCENARIOS)
    test(`${transport}: ${scenario.title}`, async () => {
      const wallet = await openTestWallet(db.app),
        previous: WagerCommand[] = [],
        envelopes: string[] = [];
      function make(step: Step) {
        const reference =
          typeof step.reference === 'number'
            ? previous[step.reference]!.data.externalTransactionId
            : step.reference === 'missing'
              ? 'not-yet-present'
              : undefined;
        return wagerCommand(wallet, {
          kind: step.kind,
          money: { amount: step.amount ?? '25', currency: 'BRL' },
          ...(reference ? { referenceExternalTransactionId: reference } : {}),
          ...(step.roundId ? { roundId: step.roundId } : {}),
          ...(step.gameId ? { gameId: step.gameId } : {}),
        });
      }
      for (const step of scenario.prepare ?? []) {
        const command = make(step);
        await submit(transport, command, envelopes);
        previous.push(command);
      }
      const command = make(scenario);
      const first = await submit(transport, command, envelopes);
      expect(first.status).toBe(scenario.status ?? Status.Processed);
      expect(first.failureCode).toBe(scenario.failure);
      expect(first.balance).toEqual({ amount: scenario.balance, currency: 'BRL' });
      const replay = await submit(transport, command, envelopes);
      expect(replay).toEqual(transport === 'HTTP' ? { ...first, idempotentReplay: true } : first);
      await assertWalletLedger(db.app, wallet.id, scenario.balance);
      const found = await http.request('/wallets/' + wallet.id);
      expect(await found.json()).toMatchObject({
        version: scenario.entries,
        balance: { amount: scenario.balance, currency: 'BRL' },
      });
      const ledger = await http.request(`/wallets/${wallet.id}/ledger?limit=200`);
      expect(((await ledger.json()) as { items: unknown[] }).items).toHaveLength(scenario.entries);
      const internal = await http.request('/wagering/transactions/' + first.transactionId);
      const external = await http.request(
        `/providers/${command.data.providerId}/wagering/transactions/${command.data.externalTransactionId}`,
      );
      expect(await internal.json()).toEqual(await external.json());
      const [audit] = await db.app.query<
        Array<{
          wagers: number;
          processed: number;
          rejected: number;
          pending: number;
          processed_events: number;
          rejected_events: number;
          pending_events: number;
          balance_events: number;
          inbox: number;
        }>
      >(
        `SELECT
    (SELECT count(*)::int FROM wagering.wager_transactions WHERE wallet_id=$1) AS wagers,
    (SELECT count(*)::int FROM wagering.wager_transactions WHERE wallet_id=$1 AND status='PROCESSED') AS processed,
    (SELECT count(*)::int FROM wagering.wager_transactions WHERE wallet_id=$1 AND status='REJECTED') AS rejected,
    (SELECT count(*)::int FROM wagering.wager_transactions WHERE wallet_id=$1 AND status='PENDING_REFERENCE') AS pending,
    (SELECT count(*)::int FROM wagering.outbox_messages WHERE aggregate_id=$1 AND event_type='WagerTransactionProcessed') AS processed_events,
    (SELECT count(*)::int FROM wagering.outbox_messages WHERE aggregate_id=$1 AND event_type='WagerTransactionRejected') AS rejected_events,
    (SELECT count(*)::int FROM wagering.outbox_messages WHERE aggregate_id=$1 AND event_type='WagerTransactionPendingReference') AS pending_events,
    (SELECT count(*)::int FROM wagering.outbox_messages WHERE aggregate_id=$1 AND event_type='WalletBalanceChanged') AS balance_events,
    (SELECT count(*)::int FROM wagering.inbox_messages WHERE message_id=ANY($2::text[])) AS inbox`,
        [wallet.id, envelopes],
      );
      expect(audit?.wagers).toBe((scenario.prepare?.length ?? 0) + 2);
      expect(audit?.processed_events).toBe(audit!.processed);
      expect(audit?.rejected_events).toBe(audit!.rejected);
      expect(audit?.pending_events).toBe(audit!.pending);
      expect(audit?.balance_events).toBe(scenario.entries);
      expect(audit?.inbox).toBe(envelopes.length);
    });
