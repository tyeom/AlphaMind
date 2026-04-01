import { Injectable, Logger } from '@nestjs/common';
import {
  ChartInterval,
  ChartRange,
  StockCandle,
  StockChartData,
  YahooChartResponse,
} from './yahoo-finance.types';

const MAX_RETRIES = 3;
const REQUEST_DELAY_MS = 300; // 요청 간 간격 (rate limit 방지)

@Injectable()
export class YahooFinanceService {
  private readonly logger = new Logger(YahooFinanceService.name);
  private readonly baseUrl = 'https://query1.finance.yahoo.com/v8/finance/chart';
  private lastRequestTime = 0;

  async getChartByPeriod(
    symbol: string,
    from: Date,
    to: Date,
    interval: ChartInterval = '1d',
  ): Promise<StockChartData> {
    const period1 = Math.floor(from.getTime() / 1000);
    const period2 = Math.floor(to.getTime() / 1000);
    const url = `${this.baseUrl}/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=${interval}&events=div|split`;

    this.logger.debug(`Fetching chart data: ${symbol} (${from.toISOString().split('T')[0]} ~ ${to.toISOString().split('T')[0]})`);

    return this.fetchWithRetry(url, symbol);
  }

  async getChart(
    symbol: string,
    range: ChartRange = '1y',
    interval: ChartInterval = '1d',
  ): Promise<StockChartData> {
    const url = `${this.baseUrl}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&events=div|split`;

    this.logger.debug(`Fetching chart data: ${symbol} (range=${range}, interval=${interval})`);

    return this.fetchWithRetry(url, symbol);
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < REQUEST_DELAY_MS) {
      await this.sleep(REQUEST_DELAY_MS - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  private async fetchWithRetry(url: string, symbol: string): Promise<StockChartData> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.throttle();
        return await this.fetchChart(url, symbol);
      } catch (error: any) {
        const isRateLimit = error.message?.includes('429');
        const isServerError = error.message?.includes('5');
        const isRetryable = isRateLimit || isServerError;

        if (attempt === MAX_RETRIES || !isRetryable) {
          throw error;
        }

        const backoffMs = isRateLimit
          ? Math.min(2000 * Math.pow(2, attempt), 30000) // 429: 4s, 8s, 16s...
          : 1000 * attempt; // 5xx: 1s, 2s, 3s

        this.logger.warn(
          `${symbol}: request failed (attempt ${attempt}/${MAX_RETRIES}, ${error.message}). Retrying in ${backoffMs}ms...`,
        );
        await this.sleep(backoffMs);
      }
    }

    throw new Error(`${symbol}: all ${MAX_RETRIES} attempts failed`);
  }

  private async fetchChart(url: string, symbol: string): Promise<StockChartData> {
    const response = await fetch(url);

    if (response.status === 429) {
      throw new Error(`Yahoo Finance API rate limited: 429 Too Many Requests (${symbol})`);
    }

    if (response.status >= 500) {
      throw new Error(`Yahoo Finance API server error: ${response.status} (${symbol})`);
    }

    if (!response.ok) {
      throw new Error(`Yahoo Finance API error: ${response.status} ${response.statusText} (${symbol})`);
    }

    const data: YahooChartResponse = await response.json();

    if (data.chart.error) {
      throw new Error(`Yahoo Finance error: ${data.chart.error.description}`);
    }

    if (!data.chart.result || data.chart.result.length === 0) {
      throw new Error(`No data found for symbol: ${symbol}`);
    }

    const result = data.chart.result[0];
    const { meta, timestamp, indicators } = result;

    if (!timestamp || timestamp.length === 0) {
      return {
        symbol: meta.symbol,
        currency: meta.currency,
        exchange: meta.fullExchangeName,
        name: meta.longName ?? meta.shortName ?? meta.symbol,
        candles: [],
      };
    }

    const quote = indicators.quote[0];
    const adjclose = indicators.adjclose?.[0]?.adjclose ?? [];

    const candles: StockCandle[] = timestamp.map((ts, i) => ({
      date: new Date(ts * 1000).toISOString().split('T')[0],
      open: quote.open[i],
      high: quote.high[i],
      low: quote.low[i],
      close: quote.close[i],
      volume: quote.volume[i],
      adjClose: adjclose[i] ?? null,
    }));

    return {
      symbol: meta.symbol,
      currency: meta.currency,
      exchange: meta.fullExchangeName,
      name: meta.longName ?? meta.shortName ?? meta.symbol,
      candles,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
