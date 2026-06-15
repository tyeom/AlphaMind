import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { TossApiResponse, TossOAuth2TokenResponse } from './toss.types';
import {
  TossRateLimiterService,
  TossRateLimitGroup,
} from './toss-rate-limiter.service';

/** 토큰 만료 직전 갱신 여유 (초). */
const TOKEN_REFRESH_LEEWAY_SEC = 60;
const DEFAULT_BASE_URL = 'https://openapi.tossinvest.com';
const DEFAULT_TIMEOUT_MS = 10000;

/** OAuth 인증 연속 실패 시 토스를 일시 차단하는 서킷 브레이커 임계/쿨다운. */
const AUTH_FAILURE_THRESHOLD = 3;
const AUTH_BREAKER_COOLDOWN_MS = 60_000;

/** .env.example 플레이스홀더가 그대로 복사된 경우를 "설정됨"으로 오인하지 않는다. */
const PLACEHOLDER_CREDENTIALS = new Set([
  'your-toss-client-id',
  'your-toss-client-secret',
]);

/**
 * 토스증권 Open API 공통 클라이언트.
 * OAuth2 client_credentials 토큰 발급/캐싱과 GET 요청 envelope 언래핑을 담당한다.
 * 시세 조회 전용이며, 키 미설정/인증 연속 실패 시 isAvailable()=false 로 상위에서 KIS 폴백을 유도한다.
 */
