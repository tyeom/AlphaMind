export interface ScanBodyDto {
  excludeCodes?: string[];
  topN?: number;
  investmentAmount?: number;
  tradeRatioPct?: number;
  commissionPct?: number;
  autoTakeProfitPct?: number;
  autoStopLossPct?: number;
  maxHoldingDays?: number;
  minCurrentSignalStrength?: number;
  minTotalTrades?: number;
  scaleOutEnabled?: boolean;
  scaleOutTp1TriggerPct?: number;
  scaleOutTp1SellRatioPct?: number;
  runnerTrailingTriggerPct?: number;
  runnerTrailingGivebackPct?: number;
  runnerBreakevenTriggerPct?: number;
  runnerBreakevenFloorPct?: number;
  runnerTakeProfitPct?: number;
  rSizingEnabled?: boolean;
  rRiskPct?: number;
  regimeEnabled?: boolean;
  correlationEnabled?: boolean;
  correlationCodes?: string[];
  /** 고정 TP/SL 모드: true 면 종목별 ATR 동적 보정을 건너뛰고 전달된 autoTakeProfitPct/autoStopLossPct 를 그대로 백테스트·세션에 사용(검증↔실전 정합). */
  forceFixedTpSl?: boolean;
}
