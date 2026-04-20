export interface BacktestQueryDto {
  /** 전략 ID: day-trading, mean-reversion, infinity-bot, candle-pattern */
  strategyId: string;
  /** 전략 variant (선택) */
  variant?: string;
  /** 초기 투자 금액 (기본 10,000,000) */
  investmentAmount?: string;
  /** 1회 매매 비율 % (기본 10) */
  tradeRatioPct?: string;
  /** 매매 수수료율 % (기본 0.015) */
  commissionPct?: string;
  /** 자동 익절 수익률 % (기본 5) */
  autoTakeProfitPct?: string;
  /** 자동 손절 수익률 % (기본 -3) */
  autoStopLossPct?: string;
}
