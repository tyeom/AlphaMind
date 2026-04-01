# KIS WebSocket APIs (실시간)

## 개요

KIS 실시간 데이터는 WebSocket으로 수신한다. REST API와 달리 한 번 구독하면 해당 종목의 데이터가 실시간으로 push된다.

## WebSocket 접속 URL

| Environment | URL |
|-------------|-----|
| Production (실전) | `ws://ops.koreainvestment.com:21000` |
| Sandbox (모의) | `ws://ops.koreainvestment.com:31000` |

## 접속 절차

### Step 1: 접속키 발급

REST API로 WebSocket 접속키를 발급받는다.

| 항목 | 값 |
|------|-----|
| API ID | 실시간-000 |
| Method | POST |
| URL | `/oauth2/Approval` (REST 도메인) |

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `grant_type` | string | Yes | `"client_credentials"` |
| `appkey` | string | Yes | 앱 키 |
| `secretkey` | string | Yes | 앱 시크릿 |

#### Response

| Field | Type | Description |
|-------|------|-------------|
| `approval_key` | string (286) | WebSocket 접속키 (24시간 유효) |

### Step 2: WebSocket 연결 및 구독

접속키를 사용하여 WebSocket에 연결하고, JSON 메시지로 종목을 구독한다.

#### 구독 요청 JSON

```json
{
  "header": {
    "approval_key": "발급받은_접속키",
    "custtype": "P",
    "tr_type": "1",
    "content-type": "utf-8"
  },
  "body": {
    "input": {
      "tr_id": "H0STCNT0",
      "tr_key": "005930"
    }
  }
}
```

| Header Field | Description |
|-------------|-------------|
| `approval_key` | 접속키 |
| `custtype` | `"P"` (개인) / `"B"` (법인) |
| `tr_type` | `"1"` 구독, `"2"` 해제 |
| `content-type` | `"utf-8"` |

| Body Field | Description |
|------------|-------------|
| `tr_id` | 실시간 데이터 종류 (아래 참고) |
| `tr_key` | 구독 대상 (종목코드 또는 HTS ID) |

#### 구독 성공 응답 (JSON)

```json
{
  "header": {
    "tr_id": "H0STCNT0",
    "tr_key": "005930",
    "encrypt": "N"
  },
  "body": {
    "rt_cd": "0",
    "msg_cd": "OPSP0000",
    "msg1": "SUBSCRIBE SUCCESS",
    "output": {
      "iv": "AES256_IV",
      "key": "AES256_KEY"
    }
  }
}
```

- `output.iv`, `output.key`: 암호화된 데이터 복호화용 AES256 키 (체결통보에 사용)

---

## 실시간 데이터 수신 형식

구독 성공 후 데이터는 **파이프(|) + 캐럿(^) 구분 텍스트**로 수신된다 (JSON이 아님).

```
[암호화여부]|[TR_ID]|[데이터건수]|[필드1^필드2^필드3^...]
```

**예시 (체결가):**
```
0|H0STCNT0|001|005930^123929^73100^2^300^0.41^73050^73200^73300^72900^73200^72900^15234^1847293^134920844100^...
```

- `0`: 암호화 안됨 (`1`이면 AES256 복호화 필요)
- `H0STCNT0`: 체결가 TR_ID
- `001`: 데이터 1건
- 이후: `^`로 구분된 필드 데이터

---

## 실시간 데이터 종류

### 1. 실시간체결가 (H0STCNT0)

종목의 실시간 체결 정보를 수신한다.

| 항목 | 값 |
|------|-----|
| API ID | 실시간-003 |
| TR_ID | `H0STCNT0` (실전/모의 동일) |
| tr_key | 종목코드 (6자리, ETN은 Q 접두) |

#### 수신 필드 (46개, `^` 구분)

