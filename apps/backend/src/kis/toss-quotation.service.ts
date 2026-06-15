import { Injectable } from '@nestjs/common';
import { TossService } from './toss.service';
import {
  TossCandle,
  TossCandlePage,
  TossOrderbook,
  TossPrice,
  TossPriceLimit,
  TossStockInfo,
  TossStockWarning,
} from './toss.types';

/** 캔들 봉 단위. */
export type TossCandleInterval = '1m' | '1d';

/**
 * 토스증권 시세 조회 클라이언트.
 * 현재가/캔들/호가/상하한가/종목정보/경고를 조회한다.
 * 단일 종목 조회 헬퍼를 제공하며, 응답은 원본 토스 타입 그대로 반환한다.
 */
@Injectable()
export class TossQuotationService {
  constructor(private readonly toss: TossService) {}

  isConfigured(): boolean {
    return this.toss.isConfigured();
  }

  /** 시세 조회 가능 여부 — 키 설정 + 인증 서킷 브레이커 닫힘. 핫패스 폴백 판단에 쓴다. */
  isAvailable(): boolean {
    return this.toss.isAvailable();
  }

  /** 현재가 조회. 단일 종목. */
  async getCurrentPrice(symbol: string): Promise<TossPrice | undefined> {
    const result = await this.toss.get<TossPrice[]>(
      '/api/v1/prices',
      'MARKET_DATA',
      { symbols: symbol },
    );
    return result?.[0];
  }

  /** 복수 종목 현재가 조회 (최대 200). */
  async getCurrentPrices(symbols: string[]): Promise<TossPrice[]> {
    if (symbols.length === 0) return [];
    return this.toss.get<TossPrice[]>('/api/v1/prices', 'MARKET_DATA', {
      symbols: symbols.join(','),
    });
  }

  /**
   * 캔들 차트 조회.
   * @param count 최대 200
   * @param before 페이지네이션 상한 (exclusive, ISO 8601)
   */
  async getCandles(
    symbol: string,
    interval: TossCandleInterval,
    count = 100,
    options?: { before?: string; adjusted?: boolean },
  ): Promise<TossCandle[]> {
    const page = await this.toss.get<TossCandlePage>(
      '/api/v1/candles',
      'MARKET_DATA_CHART',
      {
        symbol,
        interval,
        count,
        before: options?.before,
        adjusted: options?.adjusted,
      },
    );
    return page?.candles ?? [];
  }

  /** 호가 조회. */
  async getOrderbook(symbol: string): Promise<TossOrderbook> {
    return this.toss.get<TossOrderbook>('/api/v1/orderbook', 'MARKET_DATA', {
      symbol,
    });
  }

  /** 상/하한가 조회. */
  async getPriceLimits(symbol: string): Promise<TossPriceLimit> {
    return this.toss.get<TossPriceLimit>(
      '/api/v1/price-limits',
      'MARKET_DATA',
      { symbol },
    );
  }

  /** 종목 기본 정보 조회. 단일 종목. */
  async getStockInfo(symbol: string): Promise<TossStockInfo | undefined> {
    const result = await this.toss.get<TossStockInfo[]>(
      '/api/v1/stocks',
      'STOCK',
      { symbols: symbol },
    );
    return result?.[0];
  }

  /** 종목 유의사항(경고) 조회. */
  async getWarnings(symbol: string): Promise<TossStockWarning[]> {
    return this.toss.get<TossStockWarning[]>(
      `/api/v1/stocks/${encodeURIComponent(symbol)}/warnings`,
      'STOCK',
    );
  }
}
