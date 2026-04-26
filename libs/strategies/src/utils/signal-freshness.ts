import type { CandleData, Signal } from '../types/strategy.types';
import { SignalDirection } from '../types/strategy.types';

/**
 * 신호 일자(YYYY-MM-DD)가 lastCandle 일자와 같은지 — stale signal 필터 기준.
 * 일봉 기반 단타에서는 "오늘 신호"만 신뢰 가능하고, 며칠 전 신호는 시장 상황이 바뀌어
 * 진입 시점 alpha 가 사라진다. 새벽 8시 자동 스캔이 stale signal 로 매수하지 못하게 막는다.
 */
export function isFreshSignal(signal: Signal, lastCandle: CandleData): boolean {
  const a = signal.date;
  const b = lastCandle.date;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 마지막 신호가 lastCandle 일자에 발생했으면 반환, 아니면 Neutral.
 * 모든 단기 전략의 currentSignal 산출에 공통 적용.
 */
export function pickFreshCurrentSignal(
  signals: Signal[],
  lastCandle: CandleData,
  staleReason = '최근 1거래일 이내 신호 없음 (stale)',
  emptyReason = '분석 기간 내 신호 없음',
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
  const last = signals[signals.length - 1];
  if (isFreshSignal(last, lastCandle)) {
    return last;
  }
  return {
    direction: SignalDirection.Neutral,
    strength: 0,
    reason: staleReason,
    date: lastCandle.date,
    price: lastCandle.close,
  };
}
