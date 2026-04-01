# KIS Authentication APIs

## 접근토큰발급(P) - Access Token

OAuth 토큰을 발급받는다. 모든 API 호출 전에 유효한 토큰이 필요하다.

| 항목 | 값 |
|------|-----|
| API ID | 인증-001 |
| Method | POST |
| URL | `/oauth2/tokenP` |
| 인증 헤더 | 불필요 (이 API로 토큰을 발급받음) |

### Request Body

| Field | Type | Required | Length | Description |
|-------|------|----------|--------|-------------|
| `grant_type` | string | Yes | 18 | 고정값 `"client_credentials"` |
| `appkey` | string | Yes | 36 | 앱 키 |
| `appsecret` | string | Yes | 180 | 앱 시크릿 |

### Response

| Field | Type | Length | Description |
|-------|------|--------|-------------|
| `access_token` | string | 350 | OAuth 접근토큰 |
| `token_type` | string | 20 | `"Bearer"` |
| `expires_in` | number | 10 | 유효기간 (초) |
| `access_token_token_expired` | string | 50 | 만료일시 `YYYY-MM-DD HH:MM:SS` |

### Token 관리 주의사항

- 개인: 1일 유효 (24시간)
- 법인: 3개월 유효
- 발급 후 6시간 이내 재발급 요청 시 동일 토큰 반환
- 토큰 만료 전에 갱신하는 로직 구현 권장

### NestJS 구현 예시

```typescript
async getAccessToken(): Promise<string> {
  // 캐싱된 토큰이 유효하면 재사용
  if (this.accessToken && this.tokenExpiredAt > new Date()) {
    return this.accessToken;
  }

  const { data } = await firstValueFrom(
    this.httpService.post(`${this.baseUrl}/oauth2/tokenP`, {
      grant_type: 'client_credentials',
      appkey: this.configService.get('KIS_APP_KEY'),
      appsecret: this.configService.get('KIS_APP_SECRET'),
    }),
  );

  this.accessToken = data.access_token;
  this.tokenExpiredAt = new Date(data.access_token_token_expired);
  return this.accessToken;
}
```

---

## 접근토큰폐기(P) - Revoke Token

| 항목 | 값 |
|------|-----|
| Method | POST |
| URL | `/oauth2/revokeP` |

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `appkey` | string | Yes | 앱 키 |
| `appsecret` | string | Yes | 앱 시크릿 |
| `token` | string | Yes | 폐기할 접근토큰 |

---

## Hashkey

POST 요청의 Body를 SHA256 해싱한다. 주문 API에서 보안 검증용으로 사용된다.

| 항목 | 값 |
|------|-----|
| API ID | Hashkey |
| Method | POST |
| URL | `/uapi/hashkey` |

### Request Headers

| Header | Required | Description |
|--------|----------|-------------|
| `content-type` | No | `application/json; charset=utf-8` |
| `appkey` | Yes | 앱 키 |
| `appsecret` | Yes | 앱 시크릿 |

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| (전체 Body) | object | Yes | 해싱할 주문 파라미터 JSON |

### Response

| Field | Type | Length | Description |
|-------|------|--------|-------------|
| `HASH` | string | 256 | SHA256 해시값 |

### NestJS 구현 예시

```typescript
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
```
