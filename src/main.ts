import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '@/app.module';
import { safeErrorContext, writeLog } from '@/shared/infrastructure/logging/application.logger';

const DEFAULT_PORT = 3000;
let app: INestApplication | undefined;
try {
  // Application logs use the restricted JSON logger; Nest's default text/error
  // logger can include raw dependency errors with SQL or connection details.
  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? DEFAULT_PORT, '0.0.0.0');
  writeLog('application_started', { port: process.env.PORT ?? DEFAULT_PORT });
} catch (error) {
  writeLog('application_start_failed', safeErrorContext(error), 'error');
  try {
    await app?.close();
  } finally {
    process.exit(1);
  }
}
