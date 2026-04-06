import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ConflictException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { EntityManager } from '@mikro-orm/postgresql';
import { Subscription, firstValueFrom, timeout } from 'rxjs';
import {
  CandleData,
  SignalDirection,
  analyzeDayTrading,
  analyzeMeanReversion,
  analyzeInfinityBot,
  analyzeCandlePattern,
  StrategyAnalysisResult,
} from '@alpha-mind/strategies';
import {
  AutoTradingSessionEntity,
  SessionStatus,
} from './entities/auto-trading-session.entity';
import {
  StartSessionDto,
  StartSessionsDto,
  UpdateSessionDto,
} from './dto/start-session.dto';
import { KisOrderService } from '../kis/kis-order.service';
import { KisWebSocketService } from '../kis/kis-websocket.service';
import { KisQuotationService } from '../kis/kis-quotation.service';
import { UserEntity } from '../user/entities/user.entity';
import { MARKET_DATA_SERVICE } from '../rmq/rmq.module';

const STRATEGY_MAP: Record<
  string,
  (candles: CandleData[], config?: any) => StrategyAnalysisResult
> = {
  'day-trading': analyzeDayTrading,
  'mean-reversion': analyzeMeanReversion,
  'infinity-bot': analyzeInfinityBot,
  'candle-pattern': analyzeCandlePattern,
};

