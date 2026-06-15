import { from, of, throwError } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { TossService } from './toss.service';
import { TossRateLimiterService } from './toss-rate-limiter.service';

describe('TossService', () => {
  const createService = (overrides: Record<string, string> = {}) => {
    const configValues: Record<string, string> = {
      TOSS_API_BASE_URL: 'https://openapi.tossinvest.com',
      TOSS_CLIENT_ID: 'cid',
      TOSS_CLIENT_SECRET: 'secret',
      ...overrides,
    };
    const config = {
      get: jest.fn((key: string, def?: unknown) => configValues[key] ?? def),
    } as unknown as ConfigService;

    let tokenSeq = 0;
    const http = {
      // 토큰 발급마다 새 토큰 문자열을 반환 (토스는 재발급 시 이전 토큰 무효화).
      post: jest.fn(() => {
        tokenSeq += 1;
        return of({
          data: {
            access_token: `tok-${tokenSeq}`,
            token_type: 'Bearer',
            expires_in: 86400,
          },
        });
      }),
      get: jest.fn(),
    } as unknown as HttpService;

    const rateLimiter = new TossRateLimiterService();
    const service = new TossService(http, config, rateLimiter);
    return { service, http, rateLimiter, getTokenSeq: () => tokenSeq };
  };

  const okResult = (lastPrice: string) =>
    of({ data: { result: [{ symbol: '005930', lastPrice }] } });

  const make401 = () => {
    const err: any = new Error('Unauthorized');
    err.response = { status: 401 };
    return err;
  };

  // 모든 마이크로태스크 + 레이트리미터 큐가 정리되도록 매크로태스크 1틱 비운다.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  const deferred = () => {
    let reject!: (err: unknown) => void;
    const promise = new Promise((_resolve, rej) => {
      reject = rej;
    });
    return { promise, reject };
  };

  describe('401 handling', () => {
    it('a delayed 401 from an in-flight request does not wipe a newer cached token', async () => {
      const { service, http } = createService();

      // A: tok-1 로 GET 후 응답이 지연되는 요청 (나중에 옛 토큰 401 로 실패).
      const aGet = deferred();
      (http.get as jest.Mock)
        .mockReturnValueOnce(from(aGet.promise)) // A 첫 GET — 보류
        .mockReturnValueOnce(throwError(() => make401())) // B 첫 GET — tok-1 401
        .mockReturnValueOnce(okResult('2')) // B 재시도 — tok-2 성공
        .mockReturnValueOnce(okResult('3')); // A 재시도 — tok-2 성공

      // A 시작: tok-1 발급 후 보류 중인 GET 에서 대기 상태가 되도록 flush.
      const aPromise = service.get('/api/v1/prices', 'MARKET_DATA', {
        symbols: '005930',
      });
      await flush();
      expect((service as any).accessToken).toBe('tok-1');

      // B 실행: tok-1 401 → tok-1 무효화 → tok-2 재발급 후 성공. 캐시는 tok-2.
      await service.get('/api/v1/prices', 'MARKET_DATA', { symbols: '005930' });
      expect((service as any).accessToken).toBe('tok-2');

      // A 의 지연된 GET 이 이제서야 옛 토큰(tok-1) 401 로 실패.
      // A 가 쓴 토큰은 tok-1 이고 현재 캐시는 tok-2 이므로 tok-2 가 보존돼야 한다.
      aGet.reject(make401());
      await aPromise;

      expect((service as any).accessToken).toBe('tok-2');
      // 재발급은 tok-1, tok-2 두 번뿐 — 지연 401 이 불필요한 재발급을 유발하지 않았다.
      expect((http.post as jest.Mock).mock.calls.length).toBe(2);
    });

    it('a 401 carrying the CURRENT token invalidates it and refreshes once', async () => {
      const { service, http } = createService();

      (http.get as jest.Mock).mockReturnValueOnce(okResult('1'));
      await service.get('/api/v1/prices', 'MARKET_DATA', { symbols: '005930' });
      expect((service as any).accessToken).toBe('tok-1');

      // 현재 토큰(tok-1)으로 401 → 캐시 무효화 후 재발급(tok-2) 으로 재시도 성공.
      (http.get as jest.Mock)
        .mockReturnValueOnce(throwError(() => make401()))
        .mockReturnValueOnce(okResult('2'));

      const result = await service.get<{ lastPrice: string }[]>(
        '/api/v1/prices',
        'MARKET_DATA',
        { symbols: '005930' },
      );

      expect(result[0].lastPrice).toBe('2');
      expect((service as any).accessToken).toBe('tok-2');
      expect((http.post as jest.Mock).mock.calls.length).toBe(2);
    });
  });

  describe('isConfigured / isAvailable', () => {
    it('treats placeholder credentials as unconfigured', () => {
      const { service } = createService({
        TOSS_CLIENT_ID: 'your-toss-client-id',
        TOSS_CLIENT_SECRET: 'your-toss-client-secret',
      });
      expect(service.isConfigured()).toBe(false);
      expect(service.isAvailable()).toBe(false);
    });

    it('treats blank credentials as unconfigured', () => {
      const { service } = createService({
        TOSS_CLIENT_ID: '',
        TOSS_CLIENT_SECRET: '',
      });
      expect(service.isConfigured()).toBe(false);
    });

    it('is available when real credentials are set and breaker is closed', () => {
      const { service } = createService();
      expect(service.isConfigured()).toBe(true);
      expect(service.isAvailable()).toBe(true);
    });
  });

  describe('auth-failure circuit breaker', () => {
    it('opens after consecutive OAuth failures so isAvailable() goes false', async () => {
      const { service, http } = createService();
      const authError: any = new Error('invalid_client');
      authError.response = { status: 401 };
      (http.post as jest.Mock).mockReturnValue(throwError(() => authError));

      // 임계(3회)까지 연속 발급 실패.
      for (let i = 0; i < 3; i += 1) {
        await expect(service.getAccessToken()).rejects.toBeDefined();
      }

      // 브레이커가 열려 토스는 일시적으로 사용 불가 → 상위가 KIS 로 직행.
      expect(service.isConfigured()).toBe(true);
      expect(service.isAvailable()).toBe(false);

      // 브레이커가 열린 동안은 OAuth 를 더 시도하지 않고 즉시 실패한다.
      const postCallsBefore = (http.post as jest.Mock).mock.calls.length;
      await expect(service.getAccessToken()).rejects.toThrow(/브레이커/);
      expect((http.post as jest.Mock).mock.calls.length).toBe(postCallsBefore);
    });

    it('resets the failure count on a successful token issue', async () => {
      const { service, http } = createService();
      const authError: any = new Error('invalid_client');
      authError.response = { status: 401 };
      (http.post as jest.Mock)
        .mockReturnValueOnce(throwError(() => authError))
        .mockReturnValueOnce(throwError(() => authError));

      await expect(service.getAccessToken()).rejects.toBeDefined();
      await expect(service.getAccessToken()).rejects.toBeDefined();

      // 다음 발급은 성공 → 누적 실패 리셋, 브레이커는 열리지 않는다.
      const token = await service.getAccessToken();
      expect(token).toBe('tok-1');
      expect(service.isAvailable()).toBe(true);
      expect((service as any).authFailureCount).toBe(0);
    });
  });
});
