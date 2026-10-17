import { spawnWorker } from '@test/support/worker-process.util';
import { financialServices, waitFor } from '@test/support/financial.util';
import type { startMessagingTest } from '@test/support/messaging.util';

export async function startRecoveryWorkers(
  db: Awaited<ReturnType<typeof startMessagingTest>>,
  overrides: NodeJS.ProcessEnv = {},
) {
  const workers = Array.from({ length: 3 }, () =>
    spawnWorker({
      DATABASE_URL: financialServices(db.app).config.DATABASE_URL,
      AWS_ENDPOINT_URL: db.config.AWS_ENDPOINT_URL!,
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
      SQS_HEARTBEAT_INTERVAL_MS: '100',
      SQS_REQUEST_TIMEOUT_MS: '500',
      SQS_RETRY_BASE_SECONDS: '0',
      SQS_RETRY_MAX_SECONDS: '0',
      WORKERS_ENABLED: 'true',
      SHUTDOWN_DRAIN_MS: '5000',
      OUTBOX_POLL_INTERVAL_MS: '100',
      OUTBOX_LEASE_MS: '1000',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '50',
      PENDING_REFERENCE_LEASE_MS: '1000',
      PENDING_REFERENCE_RETRY_BASE_MS: '100',
      PENDING_REFERENCE_RETRY_MAX_MS: '200',
      PENDING_REFERENCE_MAX_ATTEMPTS: '50',
      TEST_WORKER_MODE: '',
      ...overrides,
    }),
  );
  async function kill() {
    for (const worker of workers)
      if (worker.child.exitCode === null && worker.child.signalCode === null)
        worker.child.kill('SIGKILL');
    await waitFor(() =>
      workers.every((w) => w.child.exitCode !== null || w.child.signalCode !== null),
    );
    await Promise.all(workers.map((w) => w.child.exited));
  }
  try {
    await Promise.all(workers.map((w) => w.phase('started')));
    console.log(
      JSON.stringify({ event: 'recovery_workers_ready', pids: workers.map((w) => w.child.pid) }),
    );
  } catch (error) {
    await kill();
    throw error;
  }
  return {
    workers,
    kill,
    stop: async () => {
      try {
        await Promise.all(workers.map((w) => w.stop()));
      } finally {
        await kill();
      }
    },
  };
}
