import { useState, useEffect } from 'react';
import { getBalance } from '../../api/kis';
import type { BalanceResponse } from '../../types/kis';

function formatNumber(n: number): string {
  return n.toLocaleString('ko-KR');
}

function formatPercent(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

const STRATEGY_NAMES: Record<string, string> = {
  'day-trading': '일간 모멘텀',
  'mean-reversion': '평균회귀',
  'infinity-bot': '무한매수봇',
  'candle-pattern': '캔들 패턴',
};

export function Balance() {
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchBalance = () => {
    setLoading(true);
    setError('');
    getBalance()
      .then(setBalance)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchBalance();
  }, []);

  if (loading) return <div className="page-loading">로딩 중...</div>;

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>잔고 현황</h2>
        <button className="btn btn-sm" onClick={fetchBalance}>
          새로고침
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {balance && (
        <>
          <div className="summary-cards">
            <div className="summary-card">
              <span className="summary-label">총 평가금액</span>
              <span className="summary-value">
                {formatNumber(balance.totalEvalAmount)}원
              </span>
            </div>
            <div className="summary-card">
              <span className="summary-label">총 매입금액</span>
              <span className="summary-value">
                {formatNumber(balance.totalPurchaseAmount)}원
              </span>
            </div>
            <div className="summary-card">
              <span className="summary-label">총 평가손익</span>
              <span
                className={`summary-value ${balance.totalProfitLoss >= 0 ? 'text-profit' : 'text-loss'}`}
              >
                {formatNumber(balance.totalProfitLoss)}원 (
                {formatPercent(balance.totalProfitLossRate)})
              </span>
            </div>
            <div className="summary-card">
              <span className="summary-label">예수금</span>
              <span className="summary-value">
                {formatNumber(balance.cashBalance)}원
              </span>
            </div>
          </div>

          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>종목코드</th>
                  <th>종목명</th>
                  <th className="text-right">보유수량</th>
                  <th className="text-right">평균매입가</th>
                  <th className="text-right">현재가</th>
                  <th className="text-right">평가금액</th>
                  <th className="text-right">평가손익</th>
                  <th className="text-right">수익률</th>
                  <th>자동매매 전략</th>
                  <th className="text-right">목표수익</th>
                  <th className="text-right">손절</th>
                </tr>
              </thead>
              <tbody>
                {balance.items.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="text-center">
                      보유 종목이 없습니다.
                    </td>
                  </tr>
                ) : (
                  balance.items.map((item) => {
                    const at = item.autoTrading;
                    return (
                      <tr key={item.stockCode}>
                        <td>{item.stockCode}</td>
                        <td>{item.stockName}</td>
                        <td className="text-right">{formatNumber(item.holdingQty)}</td>
                        <td className="text-right">{formatNumber(item.avgBuyPrice)}</td>
                        <td className="text-right">{formatNumber(item.currentPrice)}</td>
                        <td className="text-right">{formatNumber(item.evalAmount)}</td>
                        <td
                          className={`text-right ${item.profitLoss >= 0 ? 'text-profit' : 'text-loss'}`}
                        >
                          {formatNumber(item.profitLoss)}
                        </td>
                        <td
                          className={`text-right ${item.profitLossRate >= 0 ? 'text-profit' : 'text-loss'}`}
                        >
                          {formatPercent(item.profitLossRate)}
                        </td>
                        <td>
                          {at ? (
                            <>
                              {STRATEGY_NAMES[at.strategyId] || at.strategyId}
                              {at.variant && (
                                <small className="text-muted"> ({at.variant})</small>
                              )}
                            </>
                          ) : (
                            <span className="text-muted">-</span>
                          )}
                        </td>
                        <td className="text-right">
                          {at ? (
                            <span className="text-profit">+{at.takeProfitPct}%</span>
                          ) : (
                            <span className="text-muted">-</span>
                          )}
                        </td>
                        <td className="text-right">
                          {at ? (
                            <span className="text-loss">{at.stopLossPct}%</span>
                          ) : (
                            <span className="text-muted">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
