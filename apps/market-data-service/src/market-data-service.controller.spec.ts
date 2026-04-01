import { Test, TestingModule } from '@nestjs/testing';
import { MarketDataServiceController } from './market-data-service.controller';
import { MarketDataServiceService } from './market-data-service.service';

describe('MarketDataServiceController', () => {
  let marketDataServiceController: MarketDataServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [MarketDataServiceController],
      providers: [MarketDataServiceService],
    }).compile();

    marketDataServiceController = app.get<MarketDataServiceController>(MarketDataServiceController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(marketDataServiceController.getHello()).toBe('Hello World!');
    });
  });
});
