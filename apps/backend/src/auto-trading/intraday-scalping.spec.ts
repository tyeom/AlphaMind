import { KisRealtimeExecution } from '../kis/kis.types';
import { IntradayScalpingTracker } from './intraday-scalping';

describe('IntradayScalpingTracker', () => {
  const execution = (
    time: string,
    price: number,
    overrides: Partial<KisRealtimeExecution> = {},
  ): KisRealtimeExecution => ({
    stockCode: '005930',
    time,
    price,
    changeSign: '2',
    change: price - 100,
    changeRate: price - 100,
    weightedAvgPrice: 100,
    openPrice: 100,
    highPrice: price,
    lowPrice: 100,
    askPrice1: price + 0.05,
    bidPrice1: price - 0.05,
    executionVolume: 100,
    cumulativeVolume: 1_000,
    cumulativeAmount: 100_000,
    executionStrength: 120,
    executionType: '1',
    tradingHalt: false,
    hourClsCode: '0',
    ...overrides,
  });

  it('완성된 1분봉만 누적하고 진행 중인 봉은 신호 계산에서 제외한다', () => {
    const tracker = new IntradayScalpingTracker();

    tracker.record(execution('090000', 100), 1);
    tracker.record(execution('090030', 101), 2);
    tracker.record(execution('090100', 102), 3);

    expect(tracker.getCompletedCandles('005930')).toEqual([
      expect.objectContaining({
        time: '090030',
        open: 100,
        high: 101,
        low: 100,
        close: 101,
        volume: 200,
      }),
    ]);
  });

  it('VWAP 위 상승 추세와 실시간 확인 조건을 충족하면 매수 신호를 반환한다', () => {
    const tracker = new IntradayScalpingTracker();
    const receivedAt = 1_000_000;
    const prices = [100, 100.1, 100.2, 100.4, 100.7, 100.9];

    prices.forEach((price, index) => {
      tracker.record(
        execution(`090${index}00`, price, {
          weightedAvgPrice: 100.2,
          executionVolume: index === 4 ? 160 : 100,
        }),
        receivedAt + index,
      );
    });

    const decision = tracker.evaluate('005930', receivedAt + prices.length);

    expect(decision.shouldBuy).toBe(true);
    expect(decision.metrics).toEqual(
      expect.objectContaining({
        confirmations: 3,
      }),
    );
  });

  it('같은 장의 지연 체결은 무시하고 다음 장 09시 체결에서는 전일 봉을 초기화한다', () => {
    const tracker = new IntradayScalpingTracker();

    tracker.record(execution('145900', 100), 1);
    tracker.record(execution('150000', 101), 2);
    tracker.record(execution('145959', 99), 3);

    expect(tracker.getCompletedCandles('005930')).toHaveLength(1);
    expect(tracker.getCompletedCandles('005930')[0].close).toBe(100);

    tracker.record(execution('090000', 102), 4);
    tracker.record(execution('090100', 103), 5);

    expect(tracker.getCompletedCandles('005930')).toEqual([
      expect.objectContaining({
        time: '090000',
        close: 102,
      }),
    ]);
  });

  it('실시간 체결이 오래되면 일봉 신호로 대체하지 않고 진입을 거부한다', () => {
    const tracker = new IntradayScalpingTracker({ maxTickAgeMs: 1_000 });

    for (let index = 0; index < 6; index++) {
      tracker.record(execution(`090${index}00`, 100 + index * 0.1), index);
    }

    expect(tracker.evaluate('005930', 2_000)).toMatchObject({
      shouldBuy: false,
      reason: '실시간 체결 데이터 지연',
    });
  });

  it('호가 스프레드가 넓으면 상승 분봉이어도 진입하지 않는다', () => {
    const tracker = new IntradayScalpingTracker();
    const receivedAt = 1_000_000;

    for (let index = 0; index < 6; index++) {
      const price = 100 + index * 0.2;
      tracker.record(
        execution(`090${index}00`, price, {
          weightedAvgPrice: 100.2,
          askPrice1: 101,
          bidPrice1: 100,
        }),
        receivedAt + index,
      );
    }

    expect(tracker.evaluate('005930', receivedAt + 10)).toMatchObject({
      shouldBuy: false,
      reason: '호가 스프레드 과다',
    });
  });

  it('거래정지 체결을 받으면 직전 정상 체결 신호를 재사용하지 않는다', () => {
    const tracker = new IntradayScalpingTracker();
    const receivedAt = 1_000_000;

    for (let index = 0; index < 6; index++) {
      tracker.record(
        execution(`090${index}00`, 100 + index * 0.2, {
          weightedAvgPrice: 100.2,
        }),
        receivedAt + index,
      );
    }
    tracker.record(
      execution('090510', 101, {
        tradingHalt: true,
      }),
      receivedAt + 10,
    );

    expect(tracker.evaluate('005930', receivedAt + 11)).toMatchObject({
      shouldBuy: false,
      reason: '정규장 체결 상태 아님',
    });
  });
});
