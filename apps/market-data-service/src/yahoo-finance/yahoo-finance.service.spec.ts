import { YahooFinanceService } from './yahoo-finance.service';

describe('YahooFinanceService', () => {
  let service: YahooFinanceService;

  beforeEach(() => {
    service = new YahooFinanceService();
  });

  describe('getChart', () => {
    it('should fetch 1Y chart data for 004690.KS (삼천리)', async () => {
      const result = await service.getChart('004690.KS', '1y', '1d');

      expect(result.symbol).toBe('004690.KS');
      expect(result.currency).toBe('KRW');
      expect(result.name).toBeDefined();
      expect(result.candles.length).toBeGreaterThan(200);

      const firstCandle = result.candles[0];
      expect(firstCandle.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(firstCandle.open).toBeGreaterThan(0);
      expect(firstCandle.high).toBeGreaterThan(0);
      expect(firstCandle.low).toBeGreaterThan(0);
      expect(firstCandle.close).toBeGreaterThan(0);
      expect(firstCandle.volume).toBeGreaterThanOrEqual(0);

      console.log(`Symbol: ${result.symbol}`);
      console.log(`Name: ${result.name}`);
      console.log(`Exchange: ${result.exchange}`);
      console.log(`Total candles: ${result.candles.length}`);
      console.log(`First: ${firstCandle.date} O=${firstCandle.open} H=${firstCandle.high} L=${firstCandle.low} C=${firstCandle.close} V=${firstCandle.volume}`);
      const lastCandle = result.candles[result.candles.length - 1];
      console.log(`Last:  ${lastCandle.date} O=${lastCandle.open} H=${lastCandle.high} L=${lastCandle.low} C=${lastCandle.close} V=${lastCandle.volume}`);
    }, 15000);

    it('should fetch 1Y chart data for 005930.KS (삼성전자)', async () => {
      const result = await service.getChart('005930.KS', '1y', '1d');

      expect(result.symbol).toBe('005930.KS');
      expect(result.currency).toBe('KRW');
      expect(result.candles.length).toBeGreaterThan(200);

      console.log(`Symbol: ${result.symbol}`);
      console.log(`Name: ${result.name}`);
      console.log(`Total candles: ${result.candles.length}`);
    }, 15000);

    it('should throw error for invalid symbol', async () => {
      await expect(service.getChart('INVALID_SYMBOL_XYZ', '1y', '1d')).rejects.toThrow();
    }, 15000);
  });
});
