import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class KisService {
  private readonly logger = new Logger(KisService.name);
  private accessToken: string | null = null;
  private tokenExpiredAt: Date | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
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

    const { data } = await firstValueFrom(
      this.httpService.post(`${this.baseUrl}/oauth2/tokenP`, {
        grant_type: 'client_credentials',
        appkey: this.configService.get('KIS_APP_KEY'),
        appsecret: this.configService.get('KIS_APP_SECRET'),
      }),
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
    const { data } = await firstValueFrom(
      this.httpService.post(`${this.baseUrl}/uapi/hashkey`, body, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          appkey: this.configService.get('KIS_APP_KEY'),
          appsecret: this.configService.get('KIS_APP_SECRET'),
        },
      }),
    );
    return data.HASH;
  }

  /** 접근토큰 폐기 */
  async revokeToken(): Promise<void> {
    if (!this.accessToken) return;

    await firstValueFrom(
      this.httpService.post(`${this.baseUrl}/oauth2/revokeP`, {
        appkey: this.configService.get('KIS_APP_KEY'),
        appsecret: this.configService.get('KIS_APP_SECRET'),
        token: this.accessToken,
      }),
    );

    this.accessToken = null;
    this.tokenExpiredAt = null;
    this.logger.log('KIS 접근토큰 폐기 완료');
  }
}
