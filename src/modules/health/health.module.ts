import { HealthController } from '@/modules/health/health.controller';
import { Module } from '@nestjs/common';
import { MessagingModule } from '@/modules/messaging/messaging.module';
import { WalletModule } from '@/modules/wallet/wallet.module';
import { MetricsController } from '@/modules/health/metrics.controller';

@Module({
  imports: [MessagingModule, WalletModule],
  controllers: [MetricsController, HealthController],
})
export class HealthModule {}
