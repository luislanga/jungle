import { Client } from 'pg';
import type { DatabaseConfig } from '@/config/database';
import type { MessageQueue } from '@/shared/interfaces/message-queue.interface';
import type { HealthChecks } from '@/shared/interfaces/health.interface';
import {
  INBOUND_QUEUE_NAME,
  DEAD_LETTER_QUEUE_NAME,
  OUTBOUND_QUEUE_NAME,
} from '@/shared/consts/messaging.constant';

const READINESS_TIMEOUT_MS = 1000;
const REQUIRED_QUEUES = [INBOUND_QUEUE_NAME, DEAD_LETTER_QUEUE_NAME, OUTBOUND_QUEUE_NAME];

export class HealthChecksAdapter implements HealthChecks {
  constructor(
    private readonly database: DatabaseConfig,
    private readonly sqs: MessageQueue,
  ) {}

  async check() {
    const [postgres, sqs] = await Promise.all([
      this.reachable(this.pingPostgres()),
      this.reachable(
        Promise.all(
          REQUIRED_QUEUES.map(async (name) => this.sqs.queueDepth(await this.sqs.queueUrl(name))),
        ),
      ),
    ]);
    return { postgres, sqs };
  }

  private async pingPostgres(): Promise<void> {
    // A short-lived pg connection has its own query timeout. A failed health read
    // must not leave a stalled query occupying the financial connection pool.
    const client = new Client({
      connectionString: this.database.DATABASE_URL,
      connectionTimeoutMillis: READINESS_TIMEOUT_MS,
      query_timeout: READINESS_TIMEOUT_MS,
    });
    try {
      await client.connect();
      await client.query('SELECT 1');
    } finally {
      await client.end();
    }
  }

  private async reachable(work: Promise<unknown>): Promise<boolean> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // A probe must return quickly even if a dependency stops responding. SDK and pg
      // query/connection timeouts also bound the underlying read after this HTTP budget ends.
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Readiness timeout')), READINESS_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }
}
