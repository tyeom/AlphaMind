import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { KisService } from './kis.service';
import { KisOrderService } from './kis-order.service';
import { KisInquiryService } from './kis-inquiry.service';
import { KisQuotationService } from './kis-quotation.service';
import { KisJournalService } from './kis-journal.service';
import { KisWebSocketService } from './kis-websocket.service';
import { KisWebSocketGateway } from './kis-websocket.gateway';
import { KisController } from './kis.controller';
import { TradeHistoryEntity } from './entities/trade-history.entity';
import { TradeDailySummaryEntity } from './entities/trade-daily-summary.entity';
import { AutoTradingSessionEntity } from '../auto-trading/entities/auto-trading-session.entity';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
    }),
    MikroOrmModule.forFeature([
      TradeHistoryEntity,
      TradeDailySummaryEntity,
      AutoTradingSessionEntity,
    ]),
  ],
  controllers: [KisController],
  providers: [
    KisService,
    KisOrderService,
    KisInquiryService,
    KisQuotationService,
    KisJournalService,
    KisWebSocketService,
    KisWebSocketGateway,
  ],
  exports: [
    KisService,
    KisOrderService,
    KisInquiryService,
    KisQuotationService,
    KisJournalService,
    KisWebSocketService,
  ],
})
export class KisModule {}
