import { expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';

test('the application boots and accepts HTTP requests', async () => {
  const app = await NestFactory.create(AppModule, { logger: false });

  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(await app.getUrl());

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ statusCode: 404 });
  } finally {
    await app.close();
  }
});
