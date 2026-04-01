import {
  Entity,
  PrimaryKey,
  Property,
  ManyToOne,
  Unique,
  Index,
  OptionalProps,
} from '@mikro-orm/core';
import { Stock } from './stock.entity';

@Entity({ tableName: 'stock_daily_prices' })
@Unique({ properties: ['stock', 'date'] })
export class StockDailyPrice {
  [OptionalProps]?: 'id' | 'createdAt' | 'open' | 'high' | 'low' | 'close' | 'volume' | 'adjClose';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => Stock)
  @Index()
  stock!: Stock;

  @Property({ type: 'date' })
  @Index()
  date!: Date;

  @Property({ type: 'double', nullable: true })
  open?: number;

  @Property({ type: 'double', nullable: true })
  high?: number;

  @Property({ type: 'double', nullable: true })
  low?: number;

  @Property({ type: 'double', nullable: true })
  close?: number;

  @Property({ type: 'bigint', nullable: true })
  volume?: number;

  @Property({ type: 'double', nullable: true })
  adjClose?: number;

  @Property()
  createdAt: Date = new Date();
}
