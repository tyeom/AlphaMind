import { tradingDaysElapsed } from './trading-calendar';

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
});
