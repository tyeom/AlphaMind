import { SignalDirection } from '@alpha-mind/strategies';
import { ConfigService } from '@nestjs/config';
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
});
