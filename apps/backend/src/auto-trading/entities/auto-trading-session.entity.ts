import {
  Entity,
  PrimaryKey,
  Property,
  ManyToOne,
  Enum,
  Index,
  OptionalProps,
} from '@mikro-orm/core';
import { UserEntity } from '../../user/entities/user.entity';

export enum SessionStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  STOPPED = 'stopped',
}

export enum PauseReason {
  MANUAL = 'manual',
  AUTO_SELL = 'auto-sell',
}

/**
 * 세션 내 실제 포지션 상태
 * - 'holding': 실제 보유 중 (holdingQty > 0) — 익절/손절 감시 대상
 * - 'waiting': 아직 매수 전 (holdingQty === 0) — 전략 매수 신호 대기 중
 *
 * 세션 라이프사이클(status) 과는 독립적이며, holdingQty 에서 파생된다.
 */
export enum PositionStatus {
  HOLDING = 'holding',
  WAITING = 'waiting',
}

/**
 * 보유 종목에서 매수 신호가 추가로 발생했을 때의 처리 방식
 * - 'add': 추가 매수 (분할 매수 / 피라미딩)
 * - 'skip': 이미 보유 중이므로 매수 신호를 무시
 */
export enum AddOnBuyMode {
  ADD = 'add',
  SKIP = 'skip',
}

@Entity({ tableName: 'auto_trading_sessions' })
@Index({
  name: 'auto_trading_sessions_user_stock_active_uniq',
  expression: `create unique index "auto_trading_sessions_user_stock_active_uniq" on "auto_trading_sessions" ("user_id", "stock_code") where "status" = 'active'`,
})
export class AutoTradingSessionEntity {
  [OptionalProps]?:
    | 'id'
    | 'realizedPnl'
    | 'unrealizedPnl'
    | 'holdingQty'
    | 'avgBuyPrice'
    | 'totalBuys'
    | 'totalSells'
    | 'status'
    | 'pauseReason'
    | 'autoPausePending'
    | 'takeProfitPct'
    | 'stopLossPct'
    | 'addOnBuyMode'
    | 'scheduledScan'
    | 'positionStatus'
    | 'createdAt';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => UserEntity, { deleteRule: 'cascade' })
  @Index()
  user!: UserEntity;

  @Property({ length: 10 })
  @Index()
  stockCode!: string;

  @Property({ length: 100 })
  stockName!: string;

  @Property({ length: 30 })
  strategyId!: string;

  /** 전략별 변형
   * "day-trading", "mean-reversion" 전략만 해당
   *
   * day-trading 전략 variant
   * - Breakout
   * - Crossover
   * - VolumeSurge
   *
   * mean-reversion 전략 variant
   * - RSI
   * - Bollinger
   * - Grid
   * - MagicSplit
   * */
  @Property({ length: 30, nullable: true })
  variant?: string;

  @Property({ type: 'decimal', precision: 15, scale: 0 })
  investmentAmount!: number;

  /** 목표 수익률 (%) — 자동 익절 기준 */
  @Property({ type: 'float', default: 5 })
  takeProfitPct: number = 5;

  /** 손절 기준 (%) — 음수값, 자동 손절 기준 */
  @Property({ type: 'float', default: -3 })
  stopLossPct: number = -3;

  /**
   * 보유 종목에서 매수 신호가 추가로 발생했을 때의 처리 방식.
   * 기본 'skip' — 기존 동작 유지(보유 중이면 추가 매수 안 함).
   */
  @Enum({ items: () => AddOnBuyMode, default: AddOnBuyMode.SKIP })
  addOnBuyMode: AddOnBuyMode = AddOnBuyMode.SKIP;

  @Property({ type: 'decimal', precision: 15, scale: 0, default: 0 })
  realizedPnl: number = 0;

  @Property({ type: 'decimal', precision: 15, scale: 0, default: 0 })
  unrealizedPnl: number = 0;

  @Property({ default: 0 })
  holdingQty: number = 0;

  @Property({ type: 'float', default: 0 })
  avgBuyPrice: number = 0;

  @Property({ default: 0 })
  totalBuys: number = 0;

  @Property({ default: 0 })
  totalSells: number = 0;

  @Enum({ items: () => SessionStatus, default: SessionStatus.ACTIVE })
  status: SessionStatus = SessionStatus.ACTIVE;

  /** 세션이 PAUSED 상태가 된 원인 — 자동 재개 대상 판별에 사용 */
  @Property({ length: 20, nullable: true })
  pauseReason?: PauseReason;

  /**
   * 자동 익절/손절 매도 주문 후 실제 잔고가 0이 되는 시점을 기다리는 상태.
   * 체결통보 지연/미사용 환경에서도 이후 balance 동기화 시 최종 PAUSED 전환을 보장한다.
   */
  @Property({ default: false })
  autoPausePending: boolean = false;

  /**
   * ScheduledScannerService.handleDailyScan 스케줄러에 의해 생성/갱신된 세션 여부.
   * 수동 등록과 구분해 UI 에 배지로 표시하고, 스케줄러 기반 운용 현황을 추적하는 데 사용.
   */
  @Property({ default: false })
  scheduledScan: boolean = false;

  @Property({ type: 'float', nullable: true })
  aiScore?: number;

  @Property()
  createdAt: Date = new Date();

  @Property({ nullable: true })
  stoppedAt?: Date;

  /** 실보유/매수대기 상태 — holdingQty 에서 파생, API 응답에만 포함 (DB 컬럼 없음) */
  @Property({ persist: false })
  get positionStatus(): PositionStatus {
    return this.holdingQty > 0 ? PositionStatus.HOLDING : PositionStatus.WAITING;
  }
}
