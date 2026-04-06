import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { KisModule } from '../kis/kis.module';
import { RmqModule } from '../rmq/rmq.module';
import { AutoTradingController } from './auto-trading.controller';
import { AutoTradingService } from './auto-trading.service';
import { AutoTradingGateway } from './auto-trading.gateway';
import { AutoTradingSessionEntity } from './entities/auto-trading-session.entity';

@Module({
  imports: [
    KisModule,
    RmqModule,
    MikroOrmModule.forFeature([AutoTradingSessionEntity]),
  ],
  controllers: [AutoTradingController],
  providers: [AutoTradingService, AutoTradingGateway],
  exports: [AutoTradingService],
})
export class AutoTradingModule {}
