export interface DynamicTpSlOptions {
  /** ATR% 대비 손절폭 배수 */
  stopLossAtrMultiplier?: number;
  /** ATR% 대비 익절폭 배수 */
  takeProfitAtrMultiplier?: number;
  /** 동적 손절폭 절대값 상한 */
  maxStopLossPct?: number;
  /** 동적 익절폭 상한 */
  maxTakeProfitPct?: number;
}

export interface DynamicTpSlResult {
  takeProfitPct: number;
  stopLossPct: number;
}

export const DEFAULT_DYNAMIC_TP_SL_OPTIONS: Required<DynamicTpSlOptions> = {
  stopLossAtrMultiplier: 1.3,
  takeProfitAtrMultiplier: 1.8,
  maxStopLossPct: 5.0,
  maxTakeProfitPct: 6.0,
};

/**
 * 종목 변동성(ATR%)에 비례해 TP/SL 을 조정한다.
 * market-data 백테스트와 backend 세션 생성이 반드시 같은 공식을 쓰도록 공용 유틸로 둔다.
 */
export function computeAtrDynamicTpSl(
  baseTakeProfitPct: number,
  baseStopLossPct: number,
  volatilityPct: number | undefined,
  options: DynamicTpSlOptions = {},
): DynamicTpSlResult {
  if (
    volatilityPct == null ||
    !Number.isFinite(volatilityPct) ||
    volatilityPct <= 0
  ) {
    return {
      takeProfitPct: baseTakeProfitPct,
      stopLossPct: baseStopLossPct,
    };
  }

  const opts = { ...DEFAULT_DYNAMIC_TP_SL_OPTIONS, ...options };
  const dynamicSlAbs = Math.min(
    opts.maxStopLossPct,
    Math.max(
      Math.abs(baseStopLossPct),
      volatilityPct * opts.stopLossAtrMultiplier,
    ),
  );
  const dynamicTp = Math.min(
    opts.maxTakeProfitPct,
    Math.max(baseTakeProfitPct, volatilityPct * opts.takeProfitAtrMultiplier),
  );

  return {
    takeProfitPct: Math.round(dynamicTp * 100) / 100,
    stopLossPct: -Math.round(dynamicSlAbs * 100) / 100,
  };
}
