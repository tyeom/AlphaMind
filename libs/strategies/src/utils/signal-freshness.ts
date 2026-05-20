import type { CandleData, Signal } from '../types/strategy.types';
import { SignalDirection } from '../types/strategy.types';

/** 기본 freshness window — 새벽 8시 스캔이 어제 종가 신호로 오늘 시가 매수까지 활용 */
const DEFAULT_FRESH_SIGNAL_WINDOW_DAYS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type TradingDateLike = Date | { date: Date };

export interface FreshSignalOptions {
  /** fresh 로 인정할 거래일 수. 2면 마지막 봉과 직전 거래일 봉까지 허용. */
  windowDays?: number;
  /** 실제 캔들 날짜 목록. 제공되면 주말/휴장일을 건너뛰는 거래일 기준으로 계산한다. */
  tradingDates?: readonly TradingDateLike[];
}

type FreshSignalWindowArg = number | FreshSignalOptions;

function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toMidnightLocal(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function normalizeOptions(
  options: FreshSignalWindowArg = DEFAULT_FRESH_SIGNAL_WINDOW_DAYS,
): Required<Pick<FreshSignalOptions, 'windowDays'>> &
  Pick<FreshSignalOptions, 'tradingDates'> {
  if (typeof options === 'number') {
    return { windowDays: options };
  }
  return {
    windowDays: options.windowDays ?? DEFAULT_FRESH_SIGNAL_WINDOW_DAYS,
    tradingDates: options.tradingDates,
  };
}

function buildTradingDayIndex(
  tradingDates?: readonly TradingDateLike[],
): Map<string, number> | undefined {
  if (!tradingDates || tradingDates.length === 0) return undefined;
  const keys = Array.from(
    new Set(tradingDates.map((d) => toDateKey(d instanceof Date ? d : d.date))),
  ).sort();
  return new Map(keys.map((key, idx) => [key, idx]));
}

function getFreshDistance(
  signal: Signal,
  lastCandle: CandleData,
  tradingDayIndex?: Map<string, number>,
): number | null {
  const signalKey = toDateKey(signal.date);
  const lastKey = toDateKey(lastCandle.date);

  if (tradingDayIndex) {
    const signalIdx = tradingDayIndex.get(signalKey);
    const lastIdx = tradingDayIndex.get(lastKey);
    if (signalIdx != null && lastIdx != null) {
      return lastIdx - signalIdx;
    }
  }

  const signalDay = toMidnightLocal(signal.date);
  const lastDay = toMidnightLocal(lastCandle.date);
  if (signalDay > lastDay) return -1;
  return Math.round((lastDay - signalDay) / MS_PER_DAY);
}

function isFreshSignalWithIndex(
  signal: Signal,
  lastCandle: CandleData,
  windowDays: number,
  tradingDayIndex?: Map<string, number>,
): boolean {
  const diffDays = getFreshDistance(signal, lastCandle, tradingDayIndex);
  return diffDays != null && diffDays >= 0 && diffDays < windowDays;
}

/**
 * 신호 일자가 lastCandle 일자로부터 windowDays 이내인지 — stale signal 필터.
 * tradingDates 를 넘기면 캘린더일이 아니라 실제 거래일 간격으로 판단한다.
 * windowDays=1 → 신호가 lastCandle 일자와 같은 경우만 fresh.
 * windowDays=2 → 직전 거래일 신호도 fresh (다음 거래일 매수 활용).
 */
export function isFreshSignal(
  signal: Signal,
  lastCandle: CandleData,
  options: FreshSignalWindowArg = DEFAULT_FRESH_SIGNAL_WINDOW_DAYS,
): boolean {
  const opts = normalizeOptions(options);
  return isFreshSignalWithIndex(
    signal,
    lastCandle,
    opts.windowDays,
    buildTradingDayIndex(opts.tradingDates),
  );
}

/**
 * 최근 windowDays 거래일 이내에 발생한 최신 신호를 반환, 없으면 Neutral.
 * currentSignal 은 화면/전략 상태의 "현재 방향" 이므로 강도보다 최신성을 우선한다.
 */
export function pickFreshCurrentSignal(
  signals: Signal[],
  lastCandle: CandleData,
  staleReason = `최근 ${DEFAULT_FRESH_SIGNAL_WINDOW_DAYS}거래일 이내 신호 없음 (stale)`,
  emptyReason = '분석 기간 내 신호 없음',
  options: FreshSignalWindowArg = DEFAULT_FRESH_SIGNAL_WINDOW_DAYS,
): Signal {
  if (signals.length === 0) {
    return {
      direction: SignalDirection.Neutral,
      strength: 0,
      reason: emptyReason,
      date: lastCandle.date,
      price: lastCandle.close,
    };
  }

  const opts = normalizeOptions(options);
  const tradingDayIndex = buildTradingDayIndex(opts.tradingDates);
  for (let i = signals.length - 1; i >= 0; i--) {
    const s = signals[i];
    if (
      isFreshSignalWithIndex(s, lastCandle, opts.windowDays, tradingDayIndex)
    ) {
      return s;
    }
  }

  return {
    direction: SignalDirection.Neutral,
    strength: 0,
    reason: staleReason,
    date: lastCandle.date,
    price: lastCandle.close,
  };
}

/**
 * 스캔 후보 판정처럼 특정 방향만 필요할 때 사용하는 selector.
 * 같은 fresh window 안에서는 지정 방향의 가장 강한 신호를 고르고, 강도가 같으면 더 최근 신호를 유지한다.
 */
export function pickFreshStrongestSignal(
  signals: Signal[],
  lastCandle: CandleData,
  direction: SignalDirection,
  options: FreshSignalWindowArg = DEFAULT_FRESH_SIGNAL_WINDOW_DAYS,
): Signal | undefined {
  const opts = normalizeOptions(options);
  const tradingDayIndex = buildTradingDayIndex(opts.tradingDates);
  let best: Signal | undefined;

  for (let i = signals.length - 1; i >= 0; i--) {
    const s = signals[i];
    if (
      s.direction !== direction ||
      !isFreshSignalWithIndex(s, lastCandle, opts.windowDays, tradingDayIndex)
    ) {
      continue;
    }
    if (!best || s.strength > best.strength) {
      best = s;
    }
  }

  return best;
}
