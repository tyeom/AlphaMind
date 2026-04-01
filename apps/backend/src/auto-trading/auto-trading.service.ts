import { Injectable, Logger, NotFoundException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Subscription } from 'rxjs';
import {
  CandleData,
  SignalDirection,
  analyzeDayTrading,
  analyzeMeanReversion,
  analyzeInfinityBot,
  analyzeCandlePattern,
  StrategyAnalysisResult,
} from '@alpha-mind/strategies';
import { AutoTradingSessionEntity, SessionStatus } from './entities/auto-trading-session.entity';
import { StartSessionDto } from './dto/start-session.dto';
import { KisOrderService } from '../kis/kis-order.service';
import { KisWebSocketService } from '../kis/kis-websocket.service';
import { KisQuotationService } from '../kis/kis-quotation.service';
import { UserEntity } from '../user/entities/user.entity';

const STRATEGY_MAP: Record<string, (candles: CandleData[], config?: any) => StrategyAnalysisResult> = {
  'day-trading': analyzeDayTrading,
  'mean-reversion': analyzeMeanReversion,
  'infinity-bot': analyzeInfinityBot,
  'candle-pattern': analyzeCandlePattern,
};

/** 자동 익절/손절 설정 */
const AUTO_TAKE_PROFIT_PCT = 5;
const AUTO_STOP_LOSS_PCT = -3;
const TRADE_RATIO_PCT = 10;

