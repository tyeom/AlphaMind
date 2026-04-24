import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { EntityManager } from '@mikro-orm/postgresql';
import { KisOrderService } from './kis-order.service';
import { KisInquiryService } from './kis-inquiry.service';
import { KisQuotationService } from './kis-quotation.service';
import { KisJournalService } from './kis-journal.service';
import { OrderCashDto } from './dto/order-cash.dto';
import { OrderModifyDto } from './dto/order-modify.dto';
import { OrderCancelDto } from './dto/order-cancel.dto';
import { User } from '../decorator/user.decorator';
import {
  AutoTradingSessionEntity,
  SessionStatus,
} from '../auto-trading/entities/auto-trading-session.entity';
import {
  KisBalanceItem,
  KisBalanceSummary,
  KisCurrentPrice,
  KisDailyPrice,
  KisBuyableOutput,
} from './kis.types';

@ApiTags('KIS (한국투자증권)')
@ApiBearerAuth()
@Controller('kis')
export class KisController {
  constructor(
    private readonly orderService: KisOrderService,
    private readonly inquiryService: KisInquiryService,
    private readonly quotationService: KisQuotationService,
    private readonly journalService: KisJournalService,
    private readonly em: EntityManager,
  ) {}

  // ── 주문 ──

  @Post('order/buy')
  @ApiOperation({ summary: '매수 주문' })
  async buy(@User() user: any, @Body() body: OrderCashDto) {
    return this.orderService.orderCash({
      ...body,
      orderType: 'buy',
      userId: user.sub,
    });
  }

  @Post('order/sell')
  @ApiOperation({ summary: '매도 주문' })
  async sell(@User() user: any, @Body() body: OrderCashDto) {
    return this.orderService.orderCash({
      ...body,
      orderType: 'sell',
      userId: user.sub,
    });
  }

  @Post('order/modify')
  @ApiOperation({ summary: '주문 정정' })
  async modifyOrder(@User() user: any, @Body() body: OrderModifyDto) {
    return this.orderService.modifyOrder({ ...body, userId: user.sub });
  }

  @Post('order/cancel')
  @ApiOperation({ summary: '주문 취소' })
  async cancelOrder(@User() user: any, @Body() body: OrderCancelDto) {
    return this.orderService.cancelOrder({ ...body, userId: user.sub });
  }

  // ── 조회 ──

  @Get('balance')
  @ApiOperation({ summary: '주식 잔고 조회' })
  async getBalance(@User() user: any) {
    const [raw, activeSessions] = await Promise.all([
      this.inquiryService.getBalance(),
      this.em.find(AutoTradingSessionEntity, {
        user: user.sub,
        status: SessionStatus.ACTIVE,
      }),
    ]);

    const sessionByStock = new Map<string, AutoTradingSessionEntity>();
    for (const s of activeSessions) {
      sessionByStock.set(s.stockCode, s);
    }

    return this.mapBalance(raw.items, raw.summary, sessionByStock);
  }

  @Get('buyable')
  @ApiOperation({ summary: '매수 가능 금액/수량 조회' })
  @ApiQuery({
    name: 'stockCode',
    required: true,
    example: '005930',
    description: '종목코드',
  })
  @ApiQuery({
    name: 'price',
    required: false,
    example: '70000',
    description: '주문 단가',
  })
  @ApiQuery({
    name: 'orderDvsn',
    required: false,
    example: '01',
    description: '주문구분 (01: 시장가)',
  })
  async getBuyable(
    @Query('stockCode') stockCode: string,
    @Query('price') price?: string,
    @Query('orderDvsn') orderDvsn?: string,
  ) {
    const raw = await this.inquiryService.getBuyableAmount({
      stockCode,
      price: price ? Number(price) : undefined,
      orderDvsn,
    });
    return this.mapBuyable(raw);
  }

  @Get('orders')
  @ApiOperation({ summary: '일별 주문 체결 내역 조회' })
  @ApiQuery({
    name: 'startDate',
    required: true,
    example: '20260301',
    description: '조회 시작일 (YYYYMMDD)',
  })
  @ApiQuery({
    name: 'endDate',
    required: true,
    example: '20260330',
    description: '조회 종료일 (YYYYMMDD)',
  })
  @ApiQuery({
    name: 'orderType',
    required: false,
    enum: ['all', 'sell', 'buy'],
    description: '주문 유형',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['all', 'executed', 'pending'],
    description: '체결 상태',
  })
  async getDailyOrders(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('orderType') orderType?: 'all' | 'sell' | 'buy',
    @Query('status') status?: 'all' | 'executed' | 'pending',
  ) {
    return this.inquiryService.getDailyOrders({
      startDate,
      endDate,
      orderType,
      status,
    });
  }

  // ── 시세 ──

  @Get('price')
  @ApiOperation({ summary: '주식 현재가 조회' })
  @ApiQuery({
    name: 'stockCode',
    required: true,
    example: '005930',
    description: '종목코드 (6자리)',
  })
  async getCurrentPrice(@Query('stockCode') stockCode: string) {
    const raw = await this.quotationService.getCurrentPrice(stockCode);
    return this.mapCurrentPrice(stockCode, raw);
  }

