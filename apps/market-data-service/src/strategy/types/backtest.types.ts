import { SignalDirection } from '@alpha-mind/strategies';

/** 백테스트 설정 */
export interface BacktestConfig {
  /** 전략 ID: day-trading, mean-reversion, infinity-bot, candle-pattern */
  strategyId: string;
  /** 전략 variant (선택) */
  variant?: string;
  /** 초기 투자 금액 */
  investmentAmount: number;
  /** 1회 매매 비율 % (기본 10) */
  tradeRatioPct: number;
  /** 매매 수수료율 % (기본 0.015) */
  commissionPct: number;
  /** 자동 익절 수익률 % (기본 2.5) */
  autoTakeProfitPct: number;
  /** 자동 손절 수익률 % (기본 -3) */
  autoStopLossPct: number;
  /** 최대 보유 거래일 수 (기본 7, 0 이하이면 비활성) */
  maxHoldingDays?: number;
  /** 보유 중 추가 매수 신호를 반영할지 여부 (기본은 전략별 설정) */
  allowAddOnBuy?: boolean;
  /** 매수 신호 최소 강도 (기본은 전략별 설정) */
  minBuySignalStrength?: number;
  /**
   * 매도 시 거래세 % (한국 시장 기본 0.18).
   * 백테스트 → 실거래 갭을 줄이기 위해 도입.
   */
  sellTaxPct?: number;
  /**
   * 슬리피지 % — 매수가는 + 슬리피지, 매도가는 - 슬리피지로 보수적으로 체결가를 조정.
   * 한국 단타 평균 0.05 가정.
   */
  slippagePct?: number;
  /**
   * 매수를 신호 발생 다음봉의 시가에 실행할지 여부 (기본 true).
   * 실제 자동매매가 익일 09:00 시가 진입에 가까우므로 true 가 현실적.
   * false 로 두면 신호 봉의 종가에 즉시 매수 (이전 동작).
   */
  useNextOpenForBuy?: boolean;
}

/** TP/SL 그리드 서치 한 점 — 한 (TP, SL) 조합의 종목 평균 성과 */
export interface GridSearchPoint {
  tpPct: number;
  slPct: number;
  /** 통과한 종목 수 (전략 walk-forward 검증 통과) */
  sampledStocks: number;
  /** OOS 평균 수익률 % */
  avgReturnPct: number;
  /** OOS 중앙값 수익률 % (왜도 영향 적음) */
  medianReturnPct: number;
  /** OOS 평균 승률 % */
  avgWinRate: number;
  /** OOS 수익 양수 종목 수 */
  profitableCount: number;
  /** profitableCount / sampledStocks */
  profitableProportion: number;
  /** OOS 평균 MDD % */
  avgMaxDrawdownPct: number;
  /** 최종 점수 (정렬 키) — medianReturn × profitableProp − 0.3 × avgMDD */
  score: number;
}

/** TP/SL 그리드 서치 결과 — 운용에 적용할 optimal 과 전체 grid */
export interface GridSearchResult {
  optimal: { tpPct: number; slPct: number; score: number; sampleSize: number };
  grid: GridSearchPoint[];
  /** 그리드에 후보로 입력된 전체 종목 수 */
  totalSampleSize: number;
  elapsedMs: number;
}

/** 개별 거래 기록 */
export interface BacktestTrade {
  date: Date;
  direction: SignalDirection.Buy | SignalDirection.Sell;
  price: number;
  quantity: number;
  amount: number;
  commission: number;
  /** 매도 시 거래세 (한국 0.18% 등) */
  sellTax?: number;
  /** 슬리피지 (가격 조정 후 반영된 비용) */
  slippageCost?: number;
  reason: string;
  /** 매도 시 실현 손익 */
  realizedPnl?: number;
}

/** 백테스트 결과 */
export interface BacktestResult {
  /** 종목 코드 */
  stockCode: string;
  /** 종목명 */
  stockName: string;
  /** 사용된 전략 */
  strategyId: string;
  strategyName: string;
  variant?: string;
  /** 기간 */
  period: { from: Date; to: Date };
  /** 초기 투자 금액 */
  investmentAmount: number;
  /** 최종 포트폴리오 가치 (현금 + 보유주식 시가) */
  finalValue: number;
  /** 총 수익률 % */
  totalReturnPct: number;
  /** 총 실현 손익 */
  totalRealizedPnl: number;
  /** 미실현 손익 (잔여 보유분) */
  unrealizedPnl: number;
  /** 총 거래 횟수 */
  totalTrades: number;
  /** 승리 거래 횟수 */
  winTrades: number;
  /** 패배 거래 횟수 */
  lossTrades: number;
  /** 승률 % */
  winRate: number;
  /** 최대 낙폭 % (MDD) */
  maxDrawdownPct: number;
  /** 잔여 현금 */
  remainingCash: number;
  /** 잔여 보유 수량 */
  remainingQuantity: number;
  /** 거래 내역 */
  trades: BacktestTrade[];
}
