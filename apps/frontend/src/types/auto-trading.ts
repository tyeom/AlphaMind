export type SessionStatus = 'active' | 'paused' | 'stopped';

export interface AutoTradingSession {
  id: number;
  stockCode: string;
  stockName: string;
  strategyId: string;
  variant?: string;
  investmentAmount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  holdingQty: number;
  avgBuyPrice: number;
  totalBuys: number;
  totalSells: number;
  status: SessionStatus;
  aiScore?: number;
  createdAt: string;
  stoppedAt?: string;
}

export interface StartSessionRequest {
  stockCode: string;
  stockName: string;
  strategyId: string;
  variant?: string;
  investmentAmount: number;
  aiScore?: number;
}

export interface StartSessionsBatchRequest {
  sessions: StartSessionRequest[];
}
