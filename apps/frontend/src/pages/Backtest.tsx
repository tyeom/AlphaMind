import { useState, useEffect, type FormEvent } from 'react';
import {
  runBacktest,
  getStrategies,
  type BacktestResult,
  type StrategyInfo,
} from '../api/backtest';
import { getOptimalShortTermTpSl } from '../api/scanner';

function formatNumber(n: number): string {
  return n.toLocaleString('ko-KR');
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('ko-KR');
}

function toOptionalNumber(value: string): number | undefined {
  if (value.trim() === '') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function Backtest() {
  const [strategies, setStrategies] = useState<StrategyInfo[]>([]);
  const [stockCode, setStockCode] = useState('');
  const [strategyId, setStrategyId] = useState('');
  const [variant, setVariant] = useState('');
  const [investmentAmount, setInvestmentAmount] = useState('10000000');
  const [tradeRatioPct, setTradeRatioPct] = useState('10');
  const [commissionPct, setCommissionPct] = useState('0.015');
  // TP/SL 초기값은 빈 문자열 — 마운트 시 backend 그리드 서치 optimal 로 주입.
  // 비워서 제출하면 backend 가 코드 기본값 fallback (단일 백테스트는 optimal auto-apply 안 함, 사용자 의도 존중).
  const [autoTakeProfitPct, setAutoTakeProfitPct] = useState('');
  const [autoStopLossPct, setAutoStopLossPct] = useState('');
  const [optimalTpSlSource, setOptimalTpSlSource] = useState<
    'optimized' | 'default' | null
  >(null);
  const [maxHoldingDays, setMaxHoldingDays] = useState('7');
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getStrategies()
      .then(setStrategies)
      .catch(() => setError('전략 목록을 불러올 수 없습니다.'));
  }, []);

  // 마운트 시 단타 optimal TP/SL 조회 → 입력 폼 초기값으로 사용.
  useEffect(() => {
    let cancelled = false;
    getOptimalShortTermTpSl()
      .then((opt) => {
        if (cancelled) return;
        setAutoTakeProfitPct(String(opt.tpPct));
        setAutoStopLossPct(String(opt.slPct));
        setOptimalTpSlSource(opt.source);
      })
      .catch(() => {
        // 실패 시 빈 채로 둠 — 사용자가 직접 입력
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedStrategy = strategies.find((s) => s.id === strategyId);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!stockCode.trim() || !strategyId) return;

    setError('');
    setLoading(true);
    setResult(null);

    try {
      const data = await runBacktest({
        stockCode: stockCode.trim(),
        strategyId,
        variant: variant || undefined,
        investmentAmount: toOptionalNumber(investmentAmount),
        tradeRatioPct: toOptionalNumber(tradeRatioPct),
        commissionPct: toOptionalNumber(commissionPct),
        autoTakeProfitPct: toOptionalNumber(autoTakeProfitPct),
        autoStopLossPct: toOptionalNumber(autoStopLossPct),
        maxHoldingDays: toOptionalNumber(maxHoldingDays),
      });
      setResult(data);
    } catch (err: any) {
      setError(err.message || '백테스트 실행에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-container">
      <h1>전략 백테스팅</h1>
      <p className="page-desc">
        3개월 차트 데이터 기반으로 전략의 과거 성과를 시뮬레이션합니다.
      </p>

      <form className="backtest-form" onSubmit={handleSubmit}>
        <div className="form-row">
          <label>
            종목 코드
            <input
              type="text"
              value={stockCode}
              onChange={(e) => setStockCode(e.target.value)}
              placeholder="예: 005930"
              required
            />
          </label>

          <label>
            전략
            <select
              value={strategyId}
              onChange={(e) => {
                setStrategyId(e.target.value);
                setVariant('');
              }}
              required
            >
              <option value="">전략 선택</option>
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          {selectedStrategy?.variants &&
            selectedStrategy.variants.length > 0 && (
              <label>
                변형
                <select
                  value={variant}
                  onChange={(e) => setVariant(e.target.value)}
                >
                  <option value="">기본</option>
                  {selectedStrategy.variants.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            )}
        </div>

        <div className="form-row">
          <label>
            투자 금액 (원)
            <input
              type="number"
              value={investmentAmount}
              onChange={(e) => setInvestmentAmount(e.target.value)}
              min="100000"
              step="100000"
            />
          </label>

          <label>
            1회 매매 비율 (%)
            <input
              type="number"
              value={tradeRatioPct}
              onChange={(e) => setTradeRatioPct(e.target.value)}
              min="1"
              max="100"
              step="1"
            />
          </label>

          <label>
            수수료율 (%)
            <input
              type="number"
              value={commissionPct}
              onChange={(e) => setCommissionPct(e.target.value)}
              min="0"
              step="0.001"
            />
          </label>
        </div>

        {optimalTpSlSource === 'optimized' && (
          <p className="text-muted" style={{ fontSize: '0.85em', margin: 0 }}>
            ※ 자동 익절/손절은 주간 그리드 서치 결과로 채워졌습니다. 직접 수정
            가능.
          </p>
        )}
        <div className="form-row">
          <label>
            자동 익절 (%)
            <input
              type="number"
              value={autoTakeProfitPct}
              onChange={(e) => setAutoTakeProfitPct(e.target.value)}
              min="0"
              step="0.1"
              placeholder="예: 2.5"
            />
          </label>

          <label>
            자동 손절 (%)
            <input
              type="number"
              value={autoStopLossPct}
              onChange={(e) => setAutoStopLossPct(e.target.value)}
              max="0"
              step="0.1"
              placeholder="예: -3"
            />
          </label>

          <label>
            최대 보유일
            <input
              type="number"
              value={maxHoldingDays}
              onChange={(e) => setMaxHoldingDays(e.target.value)}
              min="0"
              step="1"
            />
          </label>
        </div>

        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? '백테스팅 실행 중...' : '백테스트 실행'}
        </button>
      </form>

      {error && <div className="error-message">{error}</div>}

      {result && (
        <div className="backtest-result">
          <h2>백테스트 결과</h2>

          <div className="result-summary">
            <div className="summary-header">
              <span className="stock-info">
                {result.stockName} ({result.stockCode})
              </span>
              <span className="strategy-info">
                {result.strategyName}
                {result.variant && ` - ${result.variant}`}
              </span>
            </div>

            <div className="summary-grid">
              <div className="summary-card">
                <span className="label">기간</span>
                <span className="value">
                  {formatDate(result.period.from)} ~{' '}
                  {formatDate(result.period.to)}
                </span>
              </div>
              <div className="summary-card">
                <span className="label">투자 금액</span>
                <span className="value">
                  {formatNumber(result.investmentAmount)}원
                </span>
              </div>
              <div className="summary-card">
                <span className="label">최종 평가액</span>
                <span className="value">
                  {formatNumber(result.finalValue)}원
                </span>
              </div>
              <div className="summary-card highlight">
                <span className="label">총 수익률</span>
                <span
                  className={`value ${result.totalReturnPct >= 0 ? 'positive' : 'negative'}`}
                >
                  {result.totalReturnPct >= 0 ? '+' : ''}
                  {result.totalReturnPct}%
                </span>
              </div>
              <div className="summary-card">
                <span className="label">실현 손익</span>
                <span
                  className={`value ${result.totalRealizedPnl >= 0 ? 'positive' : 'negative'}`}
                >
                  {formatNumber(result.totalRealizedPnl)}원
                </span>
              </div>
              <div className="summary-card">
                <span className="label">미실현 손익</span>
                <span
                  className={`value ${result.unrealizedPnl >= 0 ? 'positive' : 'negative'}`}
                >
                  {formatNumber(result.unrealizedPnl)}원
                </span>
              </div>
              <div className="summary-card">
                <span className="label">총 거래</span>
                <span className="value">{result.totalTrades}회</span>
              </div>
              <div className="summary-card">
                <span className="label">승률</span>
                <span className="value">
                  {result.winRate}% ({result.winTrades}승 {result.lossTrades}패)
                </span>
              </div>
              <div className="summary-card">
                <span className="label">최대 낙폭 (MDD)</span>
                <span className="value negative">
                  -{result.maxDrawdownPct}%
                </span>
              </div>
              <div className="summary-card">
                <span className="label">잔여 현금</span>
                <span className="value">
                  {formatNumber(result.remainingCash)}원
                </span>
              </div>
              <div className="summary-card">
                <span className="label">잔여 보유 수량</span>
                <span className="value">
                  {formatNumber(result.remainingQuantity)}주
                </span>
              </div>
            </div>
          </div>

          {result.trades.length > 0 && (
            <div className="trades-section">
              <h3>거래 내역 ({result.trades.length}건)</h3>
              <div className="table-wrapper">
                <table className="trades-table">
                  <thead>
                    <tr>
                      <th>날짜</th>
                      <th>구분</th>
                      <th>가격</th>
                      <th>수량</th>
                      <th>금액</th>
                      <th>수수료</th>
                      <th>실현손익</th>
                      <th>사유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((trade, i) => (
                      <tr
                        key={i}
                        className={
                          trade.direction === 'BUY' ? 'trade-buy' : 'trade-sell'
                        }
                      >
                        <td>{formatDate(trade.date)}</td>
                        <td
                          className={
                            trade.direction === 'BUY' ? 'positive' : 'negative'
                          }
                        >
                          {trade.direction === 'BUY' ? '매수' : '매도'}
                        </td>
                        <td>{formatNumber(trade.price)}원</td>
                        <td>{formatNumber(trade.quantity)}주</td>
                        <td>{formatNumber(trade.amount)}원</td>
                        <td>{formatNumber(Math.round(trade.commission))}원</td>
                        <td
                          className={
                            trade.realizedPnl != null
                              ? trade.realizedPnl >= 0
                                ? 'positive'
                                : 'negative'
                              : ''
                          }
                        >
                          {trade.realizedPnl != null
                            ? `${formatNumber(Math.round(trade.realizedPnl))}원`
                            : '-'}
                        </td>
                        <td className="reason-cell">{trade.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
