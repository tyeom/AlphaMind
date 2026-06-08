import { SignalDirection } from '@alpha-mind/strategies';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
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

  it('persists and reads market regime hysteresis state as JSON', async () => {
    const tmpDir = await fs.mkdtemp('/tmp/market-regime-');
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

function scanResult(stockCode: string, rankScore: number) {
  return {
    stockCode,
    stockName: stockCode,
    sector: 'tech',
    bestStrategy: { strategyId: 'day-trading', strategyName: 'day' },
    totalReturnPct: 1,
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
