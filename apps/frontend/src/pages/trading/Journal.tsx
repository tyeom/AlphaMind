import { useState, useEffect } from 'react';
import { getJournal } from '../../api/kis';
import type { JournalResponse, StockJournalSummary } from '../../types/kis';

function formatNumber(n: number): string {
  return n.toLocaleString('ko-KR');
}

function formatPercent(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function formatSignedAmount(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toLocaleString('ko-KR')}원`;
}

function formatDate(d: string): string {
  if (d.length !== 8) return d;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function getTodayString(): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date());
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  ) as Record<'year' | 'month' | 'day', string>;
  return `${values.year}${values.month}${values.day}`;
}

export function Journal() {
  const [date, setDate] = useState(getTodayString());
  const [journal, setJournal] = useState<JournalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchJournal = (targetDate?: string) => {
    setLoading(true);
    setError('');
    getJournal(targetDate || date)
      .then(setJournal)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchJournal();
  }, []);

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const iso = e.target.value;
    const yyyymmdd = iso.replace(/-/g, '');
    setDate(yyyymmdd);
    fetchJournal(yyyymmdd);
  };

  const dateInputValue = date.length === 8
    ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    : '';

  if (loading) return <div className="page-loading">로딩 중...</div>;

  const tradedStocks = journal?.stockSummaries.filter(
    (s) => s.buyQty > 0 || s.sellQty > 0,
  ) ?? [];
  const holdingStocks = journal?.stockSummaries.filter(
    (s) => s.holdingQty > 0,
  ) ?? [];

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>매매 일지</h2>
        <div className="journal-date-picker">
          <input
            type="date"
            value={dateInputValue}
            onChange={handleDateChange}
            max={`${getTodayString().slice(0, 4)}-${getTodayString().slice(4, 6)}-${getTodayString().slice(6, 8)}`}
          />
          <button className="btn btn-sm" onClick={() => fetchJournal()}>
            새로고침
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {journal && !journal.isAvailable && (
        <div className="journal-message">
          <p>{journal.message}</p>
        </div>
      )}

      {journal?.isAvailable && (
        <>
          <div className="journal-date-label">{formatDate(journal.date)} 매매 일지</div>
          {journal.message && (
            <div className="journal-message">
              <p>{journal.message}</p>
            </div>
          )}

          {/* 전체 요약 카드 */}
          <div className="summary-cards">
            <div className="summary-card">
              <span className="summary-label">총 평가금액</span>
              <span className="summary-value">
                {formatNumber(journal.totalEvalAmount)}원
              </span>
            </div>
            <div className="summary-card">
              <span className="summary-label">총 매입금액</span>
              <span className="summary-value">
                {formatNumber(journal.totalPurchaseAmount)}원
              </span>
            </div>
            <div className="summary-card">
              <span className="summary-label">오늘 전체 수익률</span>
              <span
                className={`summary-value ${journal.totalProfitLossRate >= 0 ? 'text-profit' : 'text-loss'}`}
              >
                {formatPercent(journal.totalProfitLossRate)}
              </span>
            </div>
            <div className="summary-card">
              <span className="summary-label">오늘 전체 손익금</span>
              <span
                className={`summary-value ${journal.totalEvalProfitLoss >= 0 ? 'text-profit' : 'text-loss'}`}
              >
                {formatSignedAmount(journal.totalEvalProfitLoss)}
              </span>
            </div>
            {journal.dayOverDayChange !== undefined && (
              <div className="summary-card">
                <span className="summary-label">
                  전날 대비 ({journal.previousDay ? formatDate(journal.previousDay.date) : ''})
                </span>
                <span
                  className={`summary-value ${journal.dayOverDayChange >= 0 ? 'text-profit' : 'text-loss'}`}
                >
                  {formatPercent(journal.dayOverDayChange)}
                </span>
              </div>
            )}
            <div className="summary-card">
              <span className="summary-label">예수금</span>
              <span className="summary-value">
                {formatNumber(journal.cashBalance)}원
              </span>
            </div>
          </div>

          {/* 오늘 매매 실현 손익 */}
          {tradedStocks.length > 0 && (
            <>
              <h3>오늘 매매 내역</h3>
              <div className="journal-trade-summary">
                <span>
                  매수: <strong>{formatNumber(journal.totalBuyAmount)}원</strong>
                </span>
                <span>
                  매도: <strong>{formatNumber(journal.totalSellAmount)}원</strong>
                </span>
                <span
                  className={journal.realizedProfitLoss >= 0 ? 'text-profit' : 'text-loss'}
                >
                  실현 손익: <strong>{formatNumber(journal.realizedProfitLoss)}원</strong>
                </span>
              </div>

              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>종목</th>
                      <th className="text-right">매수수량</th>
                      <th className="text-right">매수금액</th>
                      <th className="text-right">매도수량</th>
                      <th className="text-right">매도금액</th>
                      <th className="text-right">실현손익</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tradedStocks.map((s: StockJournalSummary) => (
                      <tr key={`trade-${s.stockCode}`}>
                        <td>
                          {s.stockName}
                          <span className="stock-code-sub">({s.stockCode})</span>
                        </td>
                        <td className="text-right">
                          {s.buyQty > 0 ? formatNumber(s.buyQty) : '-'}
                        </td>
                        <td className="text-right">
                          {s.buyAmount > 0 ? formatNumber(s.buyAmount) : '-'}
                        </td>
                        <td className="text-right">
                          {s.sellQty > 0 ? formatNumber(s.sellQty) : '-'}
                        </td>
                        <td className="text-right">
                          {s.sellAmount > 0 ? formatNumber(s.sellAmount) : '-'}
                        </td>
                        <td
                          className={`text-right ${s.profitLoss >= 0 ? 'text-profit' : 'text-loss'}`}
                        >
                          {s.buyQty > 0 && s.sellQty > 0
                            ? formatNumber(s.profitLoss)
                            : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {tradedStocks.length === 0 && (
            <div className="journal-message">
              <p>오늘 매매 내역이 없습니다.</p>
            </div>
          )}

          {/* 종목별 평가 현황 */}
          {holdingStocks.length > 0 && (
            <>
              <h3 style={{ marginTop: 24 }}>보유 종목별 수익률</h3>
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>종목</th>
                      <th className="text-right">보유수량</th>
                      <th className="text-right">평균매입가</th>
                      <th className="text-right">현재가</th>
                      <th className="text-right">평가금액</th>
                      <th className="text-right">평가손익</th>
                      <th className="text-right">수익률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdingStocks.map((s: StockJournalSummary) => (
                      <tr key={`hold-${s.stockCode}`}>
                        <td>
                          {s.stockName}
                          <span className="stock-code-sub">({s.stockCode})</span>
                        </td>
                        <td className="text-right">{formatNumber(s.holdingQty)}</td>
                        <td className="text-right">{formatNumber(s.avgBuyPrice)}</td>
                        <td className="text-right">{formatNumber(s.currentPrice)}</td>
                        <td className="text-right">{formatNumber(s.evalAmount)}</td>
                        <td
                          className={`text-right ${s.evalProfitLoss >= 0 ? 'text-profit' : 'text-loss'}`}
                        >
                          {formatNumber(s.evalProfitLoss)}
                        </td>
                        <td
                          className={`text-right ${s.evalProfitLossRate >= 0 ? 'text-profit' : 'text-loss'}`}
                        >
                          {formatPercent(s.evalProfitLossRate)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
