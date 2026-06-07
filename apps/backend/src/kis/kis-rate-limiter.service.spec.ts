import { ConfigService } from '@nestjs/config';
import { KisRateLimiterService } from './kis-rate-limiter.service';

describe('KisRateLimiterService', () => {
  let service: KisRateLimiterService;

  const createService = (maxRps: number, burst: number) => {
    const configService = {
      get: jest.fn((key: string, defaultValue: number) => {
        if (key === 'KIS_MAX_RPS') return maxRps;
        if (key === 'KIS_RATE_BURST') return burst;
        return defaultValue;
      }),
    } as unknown as ConfigService;

    service = new KisRateLimiterService(configService);
    return service;
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    service?.onModuleDestroy();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('분산된 토큰 충전으로 동시 acquire를 초당 한도 이하로 처리한다', async () => {
    const limiter = createService(2, 2);
    const completed: number[] = [];

    const acquires = Array.from({ length: 5 }, () =>
      limiter.acquire().then(() => {
        completed.push(Date.now());
      }),
    );

    await Promise.resolve();
    expect(completed).toHaveLength(2);

    await jest.advanceTimersByTimeAsync(999);
    expect(completed).toHaveLength(2);

    await jest.advanceTimersByTimeAsync(1);
    expect(completed).toHaveLength(4);

    await jest.advanceTimersByTimeAsync(1000);
    expect(completed).toHaveLength(5);

    await Promise.all(acquires);
  });
});
