import { CandleData, DayTradingVariant, MeanReversionVariant, SignalDirection } from '../types/strategy.types';
import { calculateSMA, calculateRSI, calculateBollingerBands, calculateATR } from '../indicators/technical-indicators';
import { analyzeDayTrading } from './day-trading.strategy';
import { analyzeMeanReversion } from './mean-reversion.strategy';
import { analyzeInfinityBot } from './infinity-bot.strategy';
import { analyzeCandlePattern } from './candle-pattern.strategy';

// 3개월(약 60거래일) 모의 데이터 생성
function generateMockCandles(days: number = 60, startPrice: number = 50000): CandleData[] {
  const candles: CandleData[] = [];
  let price = startPrice;
  const baseDate = new Date('2026-01-02');

  for (let i = 0; i < days; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);

    // 랜덤 변동 (-3% ~ +3%)
    const change = (Math.random() - 0.48) * 0.06; // 약간 상승 편향
    const open = price;
    const close = price * (1 + change);
    const high = Math.max(open, close) * (1 + Math.random() * 0.02);
    const low = Math.min(open, close) * (1 - Math.random() * 0.02);
    const volume = Math.floor(100000 + Math.random() * 900000);

    candles.push({
      date,
      open: Math.round(open),
      high: Math.round(high),
      low: Math.round(low),
      close: Math.round(close),
      volume,
    });

    price = close;
  }

  return candles;
}

// 하락 추세 데이터 (무한매수봇/평균회귀 테스트용)
function generateDowntrendCandles(days: number = 60, startPrice: number = 50000): CandleData[] {
  const candles: CandleData[] = [];
  let price = startPrice;
  const baseDate = new Date('2026-01-02');

  for (let i = 0; i < days; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);

    // 전반부 하락, 후반부 반등
    const phase = i / days;
    let change: number;
    if (phase < 0.6) {
      change = -0.005 - Math.random() * 0.015; // -0.5% ~ -2%
    } else {
      change = 0.005 + Math.random() * 0.02; // +0.5% ~ +2.5%
    }

    const open = price;
    const close = price * (1 + change);
    const high = Math.max(open, close) * (1 + Math.random() * 0.01);
    const low = Math.min(open, close) * (1 - Math.random() * 0.01);
    const volume = Math.floor(100000 + Math.random() * 500000);

    candles.push({
      date,
      open: Math.round(open),
      high: Math.round(high),
      low: Math.round(low),
      close: Math.round(close),
      volume,
    });

    price = close;
  }

  return candles;
}

describe('Technical Indicators', () => {
  test('SMA 계산 정확성', () => {
    const prices = [10, 20, 30, 40, 50];
    const sma3 = calculateSMA(prices, 3);

    expect(sma3[0]).toBeNull();
    expect(sma3[1]).toBeNull();
    expect(sma3[2]).toBeCloseTo(20); // (10+20+30)/3
    expect(sma3[3]).toBeCloseTo(30); // (20+30+40)/3
    expect(sma3[4]).toBeCloseTo(40); // (30+40+50)/3
  });

  test('SMA 결과 길이는 입력과 동일', () => {
    const prices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = calculateSMA(prices, 5);
    expect(result.length).toBe(prices.length);
  });

  test('RSI 계산: 모두 상승이면 100', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i * 10);
    const rsi = calculateRSI(prices, 14);
    const lastRsi = rsi[rsi.length - 1];
    expect(lastRsi).toBe(100);
  });

  test('RSI 계산: 모두 하락이면 0', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 200 - i * 10);
    const rsi = calculateRSI(prices, 14);
    const lastRsi = rsi[rsi.length - 1];
    expect(lastRsi).toBe(0);
  });

  test('RSI 결과 길이는 입력과 동일', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 10);
    const result = calculateRSI(prices, 14);
    expect(result.length).toBe(prices.length);
  });

  test('볼린저 밴드: upper > middle > lower', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i * 0.5) * 10);
    const bb = calculateBollingerBands(prices, 20, 2);
    const lastBB = bb[bb.length - 1];

    expect(lastBB).not.toBeNull();
    expect(lastBB!.upper).toBeGreaterThan(lastBB!.middle);
    expect(lastBB!.middle).toBeGreaterThan(lastBB!.lower);
    expect(lastBB!.bandwidth).toBeGreaterThan(0);
  });

  test('ATR 계산: 결과 길이 확인', () => {
    const candles = generateMockCandles(30);
    const atr = calculateATR(candles, 14);
    expect(atr.length).toBe(candles.length);
    expect(atr[0]).toBeNull();
    // 14번째 이후부터는 값이 있어야 함
    expect(atr[15]).not.toBeNull();
    expect(atr[15]!).toBeGreaterThan(0);
  });
});

