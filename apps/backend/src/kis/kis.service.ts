import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { KisRateLimiterService } from './kis-rate-limiter.service';

interface KisRequestOptions {
  retryOnRateLimit?: boolean;
}

const DEFAULT_RATE_LIMIT_MAX_RETRY = 5;
const RATE_LIMIT_BACKOFF_BASE_MS = 200;
const RATE_LIMIT_BACKOFF_MAX_MS = 5000;

@Injectable()
export class KisService {
  private readonly logger = new Logger(KisService.name);
  private accessToken: string | null = null;
  private tokenExpiredAt: Date | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly rateLimiter: KisRateLimiterService,
  ) {}

  get baseUrl(): string {
    return this.configService.get('KIS_ENV') === 'production'
      ? 'https://openapi.koreainvestment.com:9443'
      : 'https://openapivts.koreainvestment.com:29443';
  }

  get accountNo(): string {
    return this.configService.get<string>('KIS_ACCOUNT_NO')!;
  }

  get accountProdCd(): string {
    return this.configService.get<string>('KIS_ACCOUNT_PROD_CD')!;
  }

  private get commonHeaders() {
    return {
      'content-type': 'application/json; charset=utf-8',
      appkey: this.configService.get<string>('KIS_APP_KEY'),
      appsecret: this.configService.get<string>('KIS_APP_SECRET'),
      custtype: 'P',
    };
  }

  /** 실전/모의에 따라 TR_ID를 반환 */
  getTrId(prodId: string, sandboxId: string): string {
    return this.configService.get('KIS_ENV') === 'production'
      ? prodId
      : sandboxId;
  }

  /** 접근토큰 발급 (캐싱) */
  async getAccessToken(): Promise<string> {
    if (
      this.accessToken &&
      this.tokenExpiredAt &&
      this.tokenExpiredAt > new Date()
    ) {
      return this.accessToken;
    }

    this.logger.log('KIS 접근토큰 발급 요청');

    const { data } = await this.request(
      () =>
        firstValueFrom(
          this.httpService.post(`${this.baseUrl}/oauth2/tokenP`, {
            grant_type: 'client_credentials',
            appkey: this.configService.get('KIS_APP_KEY'),
            appsecret: this.configService.get('KIS_APP_SECRET'),
          }),
        ),
      { retryOnRateLimit: false },
    );

    this.accessToken = data.access_token;
    this.tokenExpiredAt = new Date(data.access_token_token_expired);
    this.logger.log(
      `KIS 접근토큰 발급 완료 (만료: ${data.access_token_token_expired})`,
    );

    return this.accessToken!;
  }

  /** 인증 헤더 생성 */
  async getAuthHeaders(trId: string) {
    const token = await this.getAccessToken();
    return {
      ...this.commonHeaders,
      authorization: `Bearer ${token}`,
      tr_id: trId,
    };
  }

  /** Hashkey 생성 (주문 시 보안 검증용) */
  async getHashkey(body: Record<string, any>): Promise<string> {
    const { data } = await this.request(() =>
      firstValueFrom(
        this.httpService.post(`${this.baseUrl}/uapi/hashkey`, body, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            appkey: this.configService.get('KIS_APP_KEY'),
            appsecret: this.configService.get('KIS_APP_SECRET'),
          },
        }),
      ),
    );
    return data.HASH;
  }

  /** 접근토큰 폐기 */
  async revokeToken(): Promise<void> {
    if (!this.accessToken) return;

    await this.request(
      () =>
        firstValueFrom(
          this.httpService.post(`${this.baseUrl}/oauth2/revokeP`, {
            appkey: this.configService.get('KIS_APP_KEY'),
            appsecret: this.configService.get('KIS_APP_SECRET'),
            token: this.accessToken,
          }),
        ),
      { retryOnRateLimit: false },
    );

    this.accessToken = null;
    this.tokenExpiredAt = null;
    this.logger.log('KIS 접근토큰 폐기 완료');
  }

  /** KIS REST 공통 실행 래퍼 — 중앙 레이트리밋과 EGW00201 백오프를 한 곳에서 처리한다. */
  async request<T>(
    fn: () => Promise<T>,
    opts: KisRequestOptions = {},
  ): Promise<T> {
    const retryOnRateLimit = opts.retryOnRateLimit ?? true;
    const maxRetry = this.getRateLimitMaxRetry();
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
      await this.rateLimiter.acquire();

      try {
        const result = await fn();
        if (!retryOnRateLimit || !this.isRateLimitResponse(result)) {
          return result;
        }

        lastError = this.createRateLimitResponseError(result);
      } catch (err) {
        if (!retryOnRateLimit || !this.isRateLimitResponse(err)) {
          throw err;
        }

        lastError = err;
      }

      if (attempt >= maxRetry) {
        this.logger.warn(
          `KIS 레이트리밋 재시도 소진: ${maxRetry}회 재시도 후 실패`,
        );
        throw lastError;
      }

      await this.sleep(this.getBackoffMs(attempt));
    }

    throw lastError;
  }

  private getRateLimitMaxRetry(): number {
    const raw = this.configService.get<number | string>(
      'KIS_RATE_MAX_RETRY',
      DEFAULT_RATE_LIMIT_MAX_RETRY,
    );
    const value = Number(raw);

    return Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : DEFAULT_RATE_LIMIT_MAX_RETRY;
  }

  private getBackoffMs(attempt: number): number {
    // 지터는 모든 인스턴스가 같은 시점에 재시도하는 것을 피하기 위한 보수 장치다.
    const exponential = RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * RATE_LIMIT_BACKOFF_BASE_MS);

    return Math.min(exponential + jitter, RATE_LIMIT_BACKOFF_MAX_MS);
  }

  private isRateLimitResponse(value: unknown): boolean {
    const response = value as any;
    const status = response?.response?.status ?? response?.status;

    if (status === 429) {
      return true;
    }

    if (this.containsRateLimitMarker(response?.response?.data ?? response)) {
      return true;
    }

    return (
      typeof status === 'number' &&
      status >= 500 &&
      this.containsRateLimitMarker(response?.message)
    );
  }

  private containsRateLimitMarker(value: unknown): boolean {
    if (value == null) {
      return false;
    }

    if (typeof value === 'string') {
      return this.isRateLimitText(value);
    }

    if (typeof value !== 'object') {
      return false;
    }

    const body = (value as any).data ?? value;
    const fields = [
      body.rt_cd,
      body.msg_cd,
      body.msg1,
      body.error_code,
      body.error_description,
      body.message,
    ];
    const fieldText = fields.filter(Boolean).join(' ');

    if (this.isRateLimitText(fieldText)) {
      return true;
    }

    try {
      return this.isRateLimitText(JSON.stringify(body));
    } catch {
      return false;
    }
  }

  private isRateLimitText(text: string): boolean {
    return (
      text.includes('EGW00201') ||
      text.includes('초당 거래건수') ||
      text.includes('초당 거래 건수') ||
      text.toLowerCase().includes('rate limit')
    );
  }

  private createRateLimitResponseError(result: unknown): Error {
    const body = (result as any)?.data ?? result;
    const message =
      body?.msg1 || body?.message || 'KIS 초당 거래건수 제한 응답';
    const err = new Error(message);
    (err as any).response = { data: body };

    return err;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
