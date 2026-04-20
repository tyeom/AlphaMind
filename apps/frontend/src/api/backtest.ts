const MARKET_API = '/market-api';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('access_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface BacktestParams {
  stockCode: string;
  strategyId: string;
  variant?: string;
  investmentAmount?: number;
  tradeRatioPct?: number;
  commissionPct?: number;
  autoTakeProfitPct?: number;
  autoStopLossPct?: number;
}

export interface BacktestTrade {
  date: string;
  direction: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  amount: number;
  commission: number;
  reason: string;
  realizedPnl?: number;
}

export interface BacktestResult {
  stockCode: string;
  stockName: string;
  strategyId: string;
  strategyName: string;
  variant?: string;
  period: { from: string; to: string };
  investmentAmount: number;
  finalValue: number;
  totalReturnPct: number;
  totalRealizedPnl: number;
  unrealizedPnl: number;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  maxDrawdownPct: number;
  remainingCash: number;
  remainingQuantity: number;
  trades: BacktestTrade[];
}

export async function runBacktest(params: BacktestParams): Promise<BacktestResult> {
  const query = new URLSearchParams();
  query.set('strategyId', params.strategyId);
  if (params.variant) query.set('variant', params.variant);
  if (params.investmentAmount !== undefined) {
    query.set('investmentAmount', String(params.investmentAmount));
  }
  if (params.tradeRatioPct !== undefined) {
    query.set('tradeRatioPct', String(params.tradeRatioPct));
  }
  if (params.commissionPct !== undefined) {
    query.set('commissionPct', String(params.commissionPct));
  }
  if (params.autoTakeProfitPct !== undefined) {
    query.set('autoTakeProfitPct', String(params.autoTakeProfitPct));
  }
  if (params.autoStopLossPct !== undefined) {
    query.set('autoStopLossPct', String(params.autoStopLossPct));
  }

  const res = await fetch(`${MARKET_API}/strategies/${params.stockCode}/backtest?${query}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message || res.statusText);
  }
  return res.json();
}

export interface StrategyInfo {
  id: string;
  name: string;
  description: string;
  variants?: string[];
}

const FALLBACK_STRATEGIES: StrategyInfo[] = [
  {
    id: 'day-trading',
    name: '일간 모멘텀 통합 전략',
    description: '변동성 돌파, SMA 크로스오버, 거래량 급증 모멘텀',
    variants: ['breakout', 'crossover', 'volume_surge'],
  },
  {
    id: 'mean-reversion',
    name: '평균회귀 전략',
    description: 'RSI, 볼린저 밴드, 그리드 트레이딩, 매직 분할매수',
    variants: ['rsi', 'bollinger', 'grid', 'magic_split'],
  },
  {
    id: 'infinity-bot',
    name: '무한매수봇',
    description: '피라미드 구조 분할 매수 + 평균 단가 대비 익절',
  },
  {
    id: 'candle-pattern',
    name: '캔들 패턴 인식',
    description: '캔들스틱 패턴(Hammer, Engulfing, Star 등) 감지 기반 매매 신호',
  },
  {
    id: 'momentum-power',
    name: 'Momentum Power',
    description: '장기 MA(시장 안전) + 단기 MA(모멘텀) 기반 공격/안전/위기 모드 전환 전략',
  },
  {
    id: 'momentum-surge',
    name: 'Momentum Surge',
    description: 'OBV + MA 정/역배열 + RSI 조합 레버리지/인버스 ETF 추세 추종 전략',
  },
];

export async function getStrategies(): Promise<StrategyInfo[]> {
  try {
    const res = await fetch(`${MARKET_API}/strategies`, {
      headers: authHeaders(),
    });
    if (!res.ok) return FALLBACK_STRATEGIES;
    return await res.json();
  } catch {
    return FALLBACK_STRATEGIES;
  }
}
