/** 활성 세션이 이미 있을 때의 처리 방식 */
export type SessionConflictAction = 'update' | 'skip';

export interface StartSessionDto {
  stockCode: string;
  stockName: string;
  /** 전략 ID — 미지정시 백테스트 기반 추천 전략 자동 선택 */
  strategyId?: string;
  variant?: string;
  investmentAmount: number;
  aiScore?: number;
  /** 목표 수익률 (%) — 기본 5 */
  takeProfitPct?: number;
  /** 손절 기준 (%) — 음수값, 기본 -3 */
  stopLossPct?: number;
  /**
   * 동일 종목에 이미 활성 세션이 있을 때의 처리
   * - 'update': 기존 세션을 새 설정으로 덮어씀
   * - 'skip': 기존 세션을 그대로 두고 생성하지 않음
   * - 미지정: 409 Conflict 응답
   */
  onConflict?: SessionConflictAction;
}

export interface StartSessionsDto {
  sessions: StartSessionDto[];
}

/** 활성/일시정지 상태의 세션 설정 수정 DTO */
export interface UpdateSessionDto {
  strategyId?: string;
  variant?: string;
  takeProfitPct?: number;
  stopLossPct?: number;
}
