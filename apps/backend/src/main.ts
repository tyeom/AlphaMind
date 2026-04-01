import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { createWinstonLogger } from './common/logger.config';

async function bootstrap() {
  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
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

  await app.listen(PORT, HOST);
  console.log(`App is running at http://${HOST}:${PORT}`);
}
bootstrap();
