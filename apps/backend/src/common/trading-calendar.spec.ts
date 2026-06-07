import { KRX_HOLIDAYS, tradingDaysElapsed } from './trading-calendar';

describe('tradingDaysElapsed', () => {
  it('금요일 진입 후 주말을 제외하고 화요일에 2거래일로 계산한다', () => {
    const from = new Date('2026-06-05T10:00:00+09:00');
    const to = new Date('2026-06-09T10:00:00+09:00');

    expect(tradingDaysElapsed(from, to, new Set())).toBe(2);
  });

  it('휴장일은 경과 거래일에서 제외한다', () => {
    const from = new Date('2026-06-05T10:00:00+09:00');
    const to = new Date('2026-06-09T10:00:00+09:00');

    expect(tradingDaysElapsed(from, to, new Set(['2026-06-08']))).toBe(1);
  });

  it('동일일 또는 미래 진입 시점은 0을 반환한다', () => {
    const sameDay = new Date('2026-06-05T15:00:00+09:00');
    const earlier = new Date('2026-06-05T09:00:00+09:00');
    const future = new Date('2026-06-06T09:00:00+09:00');

    expect(tradingDaysElapsed(earlier, sameDay, new Set())).toBe(0);
    expect(tradingDaysElapsed(future, sameDay, new Set())).toBe(0);
  });

  it('2028년 KRX 기본 휴장일은 경과 거래일에서 제외한다', () => {
    const from = new Date('2028-01-25T10:00:00+09:00');
    const to = new Date('2028-01-31T10:00:00+09:00');

    // 1/26~1/28 설 연휴, 1/29~1/30 주말을 제외하고 1/31만 거래일로 계산한다.
    expect(tradingDaysElapsed(from, to, KRX_HOLIDAYS)).toBe(1);
  });

  it('2028년 추석 대체공휴일과 연말 휴장일을 제외한다', () => {
    const chuseokFrom = new Date('2028-10-04T10:00:00+09:00');
    const chuseokTo = new Date('2028-10-05T10:00:00+09:00');
    const yearEndFrom = new Date('2028-12-28T10:00:00+09:00');
    const yearEndTo = new Date('2028-12-29T10:00:00+09:00');

    expect(tradingDaysElapsed(chuseokFrom, chuseokTo, KRX_HOLIDAYS)).toBe(0);
    expect(tradingDaysElapsed(yearEndFrom, yearEndTo, KRX_HOLIDAYS)).toBe(0);
  });
});