| # | Field | Description |
|---|-------|-------------|
| 0 | `MKSC_SHRN_ISCD` | 종목코드 (9자리) |
| 1 | `STCK_CNTG_HOUR` | 체결시각 (HHMMSS) |
| 2 | `STCK_PRPR` | 현재가 (체결가) |
| 3 | `PRDY_VRSS_SIGN` | 전일대비부호 (1:상한 2:상승 3:보합 4:하한 5:하락) |
| 4 | `PRDY_VRSS` | 전일대비 |
| 5 | `PRDY_CTRT` | 전일대비율 (%) |
| 6 | `WGHN_AVRG_STCK_PRC` | 가중평균주가 |
| 7 | `STCK_OPRC` | 시가 |
| 8 | `STCK_HGPR` | 최고가 |
| 9 | `STCK_LWPR` | 최저가 |
| 10 | `ASKP1` | 매도호가1 |
| 11 | `BIDP1` | 매수호가1 |
| 12 | `CNTG_VOL` | 체결거래량 |
| 13 | `ACML_VOL` | 누적거래량 |
| 14 | `ACML_TR_PBMN` | 누적거래대금 |
| 15 | `SELN_CNTG_CSNU` | 매도체결건수 |
| 16 | `SHNU_CNTG_CSNU` | 매수체결건수 |
| 17 | `NTBY_CNTG_CSNU` | 순매수체결건수 |
| 18 | `CTTR` | 체결강도 |
| 19 | `SELN_CNTG_SMTN` | 총매도수량 |
| 20 | `SHNU_CNTG_SMTN` | 총매수수량 |
| 21 | `CCLD_DVSN` | 체결구분 (1:매수(+) 3:장전 5:매도(-)) |
| 22 | `SHNU_RATE` | 매수비율 |
| 23 | `PRDY_VOL_VRSS_ACML_VOL_RATE` | 전일거래량대비누적거래량비율 |
| 24 | `OPRC_HOUR` | 시가시각 |
| 25 | `OPRC_VRSS_PRPR_SIGN` | 시가대비부호 |
| 26 | `OPRC_VRSS_PRPR` | 시가대비 |
| 27 | `HGPR_HOUR` | 최고가시각 |
| 28 | `HGPR_VRSS_PRPR_SIGN` | 최고가대비부호 |
| 29 | `HGPR_VRSS_PRPR` | 최고가대비 |
| 30 | `LWPR_HOUR` | 최저가시각 |
| 31 | `LWPR_VRSS_PRPR_SIGN` | 최저가대비부호 |
| 32 | `LWPR_VRSS_PRPR` | 최저가대비 |
| 33 | `BSOP_DATE` | 영업일자 (YYYYMMDD) |
| 34 | `NEW_MKOP_CLS_CODE` | 신장운영구분코드 |
| 35 | `TRHT_YN` | 거래정지여부 (Y/N) |
| 36 | `ASKP_RSQN1` | 매도호가잔량1 |
| 37 | `BIDP_RSQN1` | 매수호가잔량1 |
| 38 | `TOTAL_ASKP_RSQN` | 총매도호가잔량 |
| 39 | `TOTAL_BIDP_RSQN` | 총매수호가잔량 |
| 40 | `VOL_TNRT` | 거래량회전율 |
| 41 | `PRDY_SMNS_HOUR_ACML_VOL` | 전일동시간누적거래량 |
| 42 | `PRDY_SMNS_HOUR_ACML_VOL_RATE` | 전일동시간누적거래량비율 |
| 43 | `HOUR_CLS_CODE` | 시간구분코드 (0:장중, A:장후예상, B:장전예상, C:9시이후, D:시간외단일가예상) |
| 44 | `MRKT_TRTM_CLS_CODE` | 임의종료구분코드 |
| 45 | `VI_STND_PRC` | 정적VI발동기준가 |

### 2. 실시간호가 (H0UNASP0)

종목의 실시간 10단계 호가 정보를 수신한다.

| 항목 | 값 |
|------|-----|
| API ID | 실시간호가(통합) |
| TR_ID | `H0UNASP0` |
| tr_key | 종목코드 (6자리) |

#### 수신 필드 (주요, `^` 구분)

