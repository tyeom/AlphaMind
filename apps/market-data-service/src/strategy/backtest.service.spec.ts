import { SignalDirection } from '@alpha-mind/strategies';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BacktestService } from './backtest.service';
import type { BacktestConfig, BacktestResult } from './types/backtest.types';

function candle(day: number, close: number, high = close, low = close) {
  return {
    date: new Date(`2026-01-${String(day).padStart(2, '0')}`),
    open: close,
    high,
    low,
    close,
    volume: 100_000,
  };
}

describe('BacktestService simulate', () => {
  const stock = { code: '005930', name: '삼성전자' } as any;
  const createService = (sellTaxPct = 0.15) => {
    const configService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'BACKTEST_SELL_TAX_PCT') return sellTaxPct;
        return defaultValue;
      }),
    } as unknown as ConfigService;

    return new BacktestService({} as any, {} as any, configService);
  };
  const baseConfig: BacktestConfig = {
    strategyId: 'day-trading',
    investmentAmount: 1_000_000,
    tradeRatioPct: 100,
    commissionPct: 0,
    autoTakeProfitPct: 2.5,
    autoStopLossPct: -3,
    maxHoldingDays: 7,
    // simulate() mechanic 검증이 목적인 테스트이므로
    // 비용/슬리피지는 0, 매수는 신호봉 종가에 즉시 체결로 단순화한다.
    sellTaxPct: 0,
    slippagePct: 0,
    useNextOpenForBuy: false,
  };

  it('uses daily high/low for automatic take profit', () => {
    const service = createService();
    const candles = [candle(1, 100), candle(2, 101, 103, 99)];
    const signals = new Map([
      [
        '2026-01-01',
        {
          direction: SignalDirection.Buy,
          strength: 0.7,
          reason: 'buy',
          date: candles[0].date,
          price: 100,
        },
      ],
    ]);

    const result = (service as any).simulate(
      stock,
      candles,
      signals,
      baseConfig,
      'test',
    );

    const sell = result.trades.find(
      (trade: any) => trade.direction === SignalDirection.Sell,
    );
    expect(sell.price).toBeCloseTo(102.5);
    expect(sell.reason).toContain('자동 익절');
  });

  it('reduces only the scale-out quantity when the TP1 ladder is enabled', () => {
    const service = createService();
    const candles = [candle(1, 100), candle(2, 102, 102, 101)];
    const signals = new Map([
      [
        '2026-01-01',
        {
          direction: SignalDirection.Buy,
          strength: 0.7,
          reason: 'buy',
          date: candles[0].date,
          price: 100,
        },
      ],
    ]);

    const result = (service as any).simulate(
      stock,
      candles,
      signals,
      {
        ...baseConfig,
        scaleOut: {
          enabled: true,
          tiers: [{ triggerPct: 2, sellRatioPct: 50, tag: 'TP1' }],
        },
      },
      'test',
    );

    const sells = result.trades.filter(
      (trade: any) => trade.direction === SignalDirection.Sell,
    );
    expect(sells).toHaveLength(1);
    expect(sells[0].partial).toBe(true);
    expect(sells[0].quantity).toBe(5_000);
    expect(result.remainingQuantity).toBe(5_000);
  });

  it('uses runner parameters after partial scale-out instead of legacy trailing values', () => {
    const service = createService();
    const candles = [
      candle(1, 100),
      candle(2, 102, 102, 101),
      candle(3, 101, 103, 101),
    ];
    const signals = new Map([
      [
        '2026-01-01',
        {
          direction: SignalDirection.Buy,
          strength: 0.7,
          reason: 'buy',
          date: candles[0].date,
          price: 100,
        },
      ],
    ]);

    const result = (service as any).simulate(
      stock,
      candles,
      signals,
      {
        ...baseConfig,
        scaleOut: {
          enabled: true,
          tiers: [{ triggerPct: 2, sellRatioPct: 50, tag: 'TP1' }],
        },
      },
      'test',
    );

    const sells = result.trades.filter(
      (trade: any) => trade.direction === SignalDirection.Sell,
    );
    expect(sells).toHaveLength(1);
    expect(sells[0].reason).toContain('TP1');
    expect(result.remainingQuantity).toBe(5_000);
  });

  it('can stop out the remaining runner on the same gap scale-out candle', () => {
    const service = createService();
    const candles = [candle(1, 100), candle(2, 102, 103, 97)];
    const signals = new Map([
      [
        '2026-01-01',
        {
          direction: SignalDirection.Buy,
          strength: 0.7,
          reason: 'buy',
          date: candles[0].date,
          price: 100,
        },
      ],
    ]);

    const result = (service as any).simulate(
      stock,
      candles,
      signals,
      {
        ...baseConfig,
        scaleOut: {
          enabled: true,
          tiers: [{ triggerPct: 2, sellRatioPct: 50, tag: 'TP1' }],
        },
      },
      'test',
    );

    const sells = result.trades.filter(
      (trade: any) => trade.direction === SignalDirection.Sell,
    );
    expect(sells).toHaveLength(2);
    expect(sells[0].partial).toBe(true);
    expect(sells[1].reason).toContain('부분익절 후 손절');
    expect(result.remainingQuantity).toBe(0);
  });

  it('uses R-based quantity for first-entry backtest buys when enabled', () => {
    const service = createService();
    const candles = [candle(1, 100)];
    const signals = new Map([
      [
        '2026-01-01',
        {
          direction: SignalDirection.Buy,
          strength: 0.7,
          reason: 'buy',
          date: candles[0].date,
          price: 100,
        },
      ],
    ]);

    const result = (service as any).simulate(
      stock,
      candles,
      signals,
      {
        ...baseConfig,
        autoStopLossPct: -2,
        rSizing: { enabled: true, riskPct: 0.5 },
      },
      'test',
    );

    const buy = result.trades.find(
      (trade: any) => trade.direction === SignalDirection.Buy,
    );
    expect(buy.quantity).toBe(2_500);
  });

  it('falls back to legacy backtest quantity when R stop-loss risk is invalid', () => {
    const service = createService();
    const candles = [candle(1, 100)];
    const signals = new Map([
      [
        '2026-01-01',
        {
          direction: SignalDirection.Buy,
          strength: 0.7,
          reason: 'buy',
          date: candles[0].date,
          price: 100,
        },
      ],
    ]);

    const result = (service as any).simulate(
      stock,
      candles,
      signals,
      {
        ...baseConfig,
        autoStopLossPct: 0,
        rSizing: { enabled: true, riskPct: 0.5 },
      },
      'test',
    );

    const buy = result.trades.find(
      (trade: any) => trade.direction === SignalDirection.Buy,
    );
    expect(buy.quantity).toBe(10_000);
  });

  it('closes positions at max holding days when thresholds are not hit', () => {
    const service = createService();
    const candles = Array.from({ length: 8 }, (_, i) =>
      candle(i + 1, 100 + i * 0.1, 100 + i * 0.1 + 0.1, 99.5),
    );
    const signals = new Map([
      [
        '2026-01-01',
        {
          direction: SignalDirection.Buy,
          strength: 0.7,
          reason: 'buy',
          date: candles[0].date,
          price: 100,
        },
      ],
    ]);

    const result = (service as any).simulate(
      stock,
      candles,
      signals,
      baseConfig,
      'test',
    );

    const sell = result.trades.find(
      (trade: any) => trade.direction === SignalDirection.Sell,
    );
    expect(sell.date).toEqual(candles[7].date);
    expect(sell.reason).toContain('최대 보유기간 7일');
  });

  it('applies trailing stop in the backtest simulation', () => {
    const service = createService();
    const candles = [candle(1, 100), candle(2, 101.1, 102, 101.1)];
    const signals = new Map([
      [
        '2026-01-01',
        {
          direction: SignalDirection.Buy,
          strength: 0.7,
          reason: 'buy',
          date: candles[0].date,
          price: 100,
        },
      ],
    ]);

    const result = (service as any).simulate(
      stock,
      candles,
      signals,
      {
        ...baseConfig,
        autoTakeProfitPct: 99,
        autoStopLossPct: -99,
      },
      'test',
    );

    const sell = result.trades.find(
      (trade: any) => trade.direction === SignalDirection.Sell,
    );
    expect(sell.price).toBeCloseTo(101.184);
    expect(sell.reason).toContain('트레일링 스톱');
  });

  it('uses the configured max holding days value', () => {
    const service = createService();
    const candles = Array.from({ length: 4 }, (_, i) =>
      candle(i + 1, 100 + i * 0.1, 100 + i * 0.1 + 0.1, 99.5),
    );
    const signals = new Map([
      [
        '2026-01-01',
        {
          direction: SignalDirection.Buy,
          strength: 0.7,
          reason: 'buy',
          date: candles[0].date,
          price: 100,
        },
      ],
    ]);

    const result = (service as any).simulate(
      stock,
      candles,
      signals,
      { ...baseConfig, maxHoldingDays: 3 },
      'test',
    );

    const sell = result.trades.find(
      (trade: any) => trade.direction === SignalDirection.Sell,
    );
    expect(sell.date).toEqual(candles[3].date);
    expect(sell.reason).toContain('최대 보유기간 3일');
  });

  it('keeps infinity-bot low-strength round buys and add-on buys enabled by default', () => {
    const service = createService();
    const candles = [candle(1, 100), candle(2, 110)];
    const signals = new Map([
      [
        '2026-01-01',
        {
          direction: SignalDirection.Buy,
          strength: 0.32,
          reason: '1차 매수',
          date: candles[0].date,
          price: 100,
        },
      ],
      [
        '2026-01-02',
        {
          direction: SignalDirection.Buy,
          strength: 0.34,
          reason: '2차 매수',
          date: candles[1].date,
          price: 110,
        },
      ],
    ]);

    const result = (service as any).simulate(
      stock,
      candles,
      signals,
      {
        ...baseConfig,
        strategyId: 'infinity-bot',
        tradeRatioPct: 50,
        autoTakeProfitPct: 99,
        autoStopLossPct: -99,
        maxHoldingDays: 0,
      },
      'test',
    );

    const buys = result.trades.filter(
      (trade: any) => trade.direction === SignalDirection.Buy,
    );
    expect(buys).toHaveLength(2);
  });

  it('uses BACKTEST_SELL_TAX_PCT when config does not specify sellTaxPct', () => {
    const service = createService(0.15);
    const candles = [candle(1, 100), candle(2, 100, 101, 99)];
    const signals = new Map([
      [
        '2026-01-01',
        {
          direction: SignalDirection.Buy,
          strength: 0.7,
          reason: 'buy',
          date: candles[0].date,
          price: 100,
        },
      ],
    ]);

    const result = (service as any).simulate(
      stock,
      candles,
      signals,
      {
        ...baseConfig,
        autoTakeProfitPct: 1,
        autoStopLossPct: -99,
        sellTaxPct: undefined,
      },
      'test',
    );

    const sell = result.trades.find(
      (trade: any) => trade.direction === SignalDirection.Sell,
    );
    expect(sell.sellTax).toBeCloseTo(1515);
  });

  it('prioritizes explicit config.sellTaxPct over BACKTEST_SELL_TAX_PCT', () => {
    const service = createService(0.15);
    const candles = [candle(1, 100), candle(2, 100, 101, 99)];
    const signals = new Map([
      [
        '2026-01-01',
        {
          direction: SignalDirection.Buy,
          strength: 0.7,
          reason: 'buy',
          date: candles[0].date,
          price: 100,
        },
      ],
    ]);

    const result = (service as any).simulate(
      stock,
      candles,
      signals,
      {
        ...baseConfig,
        autoTakeProfitPct: 1,
        autoStopLossPct: -99,
        sellTaxPct: 0.2,
      },
      'test',
    );

    const sell = result.trades.find(
      (trade: any) => trade.direction === SignalDirection.Sell,
    );
    expect(sell.sellTax).toBeCloseTo(2020);
  });

  it('adds bounded RVOL bonus to scan rank score', () => {
    const service = createService();
    const baseResult = {
      totalReturnPct: 5,
      winRate: 50,
      totalTrades: 4,
      maxDrawdownPct: 1,
      remainingQuantity: 0,
    } as BacktestResult;
    const tradeQuality = {
      profitFactor: 1.5,
      expectancyPct: 0.2,
      avgWinPnl: 0,
      avgLossPnl: 0,
      payoffRatio: 0,
    };

    const withoutRvol = (service as any).calculateScanRankScore(
      baseResult,
      0.7,
      tradeQuality,
      { passed: true, reasons: [], lastClose: 100 },
    );
    const withRvol = (service as any).calculateScanRankScore(
      baseResult,
      0.7,
      tradeQuality,
      { passed: true, reasons: [], lastClose: 100, rvol: 3.5 },
    );

    expect(withRvol - withoutRvol).toBeCloseTo(1);
  });

  it('selects every sector Top 1 before adding a sector Top 2 candidate', () => {
    const service = createService();
    const candidates = [
      scanResult('TECH-1', 10, 'tech', 20),
      scanResult('TECH-2', 9, 'tech', 19),
      scanResult('BIO-1', 8, 'bio', 10),
      scanResult('BIO-2', 7, 'bio', 9),
      scanResult('FIN-1', 6, 'finance', 5),
    ];

    const selected = (service as any).selectTopScanResults(candidates, 4, {
      sectorTopOneFirst: true,
    });

    expect(selected.map((result: any) => result.stockCode)).toEqual([
      'TECH-1',
      'BIO-1',
      'FIN-1',
      'TECH-2',
    ]);
  });

  it('computes breadth from all eligible stocks, not only scan pass results', async () => {
    const stocks = [
      { id: 1, code: 'AAA', name: 'AAA', sector: 'tech' },
      { id: 2, code: 'BBB', name: 'BBB', sector: 'tech' },
      { id: 3, code: 'CCC', name: 'CCC', sector: 'bio' },
    ];
    const knex = createKnexMock([
      stocks.map((s) => ({ stock_id: s.id })),
      stocks.flatMap((s) => priceRows(s.id, 100 + s.id)),
    ]);
    const em = {
      find: jest.fn().mockResolvedValue(stocks),
      getKnex: () => knex,
      clear: jest.fn(),
    };
    const service = new BacktestService(
      em as any,
      {} as any,
      createConfigService(),
    );
    (service as any).writeMarketRegimeState = jest.fn();
    (service as any).scanSingleStock = jest.fn((stock: any) =>
      stock.code === 'AAA' ? scanResult('AAA', 3) : null,
    );

    const response = await service.scanAllStocks(
      [],
      10,
      1_000_000,
      10,
      0.015,
      2,
      -2,
      7,
      0.65,
      3,
      {},
      { regimeEnabled: true, regimeOptions: { minBreadthSample: 1 } },
    );

    expect(response.results).toHaveLength(1);
    expect(response.regime?.breadth.universeCount).toBe(3);
  });

  it('builds mixed candidate and active-position correlation clusters', async () => {
    const stocks = [
      { id: 1, code: 'AAA', name: 'AAA', sector: 'tech' },
      { id: 2, code: 'BBB', name: 'BBB', sector: 'bio' },
    ];
    const candidateRows = [
      ...priceRows(1, 100),
      ...priceRows(2, 200, (i) => (i % 2 === 0 ? 1 : -1)),
    ];
    const activeRows = priceRows(99, 100).map((row) => ({
      code: 'ZZZ',
      date: row.date,
      close: row.close,
    }));
    const knex = createKnexMock([
      stocks.map((s) => ({ stock_id: s.id })),
      candidateRows,
      activeRows,
    ]);
    const em = {
      find: jest.fn().mockResolvedValue(stocks),
      getKnex: () => knex,
      clear: jest.fn(),
    };
    const service = new BacktestService(
      em as any,
      {} as any,
      createConfigService(),
    );
    (service as any).scanSingleStock = jest.fn((stock: any) =>
      scanResult(stock.code, stock.code === 'AAA' ? 3 : 2),
    );

    const response = await service.scanAllStocks(
      [],
      10,
      1_000_000,
      10,
      0.015,
      2,
      -2,
      7,
      0.65,
      3,
      {},
      {
        correlationEnabled: true,
        correlationCodes: ['ZZZ'],
        correlationLookbackDays: 60,
        correlationOptions: { minOverlap: 10, threshold: 0.8 },
      },
    );

    expect(response.results.find((r) => r.stockCode === 'AAA')?.clusterId).toBe(
      1,
    );
    expect(response.results.find((r) => r.stockCode === 'BBB')?.clusterId).toBe(
      undefined,
    );
    expect(response.clusters).toEqual([
      { clusterId: 1, codes: ['AAA', 'ZZZ'], size: 2 },
    ]);
  });

  it('keeps the toggle-off scan JSON byte-identical while still calculating caveat metadata', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const stocks = [{ id: 1, code: 'AAA', name: 'AAA', sector: 'tech' }];
    const knex = createKnexMock([[{ stock_id: 1 }], priceRows(1, 100)]);
    const em = {
      find: jest.fn().mockResolvedValue(stocks),
      getKnex: () => knex,
      clear: jest.fn(),
    };
    const service = new BacktestService(
      em as any,
      {} as any,
      createConfigService({
        SURVIVORSHIP_RETAIN_DELISTED: false,
      }),
    );
    (service as any).scanSingleStock = jest.fn(() => scanResult('AAA', 3));

    const response = await service.scanAllStocks([], 10, 1_000_000, 10, 0.015);

    expect(response.survivorshipBias).toEqual(
      expect.objectContaining({
        universeSize: 1,
        delistedRetained: 0,
        estimatedReturnHaircutPct: 0.5,
      }),
    );
    expect(Object.keys(response)).not.toContain('survivorshipBias');
    expect(JSON.stringify(response)).toMatchInlineSnapshot(
      `"{"scannedStocks":1,"eligibleStocks":1,"excludedStocks":0,"elapsedMs":0,"results":[{"stockCode":"AAA","stockName":"AAA","sector":"tech","bestStrategy":{"strategyId":"day-trading","strategyName":"day"},"totalReturnPct":1,"winRate":50,"maxDrawdownPct":1,"totalTrades":3,"rankScore":3,"finalValue":1010000,"investmentAmount":1000000,"volatilityPct":3,"summary":"test","currentSignal":{"direction":"BUY","strength":0.8,"reason":"test"},"indicators":{}}]}"`,
    );
    nowSpy.mockRestore();
  });

  it('excludes retained delisted stocks from the default buy scan', async () => {
    const stocks = [
      { id: 1, code: 'ACTIVE', name: 'ACTIVE', sector: 'tech' },
      {
        id: 2,
        code: 'DELISTED',
        name: 'DELISTED',
        sector: 'bio',
        delistedAt: new Date('2026-03-10T00:00:00.000Z'),
      },
    ];
    const knex = createKnexMock([
      stocks.map((stock) => ({ stock_id: stock.id })),
      priceRows(1, 100),
    ]);
    const em = {
      find: jest.fn().mockResolvedValue(stocks),
      getKnex: () => knex,
      clear: jest.fn(),
    };
    const service = new BacktestService(
      em as any,
      {} as any,
      createConfigService(),
    );
    (service as any).scanSingleStock = jest.fn((stock: any) =>
      scanResult(stock.code, 3),
    );

    const response = await service.scanAllStocks([], 10, 1_000_000, 10, 0.015);

    expect(response.eligibleStocks).toBe(1);
    expect(response.results.map((result) => result.stockCode)).toEqual([
      'ACTIVE',
    ]);
  });

  it('includes a retained stock when it was listed through the backtest window end', async () => {
    const stocks = [
      { id: 1, code: 'ACTIVE', name: 'ACTIVE', sector: 'tech' },
      {
        id: 2,
        code: 'DELISTED',
        name: 'DELISTED',
        sector: 'bio',
        delistedAt: new Date('2026-03-10T00:00:00.000Z'),
      },
    ];
    const knex = createKnexMock([
      stocks.map((stock) => ({ stock_id: stock.id })),
      [...priceRows(1, 100), ...priceRows(2, 200)],
    ]);
    const em = {
      find: jest.fn().mockResolvedValue(stocks),
      getKnex: () => knex,
      clear: jest.fn(),
    };
    const service = new BacktestService(
      em as any,
      {} as any,
      createConfigService({
        SURVIVORSHIP_RETAIN_DELISTED: true,
        SCAN_INCLUDE_DELISTED_FOR_BACKTEST: true,
      }),
    );
    (service as any).scanSingleStock = jest.fn((stock: any) =>
      scanResult(stock.code, stock.code === 'ACTIVE' ? 3 : 2),
    );

    const response = await service.scanAllStocks([], 10, 1_000_000, 10, 0.015);

    expect(response.eligibleStocks).toBe(2);
    expect(response.results.map((result) => result.stockCode)).toEqual([
      'ACTIVE',
      'DELISTED',
    ]);
    expect(JSON.stringify(response)).toContain('"survivorshipBias"');
    expect(response.survivorshipBias?.note).toContain('소급 복구 불가');
    expect(response.survivorshipBias?.note).toContain('131거래일');
    expect(response.survivorshipBias?.note).toContain('낙관 편향');
  });

  it('calculates deterministic survivorship caveat assumptions without changing returns', () => {
    const service = new BacktestService(
      {} as any,
      {} as any,
      createConfigService({
        SURVIVORSHIP_ASSUMED_DELIST_RATE_ANNUAL: 0.04,
        AVG_DELIST_LOSS_FRACTION: 0.25,
      }),
    );

    const estimate = (service as any).estimateSurvivorshipBias([
      { delistedAt: null },
      { delistedAt: new Date('2026-06-01T00:00:00.000Z') },
    ]);

    expect(estimate).toEqual({
      universeSize: 2,
      delistedRetained: 1,
      assumedAnnualDelistRate: 0.04,
      estimatedReturnHaircutPct: 0.5,
      researchAnchor: 'CAGR 26%→12%(모멘텀, 외부)',
      note: expect.stringContaining('성과 수치에서는 차감하지 않음'),
    });
  });

  it('builds at most three anchored folds with no look-ahead for 131 candles', () => {
    const service = new BacktestService(
      {} as any,
      {} as any,
      createConfigService({
        ROLLING_WF_ENABLED: true,
        WF_MAX_FOLDS: 3,
      }),
    );

    const folds = (service as any).buildWalkForwardFolds(131);

    expect(folds).toHaveLength(3);
    expect(folds[folds.length - 1].oosEnd).toBe(131);
    for (const fold of folds) {
      expect(fold.inSampleStart).toBe(0);
      expect(fold.inSampleEnd).toBe(fold.oosStart);
      expect(fold.oosEnd).toBeGreaterThan(fold.oosStart);
    }
  });

  it('keeps the rolling-WF toggle-off fold byte-identical to the legacy split', () => {
    const service = new BacktestService(
      {} as any,
      {} as any,
      createConfigService({ ROLLING_WF_ENABLED: false }),
    );

    const folds = (service as any).buildWalkForwardFolds(131);

    expect(JSON.stringify(folds)).toMatchInlineSnapshot(
      `"[{"foldIndex":0,"inSampleStart":0,"inSampleEnd":87,"oosStart":87,"oosEnd":131}]"`,
    );
  });

  it('aggregates OOS folds by compounded return, summed trades, and worst drawdown', () => {
    const service = createService();
    const aggregated = (service as any).aggregateBacktestResults([
      backtestResult({ totalReturnPct: 10, totalTrades: 2, winTrades: 1, maxDrawdownPct: 3 }),
      backtestResult({ totalReturnPct: -5, totalTrades: 3, winTrades: 2, maxDrawdownPct: 7 }),
    ]);

    expect(aggregated.totalReturnPct).toBe(4.5);
    expect(aggregated.totalTrades).toBe(5);
    expect(aggregated.winTrades).toBe(3);
    expect(aggregated.winRate).toBe(60);
    expect(aggregated.maxDrawdownPct).toBe(7);
  });

  it('uses aggregate OOS without requiring every valid fold to be profitable', () => {
    const service = new BacktestService(
      {} as any,
      {} as any,
      createConfigService({
        ROLLING_WF_ENABLED: true,
        WF_MAX_FOLDS: 3,
        WF_MIN_VALID_FOLDS: 2,
      }),
    );
    const simulate = jest
      .fn()
      .mockReturnValueOnce(backtestResult({ totalReturnPct: 1, totalTrades: 5 }))
      .mockReturnValueOnce(backtestResult({ totalReturnPct: 2, totalTrades: 2 }))
      .mockReturnValueOnce(backtestResult({ totalReturnPct: 1, totalTrades: 5 }))
      .mockReturnValueOnce(backtestResult({ totalReturnPct: -1, totalTrades: 2 }))
      .mockReturnValueOnce(backtestResult({ totalReturnPct: 1, totalTrades: 5 }))
      .mockReturnValueOnce(backtestResult({ totalReturnPct: 3, totalTrades: 2 }));
    (service as any).simulate = simulate;

    const evaluation = (service as any).simulateWalkForwardRun(
      { code: 'AAA', name: 'AAA' },
      wfCandles(131),
      new Map(),
      baseConfig,
      'test',
    );

    expect(evaluation.folds).toHaveLength(3);
    expect(evaluation.outOfSample.totalTrades).toBe(6);
    expect(evaluation.outOfSample.totalReturnPct).toBeCloseTo(4.01);
    expect(evaluation.wfConsistency).toBe(0.667);
    expect(evaluation.usedFallback).toBe(false);
  });

  it('falls back to the legacy split when fewer than two WF folds are valid', () => {
    const service = new BacktestService(
      {} as any,
      {} as any,
      createConfigService({
        ROLLING_WF_ENABLED: true,
        WF_MAX_FOLDS: 3,
        WF_MIN_VALID_FOLDS: 2,
      }),
    );
    const simulate = jest
      .fn()
      .mockReturnValueOnce(backtestResult({ totalReturnPct: 1, totalTrades: 5 }))
      .mockReturnValueOnce(backtestResult({ totalReturnPct: 2, totalTrades: 2 }))
      .mockReturnValueOnce(backtestResult({ totalReturnPct: 1, totalTrades: 5 }))
      .mockReturnValueOnce(backtestResult({ totalReturnPct: 1, totalTrades: 1 }))
      .mockReturnValueOnce(backtestResult({ totalReturnPct: 1, totalTrades: 4 }))
      .mockReturnValueOnce(backtestResult({ totalReturnPct: 3, totalTrades: 5 }))
      .mockReturnValueOnce(backtestResult({ totalReturnPct: 4, totalTrades: 2 }));
    (service as any).simulate = simulate;

    const evaluation = (service as any).simulateWalkForwardRun(
      { code: 'AAA', name: 'AAA' },
      wfCandles(131),
      new Map(),
      baseConfig,
      'test',
    );

    expect(evaluation.usedFallback).toBe(true);
    expect(evaluation.folds).toHaveLength(1);
    expect(evaluation.outOfSample.totalReturnPct).toBe(4);
  });

  it('reuses the same walk-forward evaluator in scan and grid paths', () => {
    const service = createService();
    const inSample = backtestResult({ totalReturnPct: 1, totalTrades: 5 });
    const outOfSample = backtestResult({
      totalReturnPct: 2,
      totalTrades: 2,
      winTrades: 2,
      maxDrawdownPct: 1,
    });
    const walkForward = jest.fn().mockReturnValue({
      inSample,
      outOfSample,
      folds: [],
      wfConsistency: 1,
      rollingEnabled: true,
      usedFallback: false,
    });
    (service as any).simulateWalkForwardRun = walkForward;
    (service as any).passesOosQuality = jest.fn(() => true);

    const stock = { id: 1, code: 'AAA', name: 'AAA' };
    const prices = wfCandles(131);
    (service as any).scanSingleStock(
      stock,
      new Map([[1, prices]]),
      1_000_000,
      10,
      0.015,
      2,
      -2,
      7,
      0,
      0,
    );
    expect(walkForward).toHaveBeenCalled();

    walkForward.mockClear();
    const gridResult = (service as any).evaluateStockGridPoint(
      stock,
      prices,
      [
        {
          strategyId: 'day-trading',
          strategyName: 'day',
          signalByDate: new Map(),
        },
      ],
      2,
      -2,
      1_000_000,
      100,
      0.015,
      7,
    );

    expect(walkForward).toHaveBeenCalledTimes(1);
    expect(gridResult).toEqual({
      oosReturnPct: 2,
      oosWinRate: 100,
      oosDrawdownPct: 1,
      oosTrades: 2,
    });
  });

  it('backtests with fixed TP/SL (no ATR adjustment) when forceFixedTpSl is true', () => {
    const service = createService();
    const walkForward = jest.fn().mockReturnValue({
      inSample: backtestResult({ totalReturnPct: 1, totalTrades: 5 }),
      outOfSample: backtestResult({
        totalReturnPct: 2,
        totalTrades: 2,
        winTrades: 2,
        maxDrawdownPct: 1,
      }),
      folds: [],
      wfConsistency: 1,
      rollingEnabled: false,
      usedFallback: false,
    });
    (service as any).simulateWalkForwardRun = walkForward;
    (service as any).passesOosQuality = jest.fn(() => true);

    const stock = { id: 1, code: 'AAA', name: 'AAA' };
    const prices = wfCandles(131);
    // forceFixedTpSl=true (12번째 인자) → ATR 보정 없이 입력 고정 TP/SL 을 그대로 백테스트해야 함
    (service as any).scanSingleStock(
      stock,
      new Map([[1, prices]]),
      1_000_000,
      10,
      0.015,
      1,
      -2,
      7,
      0,
      0,
      {},
      true,
    );

    // 검증↔실전 정합: 백테스트 config 의 TP/SL 이 입력 고정값과 정확히 일치(ATR 보정 안 됨).
    const cfg = walkForward.mock.calls[0][3];
    expect(cfg.autoTakeProfitPct).toBe(1);
    expect(cfg.autoStopLossPct).toBe(-2);
  });

  it('persists and reads market regime hysteresis state as JSON', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'market-regime-'));
    const service = createService();
    (service as any).marketRegimeStatePath = path.join(
      tmpDir,
      'market_regime_state.json',
    );

    await (service as any).writeMarketRegimeState({
      label: 'ATTACK',
      rawScore: 0.8,
      smoothedScore: 0.7,
      slotMultiplier: 1,
      amountMultiplier: 1,
      breadth: {
        universeCount: 100,
        aboveSma20Ratio: 0.8,
        aboveSma60Ratio: 0.75,
        medianDailyReturnPct: 0.2,
        medianRet5dPct: 3,
        medianAtrPct: 2,
      },
      source: 'breadth',
    });

    const state = await (service as any).readMarketRegimeState();
    expect(state).toEqual(
      expect.objectContaining({
        prevSmoothedScore: 0.7,
        prevLabel: 'ATTACK',
      }),
    );

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

