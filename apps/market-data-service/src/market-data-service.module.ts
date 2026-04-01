import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { CacheModule } from '@nestjs/cache-manager';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthGuard } from '@alpha-mind/common';
import { MarketDataServiceController } from './market-data-service.controller';
import { MarketDataServiceService } from './market-data-service.service';
import { YahooFinanceModule } from './yahoo-finance/yahoo-finance.module';
import { StockModule } from './stock/stock.module';
import { HealthModule } from './health/health.module';
import { StrategyModule } from './strategy/strategy.module';
import { AiScoringModule } from './ai-scoring/ai-scoring.module';
import { validationSchema } from './config/validation.schema';
import { Stock } from './stock/entities/stock.entity';
import { StockDailyPrice } from './stock/entities/stock-daily-price.entity';
import { StockCollectionSavepoint } from './stock/entities/stock-collection-savepoint.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema,
      validationOptions: {
        abortEarly: true,
      },
    }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): JwtModuleOptions => ({
        secret: configService.get<string>('JWT_SECRET'),
      }),
    }),
    CacheModule.register({
      isGlobal: true,
      ttl: 60 * 1000, // 기본 TTL 60초
      max: 500,
    }),
    ScheduleModule.forRoot(),
    MikroOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        driver: PostgreSqlDriver,
        host: configService.get<string>('DB_HOST'),
        port: configService.get<number>('DB_PORT'),
        user: configService.get<string>('DB_USERNAME'),
        password: configService.get<string>('DB_PASSWORD'),
        dbName: configService.get<string>('DB_DATABASE'),
        entities: [Stock, StockDailyPrice, StockCollectionSavepoint],
        debug: configService.get<string>('NODE_ENV') === 'development',
        allowGlobalContext: true,
        extensions: [Migrator],
        migrations: {
          path: './dist/migrations',
          pathTs: './src/migrations',
        },
        schemaGenerator: { disableForeignKeys: false },
      }),
    }),
    YahooFinanceModule,
    StockModule,
    StrategyModule,
    AiScoringModule,
    HealthModule,
  ],
  controllers: [MarketDataServiceController],
  providers: [
    MarketDataServiceService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class MarketDataServiceModule {}
