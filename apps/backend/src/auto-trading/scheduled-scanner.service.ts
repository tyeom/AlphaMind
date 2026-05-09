import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { EntityManager } from '@mikro-orm/postgresql';
import { firstValueFrom } from 'rxjs';
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
/** market-data 그리드 서치 결과 미수신/실패 시 fallback. TP/SL 둘 다 동일 fallback 사용. */
const SCAN_AUTO_TAKE_PROFIT_PCT = 1.8;
const SCAN_AUTO_STOP_LOSS_PCT = -1.8;
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
/** 변동성 정보 결손 시 가정값 (%) — 한국 일반 종목 ATR/가격 중앙값 */
const FALLBACK_VOLATILITY_PCT = 3.0;

interface ScanResult {
  stockCode: string;
  stockName: string;
  sector?: string;
  volatilityPct?: number;
  bestStrategy: { strategyId: string; strategyName: string; variant?: string };
  currentSignal: { direction: string; strength: number; reason: string };
}

interface ScanResponse {
  scannedStocks: number;
  eligibleStocks: number;
  excludedStocks: number;
  results: ScanResult[];
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
      }),
      { defaultValue: undefined },
    );

    this.logger.log(
      `예약 스캔 이벤트 emit 완료 — requestId=${requestId} exclude=${excludeCodes.length}건 ` +
        `(active=${activeCodes.size}, manual=${manualCodes.size}), ` +
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
    // 세션 TP/SL 도 같은 optimal 값을 사용 — 스캔 시점과 후처리 시점 사이에
    // 영속화된 값이 바뀌었더라도 OptimalParamsService 의 60s 캐시 덕분에 일관성 유지.
    const optimal = await this.fetchOptimalShortTermTpSl();
    const sessionTakeProfitPct = optimal.tpPct;
    const sessionStopLossPct = optimal.slPct;

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
    const availableSlots = Math.max(
      0,
      MAX_CONCURRENT_HOLDINGS - activeCodes.size,
    );
    const sectorCounts = new Map(activeSectorCounts);
    const filteredCandidates: ScanResult[] = [];
    let skippedBySectorCap = 0;
    let skippedByConcurrencyCap = 0;
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
        sectorCounts.set(sector, count + 1);
      }
      filteredCandidates.push(c);
    }

    if (skippedBySectorCap > 0 || skippedByConcurrencyCap > 0) {
      this.logger.log(
        `분산 필터 — 섹터캡(${MAX_PER_SECTOR}/섹터) 초과 ${skippedBySectorCap}건, ` +
          `동시보유 상한(${MAX_CONCURRENT_HOLDINGS}) 초과 ${skippedByConcurrencyCap}건 스킵`,
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
    const investmentByCode = this.computeVolatilityWeightedInvestments(toStart);

    const resumedCodes: string[] = [];
    for (const { session, candidate } of toResume) {
      try {
        await this.autoTradingService.updateSession(session.id, userId, {
          strategyId: candidate.bestStrategy.strategyId,
          variant: candidate.bestStrategy.variant,
          takeProfitPct: sessionTakeProfitPct,
          stopLossPct: sessionStopLossPct,
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
            `(신호강도 ${strengthPct}%, 목표 ${sessionTakeProfitPct}% / 손절 ${sessionStopLossPct}%)`,
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
          sessions: toStart.map((c) => ({
            stockCode: c.stockCode,
            stockName: c.stockName,
            strategyId: c.bestStrategy.strategyId,
            variant: c.bestStrategy.variant,
            investmentAmount:
              investmentByCode.get(c.stockCode) ?? SCAN_INVESTMENT_AMOUNT,
            takeProfitPct: sessionTakeProfitPct,
            stopLossPct: sessionStopLossPct,
            maxHoldingDays: SESSION_MAX_HOLDING_DAYS,
            onConflict: 'update',
            scheduledScan: true,
          })),
          entryMode: 'monitor',
        });
        startedCodes.push(...sessions.map((s) => s.stockCode));
      } catch (err: any) {
        this.logger.error(`신규 세션 일괄 시작 실패: ${err.message ?? err}`);
      }
    }

    this.logger.log(
      `예약 스캔 완료 — 신규 ${startedCodes.length}건, 재개 ${resumedCodes.length}건 ` +
        `(TP=${sessionTakeProfitPct}%/SL=${sessionStopLossPct}% ${optimal.source})`,
    );
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
  ): Map<string, number> {
    const map = new Map<string, number>();
    if (candidates.length === 0) return map;

    const vols = candidates.map((c) =>
      Math.max(c.volatilityPct ?? FALLBACK_VOLATILITY_PCT, 0.5),
    );
    const invVols = vols.map((v) => 1 / v);
    const sumInv = invVols.reduce((a, b) => a + b, 0);
    const n = candidates.length;

    for (let i = 0; i < candidates.length; i++) {
      const rawWeight = (invVols[i] / sumInv) * n; // 평균 = 1
      const weight = Math.max(
        VOL_WEIGHT_MIN,
        Math.min(VOL_WEIGHT_MAX, rawWeight),
      );
      const amount = Math.round(SCAN_INVESTMENT_AMOUNT * weight);
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
