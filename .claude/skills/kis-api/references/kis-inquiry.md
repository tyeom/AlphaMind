# KIS Account Inquiry APIs (계좌 조회)

## 주식잔고조회 - Stock Balance Inquiry

보유 주식 종목별 잔고와 계좌 총 평가 정보를 조회한다.

| 항목 | 값 |
|------|-----|
| API ID | v1_국내주식-006 |
| Method | GET |
| URL | `/uapi/domestic-stock/v1/trading/inquire-balance` |

### TR_ID

| 실전 | 모의 |
|------|------|
| `TTTC8434R` | `VTTC8434R` |

### Query Parameters

| Field | Type | Required | Length | Description |
|-------|------|----------|--------|-------------|
| `CANO` | string | Yes | 8 | 종합계좌번호 (앞 8자리) |
| `ACNT_PRDT_CD` | string | Yes | 2 | 계좌상품코드 (뒤 2자리) |
| `AFHR_FLPR_YN` | string | Yes | 1 | 시간외단일가여부: `"N"` 기본 |
| `OFL_YN` | string | No | 1 | 오프라인여부: 공백 |
| `INQR_DVSN` | string | Yes | 2 | 조회구분: `"01"` 대출일별, `"02"` 종목별 |
| `UNPR_DVSN` | string | Yes | 2 | 단가구분: `"01"` |
| `FUND_STTL_ICLD_YN` | string | Yes | 1 | 펀드결제분포함여부: `"N"` |
| `FNCG_AMT_AUTO_RDPT_YN` | string | Yes | 1 | 융자금액자동상환여부: `"N"` |
| `PRCS_DVSN` | string | No | 2 | 처리구분: `"00"` 전일매매포함, `"01"` 전일매매미포함 |
| `CTX_AREA_FK100` | string | No | 100 | 연속조회검색조건 (초회 공백) |
| `CTX_AREA_NK100` | string | No | 100 | 연속조회키 (초회 공백) |

### Response - output1 (보유 종목 배열)

| Field | Type | Description |
|-------|------|-------------|
| `pdno` | string | 종목번호 (6자리) |
| `prdt_name` | string | 종목명 |
| `trad_dvsn_name` | string | 매매구분명 |
| `bfdy_buy_qty` | string | 전일매수수량 |
| `bfdy_sll_qty` | string | 전일매도수량 |
| `thdt_buyqty` | string | 금일매수수량 |
| `thdt_sll_qty` | string | 금일매도수량 |
| `hldg_qty` | string | 보유수량 |
| `ord_psbl_qty` | string | 주문가능수량 |
| `pchs_avg_pric` | string | 매입평균가격 |
| `pchs_amt` | string | 매입금액 |
| `prpr` | string | 현재가 |
| `evlu_amt` | string | 평가금액 |
| `evlu_pfls_amt` | string | 평가손익금액 |
| `evlu_pfls_rt` | string | 평가손익율 (%) |
| `loan_dt` | string | 대출일자 |
| `loan_amt` | string | 대출금액 |
| `fltt_rt` | string | 등락율 |
| `bfdy_cprs_icdc` | string | 전일대비증감 |
| `item_mgna_rt_name` | string | 종목증거금율명 |
| `sbst_pric` | string | 대용가격 |
| `stck_loan_unpr` | string | 주식대출단가 |

### Response - output2 (계좌 요약 배열)

| Field | Type | Description |
|-------|------|-------------|
| `dnca_tot_amt` | string | 예수금총금액 (D+0) |
| `nxdy_excc_amt` | string | 익일정산금액 (D+1) |
| `prvs_rcdl_excc_amt` | string | 가수도정산금액 (D+2) |
| `cma_evlu_amt` | string | CMA평가금액 |
| `bfdy_buy_amt` | string | 전일매수금액 |
| `thdt_buy_amt` | string | 금일매수금액 |
| `bfdy_sll_amt` | string | 전일매도금액 |
| `thdt_sll_amt` | string | 금일매도금액 |
| `tot_loan_amt` | string | 총대출금액 |
| `scts_evlu_amt` | string | 유가평가금액 |
| `tot_evlu_amt` | string | 총평가금액 (유가 + D+2 예수금) |
| `nass_amt` | string | 순자산금액 |
| `pchs_amt_smtl_amt` | string | 매입금액합계 |
| `evlu_amt_smtl_amt` | string | 평가금액합계 |
| `evlu_pfls_smtl_amt` | string | 평가손익합계 |
| `bfdy_tot_asst_evlu_amt` | string | 전일총자산평가금액 |
| `asst_icdc_amt` | string | 자산증감액 |

### Pagination

- 실전: 1회 최대 50건, 모의: 1회 최대 20건
- `tr_cont` 헤더와 `CTX_AREA_FK100`, `CTX_AREA_NK100`으로 연속조회

---

## 매수가능조회 - Buyable Amount Inquiry

특정 종목의 매수 가능 금액/수량을 조회한다.

| 항목 | 값 |
|------|-----|
| API ID | v1_국내주식-007 |
| Method | GET |
| URL | `/uapi/domestic-stock/v1/trading/inquire-psbl-order` |

### TR_ID

| 실전 | 모의 |
|------|------|
| `TTTC8908R` | `VTTC8908R` |

### Query Parameters

