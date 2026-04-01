---
name: kis-api
description: KIS (Korea Investment & Securities / 한국투자증권) OpenAPI integration for stock trading. Use this skill when building NestJS services that interact with KIS APIs — including authentication (토큰발급), stock orders (매수/매도/정정/취소), account inquiries (잔고조회, 매수가능조회, 체결조회), market data (현재가, 일자별시세), and real-time WebSocket data (실시간 체결가, 호가, 체결통보). Trigger whenever the user mentions KIS, 한국투자증권, Korean stock trading API, real-time stock price, WebSocket 시세, or wants to add brokerage integration to the alpha-mind project.
---

# KIS OpenAPI Integration Guide

This skill provides complete API specifications for integrating with Korea Investment & Securities (한국투자증권) OpenAPI in a NestJS monorepo.

## Domains

| Environment | Base URL |
|-------------|----------|
| Production (실전) | `https://openapi.koreainvestment.com:9443` |
| Sandbox (모의) | `https://openapivts.koreainvestment.com:29443` |

## Common Headers

All API requests require these headers:

| Header | Required | Description |
|--------|----------|-------------|
| `content-type` | Yes | `application/json; charset=utf-8` |
| `authorization` | Yes | `Bearer {access_token}` (인증 API 제외) |
| `appkey` | Yes | 앱 키 (36자) |
| `appsecret` | Yes | 앱 시크릿 (180자) |
| `tr_id` | Yes | 거래 ID (API별 상이) |
| `custtype` | Yes | `P` (개인) / `B` (법인) |
| `tr_cont` | No | 연속조회: 공백(초회), `N`(다음) |

## Common Response Structure

```json
{
  "rt_cd": "0",       // "0": 성공, 그 외: 실패
  "msg_cd": "KIOK0000",
  "msg1": "정상처리",
  "output": { ... }   // or output1, output2 for list APIs
}
```

## API Categories

Read the relevant reference file based on what you need:

| Category | Reference File | When to Read |
|----------|---------------|--------------|
| 인증 (토큰, Hashkey) | `references/kis-auth.md` | 토큰 발급/폐기, Hashkey 생성 |
| 주문 (매수/매도/정정/취소) | `references/kis-order.md` | 주식 주문 관련 기능 구현 |
| 계좌 조회 | `references/kis-inquiry.md` | 잔고, 매수가능, 매도가능, 체결내역 조회 |
| 시세 조회 | `references/kis-quotation.md` | 현재가, 일자별 시세 조회 |
| 실시간 WebSocket | `references/kis-websocket.md` | 실시간 체결가, 호가, 체결통보 |

## NestJS Integration Pattern

KIS API 모듈을 생성할 때 아래 구조를 따른다:

```
src/kis/
├── kis.module.ts              # KIS 모듈 정의
├── kis.service.ts             # HTTP 클라이언트, 토큰 관리
├── kis-order.service.ts       # 주문 관련 서비스
├── kis-inquiry.service.ts     # 조회 관련 서비스
├── kis-quotation.service.ts   # 시세 관련 서비스
├── kis-websocket.service.ts   # 실시간 WebSocket 서비스
├── kis.types.ts               # 공통 타입 정의
├── dto/                       # Request/Response DTO
└── interfaces/                # API response interfaces
```

### Environment Variables

```env
KIS_APP_KEY=your-app-key
KIS_APP_SECRET=your-app-secret
KIS_ACCOUNT_NO=12345678    # 계좌번호 앞 8자리
KIS_ACCOUNT_PROD_CD=01     # 계좌상품코드 뒤 2자리
KIS_ENV=sandbox             # sandbox | production
```

### HTTP Client Base Pattern

```typescript
@Injectable()
export class KisService {
  private accessToken: string;
  private tokenExpiredAt: Date;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  private get baseUrl(): string {
    return this.configService.get('KIS_ENV') === 'production'
      ? 'https://openapi.koreainvestment.com:9443'
      : 'https://openapivts.koreainvestment.com:29443';
  }

  private get commonHeaders() {
    return {
      'content-type': 'application/json; charset=utf-8',
      appkey: this.configService.get('KIS_APP_KEY'),
      appsecret: this.configService.get('KIS_APP_SECRET'),
      custtype: 'P',
    };
  }

  private async getAuthHeaders(trId: string) {
    const token = await this.getAccessToken();
    return {
      ...this.commonHeaders,
      authorization: `Bearer ${token}`,
      tr_id: trId,
    };
  }
}
```

### TR_ID Sandbox Mapping

실전/모의 환경에 따라 TR_ID가 달라지는 API가 있다. 환경에 맞는 TR_ID를 자동으로 선택하도록 구현한다:

```typescript
private getTrId(prodId: string, sandboxId: string): string {
  return this.configService.get('KIS_ENV') === 'production'
    ? prodId
    : sandboxId;
}
```

### Pagination

목록 조회 API는 `tr_cont` 헤더와 `ctx_area_fk100`, `ctx_area_nk100` 파라미터로 페이징한다:
- 초회: `tr_cont` = 공백
- 다음 페이지: `tr_cont` = `N`, 이전 응답의 `ctx_area_fk100`, `ctx_area_nk100` 값 전달
- 응답 헤더의 `tr_cont`가 `N`이면 다음 데이터 존재, `D`이면 마지막

### Rate Limiting

- 초당 20건 제한 (개인)
- 429 응답 시 재시도 로직 필요
