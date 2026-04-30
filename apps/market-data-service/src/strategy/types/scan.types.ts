export interface ScanResult {
  stockCode: string;
  stockName: string;
  sector?: string;
  bestStrategy: {
    strategyId: string;
    strategyName: string;
    variant?: string;
  };
  totalReturnPct: number;
  winRate: number;
  maxDrawdownPct: number;
  totalTrades: number;
  /** 단기 운용 적합도 기반 위험조정 랭킹 점수 */
  rankScore: number;
  finalValue: number;
  investmentAmount: number;
  /**
   * 종목 변동성 — 최근 ATR(14) / 종가 × 100 (%).
   * 분산 배분(역가중)에 사용한다.
   */
  volatilityPct?: number;
  /** OOS 손익비. 1보다 크면 이익 합계가 손실 합계보다 큼. */
  profitFactor?: number;
  /** OOS 거래당 기대값 (% of investmentAmount). */
  expectancyPct?: number;
  /** 매수 리스크 필터 지표 */
  riskProfile?: {
    avgTurnover20?: number;
    sma20Slope5dPct?: number;
    priceFromSma20Pct?: number;
    priceFromSma60Pct?: number;
    recent5dReturnPct?: number;
  };
  /**
   * In-sample(전반부) 검증 결과. 전략 선정에 사용.
   */
  inSample?: {
    totalReturnPct: number;
    winRate: number;
    totalTrades: number;
    maxDrawdownPct: number;
  };
  /**
   * Out-of-sample(후반부) 검증 결과. 랭킹 점수 산출 + 통과 필터에 사용.
   */
  outOfSample?: {
    totalReturnPct: number;
    winRate: number;
    totalTrades: number;
    maxDrawdownPct: number;
  };
  /** 추천 근거 요약 */
  summary: string;
  /** 최신 신호 */
  currentSignal: {
    direction: string;
    strength: number;
    reason: string;
  };
  /** 전략별 핵심 지표 */
  indicators: Record<string, unknown>;
}

export interface ScanResponse {
  scannedStocks: number;
  eligibleStocks: number;
  excludedStocks: number;
  elapsedMs: number;
  results: ScanResult[];
}
