export interface YahooChartResponse {
  chart: {
    result: YahooChartResult[] | null;
    error: { code: string; description: string } | null;
  };
}

export interface YahooChartResult {
  meta: YahooChartMeta;
  timestamp: number[];
  events?: {
    dividends?: Record<string, { amount: number; date: number }>;
    splits?: Record<string, { numerator: number; denominator: number; date: number }>;
  };
  indicators: {
    quote: [YahooQuote];
    adjclose: [{ adjclose: (number | null)[] }];
  };
}

export interface YahooChartMeta {
  currency: string;
  symbol: string;
  exchangeName: string;
  fullExchangeName: string;
  instrumentType: string;
  longName?: string;
  shortName?: string;
  regularMarketPrice: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  regularMarketDayHigh: number;
  regularMarketDayLow: number;
  regularMarketVolume: number;
}

export interface YahooQuote {
  open: (number | null)[];
  high: (number | null)[];
  low: (number | null)[];
  close: (number | null)[];
  volume: (number | null)[];
}

export interface StockCandle {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  adjClose: number | null;
}

export interface StockChartData {
  symbol: string;
  currency: string;
  exchange: string;
  name: string;
  candles: StockCandle[];
}

export type ChartRange = '1d' | '5d' | '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y' | '10y' | 'ytd' | 'max';
export type ChartInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '1d' | '5d' | '1wk' | '1mo' | '3mo';
