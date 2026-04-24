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
}
