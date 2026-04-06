import { useState, type FormEvent } from 'react';
import { buy, sell, getBuyable, getCurrentPrice } from '../../api/kis';
import type { StockPrice, BuyableResponse, OrderDivision } from '../../types/kis';

function formatNumber(n: number): string {
  return n.toLocaleString('ko-KR');
}

type OrderType = 'buy' | 'sell';
type PriceType = 'market' | 'limit';

export function Order() {
  const [orderType, setOrderType] = useState<OrderType>('buy');
  const [priceType, setPriceType] = useState<PriceType>('market');
  const [stockCode, setStockCode] = useState('');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [stockInfo, setStockInfo] = useState<StockPrice | null>(null);
  const [buyable, setBuyable] = useState<BuyableResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleLookup = async () => {
    if (!stockCode.trim()) return;
    setLookupLoading(true);
    setError('');
    try {
      const [priceData, buyableData] = await Promise.all([
        getCurrentPrice(stockCode.trim()),
        getBuyable(stockCode.trim()),
      ]);
      setStockInfo(priceData);
      setBuyable(buyableData);
      if (!price) setPrice(String(priceData.currentPrice));
    } catch (err) {
      setError(err instanceof Error ? err.message : '조회에 실패했습니다.');
    } finally {
      setLookupLoading(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!stockCode.trim() || !qty) {
      setError('종목코드와 수량을 입력해주세요.');
      return;
    }

    if (priceType === 'limit' && !price) {
      setError('지정가를 입력해주세요.');
      return;
    }

    const confirmed = window.confirm(
      `${stockCode} ${Number(qty)}주를 ${priceType === 'market' ? '시장가' : `${formatNumber(Number(price))}원에`} ${orderType === 'buy' ? '매수' : '매도'}하시겠습니까?`,
    );
    if (!confirmed) return;

    setLoading(true);
    try {
      const dto = {
        stockCode: stockCode.trim(),
        quantity: Number(qty),
        price: priceType === 'limit' ? Number(price) : 0,
        orderDvsn: (priceType === 'limit' ? '00' : '01') as OrderDivision,
      };

      if (orderType === 'buy') {
        await buy(dto);
      } else {
        await sell(dto);
      }

      setSuccess(
        `${orderType === 'buy' ? '매수' : '매도'} 주문이 접수되었습니다.`,
      );
      setQty('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '주문에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-container">
      <h2>주문</h2>

      <div className="order-layout">
        <form className="form-card order-form" onSubmit={handleSubmit}>
          <div className="order-type-tabs">
            <button
              type="button"
              className={`tab ${orderType === 'buy' ? 'tab-active tab-buy' : ''}`}
              onClick={() => setOrderType('buy')}
            >
              매수
            </button>
            <button
              type="button"
              className={`tab ${orderType === 'sell' ? 'tab-active tab-sell' : ''}`}
              onClick={() => setOrderType('sell')}
            >
              매도
            </button>
          </div>

          {error && <div className="alert alert-error">{error}</div>}
          {success && <div className="alert alert-success">{success}</div>}

          <div className="form-group">
            <label htmlFor="stockCode">종목코드</label>
            <div className="input-with-button">
              <input
                id="stockCode"
                type="text"
                value={stockCode}
                onChange={(e) => setStockCode(e.target.value)}
                placeholder="005930"
                maxLength={6}
                required
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleLookup}
                disabled={lookupLoading}
              >
                {lookupLoading ? '...' : '조회'}
              </button>
            </div>
          </div>

          {stockInfo && (
            <div className="stock-quick-info">
              <strong>{stockInfo.stockName}</strong>
              <span>현재가: {formatNumber(stockInfo.currentPrice)}원</span>
              {buyable && (
                <span>매수가능: {formatNumber(buyable.buyableQty)}주</span>
              )}
            </div>
          )}

          <div className="form-group">
            <label>주문유형</label>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  name="priceType"
                  checked={priceType === 'market'}
                  onChange={() => setPriceType('market')}
                />
                시장가
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="priceType"
                  checked={priceType === 'limit'}
                  onChange={() => setPriceType('limit')}
                />
                지정가
              </label>
            </div>
          </div>

          {priceType === 'limit' && (
            <div className="form-group">
              <label htmlFor="price">주문가격</label>
              <input
                id="price"
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="주문 단가"
                min={0}
                required
              />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="qty">수량</label>
            <input
              id="qty"
              type="number"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="주문 수량"
              min={1}
              required
            />
          </div>

          <button
            type="submit"
            className={`btn btn-full ${orderType === 'buy' ? 'btn-buy' : 'btn-sell'}`}
            disabled={loading}
          >
            {loading
              ? '주문 중...'
              : orderType === 'buy'
                ? '매수 주문'
                : '매도 주문'}
          </button>
        </form>
      </div>
    </div>
  );
}
