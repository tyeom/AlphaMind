import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { KisModule } from '../kis/kis.module';
import { RmqModule } from '../rmq/rmq.module';
import { NotificationModule } from '../notification/notification.module';
import { AutoTradingController } from './auto-trading.controller';
import { AutoTradingService } from './auto-trading.service';
import { AutoTradingGateway } from './auto-trading.gateway';
import { ScheduledScannerService } from './scheduled-scanner.service';
import { AutoTradingSessionEntity } from './entities/auto-trading-session.entity';

@Module({
  imports: [
    KisModule,
    RmqModule,
    NotificationModule,
    MikroOrmModule.forFeature([AutoTradingSessionEntity]),
  ],
  controllers: [AutoTradingController],
  providers: [AutoTradingService, AutoTradingGateway, ScheduledScannerService],
  exports: [AutoTradingService],
})
export class AutoTradingModule {}
