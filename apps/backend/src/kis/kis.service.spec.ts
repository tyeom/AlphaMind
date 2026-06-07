import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { KisRateLimiterService } from './kis-rate-limiter.service';
import { KisService } from './kis.service';

describe('KisService request', () => {
  const createService = (maxRetry = 5) => {
    const configService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'KIS_RATE_MAX_RETRY') return maxRetry;
        if (key === 'KIS_ENV') return 'sandbox';
        return defaultValue;
      }),
    } as unknown as ConfigService;
    const rateLimiter = {
      acquire: jest.fn().mockResolvedValue(undefined),
    } as unknown as KisRateLimiterService & { acquire: jest.Mock };
    const service = new KisService(
      {} as HttpService,
      configService,
      rateLimiter,
    );

    return { service, rateLimiter };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('EGW00201 응답은 백오프 후 재시도해 성공 응답을 반환한다', async () => {
    const { service, rateLimiter } = createService();
    const fn = jest
      .fn()
      .mockResolvedValueOnce({
        data: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수 초과' },
      })
      .mockResolvedValueOnce({
        data: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수 초과' },
      })
      .mockResolvedValueOnce({ data: { rt_cd: '0', output: { ok: true } } });

    const promise = service.request(fn);

    await jest.advanceTimersByTimeAsync(200);
    await jest.advanceTimersByTimeAsync(400);

    await expect(promise).resolves.toEqual({
      data: { rt_cd: '0', output: { ok: true } },
    });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(rateLimiter.acquire).toHaveBeenCalledTimes(3);
  });

  it('재시도 한도를 소진하면 마지막 레이트리밋 오류를 던진다', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service } = createService(2);
    const fn = jest.fn().mockResolvedValue({
      data: { rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수 초과' },
    });

    const promise = service.request(fn);
    const expectation = expect(promise).rejects.toThrow('초당 거래건수 초과');

    await jest.advanceTimersByTimeAsync(200);
    await jest.advanceTimersByTimeAsync(400);

    await expectation;
    expect(fn).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      'KIS 레이트리밋 재시도 소진: 2회 재시도 후 실패',
    );
  });
});
