import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';

export const BACKEND_SERVICE = 'BACKEND_SERVICE';
export const BACKEND_EVENTS_EXCHANGE = 'backend_events';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: BACKEND_SERVICE,
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RMQ_URL')!],
            queue: BACKEND_EVENTS_EXCHANGE,
            queueOptions: { durable: false },
            exchange: BACKEND_EVENTS_EXCHANGE,
            exchangeType: 'topic',
            wildcards: true,
          },
        }),
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class RmqModule {}