| # | Field | Description |
|---|-------|-------------|
| 0 | `MKSC_SHRN_ISCD` | 종목코드 |
| 1 | `BSOP_HOUR` | 영업시각 (HHMMSS) |
| 2 | `HOUR_CLS_CODE` | 시간구분코드 |
| 3-12 | `ASKP1`~`ASKP10` | 매도호가 1~10차 |
| 13-22 | `BIDP1`~`BIDP10` | 매수호가 1~10차 |
| 23-32 | `ASKP_RSQN1`~`ASKP_RSQN10` | 매도호가잔량 1~10 |
| 33-42 | `BIDP_RSQN1`~`BIDP_RSQN10` | 매수호가잔량 1~10 |
| 43 | `TOTAL_ASKP_RSQN` | 총매도호가잔량 |
| 44 | `TOTAL_BIDP_RSQN` | 총매수호가잔량 |
| 45 | `OVTM_TOTAL_ASKP_RSQN` | 시간외총매도호가잔량 |
| 46 | `OVTM_TOTAL_BIDP_RSQN` | 시간외총매수호가잔량 |
| 47 | `TOTAL_ASKP_RSQN_ICDC` | 총매도호가잔량증감 |
| 48 | `TOTAL_BIDP_RSQN_ICDC` | 총매수호가잔량증감 |
| 49 | `OVTM_TOTAL_ASKP_ICDC` | 시간외총매도호가증감 |
| 50 | `OVTM_TOTAL_BIDP_ICDC` | 시간외총매수호가증감 |
| 51 | `ANTC_CNPR` | 예상체결가 |
| 52 | `ANTC_CNQN` | 예상체결수량 |
| 53 | `ANTC_VOL` | 예상거래량 |
| 54 | `ANTC_CNTG_VRSS` | 예상체결대비 |
| 55 | `ANTC_CNTG_VRSS_SIGN` | 예상체결대비부호 |
| 56 | `ANTC_CNTG_PRDY_CTRT` | 예상체결전일대비율 |
| 57 | `ACML_VOL` | 누적거래량 |
| 58 | `TOTAL_ASKP_RSQN_SMTN` | 총매도호가잔량합계 |
| 59 | `TOTAL_BIDP_RSQN_SMTN` | 총매수호가잔량합계 |

### 3. 실시간체결통보 (H0STCNI0 / H0STCNI9)

내 계좌의 주문접수/체결 알림을 실시간으로 수신한다.

| 항목 | 값 |
|------|-----|
| API ID | 실시간-005 |
| TR_ID (실전) | `H0STCNI0` |
| TR_ID (모의) | `H0STCNI9` |
| tr_key | HTS ID |

#### 주의사항
- 체결통보는 **AES256 암호화**되어 수신됨
- 구독 응답의 `iv`, `key`로 복호화 필요
- `CNTG_YN` 필드로 구분: `1`=주문/정정/취소/거부, `2`=체결

#### 수신 필드 (26개, `^` 구분)

| # | Field | Description |
|---|-------|-------------|
| 0 | `CUST_ID` | 고객 ID |
| 1 | `ACNT_NO` | 계좌번호 |
| 2 | `ODER_NO` | 주문번호 |
| 3 | `OODER_NO` | 원주문번호 |
| 4 | `SELN_BYOV_CLS` | 매도매수구분 (`01`:매도, `02`:매수) |
| 5 | `RCTF_CLS` | 정정구분 (`0`:보통, `1`:정정, `2`:취소) |
| 6 | `ODER_KIND` | 주문종류 (`00`:지정가, `01`:시장가 등) |
| 7 | `ODER_COND` | 주문조건 (`0`:없음, `1`:IOC, `2`:FOK) |
| 8 | `STCK_SHRN_ISCD` | 종목코드 (축약, 9자리) |
| 9 | `CNTG_QTY` | 체결수량 |
| 10 | `CNTG_UNPR` | 체결단가 |
| 11 | `STCK_CNTG_HOUR` | 체결시각 |
| 12 | `RFUS_YN` | 거부여부 (`0`:정상, `1`:거부) |
| 13 | `CNTG_YN` | 체결여부 (`1`:주문/정정/취소/거부, `2`:체결) |
| 14 | `ACPT_YN` | 접수여부 (`1`:주문접수, `2`:확인, `3`:취소(FOK/IOC)) |
| 15 | `BRNC_NO` | 지점번호 |
| 16 | `ODER_QTY` | 주문수량 |
| 17 | `ACNT_NAME` | 계좌명 |
| 18 | `ORD_COND_PRC` | 주문조건가격 |
| 19 | `ORD_EXG_GB` | 주문거래소구분 (`1`:KRX, `2`:NXT) |
| 20 | `POPUP_YN` | 실시간체결창표시여부 |
| 21 | `FILLER` | 예비 |
| 22 | `CRDT_CLS` | 신용구분 |
| 23 | `CRDT_LOAN_DATE` | 신용대출일자 |
| 24 | `CNTG_ISNM40` | 체결종목명 (40자) |
| 25 | `ODER_PRC` | 주문가격 |

---

## AES256 복호화 (체결통보)

체결통보 데이터는 암호화되어 수신된다. 구독 응답의 `iv`와 `key`를 사용하여 AES-256-CBC로 복호화한다.

```typescript
import { createDecipheriv } from 'crypto';

function decryptAes256(encrypted: string, key: string, iv: string): string {
  const decipher = createDecipheriv(
    'aes-256-cbc',
    Buffer.from(key),
    Buffer.from(iv),
  );
  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
```

