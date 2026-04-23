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
  analyzeMomentumPower,
  analyzeMomentumSurge,
  StrategyAnalysisResult,
} from '@alpha-mind/strategies';
import {
  AddOnBuyMode,
  AutoTradingSessionEntity,
  PauseReason,
  SessionStatus,
} from './entities/auto-trading-session.entity';
import {
  InternalStartSessionDto,
  InternalStartSessionsDto,
  InternalUpdateSessionDto,
  ManualOrderDto,
} from './dto/start-session.dto';
import { KisOrderService } from '../kis/kis-order.service';
import { KisWebSocketService } from '../kis/kis-websocket.service';
import { KisQuotationService } from '../kis/kis-quotation.service';
import { KisInquiryService } from '../kis/kis-inquiry.service';
import {
  KisBalanceItem,
  KisRealtimeOrderNotification,
  KisRealtimeSubscriptionResult,
} from '../kis/kis.types';
import {
  TradeAction,
  TradeHistoryEntity,
  TradeStatus,
  TradeType,
} from '../kis/entities/trade-history.entity';
import { UserEntity } from '../user/entities/user.entity';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';
import { MARKET_DATA_SERVICE } from '../rmq/rmq.module';
import { AiMeetingResultEntity } from '../ai-meeting-result/entities/ai-meeting-result.entity';

const STRATEGY_MAP: Record<
  string,
  (
    candles: CandleData[],
    config?: any,
    stockCode?: string,
  ) => StrategyAnalysisResult
> = {
  'day-trading': analyzeDayTrading,
  'mean-reversion': analyzeMeanReversion,
  'infinity-bot': analyzeInfinityBot,
  'candle-pattern': analyzeCandlePattern,
  'momentum-power': analyzeMomentumPower,
  'momentum-surge': (candles, config, stockCode) =>
    analyzeMomentumSurge(candles, config, stockCode ?? ''),
};

