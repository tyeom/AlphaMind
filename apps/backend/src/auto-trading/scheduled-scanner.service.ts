import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { EntityManager } from '@mikro-orm/postgresql';
import { firstValueFrom, timeout } from 'rxjs';
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
const SCAN_TOP_N = 30;
const SCAN_AUTO_TAKE_PROFIT_PCT = 1.3;
const SCAN_AUTO_STOP_LOSS_PCT = -3;
const MIN_BUY_SIGNAL_STRENGTH = 0.65;
const SESSION_TAKE_PROFIT_PCT = 1.3;
const SESSION_STOP_LOSS_PCT = -2;
const SCAN_TIMEOUT_MS = 120_000;
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
    const userId = this.configService.get<number>('SCHEDULED_TRADER_USER_ID');
    if (!userId) {
      this.logger.warn('SCHEDULED_TRADER_USER_ID 미설정 — 예약 스캔 스킵');
      return;
    }

    const locked = await this.acquireScanLock();
    if (!locked) {
      this.logger.warn(
        '다른 인스턴스가 예약 스캔을 실행 중이어서 현재 실행을 건너뜁니다.',
      );
      return;
    }

    try {
      await this.runScan(userId);
    } catch (err: any) {
      this.logger.error(`예약 스캔 실패: ${err.message ?? err}`);
    } finally {
      await this.releaseScanLock();
    }
  }

  private async runScan(userId: number): Promise<void> {
    this.logger.log(`예약 스캔 시작 (userId=${userId})`);

    // 오늘의 신규 추천으로 대체될 수 있도록 보유 없는 자동 등록 세션 사전 정리.
    // 보유 중이거나 수동 등록 세션은 그대로 유지된다.
    await this.autoTradingService.removeStaleScheduledScanSessions(userId);

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

    const response = await firstValueFrom(
      this.marketDataClient
        .send<ScanResponse>('strategy.scan', {
          excludeCodes: Array.from(activeCodes),
          topN: SCAN_TOP_N,
          investmentAmount: SCAN_INVESTMENT_AMOUNT,
          autoTakeProfitPct: SCAN_AUTO_TAKE_PROFIT_PCT,
          autoStopLossPct: SCAN_AUTO_STOP_LOSS_PCT,
        })
        .pipe(timeout(SCAN_TIMEOUT_MS)),
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
            onConflict: 'skip',
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