| Field | Type | Required | Length | Description |
|-------|------|----------|--------|-------------|
| `CANO` | string | Yes | 8 | 종합계좌번호 |
| `ACNT_PRDT_CD` | string | Yes | 2 | 계좌상품코드 |
| `PDNO` | string | Yes | 12 | 종목코드 (금액만 조회 시 공백) |
| `ORD_UNPR` | string | Yes | 19 | 주문단가 (금액만 조회 시 공백) |
| `ORD_DVSN` | string | Yes | 2 | 주문구분: `"01"` 시장가 권장 |
| `CMA_EVLU_AMT_ICLD_YN` | string | Yes | 1 | CMA평가금액포함여부: `"Y"` |
| `OVRS_ICLD_YN` | string | Yes | 1 | 해외포함여부: `"N"` |

### Response Output

| Field | Type | Description |
|-------|------|-------------|
| `ord_psbl_cash` | string | 주문가능현금 |
| `ord_psbl_sbst` | string | 주문가능대용 |
| `ruse_psbl_amt` | string | 재사용가능금액 |
| `psbl_qty_calc_unpr` | string | 가능수량계산단가 |
| `nrcvb_buy_amt` | string | 미수없는매수금액 |
| `nrcvb_buy_qty` | string | 미수없는매수수량 |
| `max_buy_amt` | string | 최대매수금액 (미수 포함) |
| `max_buy_qty` | string | 최대매수수량 (미수 포함) |
| `cma_evlu_amt` | string | CMA평가금액 |
| `ovrs_re_use_amt_wcrc` | string | 해외재사용금액원화 |

### 참고

- 종목별 매수가능수량 조회 시 `ORD_DVSN`을 `"01"` (시장가)로 해야 종목 증거금율이 반영됨
- `nrcvb_buy_qty`: 미수 없이 매수 가능한 수량 (안전)
- `max_buy_qty`: 미수 포함 최대 매수 가능 수량

---

## 매도가능수량조회 - Sellable Quantity Inquiry

보유 종목의 매도 가능 수량을 조회한다.

| 항목 | 값 |
|------|-----|
| API ID | 국내주식-165 |
| Method | GET |
| URL | `/uapi/domestic-stock/v1/trading/inquire-psbl-sell` |
| TR_ID | `TTTC8408R` (모의투자 미지원) |

### Query Parameters

| Field | Type | Required | Length | Description |
|-------|------|----------|--------|-------------|
| `CANO` | string | Yes | 8 | 종합계좌번호 |
| `ACNT_PRDT_CD` | string | Yes | 2 | 계좌상품코드 |
| `PDNO` | string | Yes | 12 | 종목코드 |

### Response - output1

| Field | Type | Description |
|-------|------|-------------|
| `pdno` | string | 종목번호 |
| `prdt_name` | string | 종목명 |
| `buy_qty` | string | 매수수량 |
| `sll_qty` | string | 매도수량 |
| `cblc_qty` | string | 잔고수량 |
| `ord_psbl_qty` | string | 주문가능수량 |
| `pchs_avg_pric` | string | 매입평균가격 |
| `pchs_amt` | string | 매입금액 |
| `now_pric` | string | 현재가 |
| `evlu_amt` | string | 평가금액 |
| `evlu_pfls_amt` | string | 평가손익금액 |
| `evlu_pfls_rt` | string | 평가손익율 |

---

## 주식일별주문체결조회 - Daily Order Execution History

일별 주문/체결 내역을 조회한다.

| 항목 | 값 |
|------|-----|
| API ID | v1_국내주식-005 |
| Method | GET |
| URL | `/uapi/domestic-stock/v1/trading/inquire-daily-ccld` |

### TR_ID

| 구분 | 실전 | 모의 |
|------|------|------|
| 3개월 이내 | `TTTC0081R` | `VTTC0081R` |
| 3개월 이전 | `CTSC9215R` | `VTSC9215R` |

### Query Parameters

| Field | Type | Required | Length | Description |
|-------|------|----------|--------|-------------|
| `CANO` | string | Yes | 8 | 종합계좌번호 |
| `ACNT_PRDT_CD` | string | Yes | 2 | 계좌상품코드 |
| `INQR_STRT_DT` | string | Yes | 8 | 조회시작일 `YYYYMMDD` |
| `INQR_END_DT` | string | Yes | 8 | 조회종료일 `YYYYMMDD` |
| `SLL_BUY_DVSN_CD` | string | Yes | 2 | `"00"` 전체, `"01"` 매도, `"02"` 매수 |
| `INQR_DVSN` | string | Yes | 2 | `"00"` 역순, `"01"` 정순 |
| `PDNO` | string | No | 12 | 종목코드 (공백=전체) |
| `CCLD_DVSN` | string | Yes | 2 | `"00"` 전체, `"01"` 체결, `"02"` 미체결 |
| `ORD_GNO_BRNO` | string | No | 5 | 주문채번지점번호 (공백) |
| `ODNO` | string | No | 10 | 주문번호 (공백=전체) |
| `INQR_DVSN_3` | string | Yes | 2 | `"00"` 전체, `"01"` 현금, `"02"` 융자, `"03"` 대출 |
| `INQR_DVSN_1` | string | No | 1 | 공백 |
| `CTX_AREA_FK100` | string | No | 100 | 연속조회검색조건 |
| `CTX_AREA_NK100` | string | No | 100 | 연속조회키 |

### Pagination

- 실전: 1회 최대 100건, 모의: 1회 최대 15건
- 3개월 이전 조회: 장 마감 후 (15:30 이후) 조회 권장, 짧은 기간 단위로 조회
