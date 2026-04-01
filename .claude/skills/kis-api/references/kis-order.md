# KIS Order APIs (주문)

## 주식주문(현금) - Stock Order Cash

현금 매수/매도 주문을 실행한다.

| 항목 | 값 |
|------|-----|
| API ID | v1_국내주식-001 |
| Method | POST |
| URL | `/uapi/domestic-stock/v1/trading/order-cash` |

### TR_ID

| 구분 | 실전 (Production) | 모의 (Sandbox) |
|------|-------------------|----------------|
| 매도 | `TTTC0011U` | `VTTC0011U` |
| 매수 | `TTTC0012U` | `VTTC0012U` |

### Request Body

| Field | Type | Required | Length | Description |
|-------|------|----------|--------|-------------|
| `CANO` | string | Yes | 8 | 종합계좌번호 (앞 8자리) |
| `ACNT_PRDT_CD` | string | Yes | 2 | 계좌상품코드 (뒤 2자리) |
| `PDNO` | string | Yes | 12 | 종목코드 (6자리) |
| `ORD_DVSN` | string | Yes | 2 | 주문구분 (아래 참고) |
| `ORD_QTY` | string | Yes | 10 | 주문수량 |
| `ORD_UNPR` | string | Yes | 19 | 주문단가 (시장가일 때 "0") |
| `SLL_TYPE` | string | No | 2 | 매도유형 (매도 시: "01" 일반) |

### 주문구분 (ORD_DVSN) 코드

| 코드 | 설명 |
|------|------|
| `00` | 지정가 |
| `01` | 시장가 |
| `02` | 조건부지정가 |
| `03` | 최유리지정가 |
| `04` | 최우선지정가 |
| `05` | 장전 시간외 |
| `06` | 장후 시간외 |
| `07` | 시간외 단일가 |
| `08` | 자기주식 |
| `09` | 자기주식S-Option |
| `10` | 자기주식금전신탁 |
| `11` | IOC지정가 (즉시체결·잔량취소) |
| `12` | FOK지정가 (전량체결·전량취소) |
| `13` | IOC시장가 |
| `14` | FOK시장가 |
| `15` | IOC최유리 |
| `16` | FOK최유리 |
| `51` | 장중대량 |
| `52` | 장중바스켓 |
| `62` | 장개시전 시간외대량 |
| `63` | 장중시간외대량 |
| `67` | 장개시전 시간외바스켓 |
| `69` | 장중시간외바스켓 |
| `80` | 바스켓 |

### Response Output

| Field | Type | Length | Description |
|-------|------|--------|-------------|
| `KRX_FWDG_ORD_ORGNO` | string | 5 | 한국거래소전송주문조직번호 |
| `ODNO` | string | 10 | 주문번호 |
| `ORD_TMD` | string | 6 | 주문시각 (HHMMSS) |

### NestJS 구현 예시

```typescript
async orderCash(params: {
  stockCode: string;
  orderType: 'buy' | 'sell';
  orderDvsn: string;
  quantity: number;
  price: number;
}): Promise<KisOrderResponse> {
  const trId = this.getTrId(
    params.orderType === 'buy' ? 'TTTC0012U' : 'TTTC0011U',
    params.orderType === 'buy' ? 'VTTC0012U' : 'VTTC0011U',
  );

  const body = {
    CANO: this.configService.get('KIS_ACCOUNT_NO'),
    ACNT_PRDT_CD: this.configService.get('KIS_ACCOUNT_PROD_CD'),
    PDNO: params.stockCode,
    ORD_DVSN: params.orderDvsn,
    ORD_QTY: String(params.quantity),
    ORD_UNPR: String(params.price),
  };

  const headers = await this.getAuthHeaders(trId);
  const hashkey = await this.getHashkey(body);

  const { data } = await firstValueFrom(
    this.httpService.post(
      `${this.baseUrl}/uapi/domestic-stock/v1/trading/order-cash`,
      body,
      { headers: { ...headers, hashkey } },
    ),
  );

  return data;
}
```

---

## 주식주문(정정취소) - Order Modify/Cancel

기존 주문을 정정하거나 취소한다.

| 항목 | 값 |
|------|-----|
| API ID | v1_국내주식-003 |
| Method | POST |
| URL | `/uapi/domestic-stock/v1/trading/order-rvsecncl` |

### TR_ID

| 구분 | 실전 | 모의 |
|------|------|------|
| 정정/취소 | `TTTC0013U` | `VTTC0013U` |

### Request Body

| Field | Type | Required | Length | Description |
|-------|------|----------|--------|-------------|
| `CANO` | string | Yes | 8 | 종합계좌번호 |
| `ACNT_PRDT_CD` | string | Yes | 2 | 계좌상품코드 |
| `KRX_FWDG_ORD_ORGNO` | string | Yes | 5 | 한국거래소전송주문조직번호 |
| `ORGN_ODNO` | string | Yes | 10 | 원주문번호 |
| `ORD_DVSN` | string | Yes | 2 | 주문구분 (위 코드표 참고) |
| `RVSE_CNCL_DVSN_CD` | string | Yes | 2 | 정정취소구분: `"01"` 정정, `"02"` 취소 |
| `ORD_QTY` | string | Yes | 10 | 주문수량 (전량: `QTY_ALL_ORD_YN`="Y") |
| `ORD_UNPR` | string | Yes | 19 | 주문단가 (취소 시 "0") |
| `QTY_ALL_ORD_YN` | string | Yes | 1 | 잔량전부: `"Y"` 전량, `"N"` 일부 |

### Response Output

| Field | Type | Length | Description |
|-------|------|--------|-------------|
| `KRX_FWDG_ORD_ORGNO` | string | 5 | 한국거래소전송주문조직번호 |
| `ODNO` | string | 10 | 주문번호 |
| `ORD_TMD` | string | 6 | 주문시각 |

### 주의사항

- 정정/취소 전 `주식정정취소가능주문조회` API로 정정가능 수량을 먼저 확인할 것
- 취소 시 `ORD_DVSN`은 `"00"` (지정가), `ORD_UNPR`은 `"0"` 으로 설정
- 전량취소: `QTY_ALL_ORD_YN`=`"Y"`, `ORD_QTY`=`"0"`
