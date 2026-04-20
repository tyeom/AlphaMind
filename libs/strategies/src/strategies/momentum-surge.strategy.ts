import {
  CandleData,
  ExitConfig,
  MomentumSurgeConfig,
  MomentumSurgeEtfKind,
  Signal,
  SignalDirection,
  StrategyAnalysisResult,
} from '../types/strategy.types';
import {
  calculateSMA,
  calculateRSI,
  calculateOBV,
} from '../indicators/technical-indicators';

const DEFAULT_EXIT_CONFIG: ExitConfig = {
  stopLossEnabled: true,
  stopLossPct: 3.0,
  takeProfitEnabled: true,
  takeProfitPct: 10.0,
  trailingStopEnabled: false,
  trailingTriggerPct: 2.0,
  trailingStopPct: 1.0,
  exitOnOppositeSignal: true,
};

/**
 * Momentum Surge 전략 기본 설정.
 *
 * 원본 Rust 구현은 MA 60일 장기선을 사용하지만,
 * alpha-mind 백테스트 3개월 윈도우에 맞춰 ma_long 기본값을 40으로 조정한다.
 */
const DEFAULT_CONFIG: MomentumSurgeConfig = {
  etfKind: MomentumSurgeEtfKind.Auto,
  kospiLeverage: '122630',
  kosdaqLeverage: '233740',
  kospiInverse: '252670',
  kosdaqInverse: '251340',
  positionRatio: 0.5,
  obvPeriod: 10,
  maShort: 5,
  maMedium: 20,
  maLong: 40,
  rsiPeriod: 14,
  stopLossPct: 3.0,
  takeProfitPct: 10.0,
  exitConfig: DEFAULT_EXIT_CONFIG,
};

/**
 * Momentum Surge 전략 분석.
 *
 * OBV + 단/중/장기 MA 정배열 + RSI 조합으로 추세를 판단해
 * 레버리지 계열(정배열)과 인버스 계열(역배열) 각각 진입/청산 신호를 산출한다.
 *
 * - 레버리지 진입: OBV 상승 + MA 정배열(단기>중기>장기) + 30 < RSI < 70 → BUY
 * - 인버스 진입  : OBV 하락 + MA 역배열(단기<중기<장기) + RSI < 40    → BUY
 * - 청산         : 손절/익절 or MA 방향 반전 or OBV 방향 반전 → SELL
 *
 * stockCode 기준으로 ETF 종류를 자동 판별하며, etfKind로 강제 지정도 가능하다.
 */
