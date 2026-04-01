import { Controller, Get, Param, Query } from '@nestjs/common';
import { YahooFinanceService } from './yahoo-finance.service';
import { ChartInterval, ChartRange, StockChartData } from './yahoo-finance.types';

@Controller('yahoo-finance')
export class YahooFinanceController {
  constructor(private readonly yahooFinanceService: YahooFinanceService) {}

  @Get('chart/:symbol')
  async getChart(
    @Param('symbol') symbol: string,
    @Query('range') range: ChartRange = '1y',
    @Query('interval') interval: ChartInterval = '1d',
  ): Promise<StockChartData> {
    return this.yahooFinanceService.getChart(symbol, range, interval);
  }
}
