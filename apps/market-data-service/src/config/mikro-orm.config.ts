import { Options, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Stock } from '../stock/entities/stock.entity';
import { StockDailyPrice } from '../stock/entities/stock-daily-price.entity';
import { StockCollectionSavepoint } from '../stock/entities/stock-collection-savepoint.entity';

const config: Options = {
  driver: PostgreSqlDriver,
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USERNAME ?? 'alpha',
  password: process.env.DB_PASSWORD ?? 'alpha1234',
  dbName: process.env.DB_DATABASE ?? 'alpha_mind',
  entities: [Stock, StockDailyPrice, StockCollectionSavepoint],
  extensions: [Migrator],
  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
  },
};

export default config;
