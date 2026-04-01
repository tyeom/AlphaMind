import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { KisInquiryService } from './kis-inquiry.service';
import {
  TradeDailySummaryEntity,
  StockSummary,
} from './entities/trade-daily-summary.entity';
import { UserEntity } from '../user/entities/user.entity';
import { KisBalanceItem, KisBalanceSummary } from './kis.types';

export interface JournalResponse {
  date: string;
  isAvailable: boolean;
  message?: string;
  stockSummaries: StockSummary[];
  totalBuyAmount: number;
  totalSellAmount: number;
  realizedProfitLoss: number;
  totalEvalAmount: number;
  totalPurchaseAmount: number;
  totalEvalProfitLoss: number;
  totalProfitLossRate: number;
  cashBalance: number;
  previousDay?: {
    date: string;
    totalEvalAmount: number;
    totalProfitLossRate: number;
  };
  dayOverDayChange?: number;
}

@Injectable()
export class KisJournalService {
  private readonly logger = new Logger(KisJournalService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly inquiryService: KisInquiryService,
  ) {}

  /** 매매 일지 조회 (오늘 또는 특정 날짜) */
  async getJournal(userId: number, date?: string): Promise<JournalResponse> {
    const targetDate = date || this.getTodayString();

    // 저장된 요약이 있으면 반환
    const existing = await this.em.findOne(TradeDailySummaryEntity, {
      user: userId,
      date: targetDate,
    });

    if (existing) {
      const prevDay = await this.getPreviousDaySummary(userId, targetDate);
      return this.buildResponse(existing, prevDay);
    }

    // 오늘 날짜이고 장 마감 후(16:10)인 경우 실시간으로 생성
    const now = new Date();
    const isToday = targetDate === this.getTodayString();
    const isAfterMarketClose = now.getHours() > 16 || (now.getHours() === 16 && now.getMinutes() >= 10);

    if (isToday && isAfterMarketClose) {
      return this.generateAndSaveJournal(userId, targetDate);
    }

    if (isToday && !isAfterMarketClose) {
      return {
        date: targetDate,
        isAvailable: false,
        message: '매매 일지는 오후 4시 10분 이후에 확인할 수 있습니다.',
        stockSummaries: [],
        totalBuyAmount: 0,
        totalSellAmount: 0,
        realizedProfitLoss: 0,
        totalEvalAmount: 0,
        totalPurchaseAmount: 0,
        totalEvalProfitLoss: 0,
        totalProfitLossRate: 0,
        cashBalance: 0,
      };
    }

    // 과거 날짜인데 데이터가 없는 경우
    return {
      date: targetDate,
      isAvailable: false,
      message: '해당 날짜의 매매 일지가 없습니다.',
      stockSummaries: [],
      totalBuyAmount: 0,
      totalSellAmount: 0,
      realizedProfitLoss: 0,
      totalEvalAmount: 0,
      totalPurchaseAmount: 0,
      totalEvalProfitLoss: 0,
      totalProfitLossRate: 0,
      cashBalance: 0,
    };
  }

  /** KIS API에서 데이터 조회 후 일지 생성 및 저장 */
  private async generateAndSaveJournal(
    userId: number,
    date: string,
  ): Promise<JournalResponse> {
    try {
      // KIS API 호출: 오늘 체결 내역 + 잔고
      const [orders, balanceData] = await Promise.all([
        this.inquiryService.getDailyOrders({
          startDate: date,
          endDate: date,
          status: 'executed',
        }),
        this.inquiryService.getBalance(),
      ]);

      const stockSummaries = this.buildStockSummaries(
        orders,
        balanceData.items,
        balanceData.summary,
      );

      const totalBuyAmount = stockSummaries.reduce((s, i) => s + i.buyAmount, 0);
      const totalSellAmount = stockSummaries.reduce((s, i) => s + i.sellAmount, 0);
      const realizedProfitLoss = totalSellAmount - totalBuyAmount;
      const totalEval = Number(balanceData.summary.evlu_amt_smtl_amt) || 0;
      const totalPurchase = Number(balanceData.summary.pchs_amt_smtl_amt) || 0;
      const totalEvalProfitLoss = Number(balanceData.summary.evlu_pfls_smtl_amt) || 0;
      const totalProfitLossRate = totalPurchase > 0
        ? (totalEvalProfitLoss / totalPurchase) * 100
        : 0;
      const cashBalance = Number(balanceData.summary.dnca_tot_amt) || 0;

      // DB에 저장 (upsert)
      let summary = await this.em.findOne(TradeDailySummaryEntity, {
        user: userId,
        date,
      });

      if (summary) {
        summary.totalBuyAmount = totalBuyAmount;
        summary.totalSellAmount = totalSellAmount;
        summary.realizedProfitLoss = realizedProfitLoss;
        summary.totalEvalAmount = totalEval;
        summary.totalPurchaseAmount = totalPurchase;
        summary.totalEvalProfitLoss = totalEvalProfitLoss;
        summary.totalProfitLossRate = totalProfitLossRate;
        summary.cashBalance = cashBalance;
        summary.stockSummaries = stockSummaries;
      } else {
        summary = this.em.create(TradeDailySummaryEntity, {
          user: this.em.getReference(UserEntity, userId),
          date,
          totalBuyAmount,
          totalSellAmount,
          realizedProfitLoss,
          totalEvalAmount: totalEval,
          totalPurchaseAmount: totalPurchase,
          totalEvalProfitLoss,
          totalProfitLossRate,
          cashBalance,
          stockSummaries,
        });
      }

      await this.em.persistAndFlush(summary);

      const prevDay = await this.getPreviousDaySummary(userId, date);
      return this.buildResponse(summary, prevDay);
    } catch (err) {
      this.logger.error('매매 일지 생성 실패', err);
      throw err;
    }
  }

