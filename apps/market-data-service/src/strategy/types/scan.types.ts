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
  finalValue: number;
  investmentAmount: number;
}

export interface ScanResponse {
  scannedStocks: number;
  eligibleStocks: number;
  excludedStocks: number;
  elapsedMs: number;
  results: ScanResult[];
}
