import {
  Entity,
  PrimaryKey,
  Property,
  OneToOne,
  Unique,
  OptionalProps,
} from '@mikro-orm/core';
import { Stock } from './stock.entity';

@Entity({ tableName: 'stock_collection_savepoints' })
export class StockCollectionSavepoint {
  [OptionalProps]?: 'id' | 'createdAt' | 'updatedAt';

  @PrimaryKey()
  id!: number;

  @OneToOne(() => Stock)
  @Unique()
  stock!: Stock;

  @Property({ type: 'date', comment: '마지막으로 수집된 차트 데이터의 날짜' })
  lastCollectedDate!: Date;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
