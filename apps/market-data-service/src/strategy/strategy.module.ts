import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Stock } from '../stock/entities/stock.entity';
import { StockDailyPrice } from '../stock/entities/stock-daily-price.entity';
import { RmqModule } from '../rmq/rmq.module';
import { StrategyController } from './strategy.controller';
import { StrategyService } from './strategy.service';
import { BacktestService } from './backtest.service';
import { OptimalParamsService } from './optimal-params.service';
import { WeeklyOptimizerService } from './weekly-optimizer.service';

@Module({
  imports: [MikroOrmModule.forFeature([Stock, StockDailyPrice]), RmqModule],
  controllers: [StrategyController],
  providers: [
    StrategyService,
    BacktestService,
    OptimalParamsService,
    WeeklyOptimizerService,
  ],
  exports: [StrategyService, BacktestService, OptimalParamsService],
})
export class StrategyModule {}
