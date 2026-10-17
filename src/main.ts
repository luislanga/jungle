import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';

const DEFAULT_PORT = 3000;

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(process.env.PORT ?? DEFAULT_PORT, '0.0.0.0');
