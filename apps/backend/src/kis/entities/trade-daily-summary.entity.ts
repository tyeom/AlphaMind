import {
  Entity,
  PrimaryKey,
  Property,
  ManyToOne,
  OptionalProps,
  Index,
  Unique,
} from '@mikro-orm/core';
import { UserEntity } from '../../user/entities/user.entity';

export interface StockSummary {
  stockCode: string;
  stockName: string;
  buyQty: number;
  buyAmount: number;
  sellQty: number;
  sellAmount: number;
  profitLoss: number;
  profitLossRate: number;
  holdingQty: number;
  avgBuyPrice: number;
  currentPrice: number;
  evalAmount: number;
  evalProfitLoss: number;
  evalProfitLossRate: number;
}

@Entity({ tableName: 'trade_daily_summaries' })
@Unique({ properties: ['user', 'date'] })
export class TradeDailySummaryEntity {
  [OptionalProps]?: 'id' | 'createdAt';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => UserEntity, { deleteRule: 'cascade' })
  @Index()
  user!: UserEntity;

  @Property({ length: 8 })
  @Index()
  date!: string;

  @Property({ type: 'decimal', precision: 15, scale: 0, default: 0 })
  totalBuyAmount!: number;

  @Property({ type: 'decimal', precision: 15, scale: 0, default: 0 })
  totalSellAmount!: number;

  @Property({ type: 'decimal', precision: 15, scale: 0, default: 0 })
  realizedProfitLoss!: number;

  @Property({ type: 'decimal', precision: 15, scale: 0, default: 0 })
  totalEvalAmount!: number;

  @Property({ type: 'decimal', precision: 15, scale: 0, default: 0 })
  totalPurchaseAmount!: number;

  @Property({ type: 'decimal', precision: 15, scale: 0, default: 0 })
  totalEvalProfitLoss!: number;

  @Property({ type: 'float', default: 0 })
  totalProfitLossRate!: number;

  @Property({ type: 'decimal', precision: 15, scale: 0, default: 0 })
  cashBalance!: number;

  @Property({ default: true })
  hasBalanceSnapshot: boolean = true;

  @Property({ type: 'jsonb', nullable: true })
  stockSummaries?: StockSummary[];

  @Property()
  createdAt: Date = new Date();
}
