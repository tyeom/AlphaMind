import { SignalDirection } from '@alpha-mind/strategies';
import { BacktestService } from './backtest.service';
import type { BacktestConfig } from './types/backtest.types';

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
    const service = new BacktestService({} as any);
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

  it('closes positions at max holding days when thresholds are not hit', () => {
    const service = new BacktestService({} as any);
    const candles = Array.from({ length: 8 }, (_, i) =>
      candle(i + 1, 100 + i * 0.1, 101, 99),
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

  it('uses the configured max holding days value', () => {
    const service = new BacktestService({} as any);
    const candles = Array.from({ length: 4 }, (_, i) =>
      candle(i + 1, 100 + i * 0.1, 101, 99),
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
    const service = new BacktestService({} as any);
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
});
