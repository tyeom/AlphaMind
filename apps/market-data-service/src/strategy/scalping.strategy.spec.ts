import {
  CandleData,
  ScalpingVariant,
  SignalDirection,
  analyzeScalping,
  countConsecutiveDownCandles,
  getStrategyExitProfile,
  getStrategyTradeMeta,
} from '@alpha-mind/strategies';

/** 결정적 지그재그 상승 워밍업 — RSI14 과열(>=78)을 피하면서 우상향 */
function buildUptrendWarmup(
  days: number,
  startPrice: number,
  baseVolume = 100_000,
): CandleData[] {
  const candles: CandleData[] = [];
  let price = startPrice;
  const baseDate = new Date('2026-01-05');

  for (let i = 0; i < days; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);

    // +1.4% / -0.6% 교차 → 뚜렷한 순상승(SMA20 대비 여유) + RSI14 ≈ 70 (<78)
    const change = i % 2 === 0 ? 0.014 : -0.006;
    const open = price;
    const close = price * (1 + change);
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;

    candles.push({
      date,
      open: Math.round(open),
      high: Math.round(high),
      low: Math.round(low),
      close: Math.round(close),
      volume: baseVolume,
    });
    price = close;
  }

  return candles;
}

function appendCandle(
  candles: CandleData[],
  candle: Omit<CandleData, 'date'>,
): CandleData[] {
  const last = candles[candles.length - 1];
  const date = new Date(last.date);
  date.setDate(date.getDate() + 1);
  return [...candles, { date, ...candle }];
}

/** 눌림목 셋업: 상승 추세 → 3일 조정(거래량 수축) → 5일선 터치 반전 양봉 */
function buildPullbackSetup(): CandleData[] {
  let candles = buildUptrendWarmup(30, 11_000);
  const peak = candles[candles.length - 1].close; // ≈ 12,900대

  // 단기 고점 명시 (intraday high 가 lookback 최대가 되도록)
  candles = appendCandle(candles, {
    open: peak,
    high: Math.round(peak * 1.012),
    low: Math.round(peak * 0.998),
    close: Math.round(peak * 1.008),
    volume: 100_000,
  });
  const top = candles[candles.length - 1].close;

  // 3일 완만한 조정 — 종가 하락 + 거래량 수축 (종가는 SMA20 위 유지).
  // 가운데 날은 종가가 내려가는 작은 양봉으로 두어 연속 음봉 조건(rsi_snapback)이
  // 전일에 발화하지 않게 한다 → ensemble 단독(solo) 경로를 결정적으로 검증.
  let p = top;
  {
    const d1Close = Math.round(p * 0.994);
    candles = appendCandle(candles, {
      open: p,
      high: Math.round(p * 1.002),
      low: Math.round(d1Close * 0.997),
      close: d1Close,
      volume: 80_000,
    });
    const d2Open = Math.round(d1Close * 0.994);
    const d2Close = Math.round(d1Close * 0.996); // 양봉이지만 종가는 하락
    candles = appendCandle(candles, {
      open: d2Open,
      high: Math.round(d1Close * 0.998),
      low: Math.round(d2Open * 0.997),
      close: d2Close,
      volume: 80_000,
    });
    const d3Close = Math.round(d2Close * 0.992);
    candles = appendCandle(candles, {
      open: d2Close,
      high: Math.round(d2Close * 1.002),
      low: Math.round(d3Close * 0.997),
      close: d3Close,
      volume: 80_000,
    });
    p = d3Close;
  }

  // 반전 양봉: 저가가 5일선 부근까지 찍고 윗쪽 마감 (신고가는 아님 → gap 미발화)
  const open = Math.round(p * 0.995);
  const low = Math.round(p * 0.985);
  const close = Math.round(p * 1.008);
  const high = Math.round(p * 1.012);
  candles = appendCandle(candles, { open, high, low, close, volume: 90_000 });

  return candles;
}

/** RSI 스냅백 셋업: 상승 추세 → 3연속 음봉(소폭) — RSI3 = 0, 종가는 20일선 위 유지 */
function buildSnapbackSetup(): CandleData[] {
  let candles = buildUptrendWarmup(30, 11_000);
  let p = candles[candles.length - 1].close;

  for (let i = 0; i < 3; i++) {
    // 소폭(-0.5%) 연속 음봉 — RSI3 = 0 이지만 종가는 SMA20 위 유지
    const close = Math.round(p * 0.995);
    candles = appendCandle(candles, {
      open: p,
      high: Math.round(p * 1.002),
      low: Math.round(close * 0.998),
      close,
      volume: 95_000,
    });
    p = close;
  }

  return candles;
}