describe('Day Trading Strategy', () => {
  const candles = generateMockCandles(60);

  test('Breakout 전략: 결과 구조 확인', () => {
    const result = analyzeDayTrading(candles, { variant: DayTradingVariant.Breakout });

    expect(result.strategyName).toContain('변동성 돌파');
    expect(result.analyzedPeriod.from).toEqual(candles[0].date);
    expect(result.analyzedPeriod.to).toEqual(candles[candles.length - 1].date);
    expect(result.currentSignal).toBeDefined();
    expect(result.currentSignal.direction).toBeDefined();
    expect(result.currentSignal.strength).toBeGreaterThanOrEqual(0);
    expect(result.currentSignal.strength).toBeLessThanOrEqual(1);
    expect(result.summary).toBeTruthy();
  });

  test('Crossover 전략: SMA 지표 포함', () => {
    const result = analyzeDayTrading(candles, { variant: DayTradingVariant.Crossover });

    expect(result.strategyName).toContain('SMA 크로스오버');
    expect(result.indicators).toHaveProperty('currentShortSMA');
    expect(result.indicators).toHaveProperty('currentLongSMA');
    expect(result.indicators).toHaveProperty('smaSpread');
  });

  test('Volume Surge 전략: 볼륨/RSI 지표 포함', () => {
    const result = analyzeDayTrading(candles, { variant: DayTradingVariant.VolumeSurge });

    expect(result.strategyName).toContain('거래량 급증');
    expect(result.indicators).toHaveProperty('currentRSI');
    expect(result.indicators).toHaveProperty('currentVolume');
    expect(result.indicators).toHaveProperty('avgVolume');
  });

  test('신호 방향은 유효한 값만 포함', () => {
    const result = analyzeDayTrading(candles);
    const validDirections = [SignalDirection.Buy, SignalDirection.Sell, SignalDirection.Neutral];

    for (const signal of result.signals) {
      expect(validDirections).toContain(signal.direction);
      expect(signal.strength).toBeGreaterThanOrEqual(0);
      expect(signal.strength).toBeLessThanOrEqual(1);
      expect(signal.reason).toBeTruthy();
    }
  });
});

describe('Mean Reversion Strategy', () => {
  const candles = generateDowntrendCandles(60);

  test('RSI 전략: 과매도/과매수 판단', () => {
    const result = analyzeMeanReversion(candles, { variant: MeanReversionVariant.RSI });

    expect(result.strategyName).toContain('RSI');
    expect(result.indicators).toHaveProperty('currentRSI');
    expect(result.indicators).toHaveProperty('rsiZone');
  });

  test('Bollinger 전략: 밴드 값 포함', () => {
    const result = analyzeMeanReversion(candles, { variant: MeanReversionVariant.Bollinger });

    expect(result.strategyName).toContain('볼린저');
    expect(result.indicators).toHaveProperty('currentBands');
    expect(result.indicators).toHaveProperty('bandwidth');
    expect(result.indicators).toHaveProperty('pricePosition');
  });

  test('Grid 전략: 그리드 라인 포함', () => {
    const result = analyzeMeanReversion(candles, { variant: MeanReversionVariant.Grid });

    expect(result.strategyName).toContain('그리드');
    expect(result.indicators).toHaveProperty('basePrice');
    expect(result.indicators).toHaveProperty('gridLines');
    expect(result.indicators).toHaveProperty('priceFromBase');
  });

  test('Magic Split 전략: 분할 레벨 상태 추적', () => {
    const result = analyzeMeanReversion(candles, { variant: MeanReversionVariant.MagicSplit });

    expect(result.strategyName).toContain('매직 분할');
    expect(result.indicators).toHaveProperty('levels');
    expect(result.indicators).toHaveProperty('currentDropPct');
    expect(result.indicators).toHaveProperty('basePrice');
  });
});

