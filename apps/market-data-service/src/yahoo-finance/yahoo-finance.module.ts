import { Module } from '@nestjs/common';
import { YahooFinanceController } from './yahoo-finance.controller';
import { YahooFinanceService } from './yahoo-finance.service';

@Module({
  controllers: [YahooFinanceController],
  providers: [YahooFinanceService],
  exports: [YahooFinanceService],
})
export class YahooFinanceModule {}
