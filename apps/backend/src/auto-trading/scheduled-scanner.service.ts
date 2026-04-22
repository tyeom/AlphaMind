import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  AutoTradingSessionEntity,
  PauseReason,
  SessionStatus,
} from './entities/auto-trading-session.entity';
import { AutoTradingService } from './auto-trading.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';
import { MARKET_DATA_SERVICE } from '../rmq/rmq.module';

const SCAN_INVESTMENT_AMOUNT = 500_000;
const SCAN_TOP_N = 35;
const SCAN_AUTO_TAKE_PROFIT_PCT = 1.3;
const SCAN_AUTO_STOP_LOSS_PCT = -3;
const MIN_BUY_SIGNAL_STRENGTH = 0.65;
const SESSION_TAKE_PROFIT_PCT = 1.3;
const SESSION_STOP_LOSS_PCT = -2;
const SCAN_JOB_NAME = 'scheduled-ai-scan';
const SCAN_LOCK_TTL_MINUTES = 30;

interface ScanResult {
  stockCode: string;
  stockName: string;
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
  private readonly lockOwner = `${process.pid}:${Math.random().toString(36).slice(2, 10)}`;

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

    const locked = await this.acquireScanLock();
    if (!locked) {
      return { triggered: false, reason: 'already_running' };
    }

    this.logger.log(`예약 스캔 트리거 (source=${source})`);

