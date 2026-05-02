import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './infrastructure/nest/app.module';
import { DomainExceptionFilter } from './infrastructure/nest/DomainExceptionFilter';
import { startEventLoopMonitor } from './infrastructure/observability/EventLoopMonitor';

async function bootstrap(): Promise<void> {
  // Started before Nest so any blocking work during DI/onModuleInit is also
  // observed (migrations, sandbox.assertReady, GitHub whoami, etc.).
  const stallThresholdMs = Number(process.env.EVENT_LOOP_STALL_THRESHOLD_MS ?? 50);
  startEventLoopMonitor({ thresholdMs: stallThresholdMs });

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableCors({ origin: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // DomainErrors → friendly 4xx; everything else falls through to default.
  app.useGlobalFilters(new DomainExceptionFilter());

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  new Logger('Bootstrap').log(`Backend listening on :${port}`);
}

void bootstrap();
