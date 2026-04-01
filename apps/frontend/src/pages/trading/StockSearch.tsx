import { useState, type FormEvent } from 'react';
import { getCurrentPrice, getDailyPrice } from '../../api/kis';
import type { StockPrice, DailyPrice } from '../../types/kis';

function formatNumber(n: number): string {
  return n.toLocaleString('ko-KR');
}

export function StockSearch() {
  const [stockCode, setStockCode] = useState('');
  const [price, setPrice] = useState<StockPrice | null>(null);
  const [dailyPrices, setDailyPrices] = useState<DailyPrice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    if (!stockCode.trim()) return;

    setError('');
    setLoading(true);
    setPrice(null);
    setDailyPrices([]);

    try {
      const [priceData, dailyData] = await Promise.all([
        getCurrentPrice(stockCode.trim()),
        getDailyPrice(stockCode.trim(), 'D'),
      ]);
      setPrice(priceData);
      setDailyPrices(dailyData);
    } catch (err) {
      setError(err instanceof Error ? err.message : '조회에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const changeSign = price
    ? price.change > 0
      ? '+'
      : price.change < 0
        ? ''
        : ''
    : '';

  return (
    <div className="page-container">
      <h2>종목 조회</h2>

      <form className="search-form" onSubmit={handleSearch}>
        <input
          type="text"
          value={stockCode}
          onChange={(e) => setStockCode(e.target.value)}
          placeholder="종목코드 (예: 005930)"
          maxLength={6}
        />
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '조회 중...' : '조회'}
        </button>
      </form>

      {error && <div className="alert alert-error">{error}</div>}

      {price && (
        <div className="stock-info-card">
          <div className="stock-header">
            <h3>
              {price.stockName} ({price.stockCode})
            </h3>
          </div>
          <div className="stock-price-main">
            <span className="current-price">{formatNumber(price.currentPrice)}원</span>
            <span
              className={`price-change ${price.change > 0 ? 'text-profit' : price.change < 0 ? 'text-loss' : ''}`}
            >
              {changeSign}
              {formatNumber(price.change)}원 ({changeSign}
              {price.changeRate.toFixed(2)}%)
            </span>
          </div>
          <div className="stock-details">
            <div>
              <span className="detail-label">시가</span>
              <span>{formatNumber(price.openPrice)}</span>
            </div>
            <div>
              <span className="detail-label">고가</span>
              <span className="text-profit">{formatNumber(price.highPrice)}</span>
            </div>
            <div>
              <span className="detail-label">저가</span>
              <span className="text-loss">{formatNumber(price.lowPrice)}</span>
            </div>
            <div>
              <span className="detail-label">거래량</span>
              <span>{formatNumber(price.volume)}</span>
            </div>
          </div>
        </div>
      )}

      {dailyPrices.length > 0 && (
        <div className="table-container">
          <h3>일별 시세</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>날짜</th>
                <th className="text-right">시가</th>
                <th className="text-right">고가</th>
                <th className="text-right">저가</th>
                <th className="text-right">종가</th>
                <th className="text-right">거래량</th>
                <th className="text-right">등락률</th>
              </tr>
            </thead>
            <tbody>
              {dailyPrices.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td className="text-right">{formatNumber(d.openPrice)}</td>
                  <td className="text-right">{formatNumber(d.highPrice)}</td>
                  <td className="text-right">{formatNumber(d.lowPrice)}</td>
                  <td className="text-right">{formatNumber(d.closePrice)}</td>
                  <td className="text-right">{formatNumber(d.volume)}</td>
                  <td
                    className={`text-right ${d.changeRate > 0 ? 'text-profit' : d.changeRate < 0 ? 'text-loss' : ''}`}
                  >
                    {d.changeRate > 0 ? '+' : ''}
                    {d.changeRate.toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
