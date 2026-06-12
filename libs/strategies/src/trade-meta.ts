import {
  DayTradingVariant,
  MeanReversionVariant,
  ScalpingVariant,
} from './types/strategy.types';

/**
 * 전략별 매매 정책 메타.
 *
 * - initialBuyRatioPct: 미보유 → 첫 진입 시 investmentAmount 대비 매수 비율(%)
 * - addOnBuyRatioPct: 보유 중 추가 매수 시 비율(%) — addOnBuyMode === 'add' 일 때만 사용
 * - maxAddOnCount: 1세션 동안 허용되는 추매 최대 횟수
 *
 * 누적 매수금액은 항상 investmentAmount 를 넘지 않도록 호출 측에서 추가 가드.
 */
export interface TradeMeta {
  initialBuyRatioPct: number;
  addOnBuyRatioPct: number;
  maxAddOnCount: number;
}

const DEFAULT_TRADE_META: TradeMeta = {
  initialBuyRatioPct: 32,
  addOnBuyRatioPct: 15,
  maxAddOnCount: 3,
};

/** strategyId → TradeMeta (variant 미적용 전략용) */
const STRATEGY_TRADE_META: Record<string, TradeMeta> = {
  'day-trading': {
    initialBuyRatioPct: 40,
    addOnBuyRatioPct: 15,
    maxAddOnCount: 3,
  },
  'candle-pattern': {
    initialBuyRatioPct: 32,
    addOnBuyRatioPct: 15,
    maxAddOnCount: 3,
  },
  'infinity-bot': {
    // roundPct 2% × 50 라운드 전제 — 1회당 작게, 다회 진입
    initialBuyRatioPct: 5,
    addOnBuyRatioPct: 5,
    maxAddOnCount: 19,
  },
  'momentum-power': {
    initialBuyRatioPct: 50,
    addOnBuyRatioPct: 20,
    maxAddOnCount: 2,
  },
  'momentum-surge': {
    initialBuyRatioPct: 40,
    addOnBuyRatioPct: 15,
    maxAddOnCount: 3,
  },
  scalping: {
    // 단타: 한 번에 진입하고 추매 없이 짧게 먹고 빠진다 (단일 사이클 회전)
    initialBuyRatioPct: 50,
    addOnBuyRatioPct: 0,
    maxAddOnCount: 0,
  },
};

/** mean-reversion 은 variant 별로 비율이 다름 (Grid/MagicSplit 은 자체 분할 내장) */
const MEAN_REVERSION_BY_VARIANT: Record<string, TradeMeta> = {
  [MeanReversionVariant.RSI]: {
    initialBuyRatioPct: 27,
    addOnBuyRatioPct: 10,
    maxAddOnCount: 4,
  },
  [MeanReversionVariant.Bollinger]: {
    initialBuyRatioPct: 27,
    addOnBuyRatioPct: 10,
    maxAddOnCount: 4,
  },
  [MeanReversionVariant.Grid]: {
    initialBuyRatioPct: 20,
    addOnBuyRatioPct: 10,
    maxAddOnCount: 8,
  },
  [MeanReversionVariant.MagicSplit]: {
    initialBuyRatioPct: 20,
    addOnBuyRatioPct: 10,
    maxAddOnCount: 8,
  },
};

/** day-trading variant 별 조정 (현재는 동일하지만 확장 여지) */
const DAY_TRADING_BY_VARIANT: Partial<Record<DayTradingVariant, TradeMeta>> = {};

export function getStrategyTradeMeta(
  strategyId: string,
  variant?: string,
): TradeMeta {
  if (strategyId === 'mean-reversion' && variant) {
    return MEAN_REVERSION_BY_VARIANT[variant] ?? DEFAULT_TRADE_META;
  }
  if (strategyId === 'day-trading' && variant) {
    const v = DAY_TRADING_BY_VARIANT[variant as DayTradingVariant];
    if (v) return v;
  }
  return STRATEGY_TRADE_META[strategyId] ?? DEFAULT_TRADE_META;
}

/**
 * 전략 고유 청산 프로파일 (TP/SL/최대 보유일).
 *
 * 정의된 전략은 스캔의 전역 TP/SL(그리드 서치/ATR 동적/고정 env) 대신
 * 이 값을 사용한다 — 타이트한 청산 자체가 전략 정의의 일부인 단타용.
 * 스캔 백테스트가 이 값으로 검증하고 ScanResult 에 실어 보내면 backend 세션이
 * 그대로 사용하므로 검증↔실전 정합이 유지된다.
 *
 * takeProfitPct 는 양수, stopLossPct 는 음수, maxHoldingDays 는 거래일 기준.
 */
export interface StrategyExitProfile {
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldingDays: number;
}

const SCALPING_EXIT_PROFILES: Record<string, StrategyExitProfile> = {
  // TP는 왕복 비용(수수료+거래세+슬리피지 ≈ 0.33%)을 청산하고도 남게,
  // SL은 일중 노이즈에 쓸리지 않는 선에서 타이트하게.
  [ScalpingVariant.Pullback]: {
    takeProfitPct: 2.0,
    stopLossPct: -1.5,
    maxHoldingDays: 2,
  },
  [ScalpingVariant.RsiSnapback]: {
    takeProfitPct: 1.8,
    stopLossPct: -1.5,
    maxHoldingDays: 2,
  },
  [ScalpingVariant.GapMomentum]: {
    takeProfitPct: 2.5,
    stopLossPct: -1.8,
    maxHoldingDays: 2,
  },
  [ScalpingVariant.Ensemble]: {
    takeProfitPct: 2.2,
    stopLossPct: -1.5,
    maxHoldingDays: 3,
  },
};

export function getStrategyExitProfile(
  strategyId: string,
  variant?: string,
): StrategyExitProfile | undefined {
  if (strategyId === 'scalping') {
    return (
      SCALPING_EXIT_PROFILES[variant ?? ScalpingVariant.Ensemble] ??
      SCALPING_EXIT_PROFILES[ScalpingVariant.Ensemble]
    );
  }
  return undefined;
}
