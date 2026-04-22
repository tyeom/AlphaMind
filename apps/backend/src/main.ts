import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { createWinstonLogger } from './common/logger.config';
import { BACKEND_EVENTS_EXCHANGE } from './rmq/rmq.module';

function getBackendEventQueueName(): string {
  const rawInstanceId =
    process.env.BACKEND_INSTANCE_ID ||
    process.env.HOSTNAME ||
    process.env.HOST ||
    'local';
  const instanceId = rawInstanceId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${BACKEND_EVENTS_EXCHANGE}.${instanceId}.${process.pid}`;
}

async function bootstrap() {
  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  const RMQ_URL =
    process.env.RMQ_URL || 'amqp://alpha:alpha1234@localhost:5672';
  const backendEventQueue = getBackendEventQueueName();
  const logger = createWinstonLogger('backend');
  const app = await NestFactory.create(AppModule, { logger });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api');

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Alpha Mind API')
    .setDescription('Alpha Mind 백엔드 API 문서')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/swagger', app, document);

  // 모든 API에 Bearer 인증 전역 적용
  document.security = [{ bearer: [] }];
  SwaggerModule.setup('swagger', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  // market-data-service로부터 스캔 완료/실패 이벤트를 수신하기 위한 RMQ listener
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [RMQ_URL],
      queue: backendEventQueue,
      queueOptions: {
        durable: false,
        autoDelete: true,
      },
      exchange: BACKEND_EVENTS_EXCHANGE,
      exchangeType: 'topic',
      wildcards: true,
      noAck: true,
    },
  });

  await app.startAllMicroservices();
  await app.listen(PORT, HOST);
  console.log(`App is running at http://${HOST}:${PORT}`);
  console.log(
    `RabbitMQ microservice listening on exchange: ${BACKEND_EVENTS_EXCHANGE} (queue: ${backendEventQueue})`,
  );
}
bootstrap();
