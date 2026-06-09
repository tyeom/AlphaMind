import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { EntityManager } from '@mikro-orm/postgresql';
import { firstValueFrom } from 'rxjs';
import { computeAtrDynamicTpSl } from '@alpha-mind/strategies';
import {
  AutoTradingSessionEntity,
  PauseReason,
  SessionStatus,
} from './entities/auto-trading-session.entity';
import { AutoTradingService } from './auto-trading.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';
import { MARKET_DATA_SERVICE } from '../rmq/rmq.module';

const SCAN_INVESTMENT_AMOUNT = 1_000_000;
const SCAN_TOP_N = 35;
/**
 * market-data 그리드 서치 결과 미수신/실패 시 fallback.
 * 단타 손익비 1:1(±1.8) 은 break-even 근처라 작은 노이즈 손절이 누적된다.
 * 1.25:1 비대칭(2.5/-2.0) + 진입 종목별 ATR 동적 보정으로 손익비 우위 확보.
 */
const SCAN_AUTO_TAKE_PROFIT_PCT = 2.5;
const SCAN_AUTO_STOP_LOSS_PCT = -2.0;
const SCAN_MAX_HOLDING_DAYS = 7;
const MIN_BUY_SIGNAL_STRENGTH = 0.65;
const SESSION_MAX_HOLDING_DAYS = 7;
const SCAN_JOB_NAME = 'scheduled-ai-scan';
const SCAN_LOCK_TTL_MINUTES = 30;
const SCAN_RESULT_CLAIM_TTL_MINUTES = 5;

/** 동시 운용 종목 상한 — 모니터링 부담 + 시장 체제 변화 시 동시 손실 위험 제한 */
const MAX_CONCURRENT_HOLDINGS = 15;
/** 한 섹터 동시 보유 상한 — 같은 섹터 클러스터 손실 방지 */
const MAX_PER_SECTOR = 4;
/** 변동성 역가중 시 한 종목당 최소/최대 가중치 — 극단 배분 방지 */
const VOL_WEIGHT_MIN = 0.5;
const VOL_WEIGHT_MAX = 2.0;
const R_SIZING_ENABLED = false;
const R_SIZING_OVERRIDES_VOL_WEIGHT = false;
const R_VOL_WEIGHT_MIN = 0.8;
const R_VOL_WEIGHT_MAX = 1.25;
/** 변동성 정보 결손 시 가정값 (%) — 한국 일반 종목 ATR/가격 중앙값 */
const FALLBACK_VOLATILITY_PCT = 3.0;
const DEFAULT_REGIME_MIN_HOLDINGS_FLOOR = 3;
const DEFAULT_REGIME_AMOUNT_FLOOR = 0.4;
const DEFAULT_MAX_PER_CLUSTER = 2;

type RegimeLabel = 'CRISIS' | 'NEUTRAL' | 'ATTACK';

interface BreadthSnapshot {
  universeCount: number;
  aboveSma20Ratio: number;
  aboveSma60Ratio: number;
  medianDailyReturnPct: number;
  medianRet5dPct: number;
  medianAtrPct: number;
}

interface RegimeResult {
  label: RegimeLabel;
  rawScore: number;
  smoothedScore: number;
  slotMultiplier: number;
  amountMultiplier: number;
  breadth: BreadthSnapshot;
  source: 'breadth' | 'fallback';
}

interface ScanResult {
  stockCode: string;
  stockName: string;
  sector?: string;
  clusterId?: number;
  volatilityPct?: number;
  /** market-data 백테스트에 실제 적용된 TP/SL. backend 는 이 값을 그대로 세션에 반영한다. */
  autoTakeProfitPct?: number;
  autoStopLossPct?: number;
  bestStrategy: { strategyId: string; strategyName: string; variant?: string };
  currentSignal: { direction: string; strength: number; reason: string };
}

interface ScanResponse {
  scannedStocks: number;
  eligibleStocks: number;
  excludedStocks: number;
  results: ScanResult[];
  regime?: RegimeResult;
  clusters?: Array<{ clusterId: number; codes: string[]; size: number }>;
  survivorshipBias?: {
    universeSize: number;
    delistedRetained: number;
    assumedAnnualDelistRate: number;
    estimatedReturnHaircutPct: number;
    researchAnchor: string;
    note: string;
  };
}

