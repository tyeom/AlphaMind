import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * 단타 TP/SL 그리드 서치 결과 — 이 값을 자동매매 스캔/세션이 기본 익절·손절로 사용한다.
 * 그리드 서치 (BacktestService.gridSearchOptimalTpSl) 가 갱신.
 */
export interface ShortTermTpSlParams {
  /** 익절 수익률 % */
  tpPct: number;
  /** 손절 수익률 % (음수) */
  slPct: number;
  /** 평균 위험조정 점수 (참고용) */
  score: number;
  /** 그리드 서치에 사용된 종목 수 */
  sampleSize: number;
  /** ISO datetime */
  updatedAt: string;
}

interface OptimalParamsFile {
  shortTermTpSl?: ShortTermTpSlParams;
}

/**
 * 그리드 서치 결과를 디스크(JSON)에 영속화한다.
 * 컨테이너 재시작 / 다른 backend 인스턴스에서도 읽을 수 있도록 파일 기반.
 * Docker 에선 `apps/market-data-service/data/` 가 이미지에 포함되며, 쓰기는 컨테이너 layer 에 남는다.
 */
@Injectable()
export class OptimalParamsService {
  private readonly logger = new Logger(OptimalParamsService.name);
  private readonly filePath = path.resolve(
    process.cwd(),
    'data/optimal_params.json',
  );
  private cached: OptimalParamsFile | null = null;
  private cachedAt = 0;
  private readonly CACHE_TTL_MS = 60_000;

  async getShortTermTpSl(): Promise<ShortTermTpSlParams | null> {
    const data = await this.read();
    return data?.shortTermTpSl ?? null;
  }

  async saveShortTermTpSl(params: ShortTermTpSlParams): Promise<void> {
    const current = (await this.readFromDisk()) ?? {};
    current.shortTermTpSl = params;
    await this.writeToDisk(current);
    this.logger.log(
      `optimal params 저장: TP=${params.tpPct}% SL=${params.slPct}% (score=${params.score.toFixed(3)}, sample=${params.sampleSize})`,
    );
  }

  private async read(): Promise<OptimalParamsFile | null> {
    if (this.cached && Date.now() - this.cachedAt < this.CACHE_TTL_MS) {
      return this.cached;
    }
    const data = await this.readFromDisk();
    this.cached = data;
    this.cachedAt = Date.now();
    return data;
  }

  private async readFromDisk(): Promise<OptimalParamsFile | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as OptimalParamsFile;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      this.logger.warn(
        `optimal_params.json 읽기 실패 — fallback default 사용: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  private async writeToDisk(data: OptimalParamsFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    this.cached = data;
    this.cachedAt = Date.now();
  }
}
