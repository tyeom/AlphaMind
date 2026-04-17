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
  AddOnBuyMode,
  AutoTradingSessionEntity,
  SessionStatus,
} from './entities/auto-trading-session.entity';
import {
  StartSessionDto,
  StartSessionsDto,
  UpdateSessionDto,
  ManualOrderDto,
} from './dto/start-session.dto';
import { KisOrderService } from '../kis/kis-order.service';
import { KisWebSocketService } from '../kis/kis-websocket.service';
import { KisQuotationService } from '../kis/kis-quotation.service';
import { KisInquiryService } from '../kis/kis-inquiry.service';
import { KisRealtimeSubscriptionResult } from '../kis/kis.types';
import { UserEntity } from '../user/entities/user.entity';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';
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
const PRICE_POLL_INTERVAL_MS = 5_000;
const SUBSCRIPTION_RETRY_BASE_DELAY_MS = 5_000;
const SUBSCRIPTION_RETRY_MAX_DELAY_MS = 60_000;

@Injectable()
export class AutoTradingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoTradingService.name);
  private executionSub?: Subscription;
  private subscriptionResultSub?: Subscription;
  private notificationSub?: Subscription;
  /** 종목별 최신 가격 캐시 */
  private latestPrices = new Map<string, number>();
  /** 모니터링 인터벌 */
  private monitorInterval?: ReturnType<typeof setInterval>;
  /**
   * 활성(ACTIVE) 세션이 존재하는 종목코드 집합.
   * 현재가 브로드캐스트/구독 판단의 단일 기준 —
   * 세션 상태가 바뀔 때마다 syncStockActivity 로 갱신한다.
   */
  private activeStockCodes = new Set<string>();
  /** 구독 한도 초과 종목은 REST 현재가 폴링으로 폴백 */
  private pollingStockIntervals = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  /** 현재가 폴링 중복 실행 방지 */
  private pollingInFlight = new Set<string>();
  /** 기타 구독 실패에 대한 종목별 재시도 타이머 */
  private subscriptionRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** 기타 구독 실패 재시도 횟수 */
  private subscriptionRetryAttempts = new Map<string, number>();

  private gateway?: import('./auto-trading.gateway').AutoTradingGateway;

  constructor(
    private readonly em: EntityManager,
    private readonly kisOrderService: KisOrderService,
    private readonly kisWsService: KisWebSocketService,
    private readonly kisQuotationService: KisQuotationService,
    private readonly kisInquiryService: KisInquiryService,
    private readonly notificationService: NotificationService,
    @Inject(MARKET_DATA_SERVICE) private readonly marketDataClient: ClientProxy,
  ) {}

  setGateway(gw: import('./auto-trading.gateway').AutoTradingGateway) {
    this.gateway = gw;
  }

  private broadcastSessionUpdate(session: AutoTradingSessionEntity) {
    this.gateway?.broadcastSessionUpdate(session);
  }

  private broadcastSessionRemoved(sessionId: number, stockCode: string) {
    this.gateway?.broadcastSessionRemoved(sessionId, stockCode);
  }

  private setLatestPrice(
    stockCode: string,
    price: number,
    options?: { volume?: number; broadcast?: boolean },
  ) {
    this.latestPrices.set(stockCode, price);

    if (options?.broadcast && this.activeStockCodes.has(stockCode)) {
      this.gateway?.broadcastPriceUpdate({
        stockCode,
        price,
        volume: options.volume,
      });
    }
  }

  async onModuleInit() {
    // 서버 재시작 시 활성 세션이 있으면 모니터링 시작
    const activeSessions = await this.em.find(AutoTradingSessionEntity, {
      status: SessionStatus.ACTIVE,
    });
    // 활성 종목 캐시 복원 — gateway 의 브로드캐스트 필터링 기준이 된다
    for (const s of activeSessions) {
      this.activeStockCodes.add(s.stockCode);
    }
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
        if (dto.addOnBuyMode !== undefined) {
          existing.addOnBuyMode = dto.addOnBuyMode as AddOnBuyMode;
        }
        if (dto.aiScore !== undefined) existing.aiScore = dto.aiScore;
        await this.em.flush();
        this.logger.log(
          `자동매매 업데이트: ${dto.stockName}(${dto.stockCode}) - ${strategyId} ` +
            `(목표 ${existing.takeProfitPct}%, 손절 ${existing.stopLossPct}%)`,
        );
        await this.syncStockActivity(dto.stockCode);
        this.broadcastSessionUpdate(existing);
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
      addOnBuyMode:
        (dto.addOnBuyMode as AddOnBuyMode | undefined) ?? AddOnBuyMode.SKIP,
      aiScore: dto.aiScore,
      status: SessionStatus.ACTIVE,
    });

    await this.em.persistAndFlush(session);
    this.logger.log(
      `자동매매 시작: ${dto.stockName}(${dto.stockCode}) - ${strategyId} ` +
        `(목표 ${session.takeProfitPct}%, 손절 ${session.stopLossPct}%, ` +
        `진입 ${dto.entryMode ?? 'monitor'})`,
    );

    // 새 ACTIVE 세션 — 구독/활성 종목 집합 갱신
    await this.syncStockActivity(dto.stockCode);
    this.broadcastSessionUpdate(session);

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
    const sessions = await this.em.find(
      AutoTradingSessionEntity,
      { user: userId },
      { orderBy: { createdAt: 'DESC' } },
    );

    // KIS 실잔고와 동기화 — 포지션 상태를 정확하게 반영
    await this.syncSessionsWithBalance(sessions);

    return sessions;
  }

  /**
   * KIS 실잔고를 조회하여 세션의 holdingQty / avgBuyPrice 를 실제 보유 현황과 동기화.
   * 잔고 조회 실패 시 기존 DB 값을 그대로 유지한다.
   */
  private async syncSessionsWithBalance(
    sessions: AutoTradingSessionEntity[],
  ): Promise<void> {
    if (sessions.length === 0) return;

    let balanceItems: import('../kis/kis.types').KisBalanceItem[];
    try {
      const { items } = await this.kisInquiryService.getBalance();
      balanceItems = items;
    } catch {
      return; // 잔고 조회 실패 시 DB 값 유지
    }

    // 종목코드 → 잔고 매핑
    const balanceMap = new Map<string, { qty: number; avgPrice: number }>();
    for (const item of balanceItems) {
      const code = item.pdno?.trim();
      if (code) {
        balanceMap.set(code, {
          qty: Number(item.hldg_qty) || 0,
          avgPrice: Number(item.pchs_avg_pric) || 0,
        });
      }
    }

    let changed = false;
    for (const session of sessions) {
      if (session.status === SessionStatus.STOPPED) continue;

      const real = balanceMap.get(session.stockCode);
      const realQty = real?.qty ?? 0;
      const realAvg = real?.avgPrice ?? 0;

      if (session.holdingQty !== realQty) {
        this.logger.log(
          `잔고 동기화: ${session.stockCode} holdingQty ${session.holdingQty} → ${realQty}`,
        );
        session.holdingQty = realQty;
        session.avgBuyPrice = realAvg;
        if (realQty <= 0) {
          session.avgBuyPrice = 0;
          session.unrealizedPnl = 0;
        }
        changed = true;
      }
    }

    if (changed) {
      await this.em.flush();
    }
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
    this.broadcastSessionUpdate(session);
    // 동일 종목의 다른 활성 세션이 없으면 구독 해제 / 활성 집합에서 제거
    await this.syncStockActivity(session.stockCode);
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
    await this.syncStockActivity(session.stockCode);
    this.broadcastSessionUpdate(session);
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
      // 빈값('') 이면 추천 전략 자동 산출 — startSession 과 동일 흐름
      if (!dto.strategyId) {
        const { strategyId, variant } = await this.resolveStrategy({
          stockCode: session.stockCode,
          stockName: session.stockName,
          investmentAmount: Number(session.investmentAmount),
          variant: dto.variant,
        });
        session.strategyId = strategyId;
        session.variant = variant;
      } else {
        session.strategyId = dto.strategyId;
        // 전략을 변경하면 기존 variant는 사용자가 같이 지정하지 않는 한 무효화
        session.variant = dto.variant || undefined;
      }
    } else if (dto.variant !== undefined) {
      // strategyId 변경 없이 variant 만 갱신
      session.variant = dto.variant || undefined;
    }
    if (dto.takeProfitPct !== undefined) {
      session.takeProfitPct = dto.takeProfitPct;
    }
    if (dto.stopLossPct !== undefined) {
      session.stopLossPct = dto.stopLossPct;
    }
    if (dto.addOnBuyMode !== undefined) {
      session.addOnBuyMode = dto.addOnBuyMode as AddOnBuyMode;
    }

    await this.em.flush();
    this.logger.log(
      `자동매매 설정 수정: ${session.stockName}(${session.stockCode}) - ${session.strategyId}` +
        ` (목표 ${session.takeProfitPct}%, 손절 ${session.stopLossPct}%)`,
    );
    this.broadcastSessionUpdate(session);
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
    this.broadcastSessionUpdate(session);
    // 동일 종목의 다른 활성 세션이 없으면 구독 해제 / 활성 집합에서 제거
    await this.syncStockActivity(session.stockCode);
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
          const returnPct =
            ((price - session.avgBuyPrice) / session.avgBuyPrice) * 100;

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
        } else if (session.addOnBuyMode === AddOnBuyMode.ADD) {
          // 보유 중 + 추가 매수 허용: 매수 신호 발생 시 추가 매수
          const shouldBuy = await this.shouldBuyByStrategy(session);
          if (shouldBuy) {
            this.logger.log(
              `추가 매수 신호: ${session.stockCode} (보유 ${session.holdingQty}주, 평단 ${Math.round(session.avgBuyPrice)})`,
            );
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

  /** 매수 실행 — 신호 발생 시점의 현재가로 지정가 매수 */
  private async executeBuy(session: AutoTradingSessionEntity, price: number) {
    const tradeAmount = session.investmentAmount * (TRADE_RATIO_PCT / 100);
    const qty = Math.floor(tradeAmount / price);
    if (qty <= 0) return;

    this.logger.log(
      `매수 실행(지정가): ${session.stockCode} ${qty}주 @ ${price}`,
    );

    try {
      const result = await this.kisOrderService.orderCash({
        stockCode: session.stockCode,
        orderType: 'buy',
        orderDvsn: '00', // 지정가
        quantity: qty,
        price,
        userId: session.user.id,
      });

      if (result.rt_cd !== '0') {
        this.logger.error(
          `매수 주문 거부: ${session.stockCode} - ${result.msg1}`,
        );
        return;
      }

      const totalCost = session.avgBuyPrice * session.holdingQty + price * qty;
      session.holdingQty += qty;
      session.avgBuyPrice = totalCost / session.holdingQty;
      session.totalBuys += 1;
      await this.em.flush();
      this.broadcastSessionUpdate(session);

      this.createSignalNotification(session, 'buy', price, qty);
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

      const result = await this.kisOrderService.orderCash({
        stockCode: session.stockCode,
        orderType: 'buy',
        orderDvsn: '01', // 시장가
        quantity: qty,
        price: 0,
        userId: session.user.id,
      });

      if (result.rt_cd !== '0') {
        this.logger.error(
          `즉시 매수 주문 거부: ${session.stockCode} - ${result.msg1}`,
        );
        return;
      }

      // 즉시 매수 결과를 세션에 반영 (가중평균 매입가 계산)
      const totalCost = session.avgBuyPrice * session.holdingQty + price * qty;
      session.holdingQty += qty;
      session.avgBuyPrice = totalCost / session.holdingQty;
      session.totalBuys += 1;
      this.setLatestPrice(session.stockCode, price, { broadcast: true });
      await this.em.flush();
      this.broadcastSessionUpdate(session);
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
      const result = await this.kisOrderService.orderCash({
        stockCode: session.stockCode,
        orderType: 'sell',
        orderDvsn: '01', // 시장가
        quantity: session.holdingQty,
        price: 0,
        userId: session.user.id,
      });

      if (result.rt_cd !== '0') {
        this.logger.error(
          `매도 주문 거부: ${session.stockCode} - ${result.msg1}`,
        );
        return;
      }

      const pnl = (price - session.avgBuyPrice) * session.holdingQty;
      const sellQty = session.holdingQty;
      session.realizedPnl = Number(session.realizedPnl) + Math.round(pnl);
      session.unrealizedPnl = 0;
      session.holdingQty = 0;
      session.avgBuyPrice = 0;
      session.totalSells += 1;
      await this.em.flush();
      this.broadcastSessionUpdate(session);

      this.createSignalNotification(
        session,
        'sell',
        price,
        sellQty,
        reason,
        Math.round(pnl),
      );
    } catch (err: any) {
      this.logger.error(`매도 실패: ${session.stockCode} - ${err.message}`);
      return;
    }

    // 매도 성공 후 KIS 실잔고를 확인해 보유 종목이 아니면 세션을 완전 삭제하여
    // 모니터링 목록에서 제거한다 — 다음 사이클에서 동일 종목을 자동 재진입하는 것을 방지.
    await this.removeSessionIfNotHeld(session);
  }

  /**
   * 매도 직후 KIS 실제 잔고를 조회해, 해당 종목이 더 이상 보유 중이 아니라면
   * 세션을 DB 에서 완전 삭제하고 구독/활성 종목 캐시도 정리한다.
   *
   * - 시장가 체결 → 잔고 반영까지 약간의 지연이 있을 수 있어 짧게 대기 후 조회
   * - 잔고 조회 실패 또는 여전히 보유중이면 세션은 그대로 둔다 (다음 사이클에서 정리 가능)
   */
  private async removeSessionIfNotHeld(session: AutoTradingSessionEntity) {
    try {
      // 체결 → 잔고 반영까지 짧은 대기
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      const { items } = await this.kisInquiryService.getBalance();
      const stillHeld = items.some(
        (item) =>
          item.pdno?.trim() === session.stockCode && Number(item.hldg_qty) > 0,
      );

      if (stillHeld) {
        this.logger.log(
          `매도 후 잔고 확인: ${session.stockCode} 아직 보유중 — 세션 유지`,
        );
        return;
      }

      const stockCode = session.stockCode;
      const sessionId = session.id;
      const label = `${session.stockName}(${stockCode})`;
      await this.em.removeAndFlush(session);
      await this.syncStockActivity(stockCode);
      this.broadcastSessionRemoved(sessionId, stockCode);
      this.logger.log(`매도 후 세션 완전 삭제: ${label} (실보유 없음)`);
    } catch (err: any) {
      this.logger.warn(
        `매도 후 잔고 확인 실패: ${session.stockCode} - ${err.message ?? err}`,
      );
    }
  }

  private createSignalNotification(
    session: AutoTradingSessionEntity,
    action: 'buy' | 'sell',
    price: number,
    qty: number,
    reason?: string,
    pnl?: number,
  ) {
    const isBuy = action === 'buy';
    const type = isBuy
      ? NotificationType.BUY_SIGNAL
      : NotificationType.SELL_SIGNAL;
    const title = isBuy
      ? `${session.stockName} 매수 체결`
      : `${session.stockName} 매도 체결`;
    const message = isBuy
      ? `${session.stockName}(${session.stockCode}) ${qty}주 @ ${price.toLocaleString()}원 매수`
      : `${session.stockName}(${session.stockCode}) ${qty}주 @ ${price.toLocaleString()}원 매도${reason ? ` (${reason})` : ''}${pnl !== undefined ? ` / 손익 ${pnl.toLocaleString()}원` : ''}`;

    this.notificationService
      .create(session.user.id, type, title, message, {
        stockCode: session.stockCode,
        stockName: session.stockName,
        action,
        price,
        quantity: qty,
        reason,
        pnl,
        sessionId: session.id,
      })
      .then((n) => this.gateway?.broadcastNotification(n))
      .catch((err) => this.logger.warn(`알림 생성 실패: ${err.message}`));
  }

  /** 실시간 가격 모니터링 시작 */
  private startMonitoring(sessions: AutoTradingSessionEntity[]) {
    const stockCodes = new Set(sessions.map((s) => s.stockCode));

    // WebSocket 실시간 체결가 구독
    for (const stockCode of stockCodes) {
      this.subscribeStock(stockCode);
    }

    if (!this.executionSub) {
      this.executionSub = this.kisWsService.execution$.subscribe((data) => {
        this.setLatestPrice(data.stockCode, Number(data.price), {
          volume: data.executionVolume,
          broadcast: true,
        });
      });
    }

    if (!this.subscriptionResultSub) {
      this.subscriptionResultSub =
        this.kisWsService.subscriptionResult$.subscribe((result) => {
          this.handleExecutionSubscriptionResult(result);
        });
    }

    // 30초마다 전략 신호 체크
    if (!this.monitorInterval) {
      this.monitorInterval = setInterval(() => {
        this.checkSignalsAndTrade().catch((err) =>
          this.logger.error(`모니터링 오류: ${err.message}`),
        );
      }, 30_000);
    }
  }

  private stopMonitoring() {
    this.executionSub?.unsubscribe();
    this.subscriptionResultSub?.unsubscribe();
    this.notificationSub?.unsubscribe();
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    for (const interval of this.pollingStockIntervals.values()) {
      clearInterval(interval);
    }
    for (const timer of this.subscriptionRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.executionSub = undefined;
    this.subscriptionResultSub = undefined;
    this.notificationSub = undefined;
    this.monitorInterval = undefined;
    this.pollingStockIntervals.clear();
    this.pollingInFlight.clear();
    this.subscriptionRetryTimers.clear();
    this.subscriptionRetryAttempts.clear();
  }

  private subscribeStock(stockCode: string, options?: { force?: boolean }) {
    try {
      this.kisWsService.subscribe('H0STCNT0', stockCode, options);
    } catch (err: any) {
      this.logger.warn(`WebSocket 구독 실패: ${stockCode} - ${err.message}`);
    }
  }

  private unsubscribeStock(stockCode: string) {
    try {
      this.kisWsService.unsubscribe('H0STCNT0', stockCode);
    } catch (err: any) {
      this.logger.warn(
        `WebSocket 구독 해제 실패: ${stockCode} - ${err.message}`,
      );
    }
  }

  /**
   * 특정 종목에 활성(ACTIVE) 세션이 남아있는지에 맞춰
   * KIS 실시간 구독 / 활성 종목 캐시를 동기화한다.
   *
   * - DB 에서 해당 종목의 ACTIVE 세션 존재 여부를 확인 (모든 사용자 기준)
   *   하나라도 있으면: 구독 유지 + activeStockCodes 에 포함
   *   하나도 없으면: 구독 해제 + activeStockCodes 에서 제거 + 가격 캐시 정리
   *
   * 세션 상태가 변경되는 모든 지점(start/resume/pause/stop)에서 flush 이후 호출한다.
   */
  private async syncStockActivity(stockCode: string) {
    const active = await this.em.findOne(AutoTradingSessionEntity, {
      stockCode,
      status: SessionStatus.ACTIVE,
    });
    if (active) {
      this.activeStockCodes.add(stockCode);
      if (
        !this.executionSub ||
        !this.subscriptionResultSub ||
        !this.monitorInterval
      ) {
        this.startMonitoring([active]);
      } else {
        this.subscribeStock(stockCode);
      }
    } else {
      this.activeStockCodes.delete(stockCode);
      this.latestPrices.delete(stockCode);
      this.stopPricePolling(stockCode);
      this.clearSubscriptionRetry(stockCode);
      this.unsubscribeStock(stockCode);
    }
  }

  private handleExecutionSubscriptionResult(
    result: KisRealtimeSubscriptionResult,
  ) {
    if (result.trId !== 'H0STCNT0' || result.action !== 'subscribe') {
      return;
    }

    const stockCode = result.trKey;
    if (!this.activeStockCodes.has(stockCode)) {
      this.stopPricePolling(stockCode);
      this.clearSubscriptionRetry(stockCode);
      return;
    }

    if (result.success) {
      this.stopPricePolling(stockCode);
      this.clearSubscriptionRetry(stockCode);
      this.subscriptionRetryAttempts.delete(stockCode);
      return;
    }

    if (this.isSubscriptionLimitError(result)) {
      this.clearSubscriptionRetry(stockCode);
      this.subscriptionRetryAttempts.delete(stockCode);
      this.startPricePolling(stockCode, result.message);
      return;
    }

    this.scheduleSubscriptionRetry(stockCode, result.message);
  }

  private isSubscriptionLimitError(
    result: KisRealtimeSubscriptionResult,
  ): boolean {
    const text = `${result.code} ${result.message}`.toLowerCase();
    return (
      text.includes('max subscribe over') ||
      text.includes('limit') ||
      text.includes('exceed') ||
      text.includes('초과') ||
      text.includes('한도') ||
      text.includes('제한')
    );
  }

  private startPricePolling(stockCode: string, reason: string) {
    if (this.pollingStockIntervals.has(stockCode)) {
      return;
    }

    this.logger.warn(
      `WebSocket 구독 한도 초과로 REST 폴링 전환: ${stockCode} - ${reason}`,
    );
    this.kisWsService.unsubscribe('H0STCNT0', stockCode);
    void this.pollCurrentPrice(stockCode);

    const interval = setInterval(() => {
      void this.pollCurrentPrice(stockCode);
    }, PRICE_POLL_INTERVAL_MS);
    this.pollingStockIntervals.set(stockCode, interval);
  }

  private stopPricePolling(stockCode: string) {
    const interval = this.pollingStockIntervals.get(stockCode);
    if (interval) {
      clearInterval(interval);
      this.pollingStockIntervals.delete(stockCode);
    }
    this.pollingInFlight.delete(stockCode);
  }

  private async pollCurrentPrice(stockCode: string) {
    if (
      !this.activeStockCodes.has(stockCode) ||
      this.pollingInFlight.has(stockCode)
    ) {
      return;
    }

    this.pollingInFlight.add(stockCode);

    try {
      const priceRaw =
        await this.kisQuotationService.getCurrentPrice(stockCode);
      const price = Number(priceRaw.stck_prpr);
      if (!Number.isFinite(price) || price <= 0) {
        this.logger.warn(
          `REST 현재가 조회 실패: ${stockCode} - 유효하지 않은 가격`,
        );
        return;
      }
      this.setLatestPrice(stockCode, price, { broadcast: true });
    } catch (err: any) {
      this.logger.warn(
        `REST 현재가 폴링 실패: ${stockCode} - ${err.message ?? err}`,
      );
    } finally {
      this.pollingInFlight.delete(stockCode);
    }
  }

  private scheduleSubscriptionRetry(stockCode: string, reason: string) {
    if (
      this.subscriptionRetryTimers.has(stockCode) ||
      this.pollingStockIntervals.has(stockCode) ||
      !this.activeStockCodes.has(stockCode)
    ) {
      return;
    }

    const attempt = (this.subscriptionRetryAttempts.get(stockCode) ?? 0) + 1;
    this.subscriptionRetryAttempts.set(stockCode, attempt);

    const delay = Math.min(
      SUBSCRIPTION_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
      SUBSCRIPTION_RETRY_MAX_DELAY_MS,
    );

    this.logger.warn(
      `WebSocket 구독 재시도 예약: ${stockCode} - ${reason} ` +
        `(시도 #${attempt}, ${delay / 1000}초 후)`,
    );

    const timer = setTimeout(() => {
      this.subscriptionRetryTimers.delete(stockCode);
      if (!this.activeStockCodes.has(stockCode)) {
        this.subscriptionRetryAttempts.delete(stockCode);
        return;
      }
      this.subscribeStock(stockCode, { force: true });
    }, delay);

    this.subscriptionRetryTimers.set(stockCode, timer);
  }

  private clearSubscriptionRetry(stockCode: string) {
    const timer = this.subscriptionRetryTimers.get(stockCode);
    if (timer) {
      clearTimeout(timer);
      this.subscriptionRetryTimers.delete(stockCode);
    }
  }

  /**
   * Gateway 브로드캐스트 필터링용 — 해당 종목에 활성 세션이 있을 때만 true.
   * 실시간 체결 스트림은 초당 수십건까지 들어올 수 있으므로 in-memory 집합만 사용한다.
   */
  isStockActive(stockCode: string): boolean {
    return this.activeStockCodes.has(stockCode);
  }

  /** 수동 매수/매도 주문 실행 */
  async executeManualOrder(
    sessionId: number,
    userId: number,
    dto: ManualOrderDto,
  ): Promise<AutoTradingSessionEntity> {
    const session = await this.getSession(sessionId, userId);

    if (session.status === SessionStatus.STOPPED) {
      throw new ConflictException({
        message: '종료된 세션에서는 주문할 수 없습니다.',
        code: 'SESSION_STOPPED',
      });
    }

    if (dto.orderType === 'sell' && session.holdingQty <= 0) {
      throw new ConflictException({
        message: '보유 수량이 없어 매도할 수 없습니다.',
        code: 'NO_HOLDINGS',
      });
    }

    if (dto.orderType === 'sell' && dto.quantity > session.holdingQty) {
      throw new ConflictException({
        message: `보유 수량(${session.holdingQty})보다 많은 수량은 매도할 수 없습니다.`,
        code: 'EXCEED_HOLDINGS',
      });
    }

    const price = dto.orderDvsn === '01' ? 0 : (dto.price ?? 0);

    this.logger.log(
      `수동 ${dto.orderType === 'buy' ? '매수' : '매도'}: ${session.stockCode} ` +
        `${dto.quantity}주 @ ${dto.orderDvsn === '01' ? '시장가' : price} (세션 ${sessionId})`,
    );

    const orderResult = await this.kisOrderService.orderCash({
      stockCode: session.stockCode,
      orderType: dto.orderType,
      orderDvsn: dto.orderDvsn,
      quantity: dto.quantity,
      price,
      userId: session.user.id,
    });

    // KIS 주문 실패 시 세션 상태를 변경하지 않고 에러 반환
    if (orderResult.rt_cd !== '0') {
      throw new ConflictException({
        message: orderResult.msg1 || 'KIS 주문이 실패했습니다.',
        code: 'ORDER_FAILED',
      });
    }

    // 주문 성공 시 세션 상태 갱신
    if (dto.orderType === 'buy') {
      const estimatedPrice =
        dto.orderDvsn === '01'
          ? (this.latestPrices.get(session.stockCode) ?? session.avgBuyPrice)
          : price;
      const totalCost =
        session.avgBuyPrice * session.holdingQty +
        estimatedPrice * dto.quantity;
      session.holdingQty += dto.quantity;
      session.avgBuyPrice =
        session.holdingQty > 0 ? totalCost / session.holdingQty : 0;
      session.totalBuys += 1;
    } else {
      const sellPrice =
        dto.orderDvsn === '01'
          ? (this.latestPrices.get(session.stockCode) ?? session.avgBuyPrice)
          : price;
      const pnl = (sellPrice - session.avgBuyPrice) * dto.quantity;
      session.realizedPnl = Number(session.realizedPnl) + Math.round(pnl);
      session.holdingQty -= dto.quantity;
      if (session.holdingQty <= 0) {
        session.holdingQty = 0;
        session.avgBuyPrice = 0;
        session.unrealizedPnl = 0;
      }
      session.totalSells += 1;
    }

    await this.em.flush();
    this.broadcastSessionUpdate(session);
    return session;
  }

  /**
   * 종료(STOPPED) 세션을 완전 삭제한다.
   * - ACTIVE / PAUSED 상태는 거부 (운용 중인 세션 보호)
   * - 성공 시 DB 에서 레코드 제거 후 `{ id }` 반환
   */
  async deleteSession(
    sessionId: number,
    userId: number,
  ): Promise<{ id: number }> {
    const session = await this.getSession(sessionId, userId);
    if (session.status !== SessionStatus.STOPPED) {
      throw new ConflictException({
        message: '비활성(종료) 상태의 세션만 완전 삭제할 수 있습니다.',
        code: 'SESSION_NOT_STOPPED',
      });
    }
    const deletedId = session.id;
    const stockCode = session.stockCode;
    const label = `${session.stockName}(${session.stockCode})`;
    await this.em.removeAndFlush(session);
    this.broadcastSessionRemoved(deletedId, stockCode);
    this.logger.log(`자동매매 세션 완전 삭제: ${label}`);
    return { id: deletedId };
  }
}
