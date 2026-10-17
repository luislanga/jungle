import { SqsGateway } from '@/modules/messaging/infrastructure/sqs/sqs.gateway';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '@/app.module';
import { DATABASE_CONFIG } from '@/database/database.module';
import { financialServices } from '@test/support/financial.util';

export async function startHttpTest(dataSource: DataSource, sqs?: SqsGateway) {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DataSource)
    .useValue(dataSource)
    .overrideProvider(DATABASE_CONFIG)
    .useValue(financialServices(dataSource).config);
  if (sqs) builder = builder.overrideProvider(SqsGateway).useValue(sqs);
  const module = await builder.compile();
  const app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  return {
    app,
    baseUrl,
    request: (path: string, init?: RequestInit) => fetch(baseUrl + path, init),
  };
}

export function jsonRequest(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
