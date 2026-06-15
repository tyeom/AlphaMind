import type {
  CorrelationClusterOptions,
  MarketRegimeOptions,
  MarketRegimeState,
  RegimeResult,
} from '@alpha-mind/strategies';

export interface ScanResult {
  stockCode: string;
  stockName: string;
  sector?: string;
  /** 상관 클러스터 ID. 미산출/단독 종목은 생략한다. */
  clusterId?: number;
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
  /** 스캔 기준 최신 종가. 예약 스캔의 실제 1주 매수 가능 예산 계산에 사용한다. */
  latestPrice?: number;
  /** 엄격 OOS 품질 필터 대신 양수 OOS 수익 후보 fallback으로 채택됐는지 여부. */
  qualityFallback?: boolean;
  /** 최근 BUY 신호는 없지만 수익 양수 스켈핑 전략으로 모니터링할 후보인지 여부. */
  watchlistFallback?: boolean;
  /**
   * 스캔 백테스트에 실제 적용된 자동 익절/손절 값.
   * backend 예약 스캐너가 이 값을 그대로 세션에 반영해 검증 룰과 실전 룰을 일치시킨다.
   */
  autoTakeProfitPct?: number;
  autoStopLossPct?: number;
  /**
   * 스캔 백테스트에 실제 적용된 최대 보유 거래일.
   * 전략 고유 exit profile(단타 스캘핑 등)이 있으면 전역값 대신 그 값이 실린다.
   */
  maxHoldingDays?: number;
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
    rvol?: number;
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
  /** rolling WF 활성 시 유효 폴드별 검증 결과 */
  folds?: {
    foldIndex: number;
    inSampleLength: number;
    outOfSampleLength: number;
    inSample: {
      totalReturnPct: number;
      winRate: number;
      totalTrades: number;
      maxDrawdownPct: number;
    };
    outOfSample: {
      totalReturnPct: number;
      winRate: number;
      totalTrades: number;
      maxDrawdownPct: number;
    };
  }[];
  /** 수익 양수 OOS 폴드 수 / 유효 폴드 수 */
  wfConsistency?: number;
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

export interface ScanCluster {
  clusterId: number;
  codes: string[];
  size: number;
}

export interface SurvivorshipBiasEstimate {
  universeSize: number;
  delistedRetained: number;
  assumedAnnualDelistRate: number;
  estimatedReturnHaircutPct: number;
  researchAnchor: string;
  note: string;
}

export interface RegimeCorrelationOptions {
  regimeEnabled?: boolean;
  correlationEnabled?: boolean;
  correlationCodes?: string[];
  prevRegime?: MarketRegimeState | null;
  regimeOptions?: MarketRegimeOptions;
  correlationOptions?: CorrelationClusterOptions;
  correlationLookbackDays?: number;
}

export interface ScanResponse {
  scannedStocks: number;
  eligibleStocks: number;
  excludedStocks: number;
  elapsedMs: number;
  results: ScanResult[];
  /** 시장 레짐 스케일 계산 결과. 토글 OFF/표본부족/예외 시 생략될 수 있다. */
  regime?: RegimeResult;
  /** 후보+활성보유 혼합 상관 클러스터. backend 활성 시드 역매핑에 사용한다. */
  clusters?: ScanCluster[];
  /**
   * 생존편향 caveat. 성과에서 차감하지 않는 가정 기반 경고이며,
   * 보존 토글 OFF에서는 기존 JSON 바이트 보존을 위해 비열거 속성으로만 존재한다.
   */
  survivorshipBias?: SurvivorshipBiasEstimate;
}
