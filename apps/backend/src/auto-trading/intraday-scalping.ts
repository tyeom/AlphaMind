import { KisRealtimeExecution } from '../kis/kis.types';

const DEFAULT_MAX_CANDLES = 60;
const DEFAULT_MIN_COMPLETED_CANDLES = 5;
const DEFAULT_MAX_TICK_AGE_MS = 90_000;
const DEFAULT_ENTRY_START_TIME = '090500';
const DEFAULT_ENTRY_END_TIME = '145000';
const DEFAULT_MIN_EXECUTION_STRENGTH = 100;
const DEFAULT_MAX_SPREAD_PCT = 0.35;
const DEFAULT_MIN_VOLUME_RATIO = 1.0;
const DEFAULT_MAX_VWAP_PREMIUM_PCT = 2.0;
const DEFAULT_MAX_DAILY_GAIN_PCT = 10;
const DEFAULT_MIN_CONFIRMATIONS = 3;

export interface IntradayScalpingOptions {
  maxCandles: number;
  minCompletedCandles: number;
  maxTickAgeMs: number;
  entryStartTime: string;
  entryEndTime: string;
  minExecutionStrength: number;
  maxSpreadPct: number;
  minVolumeRatio: number;
  maxVwapPremiumPct: number;
  maxDailyGainPct: number;
  minConfirmations: number;
}

export interface IntradayMinuteCandle {
  minute: number;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IntradayScalpingDecision {
  shouldBuy: boolean;
  reason: string;
  completedCandles: number;
  metrics?: {
    fastSma: number;
    slowSma: number;
    volumeRatio: number;
    executionStrength: number;
    spreadPct: number;
    vwapPremiumPct: number;
    confirmations: number;
  };
}

interface IntradayStockState {
  current?: IntradayMinuteCandle;
  completed: IntradayMinuteCandle[];
  latestExecution?: KisRealtimeExecution;
  latestReceivedAt?: number;
  lastExecutionTime?: string;
}

export const DEFAULT_INTRADAY_SCALPING_OPTIONS: IntradayScalpingOptions = {
  maxCandles: DEFAULT_MAX_CANDLES,
  minCompletedCandles: DEFAULT_MIN_COMPLETED_CANDLES,
  maxTickAgeMs: DEFAULT_MAX_TICK_AGE_MS,
  entryStartTime: DEFAULT_ENTRY_START_TIME,
  entryEndTime: DEFAULT_ENTRY_END_TIME,
  minExecutionStrength: DEFAULT_MIN_EXECUTION_STRENGTH,
  maxSpreadPct: DEFAULT_MAX_SPREAD_PCT,
  minVolumeRatio: DEFAULT_MIN_VOLUME_RATIO,
  maxVwapPremiumPct: DEFAULT_MAX_VWAP_PREMIUM_PCT,
  maxDailyGainPct: DEFAULT_MAX_DAILY_GAIN_PCT,
  minConfirmations: DEFAULT_MIN_CONFIRMATIONS,
};

/**
 * KIS 실시간 체결 데이터를 종목별 완성 1분봉으로 집계한다.
 *
 * 현재 진행 중인 봉은 매수 신호에 사용하지 않는다. 다음 분의 첫 체결이 들어와
 * 이전 봉이 확정된 뒤에만 평가해, 봉 중간 값이 바뀌면서 신호가 뒤집히는 문제를 막는다.
 */
export class IntradayScalpingTracker {
  private readonly states = new Map<string, IntradayStockState>();
  private readonly options: IntradayScalpingOptions;

  constructor(options: Partial<IntradayScalpingOptions> = {}) {
    this.options = {
      ...DEFAULT_INTRADAY_SCALPING_OPTIONS,
      ...options,
    };
  }

  record(
    execution: KisRealtimeExecution,
    receivedAt: number = Date.now(),
  ): void {
    if (!Number.isFinite(execution.price) || execution.price <= 0) {
      return;
    }

    const normalizedTime = normalizeExecutionTime(execution.time);
    const minute = toSessionMinute(normalizedTime);
    if (minute == null) return;

    const state = this.states.get(execution.stockCode) ?? {
      completed: [],
    };

    // 장이 바뀌면 15시대 봉 뒤에 다시 09시대 체결이 들어온다.
    // 몇 초 늦게 도착한 체결은 무시하고, 시간이 크게 되감긴 경우만 일자 전환으로 본다.
    if (
      state.lastExecutionTime != null &&
      normalizedTime < state.lastExecutionTime
    ) {
      const currentMinute = state.current?.minute;
      if (currentMinute == null || currentMinute - minute < 120) {
        return;
      }
      state.current = undefined;
      state.completed = [];
    }

    // 정규장 외 체결/거래정지는 봉에는 넣지 않되 최신 상태로 보존한다.
    // 그래야 직전 정상 체결을 재사용해 정지 중 매수하는 사고를 막을 수 있다.
    if (execution.hourClsCode !== '0' || execution.tradingHalt) {
      state.latestExecution = execution;
      state.latestReceivedAt = receivedAt;
      state.lastExecutionTime = normalizedTime;
      this.states.set(execution.stockCode, state);
      return;
    }

    if (state.current == null) {
      state.current = createCandle(minute, normalizedTime, execution);
    } else if (minute === state.current.minute) {
      updateCandle(state.current, normalizedTime, execution);
    } else if (minute > state.current.minute) {
      state.completed.push(state.current);
      if (state.completed.length > this.options.maxCandles) {
        state.completed.splice(
          0,
          state.completed.length - this.options.maxCandles,
        );
      }
      state.current = createCandle(minute, normalizedTime, execution);
    } else {
      // 지연 도착한 과거 체결은 이미 확정된 OHLCV를 오염시키므로 무시한다.
      return;
    }

    state.latestExecution = execution;
    state.latestReceivedAt = receivedAt;
    state.lastExecutionTime = normalizedTime;
    this.states.set(execution.stockCode, state);
  }

