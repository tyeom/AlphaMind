export type SessionStatus = 'active' | 'paused' | 'stopped';

export interface AutoTradingSession {
  id: number;
  stockCode: string;
  stockName: string;
  strategyId: string;
  variant?: string;
  investmentAmount: number;
  takeProfitPct: number;
  stopLossPct: number;
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

/** 활성 세션이 이미 있을 때의 처리 방식 */
export type SessionConflictAction = 'update' | 'skip';

export interface StartSessionRequest {
  stockCode: string;
  stockName: string;
  /** 전략 ID — 미지정시 백엔드에서 백테스트 기반 추천 전략 자동 선택 */
  strategyId?: string;
  variant?: string;
  investmentAmount: number;
  aiScore?: number;
  /** 목표 수익률 (%) — 미지정시 백엔드 기본값 5 */
  takeProfitPct?: number;
  /** 손절 기준 (%) — 음수값, 미지정시 백엔드 기본값 -3 */
  stopLossPct?: number;
  /**
   * 동일 종목에 이미 활성 세션이 있을 때의 처리
   * - 'update': 기존 세션을 새 설정으로 덮어씀
   * - 'skip': 기존 세션을 그대로 두고 생성하지 않음
   * - 미지정: 409 Conflict 응답
   */
  onConflict?: SessionConflictAction;
}

export interface StartSessionsBatchRequest {
  sessions: StartSessionRequest[];
}

/** 활성/일시정지 세션 설정 수정 요청 */
export interface UpdateSessionRequest {
  strategyId?: string;
  variant?: string;
  takeProfitPct?: number;
  stopLossPct?: number;
}

/** 409 Conflict 응답 바디 */
export interface SessionConflictItem {
  stockCode: string;
  stockName: string;
  existingSession: {
    id: number;
    strategyId: string;
    variant?: string;
    takeProfitPct: number;
    stopLossPct: number;
  };
}

export interface SessionConflictError {
  message: string;
  code: 'SESSION_CONFLICT';
  conflicts: SessionConflictItem[];
}
