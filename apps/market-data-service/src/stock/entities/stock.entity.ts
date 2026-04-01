import {
  Entity,
  PrimaryKey,
  Property,
  OneToMany,
  Collection,
  Unique,
  OptionalProps,
} from '@mikro-orm/core';
import { StockDailyPrice } from './stock-daily-price.entity';

@Entity({ tableName: 'stocks' })
export class Stock {
  [OptionalProps]?: 'id' | 'currency' | 'exchange' | 'createdAt' | 'updatedAt' | 'dailyPrices' | 'sector';

  @PrimaryKey()
  id!: number;

  @Property({ length: 10 })
  @Unique()
  code!: string;

  @Property({ length: 100 })
  name!: string;

  @Property({ length: 100, nullable: true })
  sector?: string;

  @Property({ length: 10, default: 'KRW' })
  currency!: string;

  @Property({ length: 20, default: 'KSC' })
  exchange!: string;

  @OneToMany(() => StockDailyPrice, (price) => price.stock)
  dailyPrices = new Collection<StockDailyPrice>(this);

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