/** 강종가 모멘텀 셋업: 거래량 급증 + 신고가 돌파 + 고가권 마감 */
function buildGapMomentumSetup(volume = 300_000): CandleData[] {
  let candles = buildUptrendWarmup(30, 11_000);
  const priorMaxClose = Math.max(...candles.map((c) => c.close));

  const close = Math.round(priorMaxClose * 1.01);
  const low = Math.round(priorMaxClose * 0.985);
  const high = Math.round(close * 1.004);
  const open = Math.round(priorMaxClose * 0.99);
  candles = appendCandle(candles, { open, high, low, close, volume });

  return candles;
}

/** 컨플루언스 셋업: 일중 5일선 터치(눌림) 후 신고가 마감(돌파) + 거래량 급증 */
function buildConfluenceSetup(): CandleData[] {
  let candles = buildUptrendWarmup(30, 11_000);
  const peak = candles[candles.length - 1].close;

  // 고점 형성 (intraday high 가 이후 low 대비 2~7% 위가 되도록)
  candles = appendCandle(candles, {
    open: peak,
    high: Math.round(peak * 1.012),
    low: Math.round(peak * 0.998),
    close: Math.round(peak * 1.005),
    volume: 100_000,
  });
  const top = candles[candles.length - 1].close;

  // 2일 얕은 조정
  let p = top;
  for (const dropPct of [0.004, 0.004]) {
    const close = Math.round(p * (1 - dropPct));
    candles = appendCandle(candles, {
      open: p,
      high: Math.round(p * 1.002),
      low: Math.round(close * 0.997),
      close,
      volume: 90_000,
    });
    p = close;
  }

  // 셰이크아웃 + 돌파: 저가는 5일선 아래로 흔들고 종가는 신고가, 거래량 3배
  const priorMaxClose = Math.max(
    ...candles.map((c) => c.close),
  );
  const priorMaxHigh = Math.max(...candles.slice(-10).map((c) => c.high));
  const close = Math.round(priorMaxClose * 1.005);
  const low = Math.round(priorMaxHigh * 0.965);
  const open = Math.round(p * 0.99);
  const high = Math.round(close * 1.005);
  return appendCandle(candles, { open, high, low, close, volume: 300_000 });
}

