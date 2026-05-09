import { DayTradingVariant, MeanReversionVariant } from './types/strategy.types';

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
