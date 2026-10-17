import { afterAll, beforeAll, expect, test } from 'bun:test';
import { compose } from '@test/support/compose';

const project = `wagering-infra-${crypto.randomUUID()}`;
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  POSTGRES_PASSWORD: crypto.randomUUID(),
  APP_DATABASE_PASSWORD: crypto.randomUUID(),
  MIGRATION_DATABASE_PASSWORD: crypto.randomUUID(),
  POSTGRES_PORT: '0',
  LOCALSTACK_PORT: '0',
};
const QUEUES = ['wager-transactions.fifo', 'wager-transactions-dlq.fifo', 'wager-events.fifo'];

async function run(args: string[]): Promise<string> {
  const result = await compose(project, env, args);
  if (result.status !== 0) throw new Error(result.stderr + result.stdout);
  return result.stdout;
}

async function script(name: string): Promise<void> {
  const child = Bun.spawn([process.execPath, 'run', name], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error(stderr + stdout);
}

async function sqs(args: string[]): Promise<string> {
  return run(['exec', '-T', 'localstack', 'awslocal', 'sqs', ...args]);
}

async function attributes(name: string): Promise<Record<string, string>> {
  const output = await sqs([
    'get-queue-attributes',
    '--queue-url',
    `http://localhost:4566/000000000000/${name}`,
    '--attribute-names',
    'All',
  ]);
  return (JSON.parse(output) as { Attributes: Record<string, string> }).Attributes;
}

beforeAll(async () => {
  await script('infra:up');
}, 120_000);

afterAll(async () => {
  await run(['down', '--volumes', '--remove-orphans']);
}, 30_000);

test('infra command starts healthy dependencies without starting migrations or apps', async () => {
  expect(
    (await run(['ps', '--services', '--status', 'running'])).trim().split('\n').sort(),
  ).toEqual(['localstack', 'postgres']);
  const config = JSON.parse(await run(['config', '--format', 'json'])) as {
    services: Record<
      string,
      {
        stop_grace_period?: string;
        healthcheck?: { disable?: boolean };
        depends_on?: Record<string, { condition: string }>;
        ports?: Array<{ published: string }>;
      }
    >;
    volumes: Record<string, unknown>;
  };
  for (const name of ['app', 'app2', 'app3']) {
    expect(config.services[name]?.stop_grace_period).toBe('30s');
    expect(config.services[name]?.depends_on?.migrations?.condition).toBe(
      'service_completed_successfully',
    );
    expect(config.services[name]?.depends_on?.['queue-init']?.condition).toBe(
      'service_completed_successfully',
    );
  }
  expect(config.services.migrations?.depends_on?.postgres?.condition).toBe('service_healthy');
  expect(config.services.localstack?.healthcheck?.disable).toBe(true);
  expect(config.volumes).toHaveProperty('postgres_data');
  const ports = ['app', 'app2', 'app3'].map((name) => config.services[name]?.ports?.[0]?.published);
  expect(ports.every((port) => port !== undefined)).toBe(true);
  expect(new Set(ports).size).toBe(3);
}, 10_000);

test('queue initialization is repeatable and preserves routing and existing messages', async () => {
  const url = 'http://localhost:4566/000000000000/wager-transactions.fifo';
  const body = `preserve-${crypto.randomUUID()}`;
  await sqs([
    'send-message',
    '--queue-url',
    url,
    '--message-body',
    body,
    '--message-group-id',
    'provisioning',
    '--message-deduplication-id',
    crypto.randomUUID(),
  ]);
  await script('queue:init');
  await script('queue:init');
  for (const name of QUEUES) {
    const attrs = await attributes(name);
    expect(attrs.FifoQueue).toBe('true');
    if (name !== 'wager-transactions-dlq.fifo')
      expect(attrs.ContentBasedDeduplication).toBe('false');
    if (name === 'wager-transactions.fifo') {
      expect(attrs.VisibilityTimeout).toBe('30');
      expect(JSON.parse(attrs.RedrivePolicy ?? '{}')).toEqual({
        deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo',
        maxReceiveCount: '5',
      });
    }
    if (name === 'wager-transactions-dlq.fifo')
      expect(attrs.MessageRetentionPeriod).toBe('1209600');
  }
  const received = JSON.parse(await sqs(['receive-message', '--queue-url', url])) as {
    Messages: Array<{ Body: string; ReceiptHandle: string }>;
  };
  expect(received.Messages[0]?.Body).toBe(body);
  await sqs([
    'delete-message',
    '--queue-url',
    url,
    '--receipt-handle',
    received.Messages[0]!.ReceiptHandle,
  ]);
}, 60_000);

test('all three FIFO queues support sending, receiving and deleting messages', async () => {
  for (const name of QUEUES) {
    const url = `http://localhost:4566/000000000000/${name}`;
    const body = crypto.randomUUID();
    await sqs([
      'send-message',
      '--queue-url',
      url,
      '--message-body',
      body,
      '--message-group-id',
      'smoke',
      '--message-deduplication-id',
      crypto.randomUUID(),
    ]);
    const received = JSON.parse(await sqs(['receive-message', '--queue-url', url])) as {
      Messages: Array<{ Body: string; ReceiptHandle: string }>;
    };
    expect(received.Messages[0]?.Body).toBe(body);
    await sqs([
      'delete-message',
      '--queue-url',
      url,
      '--receipt-handle',
      received.Messages[0]!.ReceiptHandle,
    ]);
    const remaining = JSON.parse(
      (await sqs(['receive-message', '--queue-url', url])).trim() || '{}',
    ) as {
      Messages?: unknown[];
    };
    expect(remaining.Messages ?? []).toHaveLength(0);
  }
}, 60_000);