describe('analyzeScalping — 단타 스캘핑', () => {
  describe('pullback (눌림목)', () => {
    it('상승 추세 눌림 후 반전 양봉에서 BUY 신호를 낸다', () => {
      const candles = buildPullbackSetup();
      const result = analyzeScalping(candles, {
        variant: ScalpingVariant.Pullback,
      });

      const last = candles[candles.length - 1];
      const signal = result.signals.find(
        (s) => s.date.getTime() === last.date.getTime(),
      );
      expect(signal).toBeDefined();
      expect(signal!.direction).toBe(SignalDirection.Buy);
      expect(signal!.strength).toBeGreaterThanOrEqual(0.65);
      expect(signal!.strength).toBeLessThanOrEqual(0.95);
      expect(result.currentSignal.direction).toBe(SignalDirection.Buy);
    });

    it('추세 아래(종가 < SMA20)에서는 신호를 내지 않는다', () => {
      // 하락 추세: 매일 -1%
      const candles: CandleData[] = [];
      let price = 50_000;
      const baseDate = new Date('2026-01-05');
      for (let i = 0; i < 35; i++) {
        const date = new Date(baseDate);
        date.setDate(date.getDate() + i);
        const close = Math.round(price * 0.99);
        candles.push({
          date,
          open: Math.round(price),
          high: Math.round(price * 1.005),
          low: Math.round(close * 0.995),
          close,
          volume: 100_000,
        });
        price = close;
      }
      const result = analyzeScalping(candles, {
        variant: ScalpingVariant.Pullback,
      });
      expect(result.signals).toHaveLength(0);
      expect(result.currentSignal.direction).toBe(SignalDirection.Neutral);
    });
  });

  describe('rsi_snapback (RSI 스냅백)', () => {
    it('추세 위 연속 음봉 과매도에서 BUY 신호를 낸다', () => {
      const candles = buildSnapbackSetup();
      const result = analyzeScalping(candles, {
        variant: ScalpingVariant.RsiSnapback,
      });

      const last = candles[candles.length - 1];
      const signal = result.signals.find(
        (s) => s.date.getTime() === last.date.getTime(),
      );
      expect(signal).toBeDefined();
      expect(signal!.direction).toBe(SignalDirection.Buy);
      expect(signal!.strength).toBeGreaterThanOrEqual(0.65);
      expect(signal!.metadata?.consecutiveDown).toBeGreaterThanOrEqual(2);
    });

    it('하락 추세 폭락(종가 < SMA20)은 받지 않는다', () => {
      const candles: CandleData[] = [];
      let price = 50_000;
      const baseDate = new Date('2026-01-05');
      for (let i = 0; i < 35; i++) {
        const date = new Date(baseDate);
        date.setDate(date.getDate() + i);
        const close = Math.round(price * 0.985);
        candles.push({
          date,
          open: Math.round(price),
          high: Math.round(price * 1.002),
          low: Math.round(close * 0.997),
          close,
          volume: 100_000,
        });
        price = close;
      }
      const result = analyzeScalping(candles, {
        variant: ScalpingVariant.RsiSnapback,
      });
      expect(result.signals).toHaveLength(0);
    });
  });

  describe('gap_momentum (강종가 모멘텀)', () => {
    it('거래량 급증 + 신고가 돌파 + 고가권 마감에서 BUY 신호를 낸다', () => {
      const candles = buildGapMomentumSetup();
      const result = analyzeScalping(candles, {
        variant: ScalpingVariant.GapMomentum,
      });

      const last = candles[candles.length - 1];
      const signal = result.signals.find(
        (s) => s.date.getTime() === last.date.getTime(),
      );
      expect(signal).toBeDefined();
      expect(signal!.direction).toBe(SignalDirection.Buy);
      expect(signal!.metadata?.rvol).toBeGreaterThanOrEqual(1.8);
    });

    it('거래량이 평범하면(RVOL < 1.8) 신호를 내지 않는다', () => {
      const candles = buildGapMomentumSetup(120_000);
      const result = analyzeScalping(candles, {
        variant: ScalpingVariant.GapMomentum,
      });
      const last = candles[candles.length - 1];
      const signal = result.signals.find(
        (s) => s.date.getTime() === last.date.getTime(),
      );
      expect(signal).toBeUndefined();
    });

    it('당일 급등 과도(상한가 추격)는 차단한다', () => {
      let candles = buildUptrendWarmup(30, 11_000);
      const priorMaxClose = Math.max(...candles.map((c) => c.close));
      // +20% 급등 마감 — maxDailyGainPct(15) 초과
      const close = Math.round(priorMaxClose * 1.2);
      candles = appendCandle(candles, {
        open: Math.round(priorMaxClose * 1.02),
        high: Math.round(close * 1.002),
        low: Math.round(priorMaxClose * 1.01),
        close,
        volume: 500_000,
      });
      const result = analyzeScalping(candles, {
        variant: ScalpingVariant.GapMomentum,
      });
      const last = candles[candles.length - 1];
      const signal = result.signals.find(
        (s) => s.date.getTime() === last.date.getTime(),
      );
      expect(signal).toBeUndefined();
    });
  });

  describe('ensemble (혼합)', () => {
    const ENSEMBLE_CFG = { confluenceBoost: 0.1, soloDampen: 0.9 };

    it('단독 신호는 감쇠 배수를 적용한다', () => {
      const candles = buildPullbackSetup();
      const last = candles[candles.length - 1];

      const solo = analyzeScalping(candles, {
        variant: ScalpingVariant.Pullback,
      }).signals.find((s) => s.date.getTime() === last.date.getTime());
      const blended = analyzeScalping(candles, {
        variant: ScalpingVariant.Ensemble,
        ensemble: ENSEMBLE_CFG,
      }).signals.find((s) => s.date.getTime() === last.date.getTime());

      expect(solo).toBeDefined();
      expect(blended).toBeDefined();
      expect(blended!.strength).toBeCloseTo(
        solo!.strength * ENSEMBLE_CFG.soloDampen,
        5,
      );
      expect(blended!.metadata?.confluenceCount).toBe(1);
    });

    it('2개 이상 합의(컨플루언스) 시 강도를 가산한다', () => {
      const candles = buildConfluenceSetup();
      const last = candles[candles.length - 1];

      const subStrengths = [
        ScalpingVariant.Pullback,
        ScalpingVariant.RsiSnapback,
        ScalpingVariant.GapMomentum,
      ]
        .map((variant) =>
          analyzeScalping(candles, { variant }).signals.find(
            (s) => s.date.getTime() === last.date.getTime(),
          ),
        )
        .filter((s): s is NonNullable<typeof s> => s != null)
        .map((s) => s.strength);

      // 셋업 전제: 최소 2개 sub-variant 가 같은 날 발화해야 한다
      expect(subStrengths.length).toBeGreaterThanOrEqual(2);

      const blended = analyzeScalping(candles, {
        variant: ScalpingVariant.Ensemble,
        ensemble: ENSEMBLE_CFG,
      }).signals.find((s) => s.date.getTime() === last.date.getTime());

      expect(blended).toBeDefined();
      expect(blended!.reason).toContain('컨플루언스');
      expect(blended!.metadata?.confluenceCount).toBeGreaterThanOrEqual(2);
      expect(blended!.strength).toBeCloseTo(
        Math.min(
          Math.max(...subStrengths) + ENSEMBLE_CFG.confluenceBoost,
          0.95,
        ),
        5,
      );
    });

    it('전일 신호를 합의 증거로 인정한다 (어제 과매도 → 오늘 반전)', () => {
      // 스냅백 셋업에 반전 양봉을 덧붙이면: 전일 rsi_snapback + 당일 pullback
      let candles = buildSnapbackSetup();
      const p = candles[candles.length - 1].close;
      candles = appendCandle(candles, {
        open: Math.round(p * 0.995),
        high: Math.round(p * 1.012),
        low: Math.round(p * 0.985),
        close: Math.round(p * 1.008),
        volume: 90_000,
      });
      const last = candles[candles.length - 1];

      const blended = analyzeScalping(candles, {
        variant: ScalpingVariant.Ensemble,
        ensemble: ENSEMBLE_CFG,
      }).signals.find((s) => s.date.getTime() === last.date.getTime());

      // 당일 pullback 이 발화하고 전일 스냅백이 증거로 합산되면 컨플루언스
      if (blended) {
        expect(blended.metadata?.confluenceCount).toBeGreaterThanOrEqual(2);
        expect(blended.reason).toContain('전일');
      } else {
        // 당일 신호 자체가 없으면 합의도 없어야 한다 (구조 검증)
        const pullbackToday = analyzeScalping(candles, {
          variant: ScalpingVariant.Pullback,
        }).signals.find((s) => s.date.getTime() === last.date.getTime());
        expect(pullbackToday).toBeUndefined();
      }
    });
  });

  describe('공통 동작', () => {
    it('SELL 신호는 방출하지 않는다 (청산은 TP/SL 엔진 담당)', () => {
      for (const variant of Object.values(ScalpingVariant)) {
        for (const candles of [
          buildPullbackSetup(),
          buildSnapbackSetup(),
          buildGapMomentumSetup(),
        ]) {
          const result = analyzeScalping(candles, { variant });
          expect(
            result.signals.every(
              (s) => s.direction === SignalDirection.Buy,
            ),
          ).toBe(true);
        }
      }
    });

    it('lookahead 없음 — 모든 cut 에서 prefix 분석이 전체 분석과 양방향 일치한다', () => {
      const signalKey = (s: { date: Date; reason: string; strength: number }) =>
        `${s.date.toISOString()}|${s.reason}|${s.strength.toFixed(8)}`;

      const fixtures: Array<[CandleData[], ScalpingVariant]> = [
        [buildPullbackSetup(), ScalpingVariant.Pullback],
        [buildPullbackSetup(), ScalpingVariant.Ensemble],
        [buildSnapbackSetup(), ScalpingVariant.RsiSnapback],
        [buildSnapbackSetup(), ScalpingVariant.Ensemble],
        [buildGapMomentumSetup(), ScalpingVariant.GapMomentum],
      ];

      for (const [candles, variant] of fixtures) {
        const full = analyzeScalping(candles, { variant });
        expect(full.signals.length).toBeGreaterThan(0); // 검증이 공허하지 않게

        for (let cut = 23; cut <= candles.length; cut++) {
          const prefixCandles = candles.slice(0, cut);
          const prefix = analyzeScalping(prefixCandles, { variant });
          const lastDate = prefixCandles[prefixCandles.length - 1].date;
          const expected = full.signals.filter(
            (s) => s.date.getTime() <= lastDate.getTime(),
          );
          // prefix == full 의 해당 구간 (양방향 동일 — 누락도 추가도 없어야 한다)
          expect(prefix.signals.map(signalKey)).toEqual(
            expected.map(signalKey),
          );
        }
      }
    });

    it('rsi_snapback 의 trendSmaPeriod 설정이 실제로 반영된다', () => {
      const candles = buildSnapbackSetup();
      const last = candles[candles.length - 1];
      const withDefault = analyzeScalping(candles, {
        variant: ScalpingVariant.RsiSnapback,
      }).signals.find((s) => s.date.getTime() === last.date.getTime());
      // 연속 하락 직후 종가는 SMA5 아래 → 추세 기간을 5로 줄이면 신호가 사라져야 한다
      const withShortTrend = analyzeScalping(candles, {
        variant: ScalpingVariant.RsiSnapback,
        rsiSnapback: {
          rsiPeriod: 3,
          rsiOversold: 20,
          trendSmaPeriod: 5,
          minConsecutiveDownCandles: 2,
        },
      }).signals.find((s) => s.date.getTime() === last.date.getTime());

      expect(withDefault).toBeDefined();
      expect(withShortTrend).toBeUndefined();
    });

    it('RVOL 분모는 전일까지의 평균 거래량을 쓴다 (당일 급증 미포함)', () => {
      // 워밍업 100k 균일 + 신호일 300k → 전일 기준 평균 100k → RVOL 정확히 3.0
      const candles = buildGapMomentumSetup(300_000);
      const last = candles[candles.length - 1];
      const signal = analyzeScalping(candles, {
        variant: ScalpingVariant.GapMomentum,
      }).signals.find((s) => s.date.getTime() === last.date.getTime());
      expect(signal).toBeDefined();
      expect(signal!.metadata?.rvol as number).toBeCloseTo(3.0, 5);
    });

    it('미지의 variant 는 ensemble 로 정규화된다 (조용한 0신호 방지)', () => {
      const candles = buildConfluenceSetup();
      const unknown = analyzeScalping(candles, {
        variant: 'no-such-variant' as ScalpingVariant,
      });
      const ensemble = analyzeScalping(candles, {
        variant: ScalpingVariant.Ensemble,
      });
      expect(unknown.strategyName).toBe(ensemble.strategyName);
      expect(unknown.signals.map((s) => s.reason)).toEqual(
        ensemble.signals.map((s) => s.reason),
      );
      expect(unknown.signals.length).toBeGreaterThan(0);
    });

    it('캔들 수 부족 시 Neutral 을 반환하고 예외를 던지지 않는다', () => {
      const tiny = buildUptrendWarmup(10, 10_000);
      const result = analyzeScalping(tiny);
      expect(result.signals).toHaveLength(0);
      expect(result.currentSignal.direction).toBe(SignalDirection.Neutral);

      const empty = analyzeScalping([]);
      expect(empty.currentSignal.direction).toBe(SignalDirection.Neutral);
    });
  });
});

