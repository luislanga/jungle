import { expect, test } from 'bun:test';
import { canonicalHash } from '@/shared/utils/hash.util';
import {
  parseHttpWager,
  parseSqsWager,
} from '@/modules/wagering/application/contracts/wager-command.contract';
import { WagerTransactionKind as Kind } from '@/shared/enums/wager.enum';

const payload = () => ({
  providerId: 'provider',
  externalTransactionId: 'external',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round',
  gameId: 'game',
  kind: Kind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
});
const envelope = (data: object) => ({
  messageId: 'envelope-id',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-01-01T00:00:00Z',
  data: { ...data, idempotencyKey: 'provider:key' },
});

test('canonical SHA-256 has a fixed independent vector and sorts nested keys', () => {
  expect(canonicalHash({ b: { y: '2', x: '1' }, a: '0' })).toBe(
    '0f42989a92c60ac42e3f5baf2eb05f817980bba2064c8441e5b4724686aeace3',
  );
  expect(canonicalHash({ a: '0', b: { x: '1', y: '2' } })).toBe(
    canonicalHash({ b: { y: '2', x: '1' }, a: '0' }),
  );
  expect(canonicalHash({ array: [{ b: '2', a: '1' }] })).toBe(
    canonicalHash({ array: [{ a: '1', b: '2' }] }),
  );
});

test('HTTP and SQS normalize the same business data and exclude key/envelope metadata', () => {
  const http = parseHttpWager(
    { ...payload(), money: { currency: 'BRL', amount: '25' } },
    'custom:key',
  );
  const sqs = parseSqsWager(envelope(payload()));
  expect(http.payloadHash).toBe(sqs.command.payloadHash);
  expect(http.idempotencyKey).toBe('custom:key');
  expect(sqs.messageId).toBe('envelope-id');
  const changedMetadata = parseSqsWager({
    ...envelope(payload()),
    messageId: 'other',
    occurredAt: '2026-02-01T00:00:00Z',
  });
  expect(changedMetadata.command.payloadHash).toBe(http.payloadHash);
  expect(parseHttpWager(payload(), 'another-key').payloadHash).toBe(http.payloadHash);
});

test('every business field affects the hash; omitted reference differs from supplied reference', () => {
  const original = parseHttpWager(payload(), 'key').payloadHash;
  for (const field of ['providerId', 'externalTransactionId', 'roundId', 'gameId'] as const) {
    expect(parseHttpWager({ ...payload(), [field]: 'changed' }, 'key').payloadHash).not.toBe(
      original,
    );
  }
  expect(
    parseHttpWager({ ...payload(), playerId: payload().walletId }, 'key').payloadHash,
  ).not.toBe(original);
  expect(
    parseHttpWager({ ...payload(), walletId: payload().playerId }, 'key').payloadHash,
  ).not.toBe(original);
  expect(
    parseHttpWager({ ...payload(), money: { amount: '26.00', currency: 'BRL' } }, 'key')
      .payloadHash,
  ).not.toBe(original);
  expect(parseHttpWager({ ...payload(), kind: Kind.Win }, 'key').payloadHash).not.toBe(original);
  expect(
    parseHttpWager({ ...payload(), referenceExternalTransactionId: 'bet' }, 'key').payloadHash,
  ).not.toBe(original);
});

test.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])(
  'both transports enforce zero policy for %s',
  (kind) => {
    const body = {
      ...payload(),
      kind,
      money: { amount: '0.00', currency: 'BRL' },
      ...([Kind.Refund, Kind.Rollback].includes(kind)
        ? { referenceExternalTransactionId: 'bet' }
        : {}),
    };
    if (kind === Kind.Loss) {
      expect(parseHttpWager(body, 'key').data.money.amount).toBe('0.00');
      expect(parseSqsWager(envelope(body)).command.data.money.amount).toBe('0.00');
    } else {
      expect(() => parseHttpWager(body, 'key')).toThrow();
      expect(() => parseSqsWager(envelope(body))).toThrow();
    }
  },
);

test('WIN accepts both payload shapes on both transports; null reference is invalid', () => {
  for (const reference of [undefined, 'bet']) {
    const data = {
      ...payload(),
      kind: Kind.Win,
      ...(reference ? { referenceExternalTransactionId: reference } : {}),
    };
    expect(parseHttpWager(data, 'key').data.kind).toBe(Kind.Win);
    expect(parseSqsWager(envelope(data)).command.data.kind).toBe(Kind.Win);
  }
  expect(() =>
    parseHttpWager({ ...payload(), referenceExternalTransactionId: null }, 'key'),
  ).toThrow();
});

test('missing keys, unknown fields, internal OPENING, invalid IDs and numeric/negative money are rejected', () => {
  expect(() => parseHttpWager(payload(), undefined)).toThrow();
  expect(() => parseHttpWager(payload(), '')).toThrow();
  expect(() => parseSqsWager({ ...envelope(payload()), data: payload() })).toThrow();
  for (const data of [
    { ...payload(), extra: true },
    { ...payload(), kind: 'OPENING' },
    { ...payload(), kind: Kind.Refund },
    { ...payload(), walletId: 'invalid' },
    ...[25, '-1', '1e2', '1.001'].map((amount) => ({
      ...payload(),
      money: { amount, currency: 'BRL' },
    })),
  ]) {
    expect(() => parseHttpWager(data, 'key')).toThrow();
    expect(() => parseSqsWager(envelope(data))).toThrow();
  }
  expect(() => parseSqsWager({ ...envelope(payload()), transportField: true })).toThrow();
});

test('equivalent decimal strings keep the same normalized command and persistent hash', () => {
  const expected = parseHttpWager(payload(), 'key');
  for (const amount of ['25', '25.0', '25.00', '00025.00']) {
    const body = { ...payload(), money: { amount, currency: 'BRL' } };
    expect(parseHttpWager(body, 'key')).toEqual(expected);
    expect(parseSqsWager(envelope(body)).command.data).toEqual(expected.data);
    expect(parseSqsWager(envelope(body)).command.payloadHash).toBe(expected.payloadHash);
  }
});
