import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface PendingAcquire {
  resolve: () => void;
  reject: (err: Error) => void;
}

const REFILL_INTERVAL_MS = 1000;

@Injectable()
export class KisRateLimiterService implements OnModuleDestroy {
  private readonly maxRps: number;
  private readonly capacity: number;
  private tokens: number;
  private readonly queue: PendingAcquire[] = [];
  private readonly refillTimer: ReturnType<typeof setInterval>;
  private destroyed = false;

  constructor(private readonly configService: ConfigService) {
    this.maxRps = this.getPositiveInteger('KIS_MAX_RPS', 8);
    this.capacity = this.getPositiveInteger('KIS_RATE_BURST', this.maxRps);
    this.tokens = this.capacity;

    this.refillTimer = setInterval(() => {
      this.refillTokens();
    }, REFILL_INTERVAL_MS);
    (this.refillTimer as any).unref?.();
  }

  /**
   * KIS REST 호출권을 1개 획득한다.
   * Step 1. 사용 가능한 토큰이 있으면 즉시 통과.
   * Step 2. 토큰이 없으면 FIFO 큐에 넣고 다음 초 충전까지 대기.
   * Step 3. 종료 중에는 큐를 실패시켜 대기 Promise 가 남지 않게 한다.
   */
  acquire(): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('KIS 레이트리미터가 종료되었습니다.'));
    }

    if (this.queue.length === 0 && this.tokens > 0) {
      this.tokens -= 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.drainQueue();
    });
  }

  onModuleDestroy() {
    this.destroyed = true;
    clearInterval(this.refillTimer);

    while (this.queue.length > 0) {
      const pending = this.queue.shift()!;
      pending.reject(new Error('KIS 레이트리미터가 종료되었습니다.'));
    }
  }

  private refillTokens(): void {
    if (this.destroyed) {
      return;
    }

    this.tokens = Math.min(this.capacity, this.tokens + this.maxRps);
    this.drainQueue();
  }

  private drainQueue(): void {
    while (!this.destroyed && this.tokens > 0 && this.queue.length > 0) {
      const pending = this.queue.shift()!;
      this.tokens -= 1;
      pending.resolve();
    }
  }

  private getPositiveInteger(key: string, defaultValue: number): number {
    const raw = this.configService.get<number | string>(key, defaultValue);
    const value = Number(raw);

    if (!Number.isFinite(value) || value <= 0) {
      return defaultValue;
    }

    return Math.floor(value);
  }
}
