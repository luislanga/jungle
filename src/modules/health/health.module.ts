import { Module } from '@nestjs/common';
import { MessagingModule } from '@/modules/messaging/messaging.module';
import { HealthController } from '@/modules/health/health.controller';
import { MetricsController } from '@/modules/health/metrics.controller';
import { HEALTH_PROVIDERS } from '@/modules/health/health.providers';

@Module({
  imports: [MessagingModule],
  providers: [...HEALTH_PROVIDERS],
  controllers: [MetricsController, HealthController],
})
export class HealthModule {}
