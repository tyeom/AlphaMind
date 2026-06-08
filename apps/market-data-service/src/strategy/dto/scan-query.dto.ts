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
}
