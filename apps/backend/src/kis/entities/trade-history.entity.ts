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
  SUCCESS = 'success',
  FAILED = 'failed',
}

@Entity({ tableName: 'trade_histories' })
export class TradeHistoryEntity {
  [OptionalProps]?: 'id' | 'createdAt';

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

  @Property({ nullable: true, type: 'text' })
  errorMessage?: string;

  @Property({ type: 'jsonb', nullable: true })
  rawResponse?: Record<string, any>;

  @Property()
  createdAt: Date = new Date();
}
