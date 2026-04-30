/** 활성 세션이 이미 있을 때의 처리 방식 */
export type SessionConflictAction = 'update' | 'skip';

/**
 * 세션 진입 방식
 * - 'monitor': 매수 신호 감지 시까지 대기 (기본)
 * - 'immediate': 세션 생성 즉시 시장가로 전략별 첫 진입 비중 매수 후 운용
 */
export type SessionEntryMode = 'monitor' | 'immediate';

/**
 * 보유 종목에서 매수 신호가 추가로 발생했을 때의 처리 방식
 * - 'add': 추가 매수 (분할 매수 / 피라미딩)
 * - 'skip': 매수 신호 무시 (기본)
 */
export type AddOnBuyMode = 'add' | 'skip';

export interface StartSessionDto {
  stockCode: string;
  stockName: string;
  /** 전략 ID — 미지정시 백테스트 기반 추천 전략 자동 선택 */
  strategyId?: string;
  variant?: string;
  investmentAmount: number;
  aiScore?: number;
  /** 목표 수익률 (%) — 기본 2.0 */
  takeProfitPct?: number;
  /** 손절 기준 (%) — 음수값, 기본 -2.0 */
  stopLossPct?: number;
  /** 최대 보유일 수 — 기본 7, 0 이하이면 비활성 */
  maxHoldingDays?: number;
  /**
   * 보유 종목에 추가 매수 신호 발생 시 동작 — 미지정시 'skip'
   */
  addOnBuyMode?: AddOnBuyMode;
  /**
   * 동일 종목에 이미 활성 세션이 있을 때의 처리
   * - 'update': 기존 세션을 새 설정으로 덮어씀
   * - 'skip': 기존 세션을 그대로 두고 생성하지 않음
   * - 미지정: 409 Conflict 응답
   */
  onConflict?: SessionConflictAction;
  /**
   * 세션 진입 방식
   * - 'monitor' (기본): 전략 매수 신호 대기
   * - 'immediate': 세션 생성 직후 시장가로 전략별 첫 진입 비중 매수
   */
  entryMode?: SessionEntryMode;
}

export interface StartSessionsDto {
  sessions: StartSessionDto[];
  /**
   * 일괄 적용할 세션 진입 방식 — 각 세션의 entryMode 보다 우선순위 낮음.
   * 지정 시 sessions[].entryMode 가 비어있는 항목에만 적용된다.
   */
  entryMode?: SessionEntryMode;
}

/** 활성/일시정지 상태의 세션 설정 수정 DTO */
export interface UpdateSessionDto {
  strategyId?: string;
  variant?: string;
  takeProfitPct?: number;
  stopLossPct?: number;
  maxHoldingDays?: number;
  addOnBuyMode?: AddOnBuyMode;
}

/**
 * 내부 서비스 전용 DTO.
 * 공개 HTTP API 에서는 `scheduledScan` 을 받지 않고, 스케줄러 등 서버 내부 호출만 사용한다.
 */
export interface InternalStartSessionDto extends StartSessionDto {
  scheduledScan?: boolean;
}

export interface InternalStartSessionsDto {
  sessions: InternalStartSessionDto[];
  entryMode?: SessionEntryMode;
}

export interface InternalUpdateSessionDto extends UpdateSessionDto {
  scheduledScan?: boolean;
}

/** 수동 매수/매도 주문 DTO */
export interface ManualOrderDto {
  orderType: 'buy' | 'sell';
  /** '00' = 지정가, '01' = 시장가 */
  orderDvsn: '00' | '01';
  quantity: number;
  /** 지정가 주문 시 주문 단가 — 시장가일 때 0 */
  price?: number;
}
