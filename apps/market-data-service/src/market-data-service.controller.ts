import { Controller, Get } from '@nestjs/common';
import { MarketDataServiceService } from './market-data-service.service';

@Controller()
export class MarketDataServiceController {
  constructor(private readonly marketDataServiceService: MarketDataServiceService) {}

  @Get()
  getHello(): string {
    return this.marketDataServiceService.getHello();
  }
}
