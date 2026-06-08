import type { KisRealtimeExecution } from '../kis/kis.types';

export const DEFAULT_VI_HANDLING_ENABLED = false;
export const DEFAULT_VI_CLEAR_TIMEOUT_MS = 150_000;
export const DEFAULT_VI_LIMIT_NEAR_PCT = 29.5;
export const DEFAULT_VI_STOPLOSS_LIMIT_ORDER = true;
export const DEFAULT_VI_REEVAL_DEBOUNCE_MS = 1_000;
export const DEFAULT_NXT_HANDLING_ENABLED = false;

const KIS_TIME_DIGIT_LENGTH = 6;
export const KRX_OPEN_AUCTION_START_HHMMSS = '083000';
export const KRX_OPEN_AUCTION_END_HHMMSS = '090000';
export const KRX_CLOSE_AUCTION_START_HHMMSS = '152000';
export const KRX_CLOSE_AUCTION_END_HHMMSS = '153000';
export const KRX_REGULAR_AUCTION_HOUR_CLS_CODES = new Set(['A', 'B', 'D']);

// TODO(KIS): NEW_MKOP_CLS_CODE 의 VI 단일가 코드값은 현재 레퍼런스에 없다.
// 페이퍼에서 원시값을 확인하기 전까지는 비워 두고, VI active 판정은 f35 거래정지만 신뢰한다.
export const VI_SINGLE_PRICE_MKOP_CODES = new Set<string>();

export type ViStateSource = 'none' | 'trading-halt' | 'single-price-auction';

export interface ViJudgmentInput {
  time?: string;
  price?: number;
  changeRate?: number;
  newMkopClsCode?: string;
  tradingHalt?: boolean;
  hourClsCode?: string;
  viStndPrc?: number;
}

export interface ViJudgment {
  isViActive: boolean;
  source: ViStateSource;
  tradingHalt: boolean;
  singlePriceAuction: boolean;
  regularAuction: boolean;
  limitNear: boolean;
  reason: string;
}

export interface ViState extends ViJudgment {
  stockCode: string;
  since?: number;
  lastSeen: number;
  activeUntil?: number;
  lastPrice?: number;
  newMkopClsCode?: string;
  hourClsCode?: string;
  viStndPrc?: number;
}

export interface ViStateTrackerConfig {
  clearTimeoutMs: number;
  limitNearPct: number;
  now: () => number;
}

function normalizeKisTime(time?: string): string | undefined {
  const digits = time?.replace(/\D/g, '') ?? '';
  if (digits.length < KIS_TIME_DIGIT_LENGTH) return undefined;
  return digits.slice(0, KIS_TIME_DIGIT_LENGTH);
}

function isTimeInRange(time: string, start: string, end: string): boolean {
  return time >= start && time <= end;
}

export function isRegularSinglePriceAuction(
  hourClsCode?: string,
  time?: string,
): boolean {
  const normalizedHourClsCode = hourClsCode?.trim().toUpperCase();
  if (
    normalizedHourClsCode &&
    KRX_REGULAR_AUCTION_HOUR_CLS_CODES.has(normalizedHourClsCode)
  ) {
    return true;
  }

  const normalizedTime = normalizeKisTime(time);
  if (!normalizedTime) return false;

  return (
    isTimeInRange(
      normalizedTime,
      KRX_OPEN_AUCTION_START_HHMMSS,
      KRX_OPEN_AUCTION_END_HHMMSS,
    ) ||
    isTimeInRange(
      normalizedTime,
      KRX_CLOSE_AUCTION_START_HHMMSS,
      KRX_CLOSE_AUCTION_END_HHMMSS,
    )
  );
}

export function judgeViStatus(
  input: ViJudgmentInput,
  limitNearPct = DEFAULT_VI_LIMIT_NEAR_PCT,
): ViJudgment {
  try {
    const tradingHalt = input.tradingHalt === true;
    const regularAuction = isRegularSinglePriceAuction(
      input.hourClsCode,
      input.time,
    );
    const mkopCode = input.newMkopClsCode?.trim();
    const singlePriceAuction =
      mkopCode != null &&
      VI_SINGLE_PRICE_MKOP_CODES.has(mkopCode) &&
      !regularAuction;
    const changeRate = Number(input.changeRate);
    const limitNear =
      Number.isFinite(changeRate) && Math.abs(changeRate) >= limitNearPct;

    if (tradingHalt) {
      return {
        isViActive: true,
        source: 'trading-halt',
        tradingHalt,
        singlePriceAuction,
        regularAuction,
        limitNear,
        reason: '거래정지 필드 감지',
      };
    }

    if (singlePriceAuction) {
      return {
        isViActive: true,
        source: 'single-price-auction',
        tradingHalt,
        singlePriceAuction,
        regularAuction,
        limitNear,
        reason: 'VI 단일가 코드 감지',
      };
    }

    return {
      isViActive: false,
      source: 'none',
      tradingHalt,
      singlePriceAuction,
      regularAuction,
      limitNear,
      reason: regularAuction ? '정규 단일가 구간 제외' : 'VI 감지 없음',
    };
  } catch {
    return {
      isViActive: false,
      source: 'none',
      tradingHalt: false,
      singlePriceAuction: false,
      regularAuction: false,
      limitNear: false,
      reason: 'VI 판정 실패 - fail-safe',
    };
  }
}

export class ViStateTracker {
  private readonly states = new Map<string, ViState>();
  private readonly config: ViStateTrackerConfig;

  constructor(config?: Partial<ViStateTrackerConfig>) {
    this.config = {
      clearTimeoutMs: config?.clearTimeoutMs ?? DEFAULT_VI_CLEAR_TIMEOUT_MS,
      limitNearPct: config?.limitNearPct ?? DEFAULT_VI_LIMIT_NEAR_PCT,
      now: config?.now ?? Date.now,
    };
  }

  updateFromExecution(execution: KisRealtimeExecution): ViState {
    const now = this.config.now();
    const judgment = judgeViStatus(execution, this.config.limitNearPct);
    const previous = this.states.get(execution.stockCode);
    const since =
      judgment.isViActive && previous?.isViActive ? previous.since : now;

    const state: ViState = {
      ...judgment,
      stockCode: execution.stockCode,
      since: judgment.isViActive ? since : undefined,
      lastSeen: now,
      activeUntil: judgment.isViActive
        ? now + this.config.clearTimeoutMs
        : undefined,
      lastPrice: execution.price,
      newMkopClsCode: execution.newMkopClsCode,
      hourClsCode: execution.hourClsCode,
      viStndPrc: execution.viStndPrc,
    };

    this.states.set(execution.stockCode, state);
    return state;
  }

  getState(stockCode: string): ViState | undefined {
    return this.states.get(stockCode);
  }

  isActive(stockCode: string): boolean {
    return this.states.get(stockCode)?.isViActive === true;
  }

  clearStock(stockCode: string): void {
    this.states.delete(stockCode);
  }

  clearAll(): void {
    this.states.clear();
  }
}
