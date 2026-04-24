export type SessionStatus = 'active' | 'paused' | 'stopped';

/**
 * 세션 내 실제 포지션 상태
 * - 'holding': 실제 보유 중 (holdingQty > 0) — 익절/손절 감시 대상
 * - 'waiting': 아직 매수 전 (holdingQty === 0) — 전략 매수 신호 대기 중
 */
export type PositionStatus = 'holding' | 'waiting';

/**
 * 보유 종목에서 매수 신호가 추가로 발생했을 때의 처리 방식
 * - 'add': 추가 매수 (분할 매수 / 피라미딩)
 * - 'skip': 매수 신호 무시 (기본)
 */
export type AddOnBuyMode = 'add' | 'skip';

export interface AutoTradingSession {
  id: number;
  stockCode: string;
  stockName: string;
  strategyId: string;
  variant?: string;
  investmentAmount: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldingDays: number;
  addOnBuyMode: AddOnBuyMode;
  realizedPnl: number;
  unrealizedPnl: number;
  holdingQty: number;
  avgBuyPrice: number;
  totalBuys: number;
  totalSells: number;
  status: SessionStatus;
  /** 실보유/대기 상태 — 백엔드에서 holdingQty 기반으로 계산 */
  positionStatus: PositionStatus;
  /**
   * 스케줄러(매일 08:00 KST)에 의해 등록/갱신된 세션 여부.
   * 사용자가 직접 등록한 세션과 구분하기 위해 UI 에 배지로 표시.
   */
  scheduledScan: boolean;
  aiScore?: number;
  createdAt: string;
  stoppedAt?: string;
  enteredAt?: string;
}

/** 활성 세션이 이미 있을 때의 처리 방식 */
export type SessionConflictAction = 'update' | 'skip';

/**
 * 세션 진입 방식
 * - 'monitor': 전략 매수 신호 대기 (기본)
 * - 'immediate': 세션 생성 직후 시장가 전액 매수 후 운용
 */
export type SessionEntryMode = 'monitor' | 'immediate';

export interface StartSessionRequest {
  stockCode: string;
  stockName: string;
  /** 전략 ID — 미지정시 백엔드에서 백테스트 기반 추천 전략 자동 선택 */
  strategyId?: string;
  variant?: string;
  investmentAmount: number;
  aiScore?: number;
  /** 목표 수익률 (%) — 미지정시 백엔드 기본값 2.5 */
  takeProfitPct?: number;
  /** 손절 기준 (%) — 음수값, 미지정시 백엔드 기본값 -3 */
  stopLossPct?: number;
  /** 최대 보유일 수 — 미지정시 백엔드 기본값 7 */
  maxHoldingDays?: number;
  /** 보유 종목에 추가 매수 신호 발생 시 동작 — 미지정시 'skip' */
  addOnBuyMode?: AddOnBuyMode;
  /**
   * 동일 종목에 이미 활성 세션이 있을 때의 처리
   * - 'update': 기존 세션을 새 설정으로 덮어씀
   * - 'skip': 기존 세션을 그대로 두고 생성하지 않음
   * - 미지정: 409 Conflict 응답
   */
  onConflict?: SessionConflictAction;
  /** 진입 방식 — 미지정시 'monitor' */
  entryMode?: SessionEntryMode;
}

export interface StartSessionsBatchRequest {
  sessions: StartSessionRequest[];
  /** 일괄 적용할 진입 방식 — 개별 세션에 entryMode 가 없을 때만 적용 */
  entryMode?: SessionEntryMode;
}

/** 활성/일시정지 세션 설정 수정 요청 */
export interface UpdateSessionRequest {
  strategyId?: string;
  variant?: string;
  takeProfitPct?: number;
  stopLossPct?: number;
  maxHoldingDays?: number;
  addOnBuyMode?: AddOnBuyMode;
}

/** 수동 매수/매도 주문 요청 */
export interface ManualOrderRequest {
  orderType: 'buy' | 'sell';
  /** '00' = 지정가, '01' = 시장가 */
  orderDvsn: '00' | '01';
  quantity: number;
  /** 지정가 주문 시 주문 단가 — 시장가일 때 생략 */
  price?: number;
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
    maxHoldingDays: number;
  };
}

export interface SessionConflictError {
  message: string;
  code: 'SESSION_CONFLICT';
  conflicts: SessionConflictItem[];
}