  private buildStockSummaries(
    orders: any[],
    balanceItems: KisBalanceItem[],
    _summary: KisBalanceSummary,
  ): StockSummary[] {
    // 체결 내역에서 종목별 매수/매도 집계
    const stockMap = new Map<string, {
      stockName: string;
      buyQty: number;
      buyAmount: number;
      sellQty: number;
      sellAmount: number;
    }>();

    for (const order of orders) {
      const code = order.pdno || order.PDNO || '';
      const name = order.prdt_name || order.PRDT_NAME || '';
      const qty = Number(order.tot_ccld_qty || order.TOT_CCLD_QTY || 0);
      const amt = Number(order.tot_ccld_amt || order.TOT_CCLD_AMT || 0);
      const side = order.sll_buy_dvsn_cd || order.SLL_BUY_DVSN_CD || '';

      if (!code || qty === 0) continue;

      const existing = stockMap.get(code) || {
        stockName: name,
        buyQty: 0,
        buyAmount: 0,
        sellQty: 0,
        sellAmount: 0,
      };

      if (side === '02') {
        existing.buyQty += qty;
        existing.buyAmount += amt;
      } else if (side === '01') {
        existing.sellQty += qty;
        existing.sellAmount += amt;
      }
      existing.stockName = name || existing.stockName;
      stockMap.set(code, existing);
    }

    // 잔고 정보와 결합
    const balanceMap = new Map<string, KisBalanceItem>();
    for (const item of balanceItems) {
      balanceMap.set(item.pdno, item);
    }

    // 오늘 체결된 종목 + 보유 종목 결합
    const allCodes = new Set([
      ...stockMap.keys(),
      ...balanceItems
        .filter((i) => Number(i.hldg_qty) > 0)
        .map((i) => i.pdno),
    ]);

    const summaries: StockSummary[] = [];
    for (const code of allCodes) {
      const trade = stockMap.get(code);
      const balance = balanceMap.get(code);
      const holdingQty = Number(balance?.hldg_qty ?? 0);
      const avgBuyPrice = Number(balance?.pchs_avg_pric ?? 0);
      const currentPrice = Number(balance?.prpr ?? 0);
      const evalAmount = Number(balance?.evlu_amt ?? 0);
      const evalProfitLoss = Number(balance?.evlu_pfls_amt ?? 0);
      const evalProfitLossRate = Number(balance?.evlu_pfls_rt ?? 0);

      summaries.push({
        stockCode: code,
        stockName: trade?.stockName || balance?.prdt_name || '',
        buyQty: trade?.buyQty ?? 0,
        buyAmount: trade?.buyAmount ?? 0,
        sellQty: trade?.sellQty ?? 0,
        sellAmount: trade?.sellAmount ?? 0,
        profitLoss: (trade?.sellAmount ?? 0) - (trade?.buyAmount ?? 0),
        profitLossRate:
          trade && trade.buyAmount > 0
            ? ((trade.sellAmount - trade.buyAmount) / trade.buyAmount) * 100
            : 0,
        holdingQty,
        avgBuyPrice,
        currentPrice,
        evalAmount,
        evalProfitLoss,
        evalProfitLossRate,
      });
    }

    return summaries;
  }

  private async getPreviousDaySummary(
    userId: number,
    currentDate: string,
  ): Promise<TradeDailySummaryEntity | null> {
    return this.em.findOne(
      TradeDailySummaryEntity,
      { user: userId, date: { $lt: currentDate } },
      { orderBy: { date: 'DESC' } },
    );
  }

  private buildResponse(
    summary: TradeDailySummaryEntity,
    prevDay: TradeDailySummaryEntity | null,
  ): JournalResponse {
    const response: JournalResponse = {
      date: summary.date,
      isAvailable: true,
      stockSummaries: summary.stockSummaries ?? [],
      totalBuyAmount: Number(summary.totalBuyAmount),
      totalSellAmount: Number(summary.totalSellAmount),
      realizedProfitLoss: Number(summary.realizedProfitLoss),
      totalEvalAmount: Number(summary.totalEvalAmount),
      totalPurchaseAmount: Number(summary.totalPurchaseAmount),
      totalEvalProfitLoss: Number(summary.totalEvalProfitLoss),
      totalProfitLossRate: Number(summary.totalProfitLossRate),
      cashBalance: Number(summary.cashBalance),
    };

    if (prevDay) {
      const prevEval = Number(prevDay.totalEvalAmount) + Number(prevDay.cashBalance);
      const todayEval = Number(summary.totalEvalAmount) + Number(summary.cashBalance);
      response.previousDay = {
        date: prevDay.date,
        totalEvalAmount: Number(prevDay.totalEvalAmount),
        totalProfitLossRate: Number(prevDay.totalProfitLossRate),
      };
      response.dayOverDayChange = prevEval > 0
        ? ((todayEval - prevEval) / prevEval) * 100
        : 0;
    }

    return response;
  }

  private getTodayString(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
}
