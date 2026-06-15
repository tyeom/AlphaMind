// 토스증권 Open API (doc/tossinvest-open-api.json) 응답 타입.
// 시세(현재가/차트/호가/상하한가/종목정보) 조회 전용 — 주문/잔고는 KIS 를 그대로 사용한다.

/** 통화 코드. unknown enum 허용. */
export type TossCurrency = 'KRW' | 'USD' | (string & {});

/** 성공 응답 envelope. 200 응답은 result 에 실제 payload 를 담는다. */
export interface TossApiResponse<T> {
  result: T;
}

/** OAuth2 토큰 발급 응답 (envelope 미사용, OAuth2 표준 형식). */
export interface TossOAuth2TokenResponse {
  access_token: string;
  /** 항상 'Bearer'. */
  token_type: string;
  /** 만료까지 남은 초. */
  expires_in: number;
}

/** 현재가 (GET /api/v1/prices). */
export interface TossPrice {
  symbol: string;
  /** 데이터 시각. 체결 미발생 시 null. ISO 8601. */
  timestamp: string | null;
  /** 현재가 (decimal 문자열). */
  lastPrice: string;
  currency: TossCurrency;
}

/** 캔들 1봉 (GET /api/v1/candles). 모든 값은 decimal 문자열. */
export interface TossCandle {
  /** 봉 시작 시각 (ISO 8601). */
  timestamp: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
  currency: TossCurrency;
}

/** 캔들 페이지 응답. */
export interface TossCandlePage {
  candles: TossCandle[];
  /** 다음 페이지 조회용 before 값. 마지막 페이지면 null. */
  nextBefore: string | null;
}

/** 호가 1단계. */
export interface TossOrderbookEntry {
  price: string;
  volume: string;
}

/** 호가 (GET /api/v1/orderbook). */
export interface TossOrderbook {
  timestamp: string | null;
  currency: TossCurrency;
  /** 매도호가 (낮은 가격순). */
  asks: TossOrderbookEntry[];
  /** 매수호가 (높은 가격순). */
  bids: TossOrderbookEntry[];
}

/** 상/하한가 (GET /api/v1/price-limits). */
export interface TossPriceLimit {
  timestamp: string;
  /** 상한가. 가격제한 없는 시장(미국 등)은 null. */
  upperLimitPrice: string | null;
  /** 하한가. 가격제한 없는 시장(미국 등)은 null. */
  lowerLimitPrice: string | null;
  currency: TossCurrency;
}

/** 한국 시장 상세. */
export interface TossKrMarketDetail {
  liquidationTrading: boolean;
  nxtSupported: boolean;
  krxTradingSuspended: boolean;
  nxtTradingSuspended: boolean | null;
}

/** 종목 기본 정보 (GET /api/v1/stocks). */
export interface TossStockInfo {
  symbol: string;
  name: string;
  englishName: string;
  isinCode: string;
  market: 'KOSPI' | 'KOSDAQ' | 'NYSE' | 'NASDAQ' | 'AMEX' | 'KR_ETC' | 'US_ETC';
  securityType: string;
  isCommonShare: boolean;
  status: 'SCHEDULED' | 'ACTIVE' | 'DELISTED';
  currency: TossCurrency;
  sharesOutstanding: string;
  /** 국내 종목(KOSPI/KOSDAQ/KR_ETC)에만 제공, 해외 종목은 null. */
  koreanMarketDetail?: TossKrMarketDetail | null;
}

/** 종목 유의사항 유형. unknown code 허용. */
export type TossWarningType =
  | 'LIQUIDATION_TRADING'
  | 'OVERHEATED'
  | 'INVESTMENT_WARNING'
  | 'INVESTMENT_RISK'
  | 'VI_STATIC_AND_DYNAMIC'
  | 'VI_STATIC'
  | 'VI_DYNAMIC'
  | 'STOCK_WARRANTS'
  | (string & {});

/** 종목 경고 (GET /api/v1/stocks/{symbol}/warnings). */
export interface TossStockWarning {
  warningType: TossWarningType;
  exchange: string | null;
  startDate: string | null;
  endDate: string | null;
}
