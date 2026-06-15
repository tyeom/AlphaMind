import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KisQuotationService } from './kis-quotation.service';
import { TossQuotationService } from './toss-quotation.service';
import { KisCurrentPrice, KisDailyPrice } from './kis.types';
import { TossCandle, TossPrice } from './toss.types';

/** 토스 현재가의 체결시각 허용 신선도 (ms). 초과/누락 시 KIS 로 폴백. */
const DEFAULT_TOSS_PRICE_MAX_AGE_MS = 300_000;

/**
 * 시세 조회 파사드.
 *
 * 매매 대상 active 종목의 실시간 체결은 KIS WebSocket 이 담당한다.
 * 그 외 조회 중 **고빈도 경로**(현재가 숫자 폴링, 일봉 차트)는 토스증권 Open API 를
 * 우선 사용해 KIS REST 레이트리밋 부담을 던다. 토스 미설정/실패 시 KIS REST 로 폴백한다.
 *
 * 단, **매매 적격성 판단에 쓰이는 종목 상태/경고 코드**(iscd_stat_cls_code,
 * mrkt_warn_cls_code; 51 관리·54 투자주의 등)는 토스 경고 체계로 무손실 표현이 불가능하므로,
 * 상세 현재가(`getCurrentPrice`)는 KIS 를 권위 소스로 유지한다.
 *
 * 반환 형태는 기존 KIS 응답 형태(KisCurrentPrice/KisDailyPrice)를 유지해
 * 컨트롤러 매핑과 호출부를 그대로 둔다.
 */
@Injectable()
export class QuotationService {
  private readonly logger = new Logger(QuotationService.name);
  /** 토스 폴백 경고 스팸 방지용 쿨다운 (종목별). */
  private readonly tossWarnAt = new Map<string, number>();
  private static readonly WARN_COOLDOWN_MS = 60_000;
  private readonly priceMaxAgeMs: number;

  constructor(
    private readonly toss: TossQuotationService,
    private readonly kis: KisQuotationService,
    private readonly configService: ConfigService,
  ) {
    const raw = Number(
      this.configService.get<number | string>(
        'TOSS_PRICE_MAX_AGE_MS',
        DEFAULT_TOSS_PRICE_MAX_AGE_MS,
      ),
    );
    this.priceMaxAgeMs =
      Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOSS_PRICE_MAX_AGE_MS;
  }