  @Get('price/daily')
  @ApiOperation({ summary: '일자별 시세 조회' })
  @ApiQuery({
    name: 'stockCode',
    required: true,
    example: '005930',
    description: '종목코드 (6자리)',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['D', 'W', 'M', 'Y'],
    description: '기간 (D:일, W:주, M:월, Y:년)',
  })
  @ApiQuery({
    name: 'adjusted',
    required: false,
    example: 'true',
    description: '수정주가 여부',
  })
  async getDailyPrice(
    @Query('stockCode') stockCode: string,
    @Query('period') period?: 'D' | 'W' | 'M' | 'Y',
    @Query('adjusted') adjusted?: string,
  ) {
    const raw = await this.quotationService.getDailyPrice(
      stockCode,
      period,
      adjusted !== 'false',
    );
    return raw.map((d) => this.mapDailyPrice(d));
  }

  // ── 매매 일지 ──

  @Get('journal')
  @ApiOperation({ summary: '매매 일지 조회' })
  @ApiQuery({
    name: 'date',
    required: false,
    example: '20260330',
    description: '조회 날짜 (YYYYMMDD). 미입력시 오늘',
  })
  async getJournal(@User() user: any, @Query('date') date?: string) {
    return this.journalService.getJournal(user.sub, date);
  }

  // ── 매핑 helpers ──

  private mapBalance(
    items: KisBalanceItem[],
    summary: KisBalanceSummary,
    sessionByStock: Map<string, AutoTradingSessionEntity> = new Map(),
  ) {
    const totalPurchase = Number(summary.pchs_amt_smtl_amt) || 0;
    const totalEval = Number(summary.evlu_amt_smtl_amt) || 0;
    const totalProfitLoss = Number(summary.evlu_pfls_smtl_amt) || 0;

    const filtered = items.filter((i) => Number(i.hldg_qty) > 0);
    const mapped = filtered.map((i) => {
      const session = sessionByStock.get(i.pdno);
      // auto_trading_sessions 에 활성 세션이 있으면 '자동 매매', 아니면 '수동'
      const source: 'auto' | 'manual' = session ? 'auto' : 'manual';
      return {
        stockCode: i.pdno,
        stockName: i.prdt_name,
        holdingQty: Number(i.hldg_qty),
        avgBuyPrice: Number(i.pchs_avg_pric),
        currentPrice: Number(i.prpr),
        evalAmount: Number(i.evlu_amt),
        profitLoss: Number(i.evlu_pfls_amt),
        profitLossRate: Number(i.evlu_pfls_rt),
        source,
        autoTrading: session
          ? {
              sessionId: session.id,
              strategyId: session.strategyId,
              variant: session.variant,
              takeProfitPct: session.takeProfitPct,
              stopLossPct: session.stopLossPct,
              maxHoldingDays: session.maxHoldingDays,
            }
          : null,
      };
    });

    // 자동/수동 집계도 함께 제공하여 프론트에서 별도 계산 불필요
    const autoCount = mapped.filter((i) => i.source === 'auto').length;
    const manualCount = mapped.length - autoCount;

    return {
      items: mapped,
      totalEvalAmount: totalEval,
      totalPurchaseAmount: totalPurchase,
      totalProfitLoss,
      totalProfitLossRate:
        totalPurchase > 0 ? (totalProfitLoss / totalPurchase) * 100 : 0,
      cashBalance: Number(summary.dnca_tot_amt) || 0,
      autoTradingCount: autoCount,
      manualCount,
    };
  }

  private mapCurrentPrice(stockCode: string, raw: KisCurrentPrice) {
    return {
      stockCode: raw.stck_shrn_iscd || stockCode,
      stockName: raw.hts_kor_isnm || '',
      currentPrice: Number(raw.stck_prpr),
      change: Number(raw.prdy_vrss),
      changeRate: Number(raw.prdy_ctrt),
      changeSign: raw.prdy_vrss_sign,
      openPrice: Number(raw.stck_oprc),
      highPrice: Number(raw.stck_hgpr),
      lowPrice: Number(raw.stck_lwpr),
      volume: Number(raw.acml_vol),
      tradingValue: Number(raw.acml_tr_pbmn),
      /** 종목 상태 구분 코드 (51/52/53/54/58/59 등 이상 상태 식별) */
      iscdStatClsCode: raw.iscd_stat_cls_code ?? '',
      /** 시장 경고 코드 (01: 투자주의 / 02: 투자경고 / 03: 투자위험) */
      mrktWarnClsCode: raw.mrkt_warn_cls_code ?? '',
    };
  }

  private mapDailyPrice(d: KisDailyPrice) {
    return {
      date: d.stck_bsop_date,
      openPrice: Number(d.stck_oprc),
      highPrice: Number(d.stck_hgpr),
      lowPrice: Number(d.stck_lwpr),
      closePrice: Number(d.stck_clpr),
      volume: Number(d.acml_vol),
      changeRate: Number(d.prdy_ctrt),
    };
  }

  private mapBuyable(raw: KisBuyableOutput) {
    return {
      buyableAmount: Number(raw.max_buy_amt),
      buyableQty: Number(raw.max_buy_qty),
      cashBalance: Number(raw.ord_psbl_cash),
    };
  }
}