describe('Infinity Bot Strategy', () => {
  test('하락→반등 시나리오: 매수 라운드 생성', () => {
    const candles = generateDowntrendCandles(60);
    const result = analyzeInfinityBot(candles, {
      totalAmount: 10_000_000,
      maxRounds: 50,
      roundPct: 2,
      dipTriggerPct: 2,
      takeProfitPct: 3,
    });

    expect(result.strategyName).toContain('무한매수봇');
    expect(result.simulation).toBeDefined();
    expect(result.simulation.rounds.length).toBeGreaterThanOrEqual(1);
    expect(result.simulation.investedAmount).toBeGreaterThan(0);
    expect(result.simulation.totalQuantity).toBeGreaterThan(0);
  });

  test('시뮬레이션 상태 일관성', () => {
    const candles = generateDowntrendCandles(60);
    const result = analyzeInfinityBot(candles);

    expect(result.simulation.currentRound).toBeGreaterThanOrEqual(0);
    expect(result.simulation.currentRound).toBeLessThanOrEqual(50);

    if (result.simulation.avgPrice != null) {
      expect(result.simulation.avgPrice).toBeGreaterThan(0);
      expect(result.simulation.currentReturn).not.toBeNull();
    }
  });

  test('maxRounds 제한 준수', () => {
    const candles = generateDowntrendCandles(100, 50000);
    const result = analyzeInfinityBot(candles, { maxRounds: 5, dipTriggerPct: 0.5 });

    expect(result.simulation.currentRound).toBeLessThanOrEqual(5);
  });
});

describe('Candle Pattern Strategy', () => {
  test('패턴 인식 결과 구조 확인', () => {
    const candles = generateMockCandles(60);
    const result = analyzeCandlePattern(candles);

    expect(result.strategyName).toContain('캔들 패턴');
    expect(result.indicators).toHaveProperty('totalPatternsDetected');
    expect(result.indicators).toHaveProperty('recentPatterns');
    expect(result.indicators).toHaveProperty('patternStats');
  });

  test('Bullish Engulfing 감지', () => {
    const baseDate = new Date('2026-01-02');
    const candles: CandleData[] = [
      // 20개의 하락 추세 캔들 (트렌드 형성용)
      ...Array.from({ length: 20 }, (_, i) => ({
        date: new Date(baseDate.getTime() + i * 86400000),
        open: 50000 - i * 200,
        high: 50000 - i * 200 + 100,
        low: 50000 - i * 200 - 500,
        close: 50000 - i * 200 - 400,
        volume: 200000,
      })),
      // 음봉
      {
        date: new Date(baseDate.getTime() + 20 * 86400000),
        open: 46200,
        high: 46300,
        low: 45500,
        close: 45600,
        volume: 300000,
      },
      // Bullish Engulfing 양봉 (전봉을 완전히 감쌈)
      {
        date: new Date(baseDate.getTime() + 21 * 86400000),
        open: 45400,
        high: 46500,
        low: 45300,
        close: 46400,
        volume: 500000,
      },
    ];

    const result = analyzeCandlePattern(candles, {
      minPatternStrength: 0.3,
      useVolumeConfirmation: true,
      useTrendConfirmation: true,
    });

    const engulfing = result.signals.find(
      (s) => s.metadata?.patternType === 'BullishEngulfing',
    );
    expect(engulfing).toBeDefined();
    expect(engulfing!.direction).toBe(SignalDirection.Buy);
  });

  test('신호 강도는 0~1 범위', () => {
    const candles = generateMockCandles(60);
    const result = analyzeCandlePattern(candles);

    for (const signal of result.signals) {
      expect(signal.strength).toBeGreaterThanOrEqual(0);
      expect(signal.strength).toBeLessThanOrEqual(1);
    }
  });
});

describe('Edge Cases', () => {
  test('최소 데이터(1개 캔들)로 전략 실행', () => {
    const candle: CandleData = {
      date: new Date('2026-01-02'),
      open: 50000,
      high: 51000,
      low: 49000,
      close: 50500,
      volume: 100000,
    };

    const dayResult = analyzeDayTrading([candle]);
    expect(dayResult.currentSignal.direction).toBe(SignalDirection.Neutral);

    const mrResult = analyzeMeanReversion([candle]);
    expect(mrResult.currentSignal.direction).toBe(SignalDirection.Neutral);

    const ibResult = analyzeInfinityBot([candle]);
    expect(ibResult.simulation.rounds.length).toBeGreaterThanOrEqual(0);

    const cpResult = analyzeCandlePattern([candle]);
    expect(cpResult).toBeDefined();
  });

  test('동일 가격 데이터', () => {
    const candles: CandleData[] = Array.from({ length: 30 }, (_, i) => ({
      date: new Date(new Date('2026-01-02').getTime() + i * 86400000),
      open: 50000,
      high: 50000,
      low: 50000,
      close: 50000,
      volume: 100000,
    }));

    const result = analyzeDayTrading(candles);
    expect(result).toBeDefined();
    expect(result.currentSignal).toBeDefined();

    const mrResult = analyzeMeanReversion(candles);
    expect(mrResult).toBeDefined();
  });
});
