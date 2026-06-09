import { ConfigService } from '@nestjs/config';
import { StockService } from './stock.service';

describe('StockService survivorship retention', () => {
  const createService = (
    stocks: any[],
    config: Record<string, unknown> = {
      SURVIVORSHIP_RETAIN_DELISTED: true,
    },
  ) => {
    const fork = {
      find: jest.fn().mockResolvedValue(stocks),
      flush: jest.fn().mockResolvedValue(undefined),
      nativeDelete: jest.fn().mockResolvedValue(0),
    };
    const em = {
      fork: jest.fn(() => fork),
    };
    const cacheManager = {
      del: jest.fn().mockResolvedValue(undefined),
    };
    const configService = {
      get: jest.fn((key: string) => config[key]),
    } as unknown as ConfigService;
    const service = new StockService(
      em as any,
      {} as any,
      cacheManager as any,
      configService,
    );

    return { service, fork, cacheManager };
  };

  it('does nothing when the toggle is off', async () => {
    const { service, fork } = createService([], {
      SURVIVORSHIP_RETAIN_DELISTED: false,
    });

    await (service as any).reconcileDelistings(new Set(['005930']));

    expect(fork.find).not.toHaveBeenCalled();
    expect(fork.flush).not.toHaveBeenCalled();
  });

  it('resets present stocks and marks only the fifth consecutive CSV miss', async () => {
    const lastSeen = new Date('2026-06-01T00:00:00.000Z');
    const stocks = [
      {
        code: 'PRESENT',
        missingFromCsvDays: 4,
        delistedAt: new Date('2026-05-01T00:00:00.000Z'),
        lastSeenInCsvAt: lastSeen,
      },
      {
        code: 'MISSING',
        missingFromCsvDays: 4,
        lastSeenInCsvAt: lastSeen,
      },
      {
        code: 'FOUR_DAYS',
        missingFromCsvDays: 3,
        lastSeenInCsvAt: lastSeen,
      },
    ];
    const { service, fork } = createService(stocks);

    await (service as any).reconcileDelistings(
      new Set(['PRESENT', 'NEW_1', 'NEW_2']),
    );

    expect(stocks[0].missingFromCsvDays).toBe(0);
    expect(stocks[0].delistedAt).toBeNull();
    expect(stocks[1].missingFromCsvDays).toBe(5);
    expect(stocks[1].delistedAt).toEqual(lastSeen);
    expect(stocks[2].missingFromCsvDays).toBe(4);
    expect(stocks[2].delistedAt).toBeUndefined();
    expect(fork.flush).toHaveBeenCalledTimes(1);
  });

  it('automatically recovers a stock that reappears before or after marking', async () => {
    const stocks = [
      {
        code: 'RELISTED',
        missingFromCsvDays: 5,
        delistedAt: new Date('2026-05-01T00:00:00.000Z'),
        lastSeenInCsvAt: new Date('2026-05-01T00:00:00.000Z'),
      },
    ];
    const { service } = createService(stocks);

    await (service as any).reconcileDelistings(new Set(['RELISTED']));

    expect(stocks[0].missingFromCsvDays).toBe(0);
    expect(stocks[0].delistedAt).toBeNull();
    expect(stocks[0].lastSeenInCsvAt).toBeInstanceOf(Date);
  });

  it('clears a four-day miss without ever marking the stock', async () => {
    const stocks = [
      {
        code: 'TEMPORARY_MISS',
        missingFromCsvDays: 4,
        lastSeenInCsvAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ];
    const { service } = createService(stocks);

    await (service as any).reconcileDelistings(new Set(['TEMPORARY_MISS']));

    expect(stocks[0].missingFromCsvDays).toBe(0);
    expect(stocks[0].delistedAt).toBeNull();
  });

  it('skips all mutations when the CSV universe drops below half', async () => {
    const stocks = [
      {
        code: 'MISSING',
        missingFromCsvDays: 4,
        lastSeenInCsvAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ];
    const { service, fork } = createService(stocks);
    (service as any).lastHealthyCsvCount = 100;

    await (service as any).reconcileDelistings(
      new Set(Array.from({ length: 49 }, (_, index) => `S${index}`)),
    );

    expect(stocks[0].missingFromCsvDays).toBe(4);
    expect(fork.flush).not.toHaveBeenCalled();
  });

  it('freezes delisted prices inside retention and prunes only older rows', async () => {
    const stocks = [
      {
        code: 'DELISTED',
        delistedAt: new Date('2026-05-01T00:00:00.000Z'),
      },
    ];
    const { service, fork } = createService(stocks, {
      SURVIVORSHIP_RETAIN_DELISTED: true,
      DELISTED_RETENTION_MONTHS: 12,
    });

    await (service as any).pruneExpiredDelistedPrices();

    expect(fork.find).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ delistedAt: { $ne: null } }),
    );
    expect(fork.nativeDelete).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        stock: stocks[0],
        date: { $lt: expect.any(Date) },
      }),
    );
  });
});
