import type { WorkerConfig } from '@/config/workers';
import type { OutboxConfig } from '@/config/outbox';
import type { MessagingConfig } from '@/config/messaging';
import type { PendingReferenceConfig } from '@/config/pending-reference';

export interface WorkerSettings {
  worker: WorkerConfig;
  outbox: OutboxConfig;
  pending: PendingReferenceConfig;
  messaging: MessagingConfig;
}