export interface ScanCompletedEvent {
  userId: number;
  requestId: string;
  response: ScanResponse;
}

export interface ScanFailedEvent {
  userId: number;
  requestId: string;
  error: string;
}

@Injectable()
export class ScheduledScannerService {
  private readonly logger = new Logger(ScheduledScannerService.name);
  private readonly handlerInstanceId = `${process.pid}:${Math.random().toString(36).slice(2, 10)}`;

  constructor(
    private readonly configService: ConfigService,
    private readonly em: EntityManager,
    private readonly autoTradingService: AutoTradingService,
    private readonly notificationService: NotificationService,
    @Inject(MARKET_DATA_SERVICE) private readonly marketDataClient: ClientProxy,
  ) {}

  private getBooleanConfig(key: string, fallback = false): boolean {
    const value = this.configService.get<boolean | string | number>(key);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    if (typeof value === 'number') return value === 1;
    return fallback;
  }

  private getNumberConfig(key: string, fallback: number): number {
    const value = this.configService.get<number | string>(key);
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  @Cron('0 0 8 * * 1-5', {
    name: SCAN_JOB_NAME,
    timeZone: 'Asia/Seoul',
  })
  async handleDailyScan(): Promise<void> {
    const result = await this.triggerScan('cron');
    if (!result.triggered) {
      this.logger.warn(`예약 스캔 건너뜀: ${result.reason}`);
    }
  }

  /**
   * 예약 스캔을 지금 실행한다. Cron 핸들러와 수동 트리거 API가 공통으로 사용한다.
   * - `SCHEDULED_TRADER_USER_ID` 미설정 시 `no_user_id`
   * - 다른 인스턴스가 이미 실행 중(락 점유)인 경우 `already_running`
   * - emit 단계에서 실패하면 락을 해제하고 에러 throw
   */
  async triggerScan(source: 'cron' | 'manual'): Promise<{
    triggered: boolean;
    reason?: 'no_user_id' | 'already_running';
    userId?: number;
  }> {
    const userId = this.configService.get<number>('SCHEDULED_TRADER_USER_ID');
    if (!userId) {
      return { triggered: false, reason: 'no_user_id' };
    }

    // requestId를 락 owner로 사용해 완료/실패 이벤트와 DB 락을 직접 매칭한다.
    const requestId = randomUUID();
    const locked = await this.acquireScanLock(requestId);
    if (!locked) {
      return { triggered: false, reason: 'already_running' };
    }

    this.logger.log(`예약 스캔 트리거 (source=${source})`);

    try {
      await this.requestScan(userId, requestId);
      return { triggered: true, userId };
    } catch (err: any) {
      this.logger.error(`예약 스캔 요청 실패: ${err.message ?? err}`);
      await this.releaseScanLock(requestId, requestId);
      throw err;
    }
  }

  /**
   * 예약 스캔 요청 단계 — cleanup + market-data-service로 스캔 이벤트 publish.
   * 실제 후처리(resume/start)는 {@link handleScanCompleted}가 완료 이벤트 수신 시 수행한다.
   * 락은 완료/실패 이벤트 수신 시점 또는 TTL(30분)으로 해제된다.
   */
  private async requestScan(userId: number, requestId: string): Promise<void> {
    this.logger.log(`예약 스캔 요청 시작 (userId=${userId})`);

    const cleanup =
      await this.autoTradingService.removeStaleScheduledScanSessions(userId);
    if (cleanup.skippedDueToBalanceSyncFailure) {
      const detail = cleanup.balanceSyncError ?? 'unknown error';
      this.logger.warn(
        `예약 스캔 사전 삭제 스킵: KIS 실잔고 조회 2회 실패 (${detail})`,
      );
      await this.notificationService.create(
        userId,
        NotificationType.SCHEDULED_SCAN_WARNING,
        '예약 스캔 삭제 작업 건너뜀',
        'KIS 실시간 잔고 조회가 2회 실패해 기존 자동 스캔 세션 삭제를 건너뛰고, 신규 등록/갱신은 계속 진행합니다.',
        {
          scheduledScan: true,
          phase: 'pre_cleanup',
          retryAttempts: 2,
          balanceSyncError: detail,
        },
      );
    }

    const existing = await this.em.find(AutoTradingSessionEntity, {
      user: userId,
    });
    const activeCodes = new Set(
      existing
        .filter((s) => s.status === SessionStatus.ACTIVE)
        .map((s) => s.stockCode),
    );
    // 수동 등록(scheduledScan=false) 세션과 중복되는 종목은 상태와 무관하게 스캔 대상에서 제외.
    // 스케줄러가 수동 운용 종목을 덮어쓰지 않도록 보호한다.
    const manualCodes = new Set(
      existing.filter((s) => !s.scheduledScan).map((s) => s.stockCode),
    );
    const excludeCodes = Array.from(new Set([...activeCodes, ...manualCodes]));
    const regimeEnabled = this.getBooleanConfig(
      'REGIME_SCALING_ENABLED',
      false,
    );
    const correlationEnabled = this.getBooleanConfig(
      'CORRELATION_CAP_ENABLED',
      false,
    );

    // 단타 최적 TP/SL — market-data-service 의 그리드 서치 결과를 가져온다.
    // 영속화된 결과가 없거나 RMQ 실패 시 코드 기본값으로 자동 fallback.
    const optimal = await this.fetchOptimalShortTermTpSl();

    await firstValueFrom(
      this.marketDataClient.emit('strategy.scan.request', {
        userId,
        requestId,
        excludeCodes,
        topN: SCAN_TOP_N,
        investmentAmount: SCAN_INVESTMENT_AMOUNT,
        autoTakeProfitPct: optimal.tpPct,
        autoStopLossPct: optimal.slPct,
        maxHoldingDays: SCAN_MAX_HOLDING_DAYS,
        minCurrentSignalStrength: MIN_BUY_SIGNAL_STRENGTH,
        regimeEnabled,
        correlationEnabled,
        correlationCodes: Array.from(activeCodes),
      }),
      { defaultValue: undefined },
    );

    this.logger.log(
      `예약 스캔 이벤트 emit 완료 — requestId=${requestId} exclude=${excludeCodes.length}건 ` +
        `(active=${activeCodes.size}, manual=${manualCodes.size}), ` +
        `regime=${regimeEnabled ? 'ON' : 'OFF'} correlation=${correlationEnabled ? 'ON' : 'OFF'}, ` +
        `TP=${optimal.tpPct}% SL=${optimal.slPct}% (${optimal.source}), 완료 이벤트 대기`,
    );
  }

  /**
   * 단타 최적 TP/SL 을 market-data-service 에 RMQ 로 조회.
   * 그리드 서치가 한 번도 안 돌았거나 RMQ 가 끊긴 환경에서도 안전하도록
   * 결과 없음/에러 시 코드 기본값으로 fallback.
   */
  private async fetchOptimalShortTermTpSl(): Promise<{
    tpPct: number;
    slPct: number;
    source: 'optimized' | 'default' | 'fallback';
  }> {
    try {
      const result = await firstValueFrom(
        this.marketDataClient.send<{
          tpPct: number;
          slPct: number;
          source: 'optimized' | 'default';
        }>('strategy.optimal-params', {}),
        { defaultValue: null },
      );
      if (
        result &&
        typeof result.tpPct === 'number' &&
        typeof result.slPct === 'number'
      ) {
        return result;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `optimal TP/SL 조회 실패 — 코드 기본값(TP=${SCAN_AUTO_TAKE_PROFIT_PCT}/SL=${SCAN_AUTO_STOP_LOSS_PCT})으로 진행: ${msg}`,
      );
    }
    return {
      tpPct: SCAN_AUTO_TAKE_PROFIT_PCT,
      slPct: SCAN_AUTO_STOP_LOSS_PCT,
      source: 'fallback',
    };
  }

  private resolveRegimeScale(response: ScanResponse): {
    enabled: boolean;
    label: RegimeLabel | 'NONE';
    source: 'breadth' | 'fallback' | 'none';
    slotMultiplier: number;
    amountMultiplier: number;
  } {
    if (!this.getBooleanConfig('REGIME_SCALING_ENABLED', false)) {
      return {
        enabled: false,
        label: 'NONE',
        source: 'none',
        slotMultiplier: 1,
        amountMultiplier: 1,
      };
    }

    try {
      const regime = response.regime;
      if (!regime) {
        return {
          enabled: true,
          label: 'NONE',
          source: 'none',
          slotMultiplier: 1,
          amountMultiplier: 1,
        };
      }

      const slotMultiplier = Number.isFinite(regime.slotMultiplier)
        ? regime.slotMultiplier
        : 1;
      const amountMultiplier = Number.isFinite(regime.amountMultiplier)
        ? regime.amountMultiplier
        : 1;

      return {
        enabled: true,
        label: regime.label,
        source: regime.source,
        slotMultiplier: slotMultiplier > 0 ? slotMultiplier : 1,
        amountMultiplier: amountMultiplier > 0 ? amountMultiplier : 1,
      };
    } catch (err: any) {
      this.logger.warn(
        `레짐 스케일 해석 실패 — NEUTRAL 폴백: ${err.message ?? err}`,
      );
      return {
        enabled: true,
        label: 'NONE',
        source: 'fallback',
        slotMultiplier: 1,
        amountMultiplier: 1,
      };
    }
  }

  private resolveClusterGate(
    response: ScanResponse,
    activeCodes: Set<string>,
  ): {
    enabled: boolean;
    maxPerCluster: number;
    clusterCounts: Map<number, number>;
  } {
    if (!this.getBooleanConfig('CORRELATION_CAP_ENABLED', false)) {
      return {
        enabled: false,
        maxPerCluster: DEFAULT_MAX_PER_CLUSTER,
        clusterCounts: new Map(),
      };
    }

    try {
      const maxPerCluster = this.getNumberConfig(
        'MAX_PER_CLUSTER',
        DEFAULT_MAX_PER_CLUSTER,
      );
      const clusterOf = new Map<string, number>();
      for (const cluster of response.clusters ?? []) {
        for (const code of cluster.codes) {
          clusterOf.set(code, cluster.clusterId);
        }
      }

      const clusterCounts = new Map<number, number>();
      for (const code of activeCodes) {
        const clusterId = clusterOf.get(code);
        if (clusterId != null) {
          clusterCounts.set(clusterId, (clusterCounts.get(clusterId) ?? 0) + 1);
        }
      }

      return { enabled: true, maxPerCluster, clusterCounts };
    } catch (err: any) {
      this.logger.warn(
        `상관 클러스터 게이트 초기화 실패 — 캡 미적용: ${err.message ?? err}`,
      );
      return {
        enabled: false,
        maxPerCluster: DEFAULT_MAX_PER_CLUSTER,
        clusterCounts: new Map(),
      };
    }
  }

  /**
   * market-data-service로부터 스캔 완료 이벤트 수신 시 후처리.
   * - 매수 후보 필터링 → PAUSED 세션은 재개, 신규는 시작
   * - 락은 마지막에 해제
   */
  async handleScanCompleted(event: ScanCompletedEvent): Promise<void> {
    const { userId, requestId, response } = event;
    this.logger.log(
      `scan.completed 수신 userId=${userId} requestId=${requestId} results=${response.results.length}`,
    );

    const claimedOwner = await this.claimResultHandlingLock(requestId);
    if (!claimedOwner) {
      return;
    }

    try {
      await this.applyScanResults(userId, response);
    } catch (err: any) {
      this.logger.error(`예약 스캔 후처리 실패: ${err.message ?? err}`);
    } finally {
      await this.releaseScanLock(claimedOwner, requestId);
    }
  }

  /** market-data-service로부터 스캔 실패 이벤트 수신 시 락 해제 + 알림 */
  async handleScanFailed(event: ScanFailedEvent): Promise<void> {
    const { userId, requestId, error } = event;
    this.logger.error(
      `scan.failed 수신 userId=${userId} requestId=${requestId} error=${error}`,
    );

    const claimedOwner = await this.claimResultHandlingLock(requestId);
    if (!claimedOwner) {
      return;
    }

    try {
      await this.notificationService.create(
        userId,
        NotificationType.SCHEDULED_SCAN_WARNING,
        '예약 스캔 실행 실패',
        `market-data-service 스캔 처리 중 오류가 발생했습니다: ${error}`,
        {
          scheduledScan: true,
          phase: 'scan_execution',
          requestId,
          error,
        },
      );
    } catch (err: any) {
      this.logger.warn(`스캔 실패 알림 생성 실패: ${err.message ?? err}`);
    } finally {
      await this.releaseScanLock(claimedOwner, requestId);
    }
  }

  /**
   * 완료/실패 이벤트는 여러 backend 인스턴스가 동시에 받을 수 있으므로
   * owner=requestId 상태를 원자적으로 handling owner로 바꾸는 인스턴스만 후처리한다.
   * 오래 걸린 스캔의 완료 이벤트도 새 요청이 owner를 덮어쓰기 전까지는 처리할 수 있어야 하므로
   * locked_until 대신 owner(requestId) 일치 여부를 claim 기준으로 사용한다.
   */
  private async claimResultHandlingLock(
    requestId: string,
  ): Promise<string | null> {
    const claimedOwner = `handling:${requestId}:${this.handlerInstanceId}`;

    try {
      const rows = await this.em
        .getConnection()
        .execute<Array<{ job_name: string }>>(
          `
          update scheduled_job_locks
             set "owner" = '${claimedOwner}',
                 "locked_until" = greatest(
                   "locked_until",
                   now() + interval '${SCAN_RESULT_CLAIM_TTL_MINUTES} minutes'
                 ),
                 "updated_at" = now()
           where "job_name" = '${SCAN_JOB_NAME}'
             and "owner" = '${requestId}'
         returning "job_name";
        `,
        );
      if (rows.length > 0) {
        this.logger.log(
          `scan 이벤트 후처리 claim 성공 requestId=${requestId} owner=${claimedOwner}`,
        );
        return claimedOwner;
      }

      this.logger.log(
        `scan 이벤트 후처리 스킵 requestId=${requestId} (이미 처리 중이거나 다른 요청이 락을 점유 중)`,
      );
      return null;
    } catch (err: any) {
      this.logger.warn(
        `scan 이벤트 claim 실패 requestId=${requestId}: ${err.message ?? err}`,
      );
      return null;
    }
  }

  private async applyScanResults(
    userId: number,
    response: ScanResponse,
  ): Promise<void> {
    // optimal 은 그리드 서치(또는 fallback)의 평균 최적값.
    // market-data 가 종목별 ATR 보정 TP/SL 로 백테스트한 값을 내려주면 그 값을 그대로 사용한다.
    const optimal = await this.fetchOptimalShortTermTpSl();
    const baseTpPct = optimal.tpPct;
    const baseSlPct = optimal.slPct;

    const existing = await this.em.find(AutoTradingSessionEntity, {
      user: userId,
    });
    const activeSessions = existing.filter(
      (s) => s.status === SessionStatus.ACTIVE,
    );
    const activeCodes = new Set(activeSessions.map((s) => s.stockCode));
    // 수동 등록(scheduledScan=false) 세션은 상태 무관하게 보호 — onConflict:update 로
    // 덮어써서 scheduledScan=true 로 바뀌는 사고를 막는다.
    const manualCodes = new Set(
      existing.filter((s) => !s.scheduledScan).map((s) => s.stockCode),
    );
    const pausedByCode = new Map(
      existing
        .filter(
          (s) =>
            s.status === SessionStatus.PAUSED &&
            s.pauseReason === PauseReason.AUTO_SELL &&
            s.scheduledScan,
        )
        .map((s) => [s.stockCode, s]),
    );

    const rawBuyCandidates = response.results.filter(
      (r) =>
        r.currentSignal.direction.toUpperCase() === 'BUY' &&
        r.currentSignal.strength >= MIN_BUY_SIGNAL_STRENGTH,
    );
    const skippedByManual = rawBuyCandidates.filter((r) =>
      manualCodes.has(r.stockCode),
    );
    const buyCandidates = rawBuyCandidates.filter(
      (r) => !manualCodes.has(r.stockCode),
    );

    if (skippedByManual.length > 0) {
      this.logger.log(
        `수동 등록 종목과 중복되어 스킵 ${skippedByManual.length}건: ` +
          skippedByManual.map((r) => r.stockCode).join(', '),
      );
    }

    this.logger.log(
      `스캔 결과: ${response.results.length}건 → 매수 후보 ${buyCandidates.length}건 ` +
        `(strength >= ${MIN_BUY_SIGNAL_STRENGTH})`,
    );

    // 분산 필터: 동시 보유 상한 + 섹터 캡 적용
    // - 활성 세션 + 신규/재개 합계가 MAX_CONCURRENT_HOLDINGS 를 넘지 않도록 슬롯 제한.
    // - 한 섹터에 MAX_PER_SECTOR 초과 종목이 몰리면 그 이상은 스킵.
    // - 섹터 미상 종목은 캡에서 제외(분류 불가 → 클러스터 위험 산정 불가).
    // - 입력은 rankScore 내림차순(scanAllStocks 에서 정렬됨) 가정 → 상위 우선 채택.
    const activeSectorCounts = await this.countSectors(
      activeSessions,
      response,
    );
    const regimeScale = this.resolveRegimeScale(response);
    const effectiveMaxHoldings = regimeScale.enabled
      ? Math.max(
          this.getNumberConfig(
            'REGIME_MIN_HOLDINGS_FLOOR',
            DEFAULT_REGIME_MIN_HOLDINGS_FLOOR,
          ),
          Math.round(MAX_CONCURRENT_HOLDINGS * regimeScale.slotMultiplier),
        )
      : MAX_CONCURRENT_HOLDINGS;
    const amountMultiplier = regimeScale.enabled
      ? Math.max(
          this.getNumberConfig(
            'REGIME_AMOUNT_FLOOR',
            DEFAULT_REGIME_AMOUNT_FLOOR,
          ),
          regimeScale.amountMultiplier,
        )
      : 1;
    const effectiveBaseInvestmentAmount =
      amountMultiplier === 1
        ? SCAN_INVESTMENT_AMOUNT
        : Math.round(SCAN_INVESTMENT_AMOUNT * amountMultiplier);
    const clusterGate = this.resolveClusterGate(response, activeCodes);
    const availableSlots = Math.max(
      0,
      effectiveMaxHoldings - activeCodes.size,
    );
    const sectorCounts = new Map(activeSectorCounts);
    const clusterCounts = new Map(clusterGate.clusterCounts);
    const filteredCandidates: ScanResult[] = [];
    let skippedBySectorCap = 0;
    let skippedByConcurrencyCap = 0;
    let skippedByClusterCap = 0;
    for (const c of buyCandidates) {
      if (activeCodes.has(c.stockCode)) continue;
      if (filteredCandidates.length >= availableSlots) {
        skippedByConcurrencyCap++;
        continue;
      }
      const sector = c.sector;
      if (sector) {
        const count = sectorCounts.get(sector) ?? 0;
        if (count >= MAX_PER_SECTOR) {
          skippedBySectorCap++;
          continue;
        }
      }
      if (clusterGate.enabled && c.clusterId != null) {
        const count = clusterCounts.get(c.clusterId) ?? 0;
        if (count >= clusterGate.maxPerCluster) {
          skippedByClusterCap++;
          continue;
        }
      }
      if (sector) sectorCounts.set(sector, (sectorCounts.get(sector) ?? 0) + 1);
      if (clusterGate.enabled && c.clusterId != null) {
        clusterCounts.set(c.clusterId, (clusterCounts.get(c.clusterId) ?? 0) + 1);
      }
      filteredCandidates.push(c);
    }

    if (
      skippedBySectorCap > 0 ||
      skippedByConcurrencyCap > 0 ||
      skippedByClusterCap > 0
    ) {
      this.logger.log(
        `분산 필터 — 섹터캡(${MAX_PER_SECTOR}/섹터) 초과 ${skippedBySectorCap}건, ` +
          `동시보유 상한(${effectiveMaxHoldings}) 초과 ${skippedByConcurrencyCap}건, ` +
          `클러스터캡(${clusterGate.maxPerCluster}/클러스터) 초과 ${skippedByClusterCap}건 스킵`,
      );
    }

    if (regimeScale.enabled) {
      this.logger.log(
        `레짐 스케일 ${regimeScale.label}/${regimeScale.source} — ` +
          `동시보유 ${effectiveMaxHoldings}/${MAX_CONCURRENT_HOLDINGS}, ` +
          `투자금 x${amountMultiplier.toFixed(2)}`,
      );
    }

    const toResume: Array<{
      session: AutoTradingSessionEntity;
      candidate: ScanResult;
    }> = [];
    const toStart: ScanResult[] = [];
    for (const c of filteredCandidates) {
      const paused = pausedByCode.get(c.stockCode);
      if (paused) toResume.push({ session: paused, candidate: c });
      else toStart.push(c);
    }

    // 변동성 역가중 — 한 종목당 투자금을 ATR% 역수에 비례해 배분 (평균 = SCAN_INVESTMENT_AMOUNT)
    const investmentByCode = this.computeVolatilityWeightedInvestments(
      toStart,
      effectiveBaseInvestmentAmount,
    );

    const resumedCodes: string[] = [];
    for (const { session, candidate } of toResume) {
      try {
        const dyn = this.resolveCandidateTpSl(baseTpPct, baseSlPct, candidate);
        await this.autoTradingService.updateSession(session.id, userId, {
          strategyId: candidate.bestStrategy.strategyId,
          variant: candidate.bestStrategy.variant,
          takeProfitPct: dyn.takeProfitPct,
          stopLossPct: dyn.stopLossPct,
          maxHoldingDays: SESSION_MAX_HOLDING_DAYS,
          scheduledScan: true,
        });
        await this.autoTradingService.resumeSession(session.id, userId);
        resumedCodes.push(session.stockCode);

        const strengthPct = (candidate.currentSignal.strength * 100).toFixed(0);
        await this.notificationService.create(
          userId,
          NotificationType.BUY_SIGNAL,
          `${session.stockName} 자동매매 재개`,
          `최적 종목 추출 => 모니터링 종목으로 변경 — 일시정지 세션을 자동 재개합니다 ` +
            `(신호강도 ${strengthPct}%, 목표 ${dyn.takeProfitPct}% / 손절 ${dyn.stopLossPct}%, ` +
            `ATR ${candidate.volatilityPct?.toFixed(1) ?? '-'}%)`,
          {
            stockCode: session.stockCode,
            stockName: session.stockName,
            sessionId: session.id,
            scheduledScan: true,
            signalStrength: candidate.currentSignal.strength,
            strategyId: candidate.bestStrategy.strategyId,
          },
        );
      } catch (err: any) {
        this.logger.warn(
          `세션 재개 실패: ${session.stockCode} - ${err.message ?? err}`,
        );
      }
    }

    const startedCodes: string[] = [];
    if (toStart.length > 0) {
      try {
        const sessions = await this.autoTradingService.startSessions(userId, {
          sessions: toStart.map((c) => {
            const dyn = this.resolveCandidateTpSl(baseTpPct, baseSlPct, c);
            return {
              stockCode: c.stockCode,
              stockName: c.stockName,
              strategyId: c.bestStrategy.strategyId,
              variant: c.bestStrategy.variant,
              investmentAmount:
                investmentByCode.get(c.stockCode) ??
                effectiveBaseInvestmentAmount,
              takeProfitPct: dyn.takeProfitPct,
              stopLossPct: dyn.stopLossPct,
              maxHoldingDays: SESSION_MAX_HOLDING_DAYS,
              onConflict: 'update' as const,
              scheduledScan: true,
            };
          }),
          entryMode: 'monitor',
        });
        startedCodes.push(...sessions.map((s) => s.stockCode));
      } catch (err: any) {
        this.logger.error(`신규 세션 일괄 시작 실패: ${err.message ?? err}`);
      }
    }

    this.logger.log(
      `예약 스캔 완료 — 신규 ${startedCodes.length}건, 재개 ${resumedCodes.length}건 ` +
        `(base TP=${baseTpPct}%/SL=${baseSlPct}% ${optimal.source}, 스캔 검증 TP/SL 적용)`,
    );
  }

  /**
   * market-data 스캔 결과에 포함된 검증 TP/SL 을 우선 사용한다.
   * rolling deploy 중 구버전 market-data 응답이면 동일 공용 공식으로 fallback 계산한다.
   */
  private resolveCandidateTpSl(
    baseTpPct: number,
    baseSlPct: number,
    candidate: ScanResult,
  ): { takeProfitPct: number; stopLossPct: number } {
    if (
      Number.isFinite(candidate.autoTakeProfitPct) &&
      Number.isFinite(candidate.autoStopLossPct)
    ) {
      return {
        takeProfitPct: candidate.autoTakeProfitPct!,
        stopLossPct: candidate.autoStopLossPct!,
      };
    }

    return computeAtrDynamicTpSl(baseTpPct, baseSlPct, candidate.volatilityPct);
  }

  /**
   * 활성 세션의 섹터 분포 카운트.
   * scan 응답에는 trigger 가 active 종목을 excludeCodes 로 빼서 보내기 때문에
   * 활성 종목이 들어있지 않다 → stocks 테이블에서 직접 조회로 보충한다.
   * 섹터를 끝내 알 수 없는 종목은 캡 산정에서 제외한다 (분류 불가는 캡 적용 보류).
   */
  private async countSectors(
    activeSessions: AutoTradingSessionEntity[],
    response: ScanResponse,
  ): Promise<Map<string, number>> {
    const sectorByCode = new Map<string, string>();
    for (const r of response.results) {
      if (r.sector) sectorByCode.set(r.stockCode, r.sector);
    }

    const missing = activeSessions
      .map((s) => s.stockCode)
      .filter((code) => !sectorByCode.has(code));
    if (missing.length > 0) {
      try {
        const rows = await this.em
          .getConnection()
          .execute<
            Array<{ code: string; sector: string | null }>
          >('select "code", "sector" from "stocks" where "code" in (?)', [missing]);
        for (const r of rows) {
          if (r.sector) sectorByCode.set(r.code, r.sector);
        }
      } catch (err: any) {
        this.logger.warn(
          `활성 세션 섹터 조회 실패 — 캡 산정에서 누락 가능: ${err.message ?? err}`,
        );
      }
    }

    const counts = new Map<string, number>();
    for (const s of activeSessions) {
      const sector = sectorByCode.get(s.stockCode);
      if (!sector) continue;
      counts.set(sector, (counts.get(sector) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * 변동성 역가중 배분: 평균 = SCAN_INVESTMENT_AMOUNT, 종목별 weight = (1/vol) / mean(1/vol).
   * 변동성 큰 종목엔 적게, 작은 종목엔 많이. 극단 배분 방지를 위해 [0.5, 2.0]x 클램프.
   */
  private computeVolatilityWeightedInvestments(
    candidates: ScanResult[],
    baseInvestmentAmount = SCAN_INVESTMENT_AMOUNT,
  ): Map<string, number> {
    const map = new Map<string, number>();
    if (candidates.length === 0) return map;

    const vols = candidates.map((c) =>
      Math.max(c.volatilityPct ?? FALLBACK_VOLATILITY_PCT, 0.5),
    );
    const invVols = vols.map((v) => 1 / v);
    const sumInv = invVols.reduce((a, b) => a + b, 0);
    const n = candidates.length;
    const volWeightMin =
      R_SIZING_ENABLED && R_SIZING_OVERRIDES_VOL_WEIGHT
        ? R_VOL_WEIGHT_MIN
        : VOL_WEIGHT_MIN;
    const volWeightMax =
      R_SIZING_ENABLED && R_SIZING_OVERRIDES_VOL_WEIGHT
        ? R_VOL_WEIGHT_MAX
        : VOL_WEIGHT_MAX;

    for (let i = 0; i < candidates.length; i++) {
      const rawWeight = (invVols[i] / sumInv) * n; // 평균 = 1
      const weight = Math.max(
        volWeightMin,
        Math.min(volWeightMax, rawWeight),
      );
      const amount = Math.round(baseInvestmentAmount * weight);
      map.set(candidates[i].stockCode, amount);
    }
    return map;
  }

  private async acquireScanLock(requestId: string): Promise<boolean> {
    const rows = await this.em.getConnection().execute<{ job_name: string }[]>(
      `
        insert into scheduled_job_locks ("job_name", "locked_until", "owner", "updated_at")
        values ('${SCAN_JOB_NAME}', now() + interval '${SCAN_LOCK_TTL_MINUTES} minutes', '${requestId}', now())
        on conflict ("job_name") do update
          set "locked_until" = excluded."locked_until",
              "owner" = excluded."owner",
              "updated_at" = now()
        where scheduled_job_locks."locked_until" <= now()
        returning "job_name";
      `,
    );
    return rows.length > 0;
  }

  private createReleasedLockOwner(requestId: string): string {
    return `released:${requestId}`;
  }

  private async releaseScanLock(
    lockOwner: string,
    requestId: string,
  ): Promise<void> {
    try {
      await this.em.getConnection().execute(
        `
          update scheduled_job_locks
             set "locked_until" = now(),
                 "owner" = '${this.createReleasedLockOwner(requestId)}',
                 "updated_at" = now()
           where "job_name" = '${SCAN_JOB_NAME}'
             and "owner" = '${lockOwner}';
        `,
      );
    } catch (err: any) {
      this.logger.warn(`예약 스캔 락 해제 실패: ${err.message ?? err}`);
    }
  }
}