function createConfigService(values: Record<string, unknown> = {}) {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      if (key in values) return values[key];
      return defaultValue;
    }),
  } as unknown as ConfigService;
}

function createThenableBuilder(result: unknown[]) {
  const builder: any = {
    select: jest.fn(() => builder),
    count: jest.fn(() => builder),
    where: jest.fn(() => builder),
    groupBy: jest.fn(() => builder),
    having: jest.fn(() => builder),
    whereIn: jest.fn(() => builder),
    andWhere: jest.fn(() => builder),
    orderBy: jest.fn(() => builder),
    join: jest.fn(() => builder),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function createKnexMock(results: unknown[][]) {
  let idx = 0;
  const knex = jest.fn(() => createThenableBuilder(results[idx++] ?? [])) as any;
  knex.raw = jest.fn((sql: string) => sql);
  return knex;
}

function priceRows(
  stockId: number,
  base: number,
  delta: number | ((idx: number) => number) = 1,
) {
  return Array.from({ length: 60 }, (_, idx) => {
    const step = typeof delta === 'function' ? delta(idx) : delta;
    const close = base + idx * step;
    return {
      stock_id: stockId,
      date: new Date(2026, 0, idx + 1),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100_000,
    };
  });
}

function scanResult(
  stockCode: string,
  rankScore: number,
  sector = 'tech',
  totalReturnPct = 1,
) {
  return {
    stockCode,
    stockName: stockCode,
    sector,
    bestStrategy: { strategyId: 'day-trading', strategyName: 'day' },
    totalReturnPct,
    winRate: 50,
    maxDrawdownPct: 1,
    totalTrades: 3,
    rankScore,
    finalValue: 1_010_000,
    investmentAmount: 1_000_000,
    volatilityPct: 3,
    summary: 'test',
    currentSignal: { direction: 'BUY', strength: 0.8, reason: 'test' },
    indicators: {},
  };
}

function wfCandles(length: number) {
  return Array.from({ length }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 5_000_000,
  }));
}

function backtestResult(
  overrides: Partial<BacktestResult> = {},
): BacktestResult {
  const totalTrades = overrides.totalTrades ?? 2;
  const winTrades = overrides.winTrades ?? totalTrades;
  const lossTrades = overrides.lossTrades ?? totalTrades - winTrades;

  return {
    stockCode: 'AAA',
    stockName: 'AAA',
    strategyId: 'day-trading',
    strategyName: 'day',
    period: {
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-02-01T00:00:00.000Z'),
    },
    investmentAmount: 1_000_000,
    finalValue: 1_010_000,
    totalReturnPct: 1,
    totalRealizedPnl: 10_000,
    unrealizedPnl: 0,
    totalTrades,
    winTrades,
    lossTrades,
    winRate: totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0,
    maxDrawdownPct: 1,
    remainingCash: 1_010_000,
    remainingQuantity: 0,
    trades: [],
    ...overrides,
  };
}
