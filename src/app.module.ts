import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DatabaseModule } from '@/database/database.module';
import { WalletModule } from '@/modules/wallet/wallet.module';
import { HttpErrorFilter } from '@/shared/presentation/http-error.filter';
import { CorrelationMiddleware } from '@/shared/presentation/correlation.middleware';

@Module({
  imports: [DatabaseModule, WalletModule],
  providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }
}
