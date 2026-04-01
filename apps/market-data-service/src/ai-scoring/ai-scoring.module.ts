import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Stock } from '../stock/entities/stock.entity';
import { StockDailyPrice } from '../stock/entities/stock-daily-price.entity';
import { AiScoringController } from './ai-scoring.controller';
import { AiScoringService } from './ai-scoring.service';

@Module({
  imports: [MikroOrmModule.forFeature([Stock, StockDailyPrice])],
  controllers: [AiScoringController],
  providers: [AiScoringService],
})
export class AiScoringModule {}
