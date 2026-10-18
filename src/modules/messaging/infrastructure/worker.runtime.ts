import type { WorkerSettings } from '@/shared/interfaces/worker.interface';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SqsWagerConsumer } from '@/modules/messaging/application/sqs-wager.consumer';
import type { OutboxPublisher } from '@/modules/messaging/application/outbox.publisher';
import type { PendingReferenceResolver } from '@/modules/messaging/application/pending-reference.resolver';

const WORKER_ERROR_DELAY_MS = 1000;

export class WorkerRuntime {
  private readonly stopPolling = new AbortController();
  private running: Promise<void>[] = [];
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly consumer: SqsWagerConsumer,
    private readonly publisher: OutboxPublisher,
    private readonly resolver: PendingReferenceResolver,
    private readonly settings: WorkerSettings,
  ) {}

  start(): void {
    if (!this.settings.enabled || this.running.length) return;
    this.running = [
      this.loop('sqs', () => this.consumer.pollOnce(this.stopPolling.signal), 0),
      this.loop('outbox', () => this.publisher.runOnce(), this.settings.outboxPollIntervalMs),
      this.loop(
        'pending-reference',
        () => this.resolver.runOnce(),
        this.settings.pendingPollIntervalMs,
      ),
    ];
  }

  stop(): Promise<void> {
    this.stopping ??= this.drain();
    return this.stopping;
  }

  private async drain(): Promise<void> {
    this.stopPolling.abort();
    // Let active SQL/send/ack work finish first. At the deadline, return receipts and exit.
    // Uncommitted work rolls back when its connection closes; a commit whose response
    // was lost is resolved by the durable Inbox/key when the message is delivered again.
    // The final fallback also bounds shutdown when the broker cannot accept a release.
    const deadline = setTimeout(() => {
      process.stderr.write(
        JSON.stringify({ level: 'error', event: 'worker_shutdown_deadline' }) + '\n',
      );
      const force = setTimeout(() => process.exit(1), this.settings.sqsRequestTimeoutMs);
      void this.consumer.releaseInFlight().finally(() => {
        clearTimeout(force);
        process.exit(1);
      });
    }, this.settings.shutdownDrainMs);
    try {
      await Promise.allSettled(this.running);
    } finally {
      clearTimeout(deadline);
    }
  }

  private async loop(
    name: string,
    work: () => Promise<unknown>,
    intervalMs: number,
  ): Promise<void> {
    const signal = this.stopPolling.signal;
    while (!signal.aborted) {
      let delay = intervalMs;
      try {
        await work();
      } catch {
        if (signal.aborted) return;
        process.stderr.write(
          JSON.stringify({ level: 'warn', event: 'worker_iteration_failed', worker: name }) + '\n',
        );
        delay = Math.max(delay, WORKER_ERROR_DELAY_MS);
      }
      if (signal.aborted) return;
      if (delay > 0) {
        try {
          await sleep(delay, undefined, { signal });
        } catch {
          return;
        }
      }
    }
  }
}