  /**
   * 현재가(숫자)만 필요한 핫패스용 경량 조회.
   * 토스 /prices 1콜 → 실패/미설정/체결시각 미확인·stale 시 KIS 현재가로 폴백.
   *
   * 토스 체결시각(timestamp)을 검증해, 체결 미발생(null)이거나 너무 오래된 값을
   * "신선한 현재가"로 캐싱하지 않는다. 호출부(폴러)가 수신시각으로 stamp 하므로
   * stale 값을 그대로 받으면 TP/SL 판단이 왜곡될 수 있다.
   */
  async getLastPrice(stockCode: string): Promise<number | undefined> {
    if (this.toss.isAvailable()) {
      try {
        const price = await this.toss.getCurrentPrice(stockCode);
        const value = this.freshTossPrice(stockCode, price);
        if (value != null) {
          return value;
        }
      } catch (err) {
        this.warnToss('현재가', stockCode, err);
      }
    }

    try {
      const raw = await this.kis.getCurrentPrice(stockCode);
      const value = Number(raw.stck_prpr);
      return Number.isFinite(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 표시/매매 적격성 판단용 현재가(상세).
   * 종목 상태/경고 코드(51/52/53/54/58/59)를 손실 없이 제공해야 하므로 KIS 를 권위 소스로 둔다.
   * (토스는 51 관리종목·54 투자주의 등에 대응되는 필드가 없어 정상('00')으로 오인될 수 있다.)
   */
  async getCurrentPrice(stockCode: string): Promise<KisCurrentPrice> {
    return this.kis.getCurrentPrice(stockCode);
  }

  /**
   * 일자별 시세.
   * 'D'(일봉)는 토스 캔들(interval=1d)을 사용하고, 토스가 지원하지 않는
   * 'W'/'M'/'Y' 또는 실패 시 KIS REST 로 폴백한다.
   */
  async getDailyPrice(
    stockCode: string,
    period: 'D' | 'W' | 'M' | 'Y' = 'D',
    adjustedPrice = true,
  ): Promise<KisDailyPrice[]> {
    if (period === 'D' && this.toss.isAvailable()) {
      try {
        const candles = await this.toss.getCandles(stockCode, '1d', 100, {
          adjusted: adjustedPrice,
        });
        if (candles.length > 0) {
          return this.mapCandlesToDailyPrice(candles);
        }
      } catch (err) {
        this.warnToss('일봉', stockCode, err);
      }
    }
    return this.kis.getDailyPrice(stockCode, period, adjustedPrice);
  }

  /** 종목명 조회 — 토스 종목정보 → 실패 시 KIS 현재가의 종목명. */
  async getStockName(stockCode: string): Promise<string | undefined> {
    if (this.toss.isAvailable()) {
      try {
        const info = await this.toss.getStockInfo(stockCode);
        const name = info?.name?.trim();
        if (name) return name;
      } catch (err) {
        this.warnToss('종목명', stockCode, err);
      }
    }

    try {
      const raw = await this.kis.getCurrentPrice(stockCode);
      return raw?.hts_kor_isnm?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  // ── 내부 매핑 ──

  /**
   * 토스 현재가가 신선하면 가격(숫자)을, 아니면 undefined 를 반환한다.
   * - lastPrice 가 유효한 양수일 것
   * - timestamp 가 존재(체결 발생)하고 허용 신선도 이내일 것
   */
  private freshTossPrice(
    stockCode: string,
    price: TossPrice | undefined,
  ): number | undefined {
    const value = Number(price?.lastPrice);
    if (!Number.isFinite(value) || value <= 0) {
      return undefined;
    }

    if (!price?.timestamp) {
      this.warnToss('현재가(체결시각 없음)', stockCode, '체결 미발생(timestamp null)');
      return undefined;
    }

    const ts = Date.parse(price.timestamp);
    if (!Number.isFinite(ts)) {
      this.warnToss('현재가(시각 파싱 실패)', stockCode, price.timestamp);
      return undefined;
    }

    const age = Date.now() - ts;
    if (age > this.priceMaxAgeMs) {
      this.warnToss(
        '현재가(stale)',
        stockCode,
        `체결 ${Math.round(age / 1000)}초 경과`,
      );
      return undefined;
    }

    return value;
  }

  private mapCandlesToDailyPrice(candles: TossCandle[]): KisDailyPrice[] {
    // KIS 일자별 시세는 최신순이므로 동일하게 내림차순 정렬한다.
    const sorted = [...candles].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
    );

    return sorted.map((c, i) => {
      const close = Number(c.closePrice);
      const prevClose = sorted[i + 1] ? Number(sorted[i + 1].closePrice) : NaN;
      const change =
        Number.isFinite(prevClose) && prevClose > 0 ? close - prevClose : 0;
      const changeRate =
        Number.isFinite(prevClose) && prevClose > 0
          ? (change / prevClose) * 100
          : 0;
      const sign = change > 0 ? '2' : change < 0 ? '5' : '3';

      return {
        stck_bsop_date: c.timestamp.slice(0, 10).replace(/-/g, ''),
        stck_clpr: c.closePrice,
        stck_oprc: c.openPrice,
        stck_hgpr: c.highPrice,
        stck_lwpr: c.lowPrice,
        acml_vol: c.volume,
        acml_tr_pbmn: '0',
        prdy_vrss: String(change),
        prdy_vrss_sign: sign,
        prdy_ctrt: changeRate.toFixed(2),
      };
    });
  }

  private warnToss(kind: string, stockCode: string, err: unknown): void {
    const now = Date.now();
    const last = this.tossWarnAt.get(stockCode) ?? 0;
    if (now - last < QuotationService.WARN_COOLDOWN_MS) {
      return;
    }
    this.tossWarnAt.set(stockCode, now);
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn(
      `토스 ${kind} 조회 실패 → KIS 폴백: ${stockCode} - ${message}`,
    );
  }
}
