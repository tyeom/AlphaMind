/** KIS API 공통 응답 */
export interface KisApiResponse<T = any> {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: T;
  output1?: T;
  output2?: any;
}

/** 주문 응답 */
export interface KisOrderOutput {
  KRX_FWDG_ORD_ORGNO: string;
  ODNO: string;
  ORD_TMD: string;
}

/** 잔고 종목 */
export interface KisBalanceItem {
  pdno: string;
  prdt_name: string;
  trad_dvsn_name: string;
  hldg_qty: string;
  ord_psbl_qty: string;
  pchs_avg_pric: string;
  pchs_amt: string;
  prpr: string;
  evlu_amt: string;
  evlu_pfls_amt: string;
  evlu_pfls_rt: string;
  fltt_rt: string;
  bfdy_cprs_icdc: string;
}

/** 잔고 요약 */
export interface KisBalanceSummary {
  dnca_tot_amt: string;
  nxdy_excc_amt: string;
  prvs_rcdl_excc_amt: string;
  scts_evlu_amt: string;
  tot_evlu_amt: string;
  nass_amt: string;
  pchs_amt_smtl_amt: string;
  evlu_amt_smtl_amt: string;
  evlu_pfls_smtl_amt: string;
}

/** 현재가 */
export interface KisCurrentPrice {
  stck_shrn_iscd: string;
  hts_kor_isnm: string;
  stck_prpr: string;
  prdy_vrss: string;
  prdy_vrss_sign: string;
  prdy_ctrt: string;
  stck_oprc: string;
  stck_hgpr: string;
  stck_lwpr: string;
  stck_mxpr: string;
  stck_llam: string;
  acml_vol: string;
  acml_tr_pbmn: string;
  per: string;
  pbr: string;
  eps: string;
  bps: string;
  hts_avls: string;
  hts_frgn_ehrt: string;
  /**
   * 종목 상태 구분 코드
   * - 00: 정상
   * - 51: 관리종목 / 52: 투자위험 / 53: 투자경고 / 54: 투자주의 / 58: 거래정지 / 59: 단기과열종목
   */
  iscd_stat_cls_code: string;
  /**
   * 시장 경고 코드
   * - 00: 없음 / 01: 투자주의 / 02: 투자경고 / 03: 투자위험
   */
  mrkt_warn_cls_code: string;
}

/** 일자별 시세 */
export interface KisDailyPrice {
  stck_bsop_date: string;
  stck_clpr: string;
  stck_oprc: string;
  stck_hgpr: string;
  stck_lwpr: string;
  acml_vol: string;
  acml_tr_pbmn: string;
  prdy_vrss: string;
  prdy_vrss_sign: string;
  prdy_ctrt: string;
}

/** 매수가능 조회 응답 */
export interface KisBuyableOutput {
  ord_psbl_cash: string;
  ord_psbl_sbst: string;
  nrcvb_buy_amt: string;
  nrcvb_buy_qty: string;
  max_buy_amt: string;
  max_buy_qty: string;
}

/** 주문구분 코드 */
export type OrderDivision =
  | '00' // 지정가
  | '01' // 시장가
  | '02' // 조건부지정가
  | '03' // 최유리지정가
  | '04' // 최우선지정가
  | '05' // 장전 시간외
  | '06' // 장후 시간외
  | '07'; // 시간외 단일가

// ── WebSocket 실시간 타입 ──

/** 실시간 구독 가능한 TR_ID */
export type KisRealtimeTrId =
  | 'H0STCNT0' // 실시간 체결가
  | 'H0UNASP0' // 실시간 호가
  | 'H0STCNI0' // 체결통보 (실전)
  | 'H0STCNI9'; // 체결통보 (모의)

/** 실시간 체결가 데이터 */
export interface KisRealtimeExecution {
  stockCode: string;
  time: string;
  price: number;
  changeSign: string;
  change: number;
  changeRate: number;
  weightedAvgPrice: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  askPrice1: number;
  bidPrice1: number;
  executionVolume: number;
  cumulativeVolume: number;
  cumulativeAmount: number;
  executionStrength: number;
  executionType: string;
}

/** 실시간 호가 데이터 */
export interface KisRealtimeOrderbook {
  stockCode: string;
  time: string;
  askPrices: number[];
  bidPrices: number[];
  askVolumes: number[];
  bidVolumes: number[];
  totalAskVolume: number;
  totalBidVolume: number;
  expectedPrice: number;
  expectedVolume: number;
}

/** 실시간 체결통보 데이터 */
export interface KisRealtimeOrderNotification {
  accountNo: string;
  orderNo: string;
  originalOrderNo: string;
  orderType: string;
  modifyType: string;
  stockCode: string;
  executionQty: number;
  executionPrice: number;
  time: string;
  isRejected: boolean;
  isExecuted: boolean;
  orderQty: number;
  stockName: string;
  orderPrice: number;
}

/** 실시간 구독/해제 응답 */
export interface KisRealtimeSubscriptionResult {
  action: 'subscribe' | 'unsubscribe';
  trId: string;
  trKey: string;
  success: boolean;
  code: string;
  message: string;
}

/** 프론트엔드 → 백엔드 WebSocket 메시지 */
export interface WsClientMessage {
  event: 'subscribe' | 'unsubscribe';
  data: {
    type: 'execution' | 'orderbook' | 'notification';
    stockCode: string;
  };
}

/** 백엔드 → 프론트엔드 WebSocket 이벤트 */
export interface WsServerMessage {
  event:
    | 'execution'
    | 'orderbook'
    | 'notification'
    | 'subscribed'
    | 'unsubscribed'
    | 'error';
  data: any;
}
