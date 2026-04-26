import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { promises as fs } from 'fs';
import * as path from 'path';
import { BacktestService } from './backtest.service';
import {
  OptimalParamsService,
  ShortTermTpSlParams,
} from './optimal-params.service';
import { GridSearchPoint } from './types/backtest.types';

const SAMPLE_SIZE = 50;
const MAX_HOLDING_DAYS = 7;
const HISTORY_FILE = 'data/optimizer-history.jsonl';
/** 분산 잠금명 — 다중 인스턴스에서 한 번만 실행되도록 (현재는 단일 인스턴스 가정, 향후 확장 여지) */
const JOB_NAME = 'weekly-tp-sl-optimizer';

export interface OptimizerHistoryRecord {
  ranAt: string;
  previous: ShortTermTpSlParams | null;
  next: { tpPct: number; slPct: number; score: number; sampleSize: number };
  topGrid: GridSearchPoint[];
  elapsedMs: number;
  totalSampleSize: number;
}

/**
 * 주간 단타 TP/SL 자동 최적화 — 매주 일요일 03:00 KST 에 그리드 서치를 실행해
 * data/optimal_params.json 을 갱신한다. 다음 평일 08:00 예약 스캔부터 자동 반영.
 *
 * 동작:
 *   1. 직전 optimal 값을 읽어두고 (비교용)
 *   2. gridSearchOptimalTpSl({ stockSampleSize: 50, maxHoldingDays: 7 }) 실행
 *      → 결과는 OptimalParamsService 로 자동 영속화
 *   3. 직전 vs 신규 비교를 stdout 에 1줄 + 상위 5개 grid 점 로깅
 *   4. data/optimizer-history.jsonl 에 기록 (1주 후에도 검토 가능)
 *
 * 결과 확인:
 *   docker compose logs market-data --tail 200 | grep WeeklyOptimizer
 *   docker compose exec market-data cat data/optimizer-history.jsonl | tail -5
 */
@Injectable()
export class WeeklyOptimizerService {
  private readonly logger = new Logger(WeeklyOptimizerService.name);
  private readonly historyPath = path.resolve(process.cwd(), HISTORY_FILE);

  constructor(
    private readonly backtestService: BacktestService,
    private readonly optimalParamsService: OptimalParamsService,
  ) {}

  @Cron('0 0 3 * * 0', {
    name: JOB_NAME,
    timeZone: 'Asia/Seoul',
  })
  async handleWeeklyRun(): Promise<void> {
    await this.runOptimization('cron');
  }

  /** Cron 핸들러 + 수동 트리거 공용. 향후 admin 엔드포인트 추가 시 재사용. */
  async runOptimization(source: 'cron' | 'manual'): Promise<OptimizerHistoryRecord> {
    this.logger.log(`주간 TP/SL 그리드 서치 시작 (source=${source})`);

    const previous = await this.optimalParamsService.getShortTermTpSl();

    let result;
    try {
      result = await this.backtestService.gridSearchOptimalTpSl({
        stockSampleSize: SAMPLE_SIZE,
        maxHoldingDays: MAX_HOLDING_DAYS,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `주간 그리드 서치 실패 — 기존 optimal 값 유지. 사유: ${msg}`,
      );
      throw err;
    }

    const summary = this.formatChangeSummary(previous, result.optimal);
    this.logger.log(summary);
    this.logger.log('상위 5개 후보:');
    for (let i = 0; i < Math.min(5, result.grid.length); i++) {
      const p = result.grid[i];
      this.logger.log(
        `  #${i + 1} TP=${p.tpPct}% SL=${p.slPct}% ` +
          `score=${p.score.toFixed(3)} ` +
          `(중앙값 ${p.medianReturnPct}%, 통과 ${p.sampledStocks}, 양수비율 ${(p.profitableProportion * 100).toFixed(0)}%)`,
      );
    }

    const record: OptimizerHistoryRecord = {
      ranAt: new Date().toISOString(),
      previous,
      next: result.optimal,
      topGrid: result.grid.slice(0, 5),
      elapsedMs: result.elapsedMs,
      totalSampleSize: result.totalSampleSize,
    };
    await this.appendHistory(record);

    return record;
  }

  /**
   * 결과 요약 (200자 이내). 로그 1줄로 한눈에 변경폭을 보여주는 게 목적.
   * 직전 결과가 없으면 "신규 등록"으로 표시.
   */
  private formatChangeSummary(
    previous: ShortTermTpSlParams | null,
    next: { tpPct: number; slPct: number; score: number; sampleSize: number },
  ): string {
    if (!previous) {
      return (
        `[신규] 단타 optimal: TP=${next.tpPct}% SL=${next.slPct}% ` +
        `score=${next.score.toFixed(3)} (sample ${next.sampleSize}). 다음 스캔부터 적용.`
      );
    }
    const tpDelta = round(next.tpPct - previous.tpPct, 2);
    const slDelta = round(next.slPct - previous.slPct, 2);
    const scoreDelta =
      previous.score !== 0
        ? round(((next.score - previous.score) / Math.abs(previous.score)) * 100, 1)
        : 0;
    return (
      `[갱신] 직전 TP=${previous.tpPct}/SL=${previous.slPct} → ` +
      `TP=${next.tpPct}(${signed(tpDelta)})/SL=${next.slPct}(${signed(slDelta)}), ` +
      `score=${next.score.toFixed(3)} (Δ${signed(scoreDelta)}%), sample ${next.sampleSize}`
    );
  }

  private async appendHistory(record: OptimizerHistoryRecord): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.historyPath), { recursive: true });
      await fs.appendFile(
        this.historyPath,
        JSON.stringify(record) + '\n',
        'utf8',
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`optimizer history 기록 실패 (운용엔 영향 없음): ${msg}`);
    }
  }
}

function round(v: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function signed(v: number): string {
  return v > 0 ? `+${v}` : `${v}`;
}