/** 기본 익절/손절/매매비율 — 세션에 값이 없을 때만 사용 */
const DEFAULT_TAKE_PROFIT_PCT = 5;
const DEFAULT_STOP_LOSS_PCT = -3;
const DEFAULT_STRATEGY_ID = 'day-trading';
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
    @Inject(MARKET_DATA_SERVICE) private readonly marketDataClient: ClientProxy,
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

  /**
   * 복수 세션 일괄 시작
   * - 사전 검사: 활성 세션이 있는 종목에 onConflict가 지정되지 않으면 409로 충돌 정보 반환
   * - 충돌이 없거나 모두 해결된 경우에만 실제 생성/업데이트 진행 (부분 생성 방지)
   * - entryMode='immediate' 이면 세션 생성 직후 시장가 매수 실행
   */
  async startSessions(
    userId: number,
    dto: StartSessionsDto,
  ): Promise<AutoTradingSessionEntity[]> {
    // 1. 사전 충돌 감지
    const conflicts: Array<{
      stockCode: string;
      stockName: string;
      existingSession: {
        id: number;
        strategyId: string;
        variant?: string;
        takeProfitPct: number;
        stopLossPct: number;
      };
    }> = [];

    for (const sessionDto of dto.sessions) {
      if (sessionDto.onConflict) continue; // 사용자가 이미 해결책 선택

      const existing = await this.em.findOne(AutoTradingSessionEntity, {
        user: userId,
        stockCode: sessionDto.stockCode,
        status: SessionStatus.ACTIVE,
      });

      if (existing) {
        conflicts.push({
          stockCode: existing.stockCode,
          stockName: existing.stockName,
          existingSession: {
            id: existing.id,
            strategyId: existing.strategyId,
            variant: existing.variant,
            takeProfitPct: existing.takeProfitPct,
            stopLossPct: existing.stopLossPct,
          },
        });
      }
    }

    if (conflicts.length > 0) {
      throw new ConflictException({
        message: `${conflicts.length}개 종목에 이미 활성 자동매매 세션이 있습니다.`,
        code: 'SESSION_CONFLICT',
        conflicts,
      });
    }

    // 2. 실제 생성/업데이트
    const results: AutoTradingSessionEntity[] = [];
    for (const sessionDto of dto.sessions) {
      // 일괄 entryMode 는 개별 entryMode 가 비어있을 때만 적용
      const effectiveDto: StartSessionDto = {
        ...sessionDto,
        entryMode: sessionDto.entryMode ?? dto.entryMode,
      };
      const session = await this.startSession(userId, effectiveDto);
      results.push(session);
    }
    return results;
  }

  /** 세션 시작 (단일) */
  async startSession(
    userId: number,
    dto: StartSessionDto,
  ): Promise<AutoTradingSessionEntity> {
    const user = await this.em.findOneOrFail(UserEntity, userId);

    // 활성 세션 중복 검사
    const existing = await this.em.findOne(AutoTradingSessionEntity, {
      user: userId,
      stockCode: dto.stockCode,
      status: SessionStatus.ACTIVE,
    });

    if (existing) {
      // skip: 기존 세션 그대로 반환
      if (dto.onConflict === 'skip') {
        this.logger.log(
          `자동매매 중복 skip: ${dto.stockName}(${dto.stockCode}) — 기존 세션 ${existing.id} 유지`,
        );
        return existing;
      }

      // update: 기존 세션 설정 덮어쓰기
      if (dto.onConflict === 'update') {
        const { strategyId, variant } = await this.resolveStrategy(dto);
        existing.strategyId = strategyId;
        existing.variant = variant;
        existing.investmentAmount = dto.investmentAmount;
        existing.takeProfitPct = dto.takeProfitPct ?? existing.takeProfitPct;
        existing.stopLossPct = dto.stopLossPct ?? existing.stopLossPct;
        if (dto.aiScore !== undefined) existing.aiScore = dto.aiScore;
        await this.em.flush();
        this.logger.log(
          `자동매매 업데이트: ${dto.stockName}(${dto.stockCode}) - ${strategyId} ` +
            `(목표 ${existing.takeProfitPct}%, 손절 ${existing.stopLossPct}%)`,
        );
        this.subscribeStock(dto.stockCode);
        return existing;
      }

      // 해결 지정이 없으면 충돌 예외
      throw new ConflictException({
        message: `${dto.stockName}(${dto.stockCode})에 이미 활성 자동매매 세션이 있습니다.`,
        code: 'SESSION_CONFLICT',
        conflicts: [
          {
            stockCode: existing.stockCode,
            stockName: existing.stockName,
            existingSession: {
              id: existing.id,
              strategyId: existing.strategyId,
              variant: existing.variant,
              takeProfitPct: existing.takeProfitPct,
              stopLossPct: existing.stopLossPct,
            },
          },
        ],
      });
    }

    const { strategyId, variant } = await this.resolveStrategy(dto);

    const session = this.em.create(AutoTradingSessionEntity, {
      user,
      stockCode: dto.stockCode,
      stockName: dto.stockName,
      strategyId,
      variant,
      investmentAmount: dto.investmentAmount,
      takeProfitPct: dto.takeProfitPct ?? DEFAULT_TAKE_PROFIT_PCT,
      stopLossPct: dto.stopLossPct ?? DEFAULT_STOP_LOSS_PCT,
      aiScore: dto.aiScore,
      status: SessionStatus.ACTIVE,
    });

    await this.em.persistAndFlush(session);
    this.logger.log(
      `자동매매 시작: ${dto.stockName}(${dto.stockCode}) - ${strategyId} ` +
        `(목표 ${session.takeProfitPct}%, 손절 ${session.stopLossPct}%, ` +
        `진입 ${dto.entryMode ?? 'monitor'})`,
    );

    this.subscribeStock(dto.stockCode);

    // 즉시 매수 모드: 시장가로 투자금액 전체를 매수
    if (dto.entryMode === 'immediate') {
      await this.executeImmediateBuy(session);
    }

    return session;
  }

  /** DTO의 전략 필드를 해석 — 미지정 시 백테스트 기반 추천 전략 조회 */
  private async resolveStrategy(
    dto: StartSessionDto,
  ): Promise<{ strategyId: string; variant?: string }> {
    if (dto.strategyId) {
      return { strategyId: dto.strategyId, variant: dto.variant };
    }
    const recommendation = await this.recommendStrategy(
      dto.stockCode,
      dto.investmentAmount,
    );
    const strategyId = recommendation?.strategyId ?? DEFAULT_STRATEGY_ID;
    const variant = recommendation?.variant ?? dto.variant;
    this.logger.log(
      `${dto.stockCode} 추천 전략: ${strategyId}` +
        (recommendation
          ? ` (수익률 ${recommendation.totalReturnPct}%, 승률 ${recommendation.winRate}%)`
          : ' (fallback)'),
    );
    return { strategyId, variant };
  }

  /** 특정 종목 추천 전략 조회 (market-data-service RMQ 호출) */
  private async recommendStrategy(
    stockCode: string,
    investmentAmount: number,
  ): Promise<{
    strategyId: string;
    variant?: string;
    totalReturnPct: number;
    winRate: number;
  } | null> {
    try {
      const response = await firstValueFrom(
        this.marketDataClient
          .send('strategy.recommend', { stockCode, investmentAmount })
          .pipe(timeout(15_000)),
      );
      return response ?? null;
    } catch (err: any) {
      this.logger.warn(
        `추천 전략 조회 실패 (${stockCode}): ${err.message ?? err}`,
      );
      return null;
    }
  }

  /** 활성 세션을 종목코드 기준으로 매핑 — 잔고 조회에서 사용 */
  async getActiveSessionsByStockCode(
    userId: number,
  ): Promise<Map<string, AutoTradingSessionEntity>> {
    const sessions = await this.em.find(AutoTradingSessionEntity, {
      user: userId,
      status: SessionStatus.ACTIVE,
    });
    const map = new Map<string, AutoTradingSessionEntity>();
    for (const s of sessions) {
      map.set(s.stockCode, s);
    }
    return map;
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
  async getSession(
    sessionId: number,
    userId: number,
  ): Promise<AutoTradingSessionEntity> {
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
  async pauseSession(
    sessionId: number,
    userId: number,
  ): Promise<AutoTradingSessionEntity> {
    const session = await this.getSession(sessionId, userId);
    session.status = SessionStatus.PAUSED;
    await this.em.flush();
    return session;
  }

  /** 세션 재개 */
  async resumeSession(
    sessionId: number,
    userId: number,
  ): Promise<AutoTradingSessionEntity> {
    const session = await this.getSession(sessionId, userId);
    session.status = SessionStatus.ACTIVE;
    await this.em.flush();
    this.subscribeStock(session.stockCode);
    return session;
  }

  /** 세션 설정 수정 — 전략/목표수익/손절 변경 */
  async updateSession(
    sessionId: number,
    userId: number,
    dto: UpdateSessionDto,
  ): Promise<AutoTradingSessionEntity> {
    const session = await this.getSession(sessionId, userId);

    if (session.status === SessionStatus.STOPPED) {
      throw new ConflictException({
        message: '종료된 세션은 수정할 수 없습니다.',
        code: 'SESSION_STOPPED',
      });
    }

    if (dto.strategyId !== undefined) {
      session.strategyId = dto.strategyId;
      // 전략을 변경하면 기존 variant는 사용자가 별도 지정하지 않는 한 무효화
      if (dto.variant === undefined) {
        session.variant = undefined;
      }
    }
    if (dto.variant !== undefined) {
      session.variant = dto.variant || undefined;
    }
    if (dto.takeProfitPct !== undefined) {
      session.takeProfitPct = dto.takeProfitPct;
    }
    if (dto.stopLossPct !== undefined) {
      session.stopLossPct = dto.stopLossPct;
    }

    await this.em.flush();
    this.logger.log(
      `자동매매 설정 수정: ${session.stockName}(${session.stockCode}) - ${session.strategyId}` +
        ` (목표 ${session.takeProfitPct}%, 손절 ${session.stopLossPct}%)`,
    );
    return session;
  }

  /** 세션 종료 */
  async stopSession(
    sessionId: number,
    userId: number,
  ): Promise<AutoTradingSessionEntity> {
    const session = await this.getSession(sessionId, userId);
    session.status = SessionStatus.STOPPED;
    session.stoppedAt = new Date();
    await this.em.flush();
    this.logger.log(
      `자동매매 종료: ${session.stockName}(${session.stockCode})`,
    );
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

        // 보유 중이면 익절/손절 체크 (세션별 목표 수익/손절 기준)
        if (session.holdingQty > 0 && session.avgBuyPrice > 0) {
          const returnPct = ((price - session.avgBuyPrice) / session.avgBuyPrice) * 100;

          if (returnPct >= session.takeProfitPct) {
            await this.executeSell(
              session,
              price,
              `자동 익절 (${returnPct.toFixed(1)}%)`,
            );
            continue;
          }
          if (returnPct <= session.stopLossPct) {
            await this.executeSell(
              session,
              price,
              `자동 손절 (${returnPct.toFixed(1)}%)`,
            );
            continue;
          }

          // 미실현 손익 갱신
          session.unrealizedPnl = Math.round(
            (price - session.avgBuyPrice) * session.holdingQty,
          );
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
  private async shouldBuyByStrategy(
    session: AutoTradingSessionEntity,
  ): Promise<boolean> {
    const strategyFn = STRATEGY_MAP[session.strategyId];
    if (!strategyFn) return false;

    try {
      // 현재가 일봉 데이터로 신호 확인 (최근 데이터 기반)
      const dailyPrices = await this.kisQuotationService.getDailyPrice(
        session.stockCode,
        'D',
      );
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

      return (
        lastSignal.direction === SignalDirection.Buy &&
        lastSignal.strength >= 0.3
      );
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

  /**
   * 즉시 매수 실행 — 세션 생성 직후 시장가로 투자금액 전체를 매수.
   * 현재가는 실시간 캐시가 아직 없을 가능성이 높으므로 REST 현재가 조회로 확정.
   */
  private async executeImmediateBuy(session: AutoTradingSessionEntity) {
    try {
      const priceRaw = await this.kisQuotationService.getCurrentPrice(
        session.stockCode,
      );
      const price = Number(priceRaw.stck_prpr);
      if (!Number.isFinite(price) || price <= 0) {
        this.logger.warn(
          `즉시 매수 건너뜀: ${session.stockCode} - 현재가 조회 실패`,
        );
        return;
      }

      const qty = Math.floor(session.investmentAmount / price);
      if (qty <= 0) {
        this.logger.warn(
          `즉시 매수 건너뜀: ${session.stockCode} - 투자금액(${session.investmentAmount}) 대비 ` +
            `현재가(${price})가 커서 1주도 매수 불가`,
        );
        return;
      }

      this.logger.log(
        `즉시 매수 실행: ${session.stockCode} ${qty}주 @ ${price} ` +
          `(투자금 ${session.investmentAmount})`,
      );

      await this.kisOrderService.orderCash({
        stockCode: session.stockCode,
        orderType: 'buy',
        orderDvsn: '01', // 시장가
        quantity: qty,
        price: 0,
        userId: session.user.id,
      });

      // 즉시 매수 결과를 세션에 반영 (가중평균 매입가 계산)
      const totalCost = session.avgBuyPrice * session.holdingQty + price * qty;
      session.holdingQty += qty;
      session.avgBuyPrice = totalCost / session.holdingQty;
      session.totalBuys += 1;
      this.latestPrices.set(session.stockCode, price);
      await this.em.flush();
    } catch (err: any) {
      // 즉시 매수 실패는 세션 자체를 롤백하지 않고 로깅만 — 이후 전략 신호로 진입 가능
      this.logger.error(
        `즉시 매수 실패: ${session.stockCode} - ${err.message ?? err}`,
      );
    }
  }

  /** 매도 실행 */
  private async executeSell(
    session: AutoTradingSessionEntity,
    price: number,
    reason: string,
  ) {
    if (session.holdingQty <= 0) return;

    this.logger.log(
      `매도 실행: ${session.stockCode} ${session.holdingQty}주 @ ${price} (${reason})`,
    );

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
