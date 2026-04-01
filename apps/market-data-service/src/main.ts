import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { MarketDataServiceModule } from './market-data-service.module';
import { createWinstonLogger } from './common/logger.config';

async function bootstrap() {
  const PORT = process.env.PORT || 3001;
  const HOST = process.env.HOST || '0.0.0.0';
  const RMQ_URL = process.env.RMQ_URL || 'amqp://alpha:alpha1234@localhost:5672';
  const logger = createWinstonLogger('market-data-service');
  const app = await NestFactory.create(MarketDataServiceModule, { logger });

  // RabbitMQ 마이크로서비스 리스너
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [RMQ_URL],
      queue: 'market_data_queue',
      queueOptions: { durable: true },
    },
  });

  await app.startAllMicroservices();
  await app.listen(PORT, HOST);
  console.log(`App is running at http://${HOST}:${PORT}`);
  console.log(`RabbitMQ microservice listening on queue: market_data_queue`);
}
bootstrap();