/** 기본 익절/손절/매매비율 — 세션에 값이 없을 때만 사용 */
const DEFAULT_TAKE_PROFIT_PCT = 2;
const DEFAULT_STOP_LOSS_PCT = -3;
const DEFAULT_STRATEGY_ID = 'day-trading';
const TRADE_RATIO_PCT = 20;
const PRICE_POLL_INTERVAL_MS = 5_000;
const PRICE_TRIGGERED_SELL_CHECK_DEBOUNCE_MS = 1_000;
const SUBSCRIPTION_RETRY_BASE_DELAY_MS = 5_000;
const SUBSCRIPTION_RETRY_MAX_DELAY_MS = 60_000;
const SCHEDULED_CLEANUP_BALANCE_MAX_ATTEMPTS = 2;
const SCHEDULED_CLEANUP_BALANCE_RETRY_DELAY_MS = 5_000;

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
  /** 현재가 기반 익절/손절 검사 디바운스 타이머 */
  private priceTriggeredSellCheckTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** 현재가 기반 익절/손절 검사 중복 실행 방지 */
  private priceTriggeredSellCheckInFlight = new Set<string>();
  /**
   * 보유 수량이 있는 ACTIVE 세션의 stockCode 캐시.
   * 현재가 기반 익절/손절 트리거 판단에 사용해 보유 없는 종목의 DB 조회를 피한다.
   * 30초 루프의 잔고 동기화 직후 전체 재계산되며, 매수 이벤트 시 즉시 add 된다.
   */
  private holdingStockCodes = new Set<string>();
  /**
   * 매도 주문 접수가 진행 중인 세션 ID.
   * 동일 세션에 대해 실시간 트리거와 30초 루프가 동시에 executeSell 을
   * 호출해 이중 매도되는 것을 막기 위한 프로세스 내 락.
   */
  private sellInFlightSessionIds = new Set<number>();

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

  private async ensureOrderNotificationTrackingReady(): Promise<boolean> {
    const subscribed =
      await this.kisWsService.ensureOrderNotificationsSubscribed();
    if (!subscribed) {
      return false;
    }

    if (!this.notificationSub) {
      this.notificationSub = this.kisWsService.notification$.subscribe(
        (notification) => {
          this.handleOrderNotification(notification).catch((err) =>
            this.logger.error(`체결통보 처리 실패: ${err.message ?? err}`),
          );
        },
      );
    }

    return true;
  }

  private async warnOrderTrackingUnavailable(
    session: AutoTradingSessionEntity,
  ): Promise<void> {
    const detail =
      this.kisWsService.getOrderNotificationSubscriptionError() ??
      '체결통보 구독을 사용할 수 없습니다.';

    try {
      const notification = await this.notificationService.create(
        session.user.id,
        NotificationType.ORDER_TRACKING_WARNING,
        '주문 체결 추적 경고',
        `${session.stockName}(${session.stockCode}) 주문은 진행되지만 실시간 체결 추적이 비활성화되어 접수 기준으로 반영됩니다. ${detail}`,
        {
          stockCode: session.stockCode,
          sessionId: session.id,
          detail,
        },
      );
      this.gateway?.broadcastNotification(notification);
    } catch (err: any) {
      this.logger.warn(`주문 추적 경고 알림 생성 실패: ${err.message ?? err}`);
    }
  }

  private applyOptimisticBuyFill(
    session: AutoTradingSessionEntity,
    price: number,
    qty: number,
  ) {
    const totalCost = session.avgBuyPrice * session.holdingQty + price * qty;
    session.holdingQty += qty;
    session.avgBuyPrice = totalCost / session.holdingQty;
    session.totalBuys += 1;
    if (session.holdingQty > 0) {
      this.holdingStockCodes.add(session.stockCode);
    }
  }

  private applyOptimisticSellFill(
    session: AutoTradingSessionEntity,
    price: number,
    qty: number,
  ): number {
    const pnl = (price - session.avgBuyPrice) * qty;
    session.realizedPnl = Number(session.realizedPnl) + Math.round(pnl);
    session.holdingQty = Math.max(0, session.holdingQty - qty);
    if (session.holdingQty <= 0) {
      session.holdingQty = 0;
      session.avgBuyPrice = 0;
      session.unrealizedPnl = 0;
    }
    session.totalSells += 1;
    return Math.round(pnl);
  }

  private async getOpenOrderMap(
    sessions: AutoTradingSessionEntity[],
  ): Promise<Map<string, TradeHistoryEntity[]>> {
    const stockCodes = [
      ...new Set(sessions.map((session) => session.stockCode)),
    ];
    const userIds = [
      ...new Set(sessions.map((session) => this.getEntityUserId(session.user))),
    ].filter((id) => Number.isFinite(id));

    if (stockCodes.length === 0 || userIds.length === 0) {
      return new Map();
    }

    const orders = await this.em.find(TradeHistoryEntity, {
      action: TradeAction.ORDER,
      stockCode: { $in: stockCodes },
      user: { $in: userIds },
      status: {
        $in: [TradeStatus.ACCEPTED, TradeStatus.PARTIAL],
      },
    });

    const map = new Map<string, TradeHistoryEntity[]>();
    for (const order of orders) {
      const key = `${this.getEntityUserId(order.user)}:${order.stockCode}`;
      const existing = map.get(key) ?? [];
      existing.push(order);
      map.set(key, existing);
    }
    return map;
  }

  private async hasOpenOrder(
    userId: number,
    stockCode: string,
  ): Promise<boolean> {
    const openOrder = await this.em.findOne(TradeHistoryEntity, {
      action: TradeAction.ORDER,
      user: userId,
      stockCode,
      status: {
        $in: [TradeStatus.ACCEPTED, TradeStatus.PARTIAL],
      },
    });
    return Boolean(openOrder);
  }

  private hasOpenOrderInMap(
    session: AutoTradingSessionEntity,
    openOrders: Map<string, TradeHistoryEntity[]>,
  ): boolean {
    const userId = this.getEntityUserId(session.user);
    return (openOrders.get(`${userId}:${session.stockCode}`)?.length ?? 0) > 0;
  }

  private getEntityUserId(user: UserEntity | number): number {
    return typeof user === 'number' ? user : Number(user.id);
  }

  private setLatestPrice(
    stockCode: string,
    price: number,
    options?: { volume?: number; broadcast?: boolean },
  ) {
    this.latestPrices.set(stockCode, price);
    this.schedulePriceTriggeredSellCheck(stockCode);

    if (options?.broadcast && this.activeStockCodes.has(stockCode)) {
      this.gateway?.broadcastPriceUpdate({
        stockCode,
        price,
        volume: options.volume,
      });
    }
  }

  async onModuleInit() {
    const openOrderCount = await this.em.count(TradeHistoryEntity, {
      action: TradeAction.ORDER,
      status: { $in: [TradeStatus.ACCEPTED, TradeStatus.PARTIAL] },
    });
    if (openOrderCount > 0) {
      await this.ensureOrderNotificationTrackingReady();
    }

    // 서버 재시작 시 활성 세션이 있으면 모니터링 시작
    const activeSessions = await this.em.find(AutoTradingSessionEntity, {
      status: SessionStatus.ACTIVE,
    });
    // 활성 종목 캐시 복원 — gateway 의 브로드캐스트 필터링 기준이 된다
    for (const s of activeSessions) {
      this.activeStockCodes.add(s.stockCode);
    }
    this.refreshHoldingStockCodes(activeSessions);
    if (activeSessions.length > 0) {
      this.logger.log(`활성 자동매매 세션 ${activeSessions.length}개 복원`);
      this.startMonitoring(activeSessions);
    }
  }

  onModuleDestroy() {
    this.stopMonitoring();
    this.notificationSub?.unsubscribe();
    this.notificationSub = undefined;
    this.kisWsService.unsubscribeOrderNotifications();
  }

  /**
   * 복수 세션 일괄 시작
   * - 사전 검사: 활성 세션이 있는 종목에 onConflict가 지정되지 않으면 409로 충돌 정보 반환
   * - 충돌이 없거나 모두 해결된 경우에만 실제 생성/업데이트 진행 (부분 생성 방지)
   * - entryMode='immediate' 이면 세션 생성 직후 시장가 매수 실행
   */
  async startSessions(
    userId: number,
    dto: InternalStartSessionsDto,
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
      const effectiveDto: InternalStartSessionDto = {
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
    dto: InternalStartSessionDto,
  ): Promise<AutoTradingSessionEntity> {
    const user = await this.em.findOneOrFail(UserEntity, userId);

    // 클라이언트가 종목명 누락/공백 전송 시 KIS → market-data 순으로 보강.
    // 두 경로 모두 실패하면 최악의 경우에도 stockCode 로 대체해 빈 값 저장을 막는다.
    dto = {
      ...dto,
      stockName: await this.resolveStockName(dto.stockCode, dto.stockName),
    };

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
        if (dto.scheduledScan !== undefined) {
          existing.scheduledScan = dto.scheduledScan;
        }
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
      pauseReason: undefined,
      autoPausePending: false,
      scheduledScan: dto.scheduledScan ?? false,
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
    dto: InternalStartSessionDto,
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

  /**
   * DTO stockName 이 비어있거나 공백이면 KIS 현재가 → market-data `stock.lookup`
   * 순으로 보강. 모두 실패하면 stockCode 문자열을 반환해 빈 값 저장을 막는다.
   */
  private async resolveStockName(
    stockCode: string,
    provided?: string,
  ): Promise<string> {
    const trimmed = provided?.trim();
    if (trimmed) return trimmed;

    try {
      const raw = await this.kisQuotationService.getCurrentPrice(stockCode);
      const fromKis = raw?.hts_kor_isnm?.trim();
      if (fromKis) return fromKis;
    } catch (err: any) {
      this.logger.warn(
        `종목명 KIS 조회 실패 (${stockCode}): ${err.message ?? err}`,
      );
    }

    try {
      const lookup = await firstValueFrom(
        this.marketDataClient
          .send<{ code: string; name: string } | null>('stock.lookup', {
            code: stockCode,
          })
          .pipe(timeout(5_000)),
      );
      const fromMd = lookup?.name?.trim();
      if (fromMd) return fromMd;
    } catch (err: any) {
      this.logger.warn(
        `종목명 market-data 조회 실패 (${stockCode}): ${err.message ?? err}`,
      );
    }

    this.logger.warn(`종목명 확보 실패 — stockCode(${stockCode})로 대체 저장`);
    return stockCode;
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
    await this.applyLatestAiMeetingScores(userId, sessions);

    return sessions;
  }

  /**
   * 자동매매 세션 목록에 최신 AI 전문가 회의 점수를 덮어쓴다.
   * - ai_meeting_results 의 최신 결과를 우선 사용해 목록/새로고침 이후에도 점수 버튼을 유지한다.
   * - 응답용 보강이며 여기서 flush 하지는 않는다.
   */
  private async applyLatestAiMeetingScores(
    userId: number,
    sessions: AutoTradingSessionEntity[],
  ): Promise<void> {
    if (sessions.length === 0) return;

    const stockCodes = Array.from(
      new Set(sessions.map((session) => session.stockCode)),
    );
    const results = await this.em.find(AiMeetingResultEntity, {
      user: userId,
      stockCode: { $in: stockCodes },
    });
    const scoreMap = new Map(
      results.map((result) => [result.stockCode, result.score]),
    );

    for (const session of sessions) {
      const latestScore = scoreMap.get(session.stockCode);
      if (latestScore !== undefined) {
        session.aiScore = latestScore;
      }
    }
  }

  /**
   * KIS 실잔고를 조회하여 세션의 holdingQty / avgBuyPrice 를 실제 보유 현황과 동기화.
   * 잔고 조회 실패 시 기존 DB 값을 그대로 유지한다.
   */
  private async syncSessionsWithBalance(
    sessions: AutoTradingSessionEntity[],
  ): Promise<void> {
    if (sessions.length === 0) return;

    let balanceItems: KisBalanceItem[];
    try {
      const { items } = await this.kisInquiryService.getBalance();
      balanceItems = items;
    } catch {
      return; // 잔고 조회 실패 시 DB 값 유지
    }

    await this.applyBalanceSnapshotToSessions(sessions, balanceItems);
  }

  private async applyBalanceSnapshotToSessions(
    sessions: AutoTradingSessionEntity[],
    balanceItems: KisBalanceItem[],
  ): Promise<void> {
    if (sessions.length === 0) return;

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
    const pausedStockCodes = new Set<string>();
    for (const session of sessions) {
      if (session.status === SessionStatus.STOPPED) continue;

      const real = balanceMap.get(session.stockCode);
      const realQty = real?.qty ?? 0;
      const realAvg = real?.avgPrice ?? 0;

      if (session.holdingQty !== realQty || session.avgBuyPrice !== realAvg) {
        this.logger.log(
          `잔고 동기화: ${session.stockCode} holdingQty ${session.holdingQty} → ${realQty}, avgBuyPrice ${session.avgBuyPrice} → ${realAvg}`,
        );
        session.holdingQty = realQty;
        session.avgBuyPrice = realAvg;
        if (realQty <= 0) {
          session.avgBuyPrice = 0;
          session.unrealizedPnl = 0;
        } else {
          const latestPrice = this.latestPrices.get(session.stockCode);
          if (latestPrice) {
            session.unrealizedPnl = Math.round(
              (latestPrice - session.avgBuyPrice) * session.holdingQty,
            );
          }
        }
        changed = true;
      }

      if (session.autoPausePending && realQty <= 0) {
        this.applyPausedState(session, PauseReason.AUTO_SELL);
        pausedStockCodes.add(session.stockCode);
        changed = true;
      }
    }

    if (changed) {
      await this.em.flush();
      for (const stockCode of pausedStockCodes) {
        await this.syncStockActivity(stockCode);
      }
    }
  }

  private async syncSessionsWithBalanceForScheduledCleanup(
    sessions: AutoTradingSessionEntity[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    let lastError = 'unknown error';

    for (
      let attempt = 1;
      attempt <= SCHEDULED_CLEANUP_BALANCE_MAX_ATTEMPTS;
      attempt++
    ) {
      try {
        const { items } = await this.kisInquiryService.getBalance();
        await this.applyBalanceSnapshotToSessions(sessions, items);
        return { ok: true };
      } catch (err: any) {
        lastError = err?.message ?? String(err);
        this.logger.warn(
          `스케줄 정리 전 KIS 실잔고 조회 실패 (${attempt}/${SCHEDULED_CLEANUP_BALANCE_MAX_ATTEMPTS}): ${lastError}`,
        );
        if (attempt < SCHEDULED_CLEANUP_BALANCE_MAX_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, SCHEDULED_CLEANUP_BALANCE_RETRY_DELAY_MS),
          );
        }
      }
    }

    return { ok: false, error: lastError };
  }

  private async reconcilePendingAutoPauses(
    sessions: AutoTradingSessionEntity[],
  ): Promise<void> {
    const pendingSessions = sessions.filter(
      (session) => session.autoPausePending,
    );
    if (pendingSessions.length === 0) {
      return;
    }

    let balanceItems: import('../kis/kis.types').KisBalanceItem[];
    try {
      const { items } = await this.kisInquiryService.getBalance();
      balanceItems = items;
    } catch (err: any) {
      this.logger.warn(
        `자동 일시정지 대기 세션 잔고 조회 실패: ${err.message ?? err}`,
      );
      return;
    }

    const balanceMap = new Map<string, { qty: number; avgPrice: number }>();
    for (const item of balanceItems) {
      const code = item.pdno?.trim();
      if (!code) {
        continue;
      }
      balanceMap.set(code, {
        qty: Number(item.hldg_qty) || 0,
        avgPrice: Number(item.pchs_avg_pric) || 0,
      });
    }

    const pausedSessions: AutoTradingSessionEntity[] = [];
    const pausedStockCodes = new Set<string>();
    let changed = false;

    for (const session of pendingSessions) {
      const real = balanceMap.get(session.stockCode);
      const realQty = real?.qty ?? 0;
      const realAvg = real?.avgPrice ?? 0;

      if (session.holdingQty !== realQty || session.avgBuyPrice !== realAvg) {
        session.holdingQty = realQty;
        session.avgBuyPrice = realQty > 0 ? realAvg : 0;
        if (realQty <= 0) {
          session.unrealizedPnl = 0;
        } else {
          const latestPrice = this.latestPrices.get(session.stockCode);
          if (latestPrice) {
            session.unrealizedPnl = Math.round(
              (latestPrice - session.avgBuyPrice) * session.holdingQty,
            );
          }
        }
        changed = true;
      }

      if (realQty > 0) {
        continue;
      }

      this.applyPausedState(session, PauseReason.AUTO_SELL);
      pausedSessions.push(session);
      pausedStockCodes.add(session.stockCode);
      changed = true;
    }

    if (!changed) {
      return;
    }

    await this.em.flush();

    for (const stockCode of pausedStockCodes) {
      await this.syncStockActivity(stockCode);
    }
    for (const session of pausedSessions) {
      this.broadcastSessionUpdate(session);
      this.logger.log(
        `자동 매도 후 세션 일시정지 확정: ${session.stockName}(${session.stockCode})`,
      );
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

  private applyActiveState(session: AutoTradingSessionEntity) {
    session.status = SessionStatus.ACTIVE;
    session.pauseReason = undefined;
    session.autoPausePending = false;
  }

  private applyPausedState(
    session: AutoTradingSessionEntity,
    reason: PauseReason,
  ) {
    session.status = SessionStatus.PAUSED;
    session.pauseReason = reason;
    session.autoPausePending = false;
  }

  /** 세션 일시정지 */
  async pauseSession(
    sessionId: number,
    userId: number,
  ): Promise<AutoTradingSessionEntity> {
    const session = await this.getSession(sessionId, userId);
    this.applyPausedState(session, PauseReason.MANUAL);
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
    this.applyActiveState(session);
    await this.em.flush();
    await this.syncStockActivity(session.stockCode);
    this.broadcastSessionUpdate(session);
    return session;
  }

  /** 세션 설정 수정 — 전략/목표수익/손절 변경 */
  async updateSession(
    sessionId: number,
    userId: number,
    dto: InternalUpdateSessionDto,
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
    if (dto.scheduledScan !== undefined) {
      session.scheduledScan = dto.scheduledScan;
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
    session.pauseReason = undefined;
    session.autoPausePending = false;
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
    await this.syncSessionsWithBalance(sessions);
    this.refreshHoldingStockCodes(sessions);
    await this.reconcilePendingAutoPauses(sessions);
    const openOrders = await this.getOpenOrderMap(sessions);

    for (const session of sessions) {
      try {
        if (session.autoPausePending) {
          continue;
        }

        const price = this.latestPrices.get(session.stockCode);
        if (!price) continue;

        // 보유 중이면 익절/손절 체크 (세션별 목표 수익/손절 기준)
        if (session.holdingQty > 0 && session.avgBuyPrice > 0) {
          const sold = await this.evaluateAndExecuteSell(session, price);
          if (sold) continue;

          // 미실현 손익 갱신
          session.unrealizedPnl = Math.round(
            (price - session.avgBuyPrice) * session.holdingQty,
          );
        }

        if (
          this.kisWsService.isOrderNotificationsSubscribed() &&
          this.hasOpenOrderInMap(session, openOrders)
        ) {
          await this.em.flush();
          continue;
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
      const analysis = strategyFn(candles, config, session.stockCode);
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
    const trackingReady = await this.ensureOrderNotificationTrackingReady();
    if (!trackingReady) {
      await this.warnOrderTrackingUnavailable(session);
    }

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
        metadata: {
          sessionId: session.id,
          source: 'auto-buy',
          trackingMode: trackingReady ? 'notification' : 'optimistic-fallback',
        },
      });

      if (result.rt_cd !== '0') {
        this.logger.error(
          `매수 주문 거부: ${session.stockCode} - ${result.msg1}`,
        );
        return;
      }

      this.logger.log(
        `매수 주문 접수: ${session.stockCode} ${qty}주 @ ${price} ` +
          `(주문번호 ${result.output?.ODNO ?? 'N/A'})`,
      );
      if (!trackingReady) {
        this.applyOptimisticBuyFill(session, price, qty);
        await this.em.flush();
        this.broadcastSessionUpdate(session);
        this.createSignalNotification(session, 'buy', price, qty);
      }
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
      const trackingReady = await this.ensureOrderNotificationTrackingReady();
      if (!trackingReady) {
        await this.warnOrderTrackingUnavailable(session);
      }

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
        metadata: {
          sessionId: session.id,
          source: 'immediate-buy',
          trackingMode: trackingReady ? 'notification' : 'optimistic-fallback',
        },
      });

      if (result.rt_cd !== '0') {
        this.logger.error(
          `즉시 매수 주문 거부: ${session.stockCode} - ${result.msg1}`,
        );
        return;
      }

      this.setLatestPrice(session.stockCode, price, { broadcast: true });
      this.logger.log(
        `즉시 매수 주문 접수: ${session.stockCode} ${qty}주 ` +
          `(주문번호 ${result.output?.ODNO ?? 'N/A'})`,
      );
      if (!trackingReady) {
        this.applyOptimisticBuyFill(session, price, qty);
        await this.em.flush();
        this.broadcastSessionUpdate(session);
      }
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
    if (session.autoPausePending) return;
    if (this.sellInFlightSessionIds.has(session.id)) return;

    this.sellInFlightSessionIds.add(session.id);
    try {
      const trackingReady = await this.ensureOrderNotificationTrackingReady();
      if (!trackingReady) {
        await this.warnOrderTrackingUnavailable(session);
      }

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
          metadata: {
            sessionId: session.id,
            source: 'auto-sell',
            reason,
            pauseAfterSell: true,
            trackingMode: trackingReady
              ? 'notification'
              : 'optimistic-fallback',
          },
        });

        if (result.rt_cd !== '0') {
          this.logger.error(
            `매도 주문 거부: ${session.stockCode} - ${result.msg1}`,
          );
          return;
        }

        this.logger.log(
          `매도 주문 접수: ${session.stockCode} ${session.holdingQty}주 (${reason}) ` +
            `(주문번호 ${result.output?.ODNO ?? 'N/A'})`,
        );
        session.autoPausePending = true;
        session.pauseReason = undefined;
        if (!trackingReady) {
          const sellQty = session.holdingQty;
          const pnl = this.applyOptimisticSellFill(session, price, sellQty);
          await this.em.flush();
          this.broadcastSessionUpdate(session);
          this.createSignalNotification(
            session,
            'sell',
            price,
            sellQty,
            reason,
            pnl,
          );
          await this.pauseSessionAfterAutoSell(session, reason);
        } else {
          await this.em.flush();
          this.broadcastSessionUpdate(session);
        }
      } catch (err: any) {
        this.logger.error(`매도 실패: ${session.stockCode} - ${err.message}`);
      }
    } finally {
      this.sellInFlightSessionIds.delete(session.id);
    }
  }

  private async handleOrderNotification(
    notification: KisRealtimeOrderNotification,
  ): Promise<void> {
    if (notification.isRejected) {
      const history =
        await this.kisOrderService.markOrderRejected(notification);
      const sessionId = Number(history?.rawResponse?.meta?.sessionId ?? 0);
      if (history?.rawResponse?.meta?.pauseAfterSell && sessionId > 0) {
        const session = await this.em.findOne(
          AutoTradingSessionEntity,
          sessionId,
        );
        if (session?.autoPausePending) {
          session.autoPausePending = false;
          await this.em.flush();
          this.broadcastSessionUpdate(session);
        }
      }
      return;
    }

    if (!notification.isExecuted || notification.executionQty <= 0) {
      return;
    }

    const execution =
      await this.kisOrderService.recordExecutionNotification(notification);
    if (!execution) {
      return;
    }

    const sessionId = Number(
      execution.history.rawResponse?.meta?.sessionId ?? 0,
    );
    if (!sessionId) {
      return;
    }

    if (
      execution.history.rawResponse?.meta?.trackingMode ===
      'optimistic-fallback'
    ) {
      return;
    }

    const session = await this.em.findOne(AutoTradingSessionEntity, sessionId);
    if (!session) {
      return;
    }

    const executedQty = execution.appliedQty;
    const executedPrice =
      Number(notification.executionPrice) ||
      Number(notification.orderPrice) ||
      0;
    const wasFirstExecution = execution.previousExecutedQty === 0;

    if (execution.history.tradeType === TradeType.BUY) {
      const totalCost =
        session.avgBuyPrice * session.holdingQty + executedPrice * executedQty;
      session.holdingQty += executedQty;
      session.avgBuyPrice =
        session.holdingQty > 0 ? totalCost / session.holdingQty : 0;
      if (wasFirstExecution) {
        session.totalBuys += 1;
      }
      if (session.holdingQty > 0) {
        this.holdingStockCodes.add(session.stockCode);
      }
      const latestPrice = this.latestPrices.get(session.stockCode);
      if (latestPrice) {
        session.unrealizedPnl = Math.round(
          (latestPrice - session.avgBuyPrice) * session.holdingQty,
        );
      }
      this.createSignalNotification(session, 'buy', executedPrice, executedQty);
    } else if (execution.history.tradeType === TradeType.SELL) {
      const sellQty = Math.min(executedQty, session.holdingQty);
      const pnl = (executedPrice - session.avgBuyPrice) * sellQty;
      session.realizedPnl = Number(session.realizedPnl) + Math.round(pnl);
      session.holdingQty = Math.max(0, session.holdingQty - sellQty);
      if (wasFirstExecution) {
        session.totalSells += 1;
      }
      if (session.holdingQty <= 0) {
        session.holdingQty = 0;
        session.avgBuyPrice = 0;
        session.unrealizedPnl = 0;
      } else {
        const latestPrice = this.latestPrices.get(session.stockCode);
        if (latestPrice) {
          session.unrealizedPnl = Math.round(
            (latestPrice - session.avgBuyPrice) * session.holdingQty,
          );
        }
      }

      this.createSignalNotification(
        session,
        'sell',
        executedPrice,
        sellQty,
        execution.history.rawResponse?.meta?.reason,
        Math.round(pnl),
      );
    }

    await this.em.flush();
    this.broadcastSessionUpdate(session);

    if (
      execution.isFullyExecuted &&
      session.holdingQty <= 0 &&
      execution.history.rawResponse?.meta?.pauseAfterSell
    ) {
      const reason = execution.history.rawResponse?.meta?.reason as
        | string
        | undefined;
      await this.pauseSessionAfterAutoSell(session, reason);
    }
  }

  /**
   * 자동 익절/손절 매도 체결 후 세션 상태를 PAUSED 로 전환한다.
   * 실제 잔고를 재확인해 아직 보유 중이면 상태를 그대로 둔다
   * (부분 체결 등으로 다음 사이클에서 계속 감시 필요).
   */
  private async pauseSessionAfterAutoSell(
    session: AutoTradingSessionEntity,
    reason?: string,
  ) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      const { items } = await this.kisInquiryService.getBalance();
      const stillHeld = items.some(
        (item) =>
          item.pdno?.trim() === session.stockCode && Number(item.hldg_qty) > 0,
      );

      if (stillHeld) {
        this.logger.log(
          `매도 후 잔고 확인: ${session.stockCode} 아직 보유중 — 자동 일시정지 대기 유지`,
        );
        return;
      }

      if (session.status === SessionStatus.PAUSED) {
        session.autoPausePending = false;
        session.pauseReason = PauseReason.AUTO_SELL;
        await this.em.flush();
        return;
      }

      this.applyPausedState(session, PauseReason.AUTO_SELL);
      await this.em.flush();
      await this.syncStockActivity(session.stockCode);
      this.broadcastSessionUpdate(session);
      this.logger.log(
        `자동 매도 후 세션 일시정지: ${session.stockName}(${session.stockCode})` +
          (reason ? ` — ${reason}` : ''),
      );
    } catch (err: any) {
      this.logger.warn(
        `매도 후 세션 일시정지 처리 실패: ${session.stockCode} - ${err.message ?? err}`,
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

    void this.ensureOrderNotificationTrackingReady();

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
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    for (const interval of this.pollingStockIntervals.values()) {
      clearInterval(interval);
    }
    for (const timer of this.subscriptionRetryTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.priceTriggeredSellCheckTimers.values()) {
      clearTimeout(timer);
    }
    this.executionSub = undefined;
    this.subscriptionResultSub = undefined;
    this.monitorInterval = undefined;
    this.pollingStockIntervals.clear();
    this.pollingInFlight.clear();
    this.subscriptionRetryTimers.clear();
    this.subscriptionRetryAttempts.clear();
    this.priceTriggeredSellCheckTimers.clear();
    this.priceTriggeredSellCheckInFlight.clear();
    this.holdingStockCodes.clear();
    this.sellInFlightSessionIds.clear();
  }

  private schedulePriceTriggeredSellCheck(stockCode: string) {
    // 보유 수량 없는 종목은 DB 조회까지 갈 필요 없이 스킵한다.
    // 매수 이벤트는 applyOptimisticBuyFill/handleOrderNotification 에서 add 되고,
    // 30초 루프의 refreshHoldingStockCodes 가 주기적으로 전체 재계산한다.
    if (
      !this.activeStockCodes.has(stockCode) ||
      !this.holdingStockCodes.has(stockCode) ||
      this.priceTriggeredSellCheckTimers.has(stockCode)
    ) {
      return;
    }

    const timer = setTimeout(() => {
      this.priceTriggeredSellCheckTimers.delete(stockCode);
      void this.checkSellThresholdsForStock(stockCode);
    }, PRICE_TRIGGERED_SELL_CHECK_DEBOUNCE_MS);

    this.priceTriggeredSellCheckTimers.set(stockCode, timer);
  }

  private async checkSellThresholdsForStock(stockCode: string): Promise<void> {
    if (
      this.priceTriggeredSellCheckInFlight.has(stockCode) ||
      !this.activeStockCodes.has(stockCode)
    ) {
      return;
    }

    const price = this.latestPrices.get(stockCode);
    if (!price) {
      return;
    }

    this.priceTriggeredSellCheckInFlight.add(stockCode);

    try {
      const sessions = await this.em.find(AutoTradingSessionEntity, {
        stockCode,
        status: SessionStatus.ACTIVE,
      });

      for (const session of sessions) {
        await this.evaluateAndExecuteSell(session, price);
      }
    } catch (err: any) {
      this.logger.error(
        `현재가 기반 익절/손절 검사 오류: ${stockCode} - ${err.message ?? err}`,
      );
    } finally {
      this.priceTriggeredSellCheckInFlight.delete(stockCode);
    }
  }

  /**
   * 세션의 현재 보유 상태에서 익절/손절 조건을 평가하고 해당 시 executeSell 호출.
   * 30초 루프와 실시간 체결가 트리거가 공유하는 단일 진입점.
   * @returns 매도 실행이 일어난 경우 true
   */
  private async evaluateAndExecuteSell(
    session: AutoTradingSessionEntity,
    price: number,
  ): Promise<boolean> {
    if (
      session.autoPausePending ||
      session.holdingQty <= 0 ||
      session.avgBuyPrice <= 0
    ) {
      return false;
    }

    const returnPct =
      ((price - session.avgBuyPrice) / session.avgBuyPrice) * 100;

    if (returnPct >= session.takeProfitPct) {
      await this.executeSell(
        session,
        price,
        `자동 익절 (${returnPct.toFixed(1)}%)`,
      );
      return true;
    }
    if (returnPct <= session.stopLossPct) {
      await this.executeSell(
        session,
        price,
        `자동 손절 (${returnPct.toFixed(1)}%)`,
      );
      return true;
    }
    return false;
  }

  /**
   * 전체 ACTIVE 세션 기준으로 보유 종목 캐시를 재계산한다.
   * 매도 체결로 인한 holdingQty 감소는 이 경로에서만 반영되므로 — 30초 루프에서
   * 호출해 이벤트 기반 add 와의 오차를 주기적으로 교정한다.
   */
  private refreshHoldingStockCodes(
    sessions: AutoTradingSessionEntity[],
  ): void {
    const next = new Set<string>();
    for (const session of sessions) {
      if (
        session.status === SessionStatus.ACTIVE &&
        session.holdingQty > 0
      ) {
        next.add(session.stockCode);
      }
    }
    this.holdingStockCodes = next;
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

    const trackingReady = await this.ensureOrderNotificationTrackingReady();
    if (!trackingReady) {
      await this.warnOrderTrackingUnavailable(session);
    }

    if (
      trackingReady &&
      (await this.hasOpenOrder(session.user.id, session.stockCode))
    ) {
      throw new ConflictException({
        message: '미체결 주문이 있어 새 주문을 낼 수 없습니다.',
        code: 'OPEN_ORDER_EXISTS',
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
      metadata: {
        sessionId: session.id,
        source: 'manual',
        trackingMode: trackingReady ? 'notification' : 'optimistic-fallback',
      },
    });

    // KIS 주문 실패 시 세션 상태를 변경하지 않고 에러 반환
    if (orderResult.rt_cd !== '0') {
      throw new ConflictException({
        message: orderResult.msg1 || 'KIS 주문이 실패했습니다.',
        code: 'ORDER_FAILED',
      });
    }

    if (!trackingReady) {
      if (dto.orderType === 'buy') {
        const estimatedPrice =
          dto.orderDvsn === '01'
            ? (this.latestPrices.get(session.stockCode) ?? session.avgBuyPrice)
            : price;
        this.applyOptimisticBuyFill(session, estimatedPrice, dto.quantity);
      } else {
        const sellPrice =
          dto.orderDvsn === '01'
            ? (this.latestPrices.get(session.stockCode) ?? session.avgBuyPrice)
            : price;
        this.applyOptimisticSellFill(session, sellPrice, dto.quantity);
      }

      await this.em.flush();
      this.broadcastSessionUpdate(session);
    }

    return session;
  }

  /**
   * 스케줄러 사전 정리 — `scheduledScan=true` 이면서 현재 보유하지 않은(holdingQty=0)
   * 세션을 일괄 삭제한다. 보유 중이거나 수동 등록(scheduledScan=false)인 세션은 유지.
   * 삭제 후 실시간 구독/활성 종목 캐시와 프론트 브로드캐스트까지 동기화한다.
   */
  async removeStaleScheduledScanSessions(userId: number): Promise<{
    deletedCount: number;
    stockCodes: string[];
    skippedDueToBalanceSyncFailure: boolean;
    balanceSyncError?: string;
  }> {
    const scheduledSessions = await this.em.find(AutoTradingSessionEntity, {
      user: userId,
      scheduledScan: true,
      status: { $in: [SessionStatus.ACTIVE, SessionStatus.PAUSED] },
    });
    if (scheduledSessions.length === 0) {
      return {
        deletedCount: 0,
        stockCodes: [],
        skippedDueToBalanceSyncFailure: false,
      };
    }

    const balanceSync =
      await this.syncSessionsWithBalanceForScheduledCleanup(scheduledSessions);
    if (!balanceSync.ok) {
      return {
        deletedCount: 0,
        stockCodes: [],
        skippedDueToBalanceSyncFailure: true,
        balanceSyncError: balanceSync.error,
      };
    }

    const stale = scheduledSessions.filter((s) => s.holdingQty === 0);
    if (stale.length === 0) {
      return {
        deletedCount: 0,
        stockCodes: [],
        skippedDueToBalanceSyncFailure: false,
      };
    }

    const removedRefs = stale.map((s) => ({
      id: s.id,
      stockCode: s.stockCode,
      stockName: s.stockName,
    }));
    const uniqueStockCodes = Array.from(
      new Set(removedRefs.map((r) => r.stockCode)),
    );

    await this.em.removeAndFlush(stale);

    for (const stockCode of uniqueStockCodes) {
      await this.syncStockActivity(stockCode);
    }
    for (const { id, stockCode } of removedRefs) {
      this.broadcastSessionRemoved(id, stockCode);
    }

    this.logger.log(
      `스케줄 스캔 사전 정리: 보유 0 & 자동 등록 세션 ${stale.length}개 삭제 ` +
        `(${uniqueStockCodes.join(', ')})`,
    );

    return {
      deletedCount: stale.length,
      stockCodes: uniqueStockCodes,
      skippedDueToBalanceSyncFailure: false,
    };
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
