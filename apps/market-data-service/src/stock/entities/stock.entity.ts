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
  [OptionalProps]?:
    | 'id'
    | 'currency'
    | 'exchange'
    | 'createdAt'
    | 'updatedAt'
    | 'dailyPrices'
    | 'sector'
    | 'delistedAt'
    | 'missingFromCsvDays'
    | 'lastSeenInCsvAt';

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

  /**
   * CSV 탈락 확정 시점부터만 기록하는 전향적 추정일이다.
   * 과거 상폐 종목은 소급 복구할 수 없어 null이 현재 상장을 보장하지 않는다.
   */
  @Property({ type: 'date', nullable: true })
  delistedAt?: Date | null;

  @Property({ nullable: true, default: 0 })
  missingFromCsvDays?: number;

  @Property({ type: 'date', nullable: true })
  lastSeenInCsvAt?: Date | null;

  @OneToMany(() => StockDailyPrice, (price) => price.stock)
  dailyPrices = new Collection<StockDailyPrice>(this);

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