---

## NestJS WebSocket Gateway 구현 패턴

```typescript
import WebSocket from 'ws';

@Injectable()
export class KisWebSocketService implements OnModuleInit, OnModuleDestroy {
  private ws: WebSocket;
  private approvalKey: string;
  private aesIv: string;
  private aesKey: string;
  private subscriptions = new Map<string, Set<string>>();

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    await this.connect();
  }

  onModuleDestroy() {
    this.ws?.close();
  }

  // Step 1: 접속키 발급
  private async getApprovalKey(): Promise<string> {
    const baseUrl = this.configService.get('KIS_ENV') === 'production'
      ? 'https://openapi.koreainvestment.com:9443'
      : 'https://openapivts.koreainvestment.com:29443';

    const { data } = await firstValueFrom(
      this.httpService.post(`${baseUrl}/oauth2/Approval`, {
        grant_type: 'client_credentials',
        appkey: this.configService.get('KIS_APP_KEY'),
        secretkey: this.configService.get('KIS_APP_SECRET'),
      }),
    );
    return data.approval_key;
  }

  // Step 2: WebSocket 연결
  private async connect() {
    this.approvalKey = await this.getApprovalKey();

    const wsUrl = this.configService.get('KIS_ENV') === 'production'
      ? 'ws://ops.koreainvestment.com:21000'
      : 'ws://ops.koreainvestment.com:31000';

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.logger.log('KIS WebSocket 연결 성공');
      // 기존 구독 복원
      this.resubscribeAll();
    });

    this.ws.on('message', (data: Buffer) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', () => {
      this.logger.warn('KIS WebSocket 연결 종료, 재연결 시도...');
      setTimeout(() => this.connect(), 5000);
    });

    this.ws.on('error', (err) => {
      this.logger.error('KIS WebSocket 오류', err.message);
    });
  }

  // 종목 구독
  subscribe(trId: string, trKey: string) {
    const msg = JSON.stringify({
      header: {
        approval_key: this.approvalKey,
        custtype: 'P',
        tr_type: '1',
        'content-type': 'utf-8',
      },
      body: {
        input: { tr_id: trId, tr_key: trKey },
      },
    });
    this.ws.send(msg);

    if (!this.subscriptions.has(trId)) {
      this.subscriptions.set(trId, new Set());
    }
    this.subscriptions.get(trId).add(trKey);
  }

  // 구독 해제
  unsubscribe(trId: string, trKey: string) {
    const msg = JSON.stringify({
      header: {
        approval_key: this.approvalKey,
        custtype: 'P',
        tr_type: '2',
        'content-type': 'utf-8',
      },
      body: {
        input: { tr_id: trId, tr_key: trKey },
      },
    });
    this.ws.send(msg);
    this.subscriptions.get(trId)?.delete(trKey);
  }

  // 메시지 핸들링
  private handleMessage(raw: string) {
    // JSON 응답 (구독 확인)
    if (raw.startsWith('{')) {
      const json = JSON.parse(raw);
      if (json.body?.output?.iv) {
        this.aesIv = json.body.output.iv;
        this.aesKey = json.body.output.key;
      }
      return;
    }

    // 파이프 구분 실시간 데이터
    const [encrypted, trId, count, ...dataParts] = raw.split('|');
    const dataStr = dataParts.join('|');

    // 암호화된 데이터 복호화 (체결통보)
    let fields: string[];
    if (encrypted === '1' && this.aesIv && this.aesKey) {
      const decrypted = this.decryptAes256(dataStr, this.aesKey, this.aesIv);
      fields = decrypted.split('^');
    } else {
      fields = dataStr.split('^');
    }

    switch (trId) {
      case 'H0STCNT0':
        this.handleExecution(fields);
        break;
      case 'H0UNASP0':
        this.handleOrderbook(fields);
        break;
      case 'H0STCNI0':
      case 'H0STCNI9':
        this.handleOrderNotification(fields);
        break;
    }
  }
}
```

---

## 구독 제한 및 주의사항

- 최대 동시 구독 종목: 약 40종목 (체결가 + 호가 각각 카운트)
- 접속키는 24시간 유효하나, 세션은 최대 365일 유지
- 장 운영 시간 외에는 데이터 수신 없음
- 재연결 시 기존 구독이 해제되므로 재구독 필요
- PINGPONG: 서버에서 주기적으로 `PINGPONG` 메시지 전송, 동일하게 응답해야 연결 유지
