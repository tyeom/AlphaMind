# KIS Quotation APIs (시세 조회)

## 주식현재가 시세 - Current Stock Price

종목의 현재가 및 상세 시세 정보를 조회한다.

| 항목 | 값 |
|------|-----|
| API ID | v1_국내주식-008 |
| Method | GET |
| URL | `/uapi/domestic-stock/v1/quotations/inquire-price` |
| TR_ID | `FHKST01010100` (실전/모의 동일) |

### Query Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fid_cond_mrkt_div_code` | string | Yes | 시장구분: `"J"` (주식) |
| `fid_input_iscd` | string | Yes | 종목코드 (6자리) |

### Response Output (주요 필드)

#### 가격 정보

| Field | Type | Description |
|-------|------|-------------|
| `stck_prpr` | string | 주식 현재가 |
| `prdy_vrss` | string | 전일 대비 |
| `prdy_vrss_sign` | string | 전일 대비 부호 (1:상한, 2:상승, 3:보합, 4:하한, 5:하락) |
| `prdy_ctrt` | string | 전일 대비율 (%) |
| `stck_oprc` | string | 시가 |
| `stck_hgpr` | string | 최고가 |
| `stck_lwpr` | string | 최저가 |
| `stck_mxpr` | string | 상한가 |
| `stck_llam` | string | 하한가 |
| `stck_sdpr` | string | 기준가 |
| `wghn_avrg_stck_prc` | string | 가중평균주가 |

#### 거래량 정보

| Field | Type | Description |
|-------|------|-------------|
| `acml_vol` | string | 누적 거래량 |
| `acml_tr_pbmn` | string | 누적 거래대금 |
| `prdy_vrss_vol_rate` | string | 전일 대비 거래량 비율 |
| `vol_tnrt` | string | 거래량 회전율 |

#### 투자 지표

| Field | Type | Description |
|-------|------|-------------|
| `per` | string | PER |
| `pbr` | string | PBR |
| `eps` | string | EPS |
| `bps` | string | BPS |
| `hts_avls` | string | HTS 시가총액 |
| `hts_frgn_ehrt` | string | HTS 외국인 소진율 |
| `frgn_ntby_qty` | string | 외국인 순매수 수량 |
| `pgtr_ntby_qty` | string | 프로그램매매 순매수 수량 |

#### 시장 정보

| Field | Type | Description |
|-------|------|-------------|
| `iscd_stat_cls_code` | string | 종목상태구분코드 |
| `rprs_mrkt_kor_name` | string | 대표시장한글명 |
| `bstp_kor_isnm` | string | 업종한글종목명 |
| `temp_stop_yn` | string | 임시정지여부 |
| `crdt_able_yn` | string | 신용가능여부 |
| `marg_rate` | string | 증거금비율 |
| `stck_fcam` | string | 액면가 |
| `lstn_stcn` | string | 상장주수 |
| `cpfn` | string | 자본금 |
| `stac_month` | string | 결산월 |
| `aspr_unit` | string | 호가단위 |

#### 피벗/지지·저항

| Field | Type | Description |
|-------|------|-------------|
| `pvt_scnd_dmrs_prc` | string | 피벗 2차 디저항 가격 |
| `pvt_frst_dmrs_prc` | string | 피벗 1차 디저항 가격 |
| `pvt_pont_val` | string | 피벗 포인트 값 |
| `pvt_frst_dmsp_prc` | string | 피벗 1차 디지지 가격 |
| `pvt_scnd_dmsp_prc` | string | 피벗 2차 디지지 가격 |
| `dmrs_val` | string | 디저항 값 |
| `dmsp_val` | string | 디지지 값 |

#### 250일 기준

| Field | Type | Description |
|-------|------|-------------|
| `d250_hgpr` | string | 250일 최고가 |
| `d250_hgpr_date` | string | 250일 최고가 일자 |
| `d250_hgpr_vrss_prpr_rate` | string | 250일 최고가 대비 현재가 비율 |
| `d250_lwpr` | string | 250일 최저가 |
| `d250_lwpr_date` | string | 250일 최저가 일자 |
| `d250_lwpr_vrss_prpr_rate` | string | 250일 최저가 대비 현재가 비율 |

---

## 주식현재가 일자별 - Daily Stock Price

종목의 일/주/월별 시세를 조회한다.

| 항목 | 값 |
|------|-----|
| API ID | v1_국내주식-010 |
| Method | GET |
| URL | `/uapi/domestic-stock/v1/quotations/inquire-daily-price` |
| TR_ID | `FHKST01010400` (실전/모의 동일) |

### Query Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fid_cond_mrkt_div_code` | string | Yes | 시장구분: `"J"` (주식) |
| `fid_input_iscd` | string | Yes | 종목코드 (6자리) |
| `fid_org_adj_prc` | string | Yes | 수정주가여부: `"0"` 수정주가, `"1"` 원주가 |
| `fid_period_div_code` | string | Yes | 기간구분: `"D"` 일, `"W"` 주, `"M"` 월, `"Y"` 년 |

### Response Output (배열)

| Field | Type | Description |
|-------|------|-------------|
| `stck_bsop_date` | string | 주식영업일자 `YYYYMMDD` |
| `stck_clpr` | string | 종가 |
| `stck_oprc` | string | 시가 |
| `stck_hgpr` | string | 최고가 |
| `stck_lwpr` | string | 최저가 |
| `acml_vol` | string | 누적거래량 |
| `acml_tr_pbmn` | string | 누적거래대금 |
| `prdy_vrss` | string | 전일대비 |
| `prdy_vrss_sign` | string | 전일대비부호 (1:상한, 2:상승, 3:보합, 4:하한, 5:하락) |
| `prdy_ctrt` | string | 전일대비율 (%) |
| `flng_cls_code` | string | 락구분코드 |
| `acml_prtt_rate` | string | 누적분할비율 |

### NestJS 구현 예시

```typescript
async getCurrentPrice(stockCode: string): Promise<KisCurrentPrice> {
  const headers = await this.getAuthHeaders('FHKST01010100');

  const { data } = await firstValueFrom(
    this.httpService.get(
      `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price`,
      {
        headers,
        params: {
          fid_cond_mrkt_div_code: 'J',
          fid_input_iscd: stockCode,
        },
      },
    ),
  );

  return data.output;
}

async getDailyPrice(
  stockCode: string,
  period: 'D' | 'W' | 'M' | 'Y' = 'D',
  adjustedPrice = true,
): Promise<KisDailyPrice[]> {
  const headers = await this.getAuthHeaders('FHKST01010400');

  const { data } = await firstValueFrom(
    this.httpService.get(
      `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-price`,
      {
        headers,
        params: {
          fid_cond_mrkt_div_code: 'J',
          fid_input_iscd: stockCode,
          fid_org_adj_prc: adjustedPrice ? '0' : '1',
          fid_period_div_code: period,
        },
      },
    ),
  );

  return data.output;
}
```

### 참고

- 주/월/년 데이터는 최근 30건까지 조회 가능
- `fid_org_adj_prc`: 수정주가 (`"0"`)는 액면분할 등이 반영된 가격, 원주가 (`"1"`)는 실제 체결 가격
- `prdy_vrss_sign` 부호: 1(상한), 2(상승), 3(보합), 4(하한), 5(하락)
