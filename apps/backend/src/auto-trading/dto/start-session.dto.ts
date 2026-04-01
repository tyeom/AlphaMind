export interface StartSessionDto {
  stockCode: string;
  stockName: string;
  strategyId: string;
  variant?: string;
  investmentAmount: number;
  aiScore?: number;
}

export interface StartSessionsDto {
  sessions: StartSessionDto[];
}
