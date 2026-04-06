import { useState, useEffect, useMemo } from 'react';
import { getBalance } from '../../api/kis';
import type { BalanceItem, BalanceItemSource, BalanceResponse } from '../../types/kis';

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

type SourceFilter = 'all' | BalanceItemSource;

export function Balance() {
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');

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

  const visibleItems: BalanceItem[] = useMemo(() => {
    if (!balance) return [];
    if (sourceFilter === 'all') return balance.items;
    return balance.items.filter((i) => i.source === sourceFilter);
  }, [balance, sourceFilter]);

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

          {/* 자동/수동 구분 필터 */}
          <div className="balance-source-filter">
            <button
              type="button"
              className={`btn btn-sm ${sourceFilter === 'all' ? 'btn-primary' : ''}`}
              onClick={() => setSourceFilter('all')}
            >
              전체 ({balance.items.length})
            </button>
            <button
              type="button"
              className={`btn btn-sm ${sourceFilter === 'auto' ? 'btn-primary' : ''}`}
              onClick={() => setSourceFilter('auto')}
            >
              자동매매 ({balance.autoTradingCount})
            </button>
            <button
              type="button"
              className={`btn btn-sm ${sourceFilter === 'manual' ? 'btn-primary' : ''}`}
              onClick={() => setSourceFilter('manual')}
            >
              수동 ({balance.manualCount})
            </button>
          </div>

          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>구분</th>
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
                {visibleItems.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="text-center">
                      {balance.items.length === 0
                        ? '보유 종목이 없습니다.'
                        : '선택한 구분에 해당하는 종목이 없습니다.'}
                    </td>
                  </tr>
                ) : (
                  visibleItems.map((item) => {
                    const at = item.autoTrading;
                    const isAuto = item.source === 'auto';
                    return (
                      <tr
                        key={item.stockCode}
                        className={isAuto ? 'row-auto' : 'row-manual'}
                      >
                        <td>
                          <span
                            className={`source-badge source-${item.source}`}
                          >
                            {isAuto ? '자동' : '수동'}
                          </span>
                        </td>
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
