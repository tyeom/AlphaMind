import {
  SignalDirection,
  isFreshSignal,
  pickFreshCurrentSignal,
  pickFreshStrongestSignal,
} from '@alpha-mind/strategies';
import type { CandleData, Signal } from '@alpha-mind/strategies';

function candle(date: string, close = 100): CandleData {
  return {
    date: new Date(date),
    open: close,
    high: close,
    low: close,
    close,
    volume: 100_000,
  };
}

function signal(
  date: string,
  direction: SignalDirection,
  strength: number,
): Signal {
  return {
    date: new Date(date),
    direction,
    strength,
    reason: `${direction} ${strength}`,
    price: 100,
  };
}

describe('Signal freshness', () => {
  it('treats the previous trading candle as fresh across weekends', () => {
    const candles = [
      candle('2026-05-15'), // 금요일
      candle('2026-05-18'), // 월요일
    ];
    const fridaySignal = signal('2026-05-15', SignalDirection.Buy, 0.8);

    // 캘린더로는 3일 차이지만, 실제 캔들 기준으로는 직전 거래일이므로 fresh.
    expect(
      isFreshSignal(fridaySignal, candles[1], { tradingDates: candles }),
    ).toBe(true);
  });

  it('keeps current signal latest while scan selector can choose strongest fresh buy', () => {
    const candles = [candle('2026-05-19'), candle('2026-05-20')];
    const signals = [
      signal('2026-05-19', SignalDirection.Buy, 0.9),
      signal('2026-05-20', SignalDirection.Sell, 0.2),
    ];

    const current = pickFreshCurrentSignal(
      signals,
      candles[1],
      undefined,
      undefined,
      { tradingDates: candles },
    );
    const scanBuy = pickFreshStrongestSignal(
      signals,
      candles[1],
      SignalDirection.Buy,
      { tradingDates: candles },
    );

    expect(current.direction).toBe(SignalDirection.Sell);
    expect(scanBuy?.direction).toBe(SignalDirection.Buy);
    expect(scanBuy?.strength).toBe(0.9);
  });
});
