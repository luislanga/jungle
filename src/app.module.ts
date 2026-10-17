import { HealthModule } from '@/modules/health/health.module';
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { MessagingModule } from '@/modules/messaging/messaging.module';
import { DatabaseModule } from '@/database/database.module';
import { WageringModule } from '@/modules/wagering/wagering.module';
import { WalletModule } from '@/modules/wallet/wallet.module';
import { APP_PROVIDERS } from '@/app.providers';
import { CorrelationMiddleware } from '@/shared/presentation/correlation.middleware';

@Module({
  imports: [DatabaseModule, WalletModule, WageringModule, MessagingModule, HealthModule],
  providers: [...APP_PROVIDERS],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }
}
