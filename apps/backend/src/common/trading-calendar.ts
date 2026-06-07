const KST_TIME_ZONE = 'Asia/Seoul';
const DAY_MS = 24 * 60 * 60 * 1000;

const kstFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: KST_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * KRX 휴장일.
 * 운영 전에는 한국거래소 최신 공지로 갱신한다. 누락된 휴장일은 조기 청산 위험이 있어
 * 의심 날짜는 휴장으로 두는 편이 보수적이다.
 */
export const KRX_HOLIDAYS = new Set<string>([
  // 2026
  '2026-01-01',
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-03-02',
  '2026-05-01',
  '2026-05-05',
  '2026-05-25',
  '2026-06-03',
  '2026-07-17',
  '2026-08-17',
  '2026-09-24',
  '2026-09-25',
  '2026-10-05',
  '2026-10-09',
  '2026-12-25',
  '2026-12-31',

  // 2027
  '2027-01-01',
  '2027-02-08',
  '2027-02-09',
  '2027-03-01',
  '2027-05-05',
  '2027-05-13',
  '2027-06-07',
  '2027-07-19',
  '2027-08-16',
  '2027-09-14',
  '2027-09-15',
  '2027-09-16',
  '2027-10-04',
  '2027-10-11',
  '2027-12-27',
  '2027-12-31',
]);

export function tradingDaysElapsed(
  from: Date,
  to: Date,
  holidays: Set<string> = KRX_HOLIDAYS,
): number {
  const fromMs = dateKeyToUtcMs(toKstDateKey(from));
  const toMs = dateKeyToUtcMs(toKstDateKey(to));

  if (toMs <= fromMs) {
    return 0;
  }

  let count = 0;

  // 진입 당일은 0일차로 보고, 다음 KST 날짜부터 현재 날짜까지 거래일을 센다.
  for (let dayMs = fromMs + DAY_MS; dayMs <= toMs; dayMs += DAY_MS) {
    const key = utcMsToDateKey(dayMs);
    if (isTradingDate(dayMs, key, holidays)) {
      count += 1;
    }
  }

  return count;
}

function isTradingDate(
  utcMs: number,
  key: string,
  holidays: Set<string>,
): boolean {
  const day = new Date(utcMs).getUTCDay();
  const isWeekend = day === 0 || day === 6;

  return !isWeekend && !holidays.has(key);
}

function toKstDateKey(date: Date): string {
  const parts = kstFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

function dateKeyToUtcMs(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function utcMsToDateKey(utcMs: number): string {
  const date = new Date(utcMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}