describe('scalping exit profile / trade meta', () => {
  it('variant 별 exit profile 부호와 보유일이 유효하다', () => {
    for (const variant of Object.values(ScalpingVariant)) {
      const profile = getStrategyExitProfile('scalping', variant);
      expect(profile).toBeDefined();
      expect(profile!.takeProfitPct).toBeGreaterThan(0);
      expect(profile!.stopLossPct).toBeLessThan(0);
      expect(profile!.maxHoldingDays).toBeGreaterThan(0);
      // 단타: 보유일은 짧아야 한다
      expect(profile!.maxHoldingDays).toBeLessThanOrEqual(3);
    }
  });

  it('variant 미지정 시 ensemble 프로파일로 fallback 한다', () => {
    expect(getStrategyExitProfile('scalping')).toEqual(
      getStrategyExitProfile('scalping', ScalpingVariant.Ensemble),
    );
  });

  it('exit profile 이 없는 전략은 undefined 를 반환한다', () => {
    expect(getStrategyExitProfile('day-trading', 'breakout')).toBeUndefined();
    expect(getStrategyExitProfile('mean-reversion', 'rsi')).toBeUndefined();
  });

  it('단타 trade meta 는 추매 없는 단일 사이클이다', () => {
    const meta = getStrategyTradeMeta('scalping');
    expect(meta.initialBuyRatioPct).toBe(50);
    expect(meta.addOnBuyRatioPct).toBe(0);
    expect(meta.maxAddOnCount).toBe(0);
  });
});

describe('countConsecutiveDownCandles', () => {
  it('현재 캔들부터 역순으로 음봉 수를 센다', () => {
    const base = new Date('2026-03-02');
    const mk = (open: number, close: number, i: number): CandleData => {
      const date = new Date(base);
      date.setDate(date.getDate() + i);
      return { date, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 };
    };
    const candles = [
      mk(100, 105, 0), // 양봉
      mk(105, 103, 1), // 음봉
      mk(103, 101, 2), // 음봉
      mk(101, 99, 3), // 음봉
    ];
    expect(countConsecutiveDownCandles(candles, 3)).toBe(3);
    expect(countConsecutiveDownCandles(candles, 0)).toBe(0);
  });
});
