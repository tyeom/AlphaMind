import { YahooFinanceService } from './yahoo-finance.service';

describe('YahooFinanceService', () => {
  let service: YahooFinanceService;

  beforeEach(() => {
    service = new YahooFinanceService();
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const symbol = decodeURIComponent(
        String(url).split('/chart/')[1]?.split('?')[0] ?? '',
      );

      if (symbol === 'INVALID_SYMBOL_XYZ') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            chart: {
              result: null,
              error: { description: 'No data found' },
            },
          }),
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => buildYahooChartResponse(symbol),
      } as Response;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
    }, 15000);

    it('should fetch 1Y chart data for 005930.KS (삼성전자)', async () => {
      const result = await service.getChart('005930.KS', '1y', '1d');

      expect(result.symbol).toBe('005930.KS');
      expect(result.currency).toBe('KRW');
      expect(result.candles.length).toBeGreaterThan(200);
    }, 15000);

    it('should throw error for invalid symbol', async () => {
      await expect(service.getChart('INVALID_SYMBOL_XYZ', '1y', '1d')).rejects.toThrow();
    }, 15000);
  });
});

function buildYahooChartResponse(symbol: string) {
  const length = 230;
  const timestamp = Array.from({ length }, (_, i) =>
    Math.floor(Date.UTC(2025, 0, 2 + i) / 1000),
  );
  const open = Array.from({ length }, (_, i) => 50000 + i * 10);
  const close = open.map((value) => value + 100);
  const high = close.map((value) => value + 200);
  const low = open.map((value) => value - 200);
  const volume = Array.from({ length }, (_, i) => 100000 + i);

  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            currency: 'KRW',
            fullExchangeName: 'Korea Exchange',
            longName: symbol === '005930.KS' ? 'Samsung Electronics' : 'Samchully',
          },
          timestamp,
          indicators: {
            quote: [{ open, high, low, close, volume }],
            adjclose: [{ adjclose: close }],
          },
        },
      ],
      error: null,
    },
  };
}