  evaluate(
    stockCode: string,
    now: number = Date.now(),
  ): IntradayScalpingDecision {
    const state = this.states.get(stockCode);
    const completedCandles = state?.completed.length ?? 0;
    const execution = state?.latestExecution;

    if (!state || !execution || state.latestReceivedAt == null) {
      return reject('실시간 체결 데이터 없음', completedCandles);
    }
    if (now - state.latestReceivedAt > this.options.maxTickAgeMs) {
      return reject('실시간 체결 데이터 지연', completedCandles);
    }

    const time = normalizeExecutionTime(execution.time);
    if (
      time < this.options.entryStartTime ||
      time > this.options.entryEndTime
    ) {
      return reject('스켈핑 진입 허용 시간 아님', completedCandles);
    }
    if (execution.tradingHalt || execution.hourClsCode !== '0') {
      return reject('정규장 체결 상태 아님', completedCandles);
    }
    if (completedCandles < this.options.minCompletedCandles) {
      return reject('완성된 1분봉 부족', completedCandles);
    }

    const recent = state.completed.slice(-this.options.minCompletedCandles);
    const latest = recent[recent.length - 1];
    const fastSma = average(recent.slice(-3).map((c) => c.close));
    const slowSma = average(recent.slice(-5).map((c) => c.close));
    const previousVolumes = recent.slice(0, -1).map((c) => c.volume);
    const volumeAverage = average(previousVolumes);
    const volumeRatio = volumeAverage > 0 ? latest.volume / volumeAverage : 0;

    const ask = execution.askPrice1;
    const bid = execution.bidPrice1;
    if (ask <= 0 || bid <= 0 || ask < bid) {
      return reject('유효한 매수/매도 1호가 없음', completedCandles);
    }
    const spreadMid = (ask + bid) / 2;
    const spreadPct = spreadMid > 0 ? ((ask - bid) / spreadMid) * 100 : 100;
    if (spreadPct > this.options.maxSpreadPct) {
      return reject('호가 스프레드 과다', completedCandles);
    }

    const vwap = execution.weightedAvgPrice;
    if (!Number.isFinite(vwap) || vwap <= 0) {
      return reject('유효한 VWAP 없음', completedCandles);
    }
    const vwapPremiumPct = ((execution.price - vwap) / vwap) * 100;
    if (vwapPremiumPct < 0 || vwapPremiumPct > this.options.maxVwapPremiumPct) {
      return reject('VWAP 상단 진입 범위 이탈', completedCandles);
    }
    if (execution.changeRate > this.options.maxDailyGainPct) {
      return reject('당일 급등 추격 제한', completedCandles);
    }

    // Step 1. 완성 봉 기준 단기 추세가 상승 중이어야 한다.
    const trendUp = fastSma > slowSma && latest.close > fastSma;
    if (!trendUp) {
      return reject('1분봉 단기 상승 추세 미충족', completedCandles);
    }

    // Step 2. 서로 다른 체결 근거를 합산해 단일 지표 과적합을 피한다.
    const candleRange = latest.high - latest.low;
    const closePosition =
      candleRange > 0 ? (latest.close - latest.low) / candleRange : 0;
    const confirmations = [
      latest.close > latest.open && closePosition >= 0.65,
      volumeRatio >= this.options.minVolumeRatio,
      execution.executionStrength >= this.options.minExecutionStrength,
      execution.price >= latest.close,
    ].filter(Boolean).length;

    if (confirmations < this.options.minConfirmations) {
      return reject('실시간 모멘텀 확인 수 부족', completedCandles);
    }

    return {
      shouldBuy: true,
      reason: '완성 1분봉 스켈핑 진입 신호',
      completedCandles,
      metrics: {
        fastSma,
        slowSma,
        volumeRatio,
        executionStrength: execution.executionStrength,
        spreadPct,
        vwapPremiumPct,
        confirmations,
      },
    };
  }

  clearStock(stockCode: string): void {
    this.states.delete(stockCode);
  }

  clearAll(): void {
    this.states.clear();
  }

  getCompletedCandles(stockCode: string): IntradayMinuteCandle[] {
    return [...(this.states.get(stockCode)?.completed ?? [])];
  }
}

function createCandle(
  minute: number,
  time: string,
  execution: KisRealtimeExecution,
): IntradayMinuteCandle {
  return {
    minute,
    time,
    open: execution.price,
    high: execution.price,
    low: execution.price,
    close: execution.price,
    volume: Math.abs(execution.executionVolume),
  };
}

function updateCandle(
  candle: IntradayMinuteCandle,
  time: string,
  execution: KisRealtimeExecution,
): void {
  candle.time = time;
  candle.high = Math.max(candle.high, execution.price);
  candle.low = Math.min(candle.low, execution.price);
  candle.close = execution.price;
  candle.volume += Math.abs(execution.executionVolume);
}

function normalizeExecutionTime(time: string): string {
  return /^\d{6}$/.test(time) ? time : '';
}

function toSessionMinute(time: string): number | undefined {
  if (!/^\d{6}$/.test(time)) return undefined;
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));
  const second = Number(time.slice(4, 6));
  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return undefined;
  }
  return hour * 60 + minute;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function reject(
  reason: string,
  completedCandles: number,
): IntradayScalpingDecision {
  return {
    shouldBuy: false,
    reason,
    completedCandles,
  };
}
