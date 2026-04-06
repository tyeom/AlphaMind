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

@Entity({ tableName: 'auto_trading_sessions' })
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
    | 'takeProfitPct'
    | 'stopLossPct'
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

  @Property({ type: 'float', nullable: true })
  aiScore?: number;

  @Property()
  createdAt: Date = new Date();

  @Property({ nullable: true })
  stoppedAt?: Date;
}