export function analyzeMomentumSurge(
  candles: CandleData[],
  config: Partial<MomentumSurgeConfig> = {},
  stockCode = '',
): StrategyAnalysisResult {
  const cfg = mergeConfig(config);
  const kind = resolveEtfKind(cfg, stockCode);

  const closes = candles.map((c) => c.close);
  const sma5 = calculateSMA(closes, cfg.maShort);
  const sma20 = calculateSMA(closes, cfg.maMedium);
  const sma60 = calculateSMA(closes, cfg.maLong);
  const rsi = calculateRSI(closes, cfg.rsiPeriod);
  const obv = calculateOBV(candles);

  const signals: Signal[] = [];

  let entryPrice: number | null = null; // 보유 중 진입가 (마지막 BUY 기준)

  for (let i = cfg.obvPeriod; i < candles.length; i++) {
    const s = sma5[i];
    const m = sma20[i];
    const l = sma60[i];
    const r = rsi[i];
    if (s == null || m == null || l == null || r == null) continue;

    const bullishAligned = s > m && m > l;
    const bearishAligned = s < m && m < l;
    const obvUp = obv[i] > obv[i - cfg.obvPeriod];
    const obvDown = obv[i] < obv[i - cfg.obvPeriod];
    const close = candles[i].close;

    // ─── 청산 체크 (보유 중인 경우) ───
    if (entryPrice != null) {
      const pnlPct = ((close - entryPrice) / entryPrice) * 100;

      // 손절
      if (pnlPct <= -cfg.stopLossPct) {
        signals.push({
          direction: SignalDirection.Sell,
          strength: clamp01(Math.abs(pnlPct) / (cfg.stopLossPct * 2) + 0.5),
          reason: `손절 (수익률 ${pnlPct.toFixed(1)}% ≤ -${cfg.stopLossPct}%)`,
          date: candles[i].date,
          price: close,
          metadata: { entryPrice, pnlPct, exitReason: 'stop_loss' },
        });
        entryPrice = null;
        continue;
      }
      // 익절
      if (pnlPct >= cfg.takeProfitPct) {
        signals.push({
          direction: SignalDirection.Sell,
          strength: clamp01(pnlPct / (cfg.takeProfitPct * 2) + 0.5),
          reason: `익절 (수익률 ${pnlPct.toFixed(1)}% ≥ ${cfg.takeProfitPct}%)`,
          date: candles[i].date,
          price: close,
          metadata: { entryPrice, pnlPct, exitReason: 'take_profit' },
        });
        entryPrice = null;
        continue;
      }

      // 추세 반전 청산
      if (kind === MomentumSurgeEtfKind.Leverage) {
        if (bearishAligned) {
          signals.push({
            direction: SignalDirection.Sell,
            strength: 0.6,
            reason: `MA 역배열 전환 (단기<중기<장기)`,
            date: candles[i].date,
            price: close,
            metadata: { entryPrice, pnlPct, exitReason: 'ma_bearish' },
          });
          entryPrice = null;
          continue;
        }
        if (obvDown) {
          signals.push({
            direction: SignalDirection.Sell,
            strength: 0.5,
            reason: `OBV 하락 전환`,
            date: candles[i].date,
            price: close,
            metadata: { entryPrice, pnlPct, exitReason: 'obv_down' },
          });
          entryPrice = null;
          continue;
        }
      } else {
        // Inverse 포지션: 오히려 정배열/ OBV 상승 시 청산
        if (bullishAligned) {
          signals.push({
            direction: SignalDirection.Sell,
            strength: 0.6,
            reason: `MA 정배열 전환 (인버스 포지션 정리)`,
            date: candles[i].date,
            price: close,
            metadata: { entryPrice, pnlPct, exitReason: 'ma_bullish' },
          });
          entryPrice = null;
          continue;
        }
      }
    }

    // ─── 진입 체크 (미보유 상태) ───
    if (entryPrice != null) continue;

    if (kind === MomentumSurgeEtfKind.Leverage) {
      const rsiOk = r > 30 && r < 70;
      if (obvUp && bullishAligned && rsiOk) {
        signals.push({
          direction: SignalDirection.Buy,
          strength: clamp01(cfg.positionRatio + 0.3),
          reason: `레버리지 매수 (MA 정배열 + OBV 상승 + RSI ${r.toFixed(1)})`,
          date: candles[i].date,
          price: close,
          metadata: {
            etfKind: kind,
            obv: obv[i],
            sma5: s,
            sma20: m,
            sma60: l,
            rsi: r,
          },
        });
        entryPrice = close;
      }
    } else {
      // 인버스: 반대 조건 (역배열 + OBV 하락 + RSI<40)
      const rsiOk = r < 40;
      if (obvDown && bearishAligned && rsiOk) {
        signals.push({
          direction: SignalDirection.Buy,
          strength: clamp01(cfg.positionRatio + 0.3),
          reason: `인버스 매수 (MA 역배열 + OBV 하락 + RSI ${r.toFixed(1)})`,
          date: candles[i].date,
          price: close,
          metadata: {
            etfKind: kind,
            obv: obv[i],
            sma5: s,
            sma20: m,
            sma60: l,
            rsi: r,
          },
        });
        entryPrice = close;
      }
    }
  }

  const lastIdx = candles.length - 1;
  const lastCandle = candles[lastIdx];
  const currentSignal = buildCurrentSignal(signals, lastCandle);

  return {
    strategyName: 'Momentum Surge',
    stockCode,
    analyzedPeriod: { from: candles[0].date, to: lastCandle.date },
    currentSignal,
    signals,
    indicators: {
      etfKind: kind,
      maShort: cfg.maShort,
      maMedium: cfg.maMedium,
      maLong: cfg.maLong,
      obvPeriod: cfg.obvPeriod,
      rsiPeriod: cfg.rsiPeriod,
      currentSMA5: sma5[lastIdx],
      currentSMA20: sma20[lastIdx],
      currentSMA60: sma60[lastIdx],
      currentRSI: rsi[lastIdx],
      currentOBV: obv[lastIdx],
      obvDelta:
        lastIdx >= cfg.obvPeriod ? obv[lastIdx] - obv[lastIdx - cfg.obvPeriod] : null,
      totalSignals: signals.length,
      buySignals: signals.filter((s) => s.direction === SignalDirection.Buy).length,
      sellSignals: signals.filter((s) => s.direction === SignalDirection.Sell).length,
    },
    summary: buildSummary('Momentum Surge', currentSignal, signals, kind),
  };
}