    try {
      await this.requestScan(userId);
      return { triggered: true, userId };
    } catch (err: any) {
      this.logger.error(`예약 스캔 요청 실패: ${err.message ?? err}`);
      await this.releaseScanLock();
      throw err;
    }
  }

  /**
   * 예약 스캔 요청 단계 — cleanup + market-data-service로 스캔 이벤트 emit (fire-and-forget).
   * 실제 후처리(resume/start)는 {@link handleScanCompleted}가 완료 이벤트 수신 시 수행한다.
   * 락은 완료/실패 이벤트 수신 시점 또는 TTL(30분)으로 해제된다.
   */
  private async requestScan(userId: number): Promise<void> {
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
    const activeCodes = Array.from(
      new Set(
        existing
          .filter((s) => s.status === SessionStatus.ACTIVE)
          .map((s) => s.stockCode),
      ),
    );

    const requestId = randomUUID();
    this.marketDataClient.emit('strategy.scan.request', {
      userId,
      requestId,
      excludeCodes: activeCodes,
      topN: SCAN_TOP_N,
      investmentAmount: SCAN_INVESTMENT_AMOUNT,
      autoTakeProfitPct: SCAN_AUTO_TAKE_PROFIT_PCT,
      autoStopLossPct: SCAN_AUTO_STOP_LOSS_PCT,
    });

    this.logger.log(
      `예약 스캔 이벤트 emit 완료 — requestId=${requestId} exclude=${activeCodes.length}건, 완료 이벤트 대기`,
    );
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

    if (!(await this.isCurrentLockOwner(requestId))) {
      return;
    }

    try {
      await this.applyScanResults(userId, response);
    } catch (err: any) {
      this.logger.error(`예약 스캔 후처리 실패: ${err.message ?? err}`);
    } finally {
      await this.releaseScanLock();
    }
  }

  /** market-data-service로부터 스캔 실패 이벤트 수신 시 락 해제 + 알림 */
  async handleScanFailed(event: ScanFailedEvent): Promise<void> {
    const { userId, requestId, error } = event;
    this.logger.error(
      `scan.failed 수신 userId=${userId} requestId=${requestId} error=${error}`,
    );

    if (!(await this.isCurrentLockOwner(requestId))) {
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
      await this.releaseScanLock();
    }
  }

  /**
   * scan 완료/실패 이벤트는 모든 backend 인스턴스가 수신하므로
   * 실제 락 owner 인스턴스만 후처리를 진행한다.
   */
  private async isCurrentLockOwner(requestId: string): Promise<boolean> {
    try {
      const rows = await this.em.getConnection().execute<
        Array<{ owner: string }>
      >(
        `
          select "owner"
            from scheduled_job_locks
           where "job_name" = '${SCAN_JOB_NAME}'
             and "locked_until" > now();
        `,
      );
      const currentOwner = rows[0]?.owner;
      if (currentOwner === this.lockOwner) {
        return true;
      }

      this.logger.log(
        `scan 이벤트 후처리 스킵 requestId=${requestId} owner=${currentOwner ?? 'none'} current=${this.lockOwner}`,
      );
      return false;
    } catch (err: any) {
      this.logger.warn(
        `scan 이벤트 owner 확인 실패 requestId=${requestId}: ${err.message ?? err}`,
      );
      return false;
    }
  }

  private async applyScanResults(
    userId: number,
    response: ScanResponse,
  ): Promise<void> {
    const existing = await this.em.find(AutoTradingSessionEntity, {
      user: userId,
    });
    const activeCodes = new Set(
      existing
        .filter((s) => s.status === SessionStatus.ACTIVE)
        .map((s) => s.stockCode),
    );
    const pausedByCode = new Map(
      existing
        .filter(
          (s) =>
            s.status === SessionStatus.PAUSED &&
            s.pauseReason === PauseReason.AUTO_SELL,
        )
        .map((s) => [s.stockCode, s]),
    );

    const candidates = response.results.filter(
      (r) =>
        r.currentSignal.direction.toUpperCase() === 'BUY' &&
        r.currentSignal.strength >= MIN_BUY_SIGNAL_STRENGTH,
    );

    this.logger.log(
      `스캔 결과: ${response.results.length}건 → 매수 후보 ${candidates.length}건 ` +
        `(strength >= ${MIN_BUY_SIGNAL_STRENGTH})`,
    );

    const toResume: Array<{
      session: AutoTradingSessionEntity;
      candidate: ScanResult;
    }> = [];
    const toStart: ScanResult[] = [];
    for (const c of candidates) {
      if (activeCodes.has(c.stockCode)) continue;
      const paused = pausedByCode.get(c.stockCode);
      if (paused) toResume.push({ session: paused, candidate: c });
      else toStart.push(c);
    }

    const resumedCodes: string[] = [];
    for (const { session, candidate } of toResume) {
      try {
        await this.autoTradingService.updateSession(session.id, userId, {
          strategyId: candidate.bestStrategy.strategyId,
          variant: candidate.bestStrategy.variant,
          takeProfitPct: SESSION_TAKE_PROFIT_PCT,
          stopLossPct: SESSION_STOP_LOSS_PCT,
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
            `(신호강도 ${strengthPct}%, 목표 ${SESSION_TAKE_PROFIT_PCT}% / 손절 ${SESSION_STOP_LOSS_PCT}%)`,
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
            investmentAmount: SCAN_INVESTMENT_AMOUNT,
            takeProfitPct: SESSION_TAKE_PROFIT_PCT,
            stopLossPct: SESSION_STOP_LOSS_PCT,
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
      `예약 스캔 완료 — 신규 ${startedCodes.length}건, 재개 ${resumedCodes.length}건`,
    );
  }

  private async acquireScanLock(): Promise<boolean> {
    const rows = await this.em.getConnection().execute<{ job_name: string }[]>(
      `
        insert into scheduled_job_locks ("job_name", "locked_until", "owner", "updated_at")
        values ('${SCAN_JOB_NAME}', now() + interval '${SCAN_LOCK_TTL_MINUTES} minutes', '${this.lockOwner}', now())
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

  private async releaseScanLock(): Promise<void> {
    try {
      await this.em.getConnection().execute(
        `
          update scheduled_job_locks
             set "locked_until" = now(),
                 "updated_at" = now()
           where "job_name" = '${SCAN_JOB_NAME}'
             and "owner" = '${this.lockOwner}';
        `,
      );
    } catch (err: any) {
      this.logger.warn(`예약 스캔 락 해제 실패: ${err.message ?? err}`);
    }
  }
}
