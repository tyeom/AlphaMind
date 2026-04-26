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
  isPartial?: boolean;
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
  private readonly marketTimeZone = 'Asia/Seoul';

  constructor(
    private readonly em: EntityManager,
    private readonly inquiryService: KisInquiryService,
  ) {}

  /** 매매 일지 조회 (오늘 또는 특정 날짜) */
  async getJournal(userId: number, date?: string): Promise<JournalResponse> {
    const now = this.getMarketNowParts();
    const today = now.date;
    const targetDate = date || today;
    const isToday = targetDate === today;
    const isAfterMarketClose =
      now.hour > 16 || (now.hour === 16 && now.minute >= 10);

    if (targetDate > today) {
      return this.buildUnavailableResponse(
        targetDate,
        '미래 날짜의 매매 일지는 조회할 수 없습니다.',
      );
    }

    // 저장된 요약이 있으면 반환
    const existing = await this.em.findOne(TradeDailySummaryEntity, {
      user: userId,
      date: targetDate,
    });

    // 오늘 날짜이고 장 마감 전(16:10)인 경우
    if (isToday) {
      if (!isAfterMarketClose) {
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

      const generated = await this.generateAndSaveJournal(
        userId,
        targetDate,
        true,
      );
      if (generated.isAvailable || !existing) {
        return generated;
      }

      const prevDay = existing.hasBalanceSnapshot
        ? await this.getPreviousDaySummary(userId, targetDate)
        : null;
      const fallback = this.buildResponse(existing, prevDay);
      fallback.message =
        '실시간 갱신에 실패해 마지막 저장 데이터를 표시합니다. 잠시 후 다시 시도해 주세요.';
      return fallback;
    }

    if (existing) {
      const prevDay = existing.hasBalanceSnapshot
        ? await this.getPreviousDaySummary(userId, targetDate)
        : null;
      return this.buildResponse(existing, prevDay);
    }

    // 과거 날짜 DB 미존재: KIS API 조회 후 저장
    return this.generateAndSaveJournal(userId, targetDate, false);
  }

  /** KIS API에서 데이터 조회 후 일지 생성 및 저장 */
  private async generateAndSaveJournal(
    userId: number,
    date: string,
    isToday: boolean,
  ): Promise<JournalResponse> {
    let orders: any[];
    let balanceData: Awaited<
      ReturnType<KisInquiryService['getBalance']>
    > | null;
    let realizedBalanceData: Awaited<
      ReturnType<KisInquiryService['getBalanceWithRealized']>
    > | null;

    try {
      if (isToday) {
        [orders, balanceData, realizedBalanceData] = await Promise.all([
          this.inquiryService.getDailyOrders({
            startDate: date,
            endDate: date,
            status: 'executed',
          }),
          this.inquiryService.getBalance().catch((err) => {
            this.logger.warn(
              `잔고 조회 실패, 실현손익 잔고로 대체 시도: ${err instanceof Error ? err.message : err}`,
            );
            return null;
          }),
          this.inquiryService.getBalanceWithRealized().catch((err) => {
            this.logger.warn(
              `실현손익 포함 잔고 조회 실패, 기본 잔고 계산으로 대체: ${err instanceof Error ? err.message : err}`,
            );
            return null;
          }),
        ]);
      } else {
        orders = await this.inquiryService.getDailyOrders({
          startDate: date,
          endDate: date,
          status: 'executed',
        });
        balanceData = null;
        realizedBalanceData = null;
      }
    } catch (err) {
      this.logger.error(
        `매매 일지 원본 조회 실패 (${date}): ${err instanceof Error ? err.message : err}`,
      );

      return this.buildUnavailableResponse(
        date,
        isToday
          ? '매매 일지를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.'
          : '해당 날짜의 매매 일지를 KIS에서 조회하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      );
    }

    // getBalance() 실패 시 getBalanceWithRealized()로 대체
    // (KisBalanceRealizedSummary extends KisBalanceSummary이므로 동일 필드 포함)
    const effectiveItems =
      balanceData?.items ?? realizedBalanceData?.items ?? [];
    const effectiveSummary =
      balanceData?.summary ?? realizedBalanceData?.summary;
    const hasBalanceSnapshot = Boolean(effectiveSummary);

    const stockSummaries = this.buildStockSummaries(
      orders,
      effectiveItems,
      effectiveSummary ?? ({} as KisBalanceSummary),
    );

    const totalBuyAmount =
      this.parseNumber(realizedBalanceData?.summary.thdt_buy_amt) ??
      stockSummaries.reduce((s, i) => s + i.buyAmount, 0);
    const totalSellAmount =
      this.parseNumber(realizedBalanceData?.summary.thdt_sll_amt) ??
      stockSummaries.reduce((s, i) => s + i.sellAmount, 0);
    const realizedProfitLoss =
      this.parseNumber(realizedBalanceData?.summary.rlzt_pfls) ??
      this.estimateRealizedProfitLoss(stockSummaries);
    const totalEval = Number(effectiveSummary?.evlu_amt_smtl_amt) || 0;
    const totalPurchase = Number(effectiveSummary?.pchs_amt_smtl_amt) || 0;
    const totalEvalProfitLoss =
      Number(effectiveSummary?.evlu_pfls_smtl_amt) || 0;
    const totalProfitLossRate = this.calculateTotalProfitLossRate(
      totalEvalProfitLoss,
      totalPurchase,
    );
    const cashBalance = Number(effectiveSummary?.dnca_tot_amt) || 0;

    try {
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
        summary.hasBalanceSnapshot = hasBalanceSnapshot;
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
          hasBalanceSnapshot,
          stockSummaries,
        });
      }

      await this.em.persistAndFlush(summary);

      const prevDay = hasBalanceSnapshot
        ? await this.getPreviousDaySummary(userId, date)
        : null;
      return this.buildResponse(summary, prevDay);
    } catch (err) {
      this.logger.error(
        `매매 일지 저장 실패 (${date}): ${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }
  }

  private buildStockSummaries(
    orders: any[],
    balanceItems: KisBalanceItem[],
    _summary: KisBalanceSummary,
  ): StockSummary[] {
    // 체결 내역에서 종목별 매수/매도 집계
    const stockMap = new Map<
      string,
      {
        stockName: string;
        buyQty: number;
        buyAmount: number;
        sellQty: number;
        sellAmount: number;
      }
    >();

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
      ...balanceItems.filter((i) => Number(i.hldg_qty) > 0).map((i) => i.pdno),
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
    const hasBalanceSnapshot = summary.hasBalanceSnapshot ?? true;
    const totalPurchaseAmount = Number(summary.totalPurchaseAmount);
    const totalEvalProfitLoss = Number(summary.totalEvalProfitLoss);
    const response: JournalResponse = {
      date: summary.date,
      isAvailable: true,
      isPartial: !hasBalanceSnapshot,
      stockSummaries: summary.stockSummaries ?? [],
      totalBuyAmount: Number(summary.totalBuyAmount),
      totalSellAmount: Number(summary.totalSellAmount),
      realizedProfitLoss: Number(summary.realizedProfitLoss),
      totalEvalAmount: Number(summary.totalEvalAmount),
      totalPurchaseAmount,
      totalEvalProfitLoss,
      totalProfitLossRate: hasBalanceSnapshot
        ? this.calculateTotalProfitLossRate(
            totalEvalProfitLoss,
            totalPurchaseAmount,
          )
        : 0,
      cashBalance: Number(summary.cashBalance),
    };

    if (!hasBalanceSnapshot) {
      response.message =
        '과거 날짜의 매매 일지는 체결 내역 기준으로 생성되었습니다. 평가금액과 예수금은 포함되지 않습니다.';
      return response;
    }

    if (prevDay && (prevDay.hasBalanceSnapshot ?? true)) {
      const prevEval =
        Number(prevDay.totalEvalAmount) + Number(prevDay.cashBalance);
      const todayEval =
        Number(summary.totalEvalAmount) + Number(summary.cashBalance);
      response.previousDay = {
        date: prevDay.date,
        totalEvalAmount: Number(prevDay.totalEvalAmount),
        totalProfitLossRate: this.calculateTotalProfitLossRate(
          Number(prevDay.totalEvalProfitLoss),
          Number(prevDay.totalPurchaseAmount),
        ),
      };
      response.dayOverDayChange =
        prevEval > 0 ? ((todayEval - prevEval) / prevEval) * 100 : 0;
    } else if (prevDay) {
      response.message =
        '이전 매매 일지가 부분 데이터라 전일 대비 변화율은 계산하지 않습니다.';
    }

    return response;
  }

  private buildUnavailableResponse(
    date: string,
    message: string,
  ): JournalResponse {
    return {
      date,
      isAvailable: false,
      message,
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

  private getMarketNowParts(): { date: string; hour: number; minute: number } {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.marketTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date());
    const values = Object.fromEntries(
      parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute', string>;

    return {
      date: `${values.year}${values.month}${values.day}`,
      hour: Number(values.hour),
      minute: Number(values.minute),
    };
  }

  private parseNumber(value?: string | null): number | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private calculateTotalProfitLossRate(
    totalEvalProfitLoss: number,
    totalPurchaseAmount: number,
  ): number {
    return totalPurchaseAmount > 0
      ? (totalEvalProfitLoss / totalPurchaseAmount) * 100
      : 0;
  }

  private estimateRealizedProfitLoss(stockSummaries: StockSummary[]): number {
    return stockSummaries.reduce((sum, item) => {
      if (item.buyQty > 0 && item.sellQty > 0) {
        return sum + item.profitLoss;
      }
      return sum;
    }, 0);
  }
}