@Injectable()
export class TossService {
  private readonly logger = new Logger(TossService.name);
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenInFlight: Promise<string> | null = null;
  /** OAuth 발급 연속 실패 횟수와 서킷 브레이커 차단 만료 시각. */
  private authFailureCount = 0;
  private breakerOpenUntil = 0;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly rateLimiter: TossRateLimiterService,
  ) {}

  get baseUrl(): string {
    return (
      this.configService.get<string>('TOSS_API_BASE_URL')?.trim() ||
      DEFAULT_BASE_URL
    );
  }

  private get clientId(): string | undefined {
    return (
      this.configService.get<string>('TOSS_CLIENT_ID')?.trim() || undefined
    );
  }

  private get clientSecret(): string | undefined {
    return (
      this.configService.get<string>('TOSS_CLIENT_SECRET')?.trim() || undefined
    );
  }

  private get timeoutMs(): number {
    const raw = Number(
      this.configService.get<number | string>(
        'TOSS_REQUEST_TIMEOUT_MS',
        DEFAULT_TIMEOUT_MS,
      ),
    );
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  }

  /**
   * 클라이언트 키가 모두 실제 값으로 설정되어 있는지.
   * 빈 값/플레이스홀더는 미설정으로 본다. 미설정 시 시세 조회는 KIS 로 폴백한다.
   */
  isConfigured(): boolean {
    return (
      this.isRealCredential(this.clientId) &&
      this.isRealCredential(this.clientSecret)
    );
  }

  /**
   * 시세 조회에 실제 사용 가능한지 — 키가 설정돼 있고 인증 서킷 브레이커가 닫혀 있을 때.
   * OAuth 가 연속 실패(invalid_client/키 폐기 등)하면 일정 시간 false 가 되어,
   * 상위가 토스 시도를 건너뛰고 곧장 KIS 로 폴백해 핫패스 지연을 막는다.
   */
  isAvailable(): boolean {
    return this.isConfigured() && Date.now() >= this.breakerOpenUntil;
  }

  private isRealCredential(value: string | undefined): boolean {
    return Boolean(value) && !PLACEHOLDER_CREDENTIALS.has(value as string);
  }

  /** OAuth2 액세스 토큰 발급 (캐싱). 동시 요청은 단일 in-flight 로 합친다. */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt) {
      return this.accessToken;
    }

    if (this.tokenInFlight) {
      return this.tokenInFlight;
    }

    if (!this.isConfigured()) {
      throw new Error('TOSS_CLIENT_ID/SECRET 미설정');
    }

    if (now < this.breakerOpenUntil) {
      throw new Error('토스 인증 서킷 브레이커 열림 — KIS 폴백');
    }

    this.tokenInFlight = this.issueToken().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async issueToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId!,
      client_secret: this.clientSecret!,
    });

    await this.rateLimiter.acquire('AUTH');
    try {
      const { data } = await firstValueFrom(
        this.httpService.post<TossOAuth2TokenResponse>(
          `${this.baseUrl}/oauth2/token`,
          body.toString(),
          {
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
            },
            timeout: this.timeoutMs,
          },
        ),
      );

      this.accessToken = data.access_token;
      // expires_in(초)에서 여유분을 빼 만료 직전 재발급을 강제한다.
      const ttlMs =
        Math.max(0, data.expires_in - TOKEN_REFRESH_LEEWAY_SEC) * 1000;
      this.tokenExpiresAt = Date.now() + ttlMs;
      // 발급 성공 — 누적 실패/브레이커 리셋.
      this.authFailureCount = 0;
      this.breakerOpenUntil = 0;
      this.logger.log(`토스 액세스 토큰 발급 완료 (만료 ${data.expires_in}s)`);
      return this.accessToken;
    } catch (err) {
      this.recordAuthFailure(err);
      throw err;
    }
  }

  /** OAuth 발급 실패를 누적해, 임계 도달 시 서킷 브레이커를 연다. */
  private recordAuthFailure(err: unknown): void {
    this.authFailureCount += 1;
    if (this.authFailureCount >= AUTH_FAILURE_THRESHOLD) {
      this.breakerOpenUntil = Date.now() + AUTH_BREAKER_COOLDOWN_MS;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `토스 인증 연속 실패 ${this.authFailureCount}회 → ${Math.round(
          AUTH_BREAKER_COOLDOWN_MS / 1000,
        )}초간 차단(KIS 폴백): ${message}`,
      );
    }
  }

  /**
   * 인증된 GET 요청 후 envelope(result) 를 언래핑해 반환한다.
   * 토큰 만료(401)면 한 번 재발급 후 재시도한다.
   */
  async get<T>(
    path: string,
    group: TossRateLimitGroup,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const cleanedParams = this.cleanParams(params);

    // 이 요청이 실제 사용한 토큰을 로컬에 기록해, 401 시 "그 토큰"만 무효화한다.
    // err.config 헤더에 의존하지 않으므로 AxiosHeaders 정규화/헤더 누락에도 안전하다.
    let usedToken: string | null = null;
    const exec = async (): Promise<T> => {
      const token = await this.getAccessToken();
      usedToken = token;
      await this.rateLimiter.acquire(group);
      const { data } = await firstValueFrom(
        this.httpService.get<TossApiResponse<T>>(`${this.baseUrl}${path}`, {
          headers: { authorization: `Bearer ${token}` },
          params: cleanedParams,
          timeout: this.timeoutMs,
        }),
      );
      return data.result;
    };

    try {
      return await exec();
    } catch (err: any) {
      if (err?.response?.status === 401) {
        // 실패한 요청이 쓴 토큰이 아직 현재 캐시일 때만 비운다.
        // 동시성 상황에서 지연 도착한 옛 401 이 새로 발급된 토큰을 지우지 않게 한다.
        this.invalidateToken(usedToken);
        return await exec();
      }
      throw err;
    }
  }

  /**
   * 주어진 토큰이 아직 현재 캐시된 토큰일 때만 무효화한다.
   * 알 수 없는 토큰(null)이면 비우지 않아, 다른 요청이 막 발급한 새 토큰을 지키게 한다.
   */
  private invalidateToken(token: string | null): void {
    if (token != null && this.accessToken === token) {
      this.accessToken = null;
      this.tokenExpiresAt = 0;
    }
  }

  private cleanParams(
    params?: Record<string, string | number | boolean | undefined>,
  ): Record<string, string | number | boolean> | undefined {
    if (!params) return undefined;
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
}
