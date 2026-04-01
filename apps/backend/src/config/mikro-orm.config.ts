import { Options, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { UserEntity } from '../user/entities/user.entity';
import { TradeHistoryEntity } from '../kis/entities/trade-history.entity';
import { TradeDailySummaryEntity } from '../kis/entities/trade-daily-summary.entity';

const config: Options = {
  driver: PostgreSqlDriver,
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USERNAME ?? 'alpha',
  password: process.env.DB_PASSWORD ?? 'alpha1234',
  dbName: process.env.DB_DATABASE ?? 'alpha_mind',
  entities: [UserEntity, TradeHistoryEntity, TradeDailySummaryEntity],
  extensions: [Migrator],
  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
  },
};

export default config;
