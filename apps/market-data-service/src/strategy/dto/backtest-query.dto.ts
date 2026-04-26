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
  /** 자동 익절 수익률 % (기본 2.5) */
  autoTakeProfitPct?: string;
  /** 자동 손절 수익률 % (기본 -3) */
  autoStopLossPct?: string;
  /** 최대 보유 거래일 수 (기본 7) */
  maxHoldingDays?: string;
  /** 보유 중 추가 매수 허용 여부 (미지정 시 전략별 기본값) */
  allowAddOnBuy?: string;
  /** 매도 시 거래세 % (기본 0.18) */
  sellTaxPct?: string;
  /** 슬리피지 % (양방향 적용, 기본 0.05) */
  slippagePct?: string;
  /** 매수를 다음봉 시가에 실행할지 (기본 true). false면 신호봉 종가에 즉시 매수. */
  useNextOpenForBuy?: string;
}
