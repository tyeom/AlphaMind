import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Stock } from './entities/stock.entity';
import { StockDailyPrice } from './entities/stock-daily-price.entity';
import { StockCollectionSavepoint } from './entities/stock-collection-savepoint.entity';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { YahooFinanceModule } from '../yahoo-finance/yahoo-finance.module';

@Module({
  imports: [
    MikroOrmModule.forFeature([Stock, StockDailyPrice, StockCollectionSavepoint]),
    YahooFinanceModule,
  ],
  controllers: [StockController],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
