import {
  DEFAULT_VI_CLEAR_TIMEOUT_MS,
  VI_SINGLE_PRICE_MKOP_CODES,
  ViStateTracker,
  isRegularSinglePriceAuction,
  judgeViStatus,
} from './vi-state-tracker';

describe('ViStateTracker', () => {
  afterEach(() => {
    VI_SINGLE_PRICE_MKOP_CODES.clear();
  });

  it('marks trading halt as active and clears it on timeout', () => {
    let now = 1_000;
    const tracker = new ViStateTracker({
      clearTimeoutMs: DEFAULT_VI_CLEAR_TIMEOUT_MS,
      now: () => now,
    });

    const active = tracker.updateFromExecution({
      stockCode: '005930',
      time: '100000',
      price: 70000,
      changeSign: '2',
      change: 1000,
      changeRate: 1.5,
      weightedAvgPrice: 70000,
      openPrice: 69000,
      highPrice: 70500,
      lowPrice: 68800,
      askPrice1: 70000,
      bidPrice1: 69900,
      executionVolume: 10,
      cumulativeVolume: 10000,
      cumulativeAmount: 700000000,
      executionStrength: 120,
      executionType: '1',
      tradingHalt: true,
      hourClsCode: '0',
    });

    expect(active.isViActive).toBe(true);
    expect(active.source).toBe('trading-halt');

    now += DEFAULT_VI_CLEAR_TIMEOUT_MS;
    const cleared = tracker.getState('005930');

    expect(cleared?.isViActive).toBe(false);
    expect(cleared?.clearReason).toBe('timeout');
    expect(tracker.isActive('005930')).toBe(false);
  });

  it('does not classify regular single-price auction windows as VI', () => {
    VI_SINGLE_PRICE_MKOP_CODES.add('PAPER_VI');

    expect(isRegularSinglePriceAuction('B', '085000')).toBe(true);
    expect(
      judgeViStatus({
        time: '085000',
        newMkopClsCode: 'PAPER_VI',
        tradingHalt: false,
        hourClsCode: 'B',
      }).isViActive,
    ).toBe(false);
    expect(
      judgeViStatus({
        time: '152500',
        newMkopClsCode: 'PAPER_VI',
        tradingHalt: false,
        hourClsCode: '0',
      }).isViActive,
    ).toBe(false);
  });

  it('falls back to inactive when fields are missing but still flags limit-near status', () => {
    const judgment = judgeViStatus({
      changeRate: -29.6,
      tradingHalt: false,
    });

    expect(judgment.isViActive).toBe(false);
    expect(judgment.limitNear).toBe(true);
    expect(judgment.reason).toBe('VI 감지 없음');
  });
});