// ─── Helpers ───

function mergeConfig(partial: Partial<MomentumSurgeConfig>): MomentumSurgeConfig {
  return {
    etfKind: partial.etfKind ?? DEFAULT_CONFIG.etfKind,
    kospiLeverage: partial.kospiLeverage ?? DEFAULT_CONFIG.kospiLeverage,
    kosdaqLeverage: partial.kosdaqLeverage ?? DEFAULT_CONFIG.kosdaqLeverage,
    kospiInverse: partial.kospiInverse ?? DEFAULT_CONFIG.kospiInverse,
    kosdaqInverse: partial.kosdaqInverse ?? DEFAULT_CONFIG.kosdaqInverse,
    positionRatio: partial.positionRatio ?? DEFAULT_CONFIG.positionRatio,
    obvPeriod: partial.obvPeriod ?? DEFAULT_CONFIG.obvPeriod,
    maShort: partial.maShort ?? DEFAULT_CONFIG.maShort,
    maMedium: partial.maMedium ?? DEFAULT_CONFIG.maMedium,
    maLong: partial.maLong ?? DEFAULT_CONFIG.maLong,
    rsiPeriod: partial.rsiPeriod ?? DEFAULT_CONFIG.rsiPeriod,
    stopLossPct: partial.stopLossPct ?? DEFAULT_CONFIG.stopLossPct,
    takeProfitPct: partial.takeProfitPct ?? DEFAULT_CONFIG.takeProfitPct,
    exitConfig: { ...DEFAULT_EXIT_CONFIG, ...partial.exitConfig },
  };
}

function resolveEtfKind(
  cfg: MomentumSurgeConfig,
  stockCode: string,
): MomentumSurgeEtfKind.Leverage | MomentumSurgeEtfKind.Inverse {
  if (cfg.etfKind === MomentumSurgeEtfKind.Leverage) return MomentumSurgeEtfKind.Leverage;
  if (cfg.etfKind === MomentumSurgeEtfKind.Inverse) return MomentumSurgeEtfKind.Inverse;

  // Auto: 설정된 티커와 매칭
  if (stockCode === cfg.kospiInverse || stockCode === cfg.kosdaqInverse) {
    return MomentumSurgeEtfKind.Inverse;
  }
  // 그 외(레버리지 티커/일반 종목)는 레버리지 모드로 처리
  return MomentumSurgeEtfKind.Leverage;
}

function buildCurrentSignal(signals: Signal[], lastCandle: CandleData): Signal {
  const recent = signals.slice(-5);
  if (recent.length === 0) {
    return {
      direction: SignalDirection.Neutral,
      strength: 0,
      reason: '분석 기간 내 신호 없음',
      date: lastCandle.date,
      price: lastCandle.close,
    };
  }
  return recent[recent.length - 1];
}

function buildSummary(
  name: string,
  current: Signal,
  signals: Signal[],
  kind: MomentumSurgeEtfKind,
): string {
  const buys = signals.filter((s) => s.direction === SignalDirection.Buy).length;
  const sells = signals.filter((s) => s.direction === SignalDirection.Sell).length;
  return `[${name}] (${kind}) 총 ${signals.length}개 신호 (매수 ${buys}, 매도 ${sells}). 현재: ${current.direction} (강도 ${(current.strength * 100).toFixed(0)}%)`;
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
