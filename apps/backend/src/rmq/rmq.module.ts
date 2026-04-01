import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';

export const MARKET_DATA_SERVICE = 'MARKET_DATA_SERVICE';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: MARKET_DATA_SERVICE,
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RMQ_URL')!],
            queue: 'market_data_queue',
            queueOptions: { durable: true },
          },
        }),
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class RmqModule {}