@Injectable()
export class AutoTradingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoTradingService.name);
  private executionSub?: Subscription;
  private notificationSub?: Subscription;
  /** 종목별 최신 가격 캐시 */
  private latestPrices = new Map<string, number>();
  /** 모니터링 인터벌 */
  private monitorInterval?: ReturnType<typeof setInterval>;

  constructor(
    private readonly em: EntityManager,
    private readonly kisOrderService: KisOrderService,
    private readonly kisWsService: KisWebSocketService,
    private readonly kisQuotationService: KisQuotationService,
  ) {}

  async onModuleInit() {
    // 서버 재시작 시 활성 세션이 있으면 모니터링 시작
    const activeSessions = await this.em.find(AutoTradingSessionEntity, {
      status: SessionStatus.ACTIVE,
    });
    if (activeSessions.length > 0) {
      this.logger.log(`활성 자동매매 세션 ${activeSessions.length}개 복원`);
      this.startMonitoring(activeSessions);
    }
  }

  onModuleDestroy() {
    this.stopMonitoring();
  }

  /** 세션 시작 */
  async startSession(userId: number, dto: StartSessionDto): Promise<AutoTradingSessionEntity> {
    const user = await this.em.findOneOrFail(UserEntity, userId);

    const session = this.em.create(AutoTradingSessionEntity, {
      user,
      stockCode: dto.stockCode,
      stockName: dto.stockName,
      strategyId: dto.strategyId,
      variant: dto.variant,
      investmentAmount: dto.investmentAmount,
      aiScore: dto.aiScore,
      status: SessionStatus.ACTIVE,
    });

    await this.em.persistAndFlush(session);
    this.logger.log(`자동매매 시작: ${dto.stockName}(${dto.stockCode}) - ${dto.strategyId}`);

    // 실시간 모니터링 시작
    this.subscribeStock(dto.stockCode);

    return session;
  }

  /** 세션 목록 */
  async getSessions(userId: number): Promise<AutoTradingSessionEntity[]> {
    return this.em.find(
      AutoTradingSessionEntity,
      { user: userId },
      { orderBy: { createdAt: 'DESC' } },
    );
  }

  /** 세션 상세 */
  async getSession(sessionId: number, userId: number): Promise<AutoTradingSessionEntity> {
    const session = await this.em.findOne(AutoTradingSessionEntity, {
      id: sessionId,
      user: userId,
    });
    if (!session) throw new NotFoundException('세션을 찾을 수 없습니다.');

    // 최신 가격으로 미실현 손익 갱신
    const price = this.latestPrices.get(session.stockCode);
    if (price && session.holdingQty > 0) {
      session.unrealizedPnl = Math.round(
        (price - session.avgBuyPrice) * session.holdingQty,
      );
    }

    return session;
  }

  /** 세션 일시정지 */
  async pauseSession(sessionId: number, userId: number): Promise<AutoTradingSessionEntity> {
    const session = await this.getSession(sessionId, userId);
    session.status = SessionStatus.PAUSED;
    await this.em.flush();
    return session;
  }

  /** 세션 재개 */
  async resumeSession(sessionId: number, userId: number): Promise<AutoTradingSessionEntity> {
    const session = await this.getSession(sessionId, userId);
    session.status = SessionStatus.ACTIVE;
    await this.em.flush();
    this.subscribeStock(session.stockCode);
    return session;
  }

  /** 세션 종료 */
  async stopSession(sessionId: number, userId: number): Promise<AutoTradingSessionEntity> {
    const session = await this.getSession(sessionId, userId);
    session.status = SessionStatus.STOPPED;
    session.stoppedAt = new Date();
    await this.em.flush();
    this.logger.log(`자동매매 종료: ${session.stockName}(${session.stockCode})`);
    return session;
  }

  /** 실시간 가격으로 전략 신호 체크 및 자동 매매 */
  private async checkSignalsAndTrade() {
    const sessions = await this.em.find(AutoTradingSessionEntity, {
      status: SessionStatus.ACTIVE,
    });

    for (const session of sessions) {
      try {
        const price = this.latestPrices.get(session.stockCode);
        if (!price) continue;

        // 보유 중이면 익절/손절 체크
        if (session.holdingQty > 0 && session.avgBuyPrice > 0) {
          const returnPct = ((price - session.avgBuyPrice) / session.avgBuyPrice) * 100;

          if (returnPct >= AUTO_TAKE_PROFIT_PCT) {
            await this.executeSell(session, price, `자동 익절 (${returnPct.toFixed(1)}%)`);
            continue;
          }
          if (returnPct <= AUTO_STOP_LOSS_PCT) {
            await this.executeSell(session, price, `자동 손절 (${returnPct.toFixed(1)}%)`);
            continue;
          }

          // 미실현 손익 갱신
          session.unrealizedPnl = Math.round((price - session.avgBuyPrice) * session.holdingQty);
        }

        // 전략 신호 분석 (일봉 기반이므로 일중에는 현재가 기반 간이 분석)
        if (session.holdingQty === 0) {
          // 미보유 시: 매수 신호 확인
          const shouldBuy = await this.shouldBuyByStrategy(session);
          if (shouldBuy) {
            await this.executeBuy(session, price);
          }
        }

        await this.em.flush();
      } catch (err: any) {
        this.logger.error(`세션 ${session.id} 처리 오류: ${err.message}`);
      }
    }
  }

  /** 전략 기반 매수 신호 확인 */
  private async shouldBuyByStrategy(session: AutoTradingSessionEntity): Promise<boolean> {
    const strategyFn = STRATEGY_MAP[session.strategyId];
    if (!strategyFn) return false;

    try {
      // 현재가 일봉 데이터로 신호 확인 (최근 데이터 기반)
      const dailyPrices = await this.kisQuotationService.getDailyPrice(session.stockCode, 'D');
      if (!dailyPrices || dailyPrices.length < 20) return false;

      const candles: CandleData[] = dailyPrices
        .slice(0, 60)
        .reverse()
        .map((p: any) => ({
          date: new Date(
            `${p.stck_bsop_date.slice(0, 4)}-${p.stck_bsop_date.slice(4, 6)}-${p.stck_bsop_date.slice(6, 8)}`,
          ),
          open: Number(p.stck_oprc),
          high: Number(p.stck_hgpr),
          low: Number(p.stck_lwpr),
          close: Number(p.stck_clpr),
          volume: Number(p.acml_vol),
        }));

      const config = session.variant ? { variant: session.variant } : {};
      const analysis = strategyFn(candles, config);
      const lastSignal = analysis.currentSignal;

      return lastSignal.direction === SignalDirection.Buy && lastSignal.strength >= 0.3;
    } catch {
      return false;
    }
  }

  /** 매수 실행 */
  private async executeBuy(session: AutoTradingSessionEntity, price: number) {
    const tradeAmount = session.investmentAmount * (TRADE_RATIO_PCT / 100);
    const qty = Math.floor(tradeAmount / price);
    if (qty <= 0) return;

    this.logger.log(`매수 실행: ${session.stockCode} ${qty}주 @ ${price}`);

    try {
      await this.kisOrderService.orderCash({
        stockCode: session.stockCode,
        orderType: 'buy',
        orderDvsn: '01', // 시장가
        quantity: qty,
        price: 0,
        userId: session.user.id,
      });

      const totalCost = session.avgBuyPrice * session.holdingQty + price * qty;
      session.holdingQty += qty;
      session.avgBuyPrice = totalCost / session.holdingQty;
      session.totalBuys += 1;
      await this.em.flush();
    } catch (err: any) {
      this.logger.error(`매수 실패: ${session.stockCode} - ${err.message}`);
    }
  }

  /** 매도 실행 */
  private async executeSell(session: AutoTradingSessionEntity, price: number, reason: string) {
    if (session.holdingQty <= 0) return;

    this.logger.log(`매도 실행: ${session.stockCode} ${session.holdingQty}주 @ ${price} (${reason})`);

    try {
      await this.kisOrderService.orderCash({
        stockCode: session.stockCode,
        orderType: 'sell',
        orderDvsn: '01', // 시장가
        quantity: session.holdingQty,
        price: 0,
        userId: session.user.id,
      });

      const pnl = (price - session.avgBuyPrice) * session.holdingQty;
      session.realizedPnl = Number(session.realizedPnl) + Math.round(pnl);
      session.unrealizedPnl = 0;
      session.holdingQty = 0;
      session.avgBuyPrice = 0;
      session.totalSells += 1;
      await this.em.flush();
    } catch (err: any) {
      this.logger.error(`매도 실패: ${session.stockCode} - ${err.message}`);
    }
  }

  /** 실시간 가격 모니터링 시작 */
  private startMonitoring(sessions: AutoTradingSessionEntity[]) {
    // WebSocket 실시간 체결가 구독
    for (const s of sessions) {
      this.subscribeStock(s.stockCode);
    }

    this.executionSub = this.kisWsService.execution$.subscribe((data) => {
      this.latestPrices.set(data.stockCode, Number(data.price));
    });

    // 30초마다 전략 신호 체크
    this.monitorInterval = setInterval(() => {
      this.checkSignalsAndTrade().catch((err) =>
        this.logger.error(`모니터링 오류: ${err.message}`),
      );
    }, 30_000);
  }

  private stopMonitoring() {
    this.executionSub?.unsubscribe();
    this.notificationSub?.unsubscribe();
    if (this.monitorInterval) clearInterval(this.monitorInterval);
  }

  private subscribeStock(stockCode: string) {
    try {
      this.kisWsService.subscribe('H0STCNT0', stockCode);
    } catch (err: any) {
      this.logger.warn(`WebSocket 구독 실패: ${stockCode} - ${err.message}`);
    }
  }
}
