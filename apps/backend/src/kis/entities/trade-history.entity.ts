import {
  Entity,
  PrimaryKey,
  Property,
  Enum,
  ManyToOne,
  OptionalProps,
  Index,
} from '@mikro-orm/core';
import { UserEntity } from '../../user/entities/user.entity';

export enum TradeType {
  BUY = 'buy',
  SELL = 'sell',
}

export enum TradeAction {
  ORDER = 'order',
  MODIFY = 'modify',
  CANCEL = 'cancel',
}

export enum TradeStatus {
  ACCEPTED = 'accepted',
  PARTIAL = 'partial',
  EXECUTED = 'executed',
  SUCCESS = 'success',
  FAILED = 'failed',
}

@Entity({ tableName: 'trade_histories' })
export class TradeHistoryEntity {
  [OptionalProps]?:
    | 'id'
    | 'createdAt'
    | 'executedQuantity'
    | 'executedAmount'
    | 'lastExecutedAt';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => UserEntity, { deleteRule: 'cascade' })
  @Index()
  user!: UserEntity;

  @Enum(() => TradeAction)
  action!: TradeAction;

  @Enum({ items: () => TradeType, nullable: true })
  tradeType?: TradeType;

  @Property({ length: 6 })
  @Index()
  stockCode!: string;

  @Property({ nullable: true })
  stockName?: string;

  /** 주문 구분
   * [SOR]
   * 00 : 지정가
   * 01 : 시장가
   * 03 : 최유리지정가
   * 04 : 최우선지정가
   * 11 : IOC지정가 (즉시체결,잔량취소)
   * 12 : FOK지정가 (즉시체결,전량취소)
   * 13 : IOC시장가 (즉시체결,잔량취소)
   * 14 : FOK시장가 (즉시체결,전량취소)
   * 15 : IOC최유리 (즉시체결,잔량취소)
   * 16 : FOK최유리 (즉시체결,전량취소)
   * */
  @Property()
  orderDvsn!: string;

  @Property()
  quantity!: number;

  @Property()
  price!: number;

  @Property({ nullable: true })
  kisOrderNo?: string;

  @Property({ nullable: true })
  kisOrgOrderNo?: string;

  @Enum(() => TradeStatus)
  status!: TradeStatus;

  @Property({ default: 0 })
  executedQuantity: number = 0;

  @Property({ type: 'decimal', precision: 15, scale: 0, default: 0 })
  executedAmount: number = 0;

  @Property({ nullable: true })
  lastExecutedAt?: Date;

  @Property({ nullable: true, type: 'text' })
  errorMessage?: string;

  @Property({ type: 'jsonb', nullable: true })
  rawResponse?: Record<string, any>;

  @Property()
  createdAt: Date = new Date();
}
