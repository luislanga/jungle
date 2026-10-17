import {
  Inject,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { WageringModule } from '@/modules/wagering/wagering.module';
import { SqsGateway } from '@/modules/messaging/infrastructure/sqs/sqs.gateway';
import { WorkerRuntime } from '@/modules/messaging/infrastructure/worker.runtime';
import { MESSAGE_QUEUE } from '@/shared/interfaces/message-queue.interface';
import { MESSAGING_CONFIG, MESSAGING_PROVIDERS } from '@/modules/messaging/messaging.providers';

export {
  MESSAGING_CONFIG,
  OUTBOX_CONFIG,
  PENDING_REFERENCE_CONFIG,
  WORKER_CONFIG,
} from '@/modules/messaging/messaging.providers';

@Module({
  imports: [WageringModule],
  providers: [...MESSAGING_PROVIDERS],
  exports: [MESSAGE_QUEUE, MESSAGING_CONFIG],
})
export class MessagingModule
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  constructor(
    @Inject(WorkerRuntime) private readonly runtime: WorkerRuntime,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
  ) {}

  onApplicationBootstrap(): void {
    this.runtime.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.runtime.stop();
  }

  onApplicationShutdown(): void {
    this.sqs.close();
  }
}
