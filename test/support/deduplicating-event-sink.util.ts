import type { DataSource } from 'typeorm';
import type { SqsGateway } from '@/modules/messaging/infrastructure/sqs/sqs.gateway';
import type { EventEnvelope } from '@/shared/interfaces/event.interface';
import { waitFor } from '@test/support/financial.util';

// This test sink applies its effect and remembers eventId in the same database row.
// A new connection/process can repeat a delivery without depending on FIFO's dedup window.
export async function consumeEvents(
  dataSource: DataSource,
  sqs: SqsGateway,
  queueUrl: string,
  count: number,
) {
  const events: EventEnvelope[] = [];
  await waitFor(async () => {
    for (const message of await sqs.receive(queueUrl)) {
      const event = JSON.parse(message.Body!) as EventEnvelope;
      await dataSource.query(
        'INSERT INTO wagering.test_event_effects(event_id,aggregate_id,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',
        [event.eventId, event.aggregateId, JSON.stringify(event)],
      );
      await sqs.delete(queueUrl, message.ReceiptHandle!);
      events.push(event);
    }
    return events.length >= count;
  }, 10000);
  return events;
}
