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
  /** 자동 익절 수익률 % (기본 2.0) */
  autoTakeProfitPct?: string;
  /** 자동 손절 수익률 % (기본 -2.0) */
  autoStopLossPct?: string;
  /** 최대 보유 거래일 수 (기본 7) */
  maxHoldingDays?: string;
  /** 보유 중 추가 매수 허용 여부 (미지정 시 전략별 기본값) */
  allowAddOnBuy?: string;
  /** 매도 시 거래세 % (미지정 시 BACKTEST_SELL_TAX_PCT, 기본 0.15) */
  sellTaxPct?: string;
  /** 슬리피지 % (양방향 적용, 기본 0.05) */
  slippagePct?: string;
  /** 매수를 다음봉 시가에 실행할지 (기본 true). false면 신호봉 종가에 즉시 매수. */
  useNextOpenForBuy?: string;
  /** 트레일링 스톱 시작 수익률 % (기본 1.2) */
  trailingStopTriggerPct?: string;
  /** 고점 대비 반납 허용률 % (기본 0.8) */
  trailingStopGivebackPct?: string;
  /** 본전 보호 시작 수익률 % (기본 1.0) */
  breakevenTriggerPct?: string;
  /** 본전 보호 청산선 % (기본 0.1) */
  breakevenFloorPct?: string;
  /** 부분익절 사용 여부 (기본 false) */
  scaleOutEnabled?: string;
  /** TP1 발동 수익률 % (기본 2.0) */
  scaleOutTp1TriggerPct?: string;
  /** TP1 매도 비율 % (기본 50) */
  scaleOutTp1SellRatioPct?: string;
  /** 부분익절 후 잔량 트레일링 시작 수익률 % (기본 3.5) */
  runnerTrailingTriggerPct?: string;
  /** 부분익절 후 잔량 고점 대비 반납 허용률 % (기본 2.5) */
  runnerTrailingGivebackPct?: string;
  /** 부분익절 후 잔량 본전 보호 시작 수익률 % (기본 4.0) */
  runnerBreakevenTriggerPct?: string;
  /** 부분익절 후 잔량 본전 보호 청산선 % (기본 1.0) */
  runnerBreakevenFloorPct?: string;
  /** 부분익절 후 잔량 상위 익절선 % (기본 6.0) */
  runnerTakeProfitPct?: string;
}
