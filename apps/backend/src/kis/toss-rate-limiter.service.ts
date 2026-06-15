import { Injectable, OnModuleDestroy } from '@nestjs/common';

/**
 * 토스증권 Open API 레이트리밋 그룹 (doc/tossinvest-open-api-ratelimits.md).
 * 한도는 클라이언트 × API 그룹 단위 TPS 로 적용된다.
 */
export type TossRateLimitGroup =
  | 'AUTH'
  | 'ACCOUNT'
  | 'ASSET'
  | 'STOCK'
  | 'MARKET_INFO'
  | 'MARKET_DATA'
  | 'MARKET_DATA_CHART'
  | 'ORDER'
  | 'ORDER_HISTORY'
  | 'ORDER_INFO';

/**
 * 그룹별 초당 허용 요청 수. 문서 기준값에서 안전 여유 없이 그대로 사용하되,
 * 운영 중 헤더로 통지되는 동적 한도가 더 낮아질 수 있으므로 호출부는 실패 폴백을 갖춘다.
 */
const GROUP_RPS: Record<TossRateLimitGroup, number> = {
  AUTH: 5,
  ACCOUNT: 1,
  ASSET: 5,
  STOCK: 5,
  MARKET_INFO: 3,
  MARKET_DATA: 10,
  MARKET_DATA_CHART: 5,
  ORDER: 3, // 피크시간(09:00~09:10) 한도에 맞춰 보수적으로 운용
  ORDER_HISTORY: 5,
  ORDER_INFO: 3,
};

const REFILL_INTERVAL_MS = 1000;

interface PendingAcquire {
  resolve: () => void;
  reject: (err: Error) => void;
}

interface Bucket {
  tokens: number;
  readonly capacity: number;
  readonly queue: PendingAcquire[];
}

/**
 * 그룹별 토큰버킷 레이트리미터.
 * KisRateLimiterService 와 동일한 FIFO 큐 + 초당 충전 방식을 그룹 단위로 운용한다.
 */
@Injectable()
export class TossRateLimiterService implements OnModuleDestroy {
  private readonly buckets = new Map<TossRateLimitGroup, Bucket>();
  private readonly refillTimer: ReturnType<typeof setInterval>;
  private destroyed = false;

  constructor() {
    this.refillTimer = setInterval(() => this.refillAll(), REFILL_INTERVAL_MS);
    (this.refillTimer as any).unref?.();
  }

  /** 해당 그룹 호출권 1개를 획득한다. 토큰이 없으면 다음 초 충전까지 FIFO 로 대기. */
  acquire(group: TossRateLimitGroup): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('토스 레이트리미터가 종료되었습니다.'));
    }

    const bucket = this.getBucket(group);
    if (bucket.queue.length === 0 && bucket.tokens > 0) {
      bucket.tokens -= 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      bucket.queue.push({ resolve, reject });
      this.drain(bucket);
    });
  }

  onModuleDestroy() {
    this.destroyed = true;
    clearInterval(this.refillTimer);
    for (const bucket of this.buckets.values()) {
      while (bucket.queue.length > 0) {
        bucket.queue
          .shift()!
          .reject(new Error('토스 레이트리미터가 종료되었습니다.'));
      }
    }
  }

  private getBucket(group: TossRateLimitGroup): Bucket {
    let bucket = this.buckets.get(group);
    if (!bucket) {
      const capacity = GROUP_RPS[group] ?? 1;
      bucket = { tokens: capacity, capacity, queue: [] };
      this.buckets.set(group, bucket);
    }
    return bucket;
  }

  private refillAll(): void {
    if (this.destroyed) return;
    for (const bucket of this.buckets.values()) {
      bucket.tokens = bucket.capacity;
      this.drain(bucket);
    }
  }

  private drain(bucket: Bucket): void {
    while (!this.destroyed && bucket.tokens > 0 && bucket.queue.length > 0) {
      bucket.tokens -= 1;
      bucket.queue.shift()!.resolve();
    }
  }
}
