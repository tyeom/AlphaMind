import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Stock } from '../stock/entities/stock.entity';
import { StockDailyPrice } from '../stock/entities/stock-daily-price.entity';
import {
  CandleData,
  DayTradingConfig,
  MeanReversionConfig,
  InfinityBotConfig,
  CandlePatternConfig,
  MomentumPowerConfig,
  MomentumSurgeConfig,
  StrategyAnalysisResult,
  InfinityBotResult,
  analyzeDayTrading,
  analyzeMeanReversion,
  analyzeInfinityBot,
  analyzeCandlePattern,
  analyzeMomentumPower,
  analyzeMomentumSurge,
} from '@alpha-mind/strategies';

const STRATEGY_LOOKBACK_MONTHS = 6;

@Injectable()
export class StrategyService {
  constructor(private readonly em: EntityManager) {}

  /** 사용 가능한 전략 목록 */
  getAvailableStrategies() {
    return [
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
        description:
          '캔들스틱 패턴(Hammer, Engulfing, Star 등) 감지 기반 매매 신호',
      },
      {
        id: 'momentum-power',
        name: 'Momentum Power',
        description:
          '장기 MA(시장 안전) + 단기 MA(모멘텀) 기반 공격/안전/위기 모드 전환 전략',
      },
      {
        id: 'momentum-surge',
        name: 'Momentum Surge',
        description:
          'OBV + MA 정/역배열 + RSI 조합 레버리지/인버스 ETF 추세 추종 전략',
      },
    ];
  }

  /** 전체 전략 종합 분석 */
  async analyzeAll(code: string): Promise<{
    stock: { code: string; name: string };
    results: Record<string, StrategyAnalysisResult | InfinityBotResult>;
  }> {
    const { stock, candles } = await this.loadCandles(code);

    const results = {
      dayTrading: withStockCode(analyzeDayTrading(candles), code),
      meanReversion: withStockCode(analyzeMeanReversion(candles), code),
      infinityBot: withStockCode(
        analyzeInfinityBot(candles),
        code,
      ) as InfinityBotResult,
      candlePattern: withStockCode(analyzeCandlePattern(candles), code),
      momentumPower: withStockCode(analyzeMomentumPower(candles), code),
      momentumSurge: withStockCode(
        analyzeMomentumSurge(candles, {}, code),
        code,
      ),
    };

    return { stock: { code: stock.code, name: stock.name }, results };
  }

  /** Day Trading 전략 분석 */
  async analyzeDayTrading(
    code: string,
    config: Partial<DayTradingConfig> = {},
  ): Promise<StrategyAnalysisResult> {
    const { candles } = await this.loadCandles(code);
    return withStockCode(analyzeDayTrading(candles, config), code);
  }

  /** Mean Reversion 전략 분석 */
  async analyzeMeanReversion(
    code: string,
    config: Partial<MeanReversionConfig> = {},
  ): Promise<StrategyAnalysisResult> {
    const { candles } = await this.loadCandles(code);
    return withStockCode(analyzeMeanReversion(candles, config), code);
  }

  /** Infinity Bot 시뮬레이션 */
  async analyzeInfinityBot(
    code: string,
    config: Partial<InfinityBotConfig> = {},
  ): Promise<InfinityBotResult> {
    const { candles } = await this.loadCandles(code);
    return withStockCode(
      analyzeInfinityBot(candles, config),
      code,
    ) as InfinityBotResult;
  }

  /** Candle Pattern 인식 */
  async analyzeCandlePattern(
    code: string,
    config: Partial<CandlePatternConfig> = {},
  ): Promise<StrategyAnalysisResult> {
    const { candles } = await this.loadCandles(code);
    return withStockCode(analyzeCandlePattern(candles, config), code);
  }

  /** Momentum Power (Snow) 전략 분석 */
  async analyzeMomentumPower(
    code: string,
    config: Partial<MomentumPowerConfig> = {},
  ): Promise<StrategyAnalysisResult> {
    const { candles } = await this.loadCandles(code);
    return withStockCode(analyzeMomentumPower(candles, config), code);
  }

  /** Momentum Surge 전략 분석 */
  async analyzeMomentumSurge(
    code: string,
    config: Partial<MomentumSurgeConfig> = {},
  ): Promise<StrategyAnalysisResult> {
    const { candles } = await this.loadCandles(code);
    return withStockCode(analyzeMomentumSurge(candles, config, code), code);
  }

  /** DB에서 6개월 일봉 데이터 로드 */
  private async loadCandles(
    code: string,
  ): Promise<{ stock: Stock; candles: CandleData[] }> {
    const stock = await this.em.findOne(Stock, { code });
    if (!stock) {
      throw new NotFoundException(`종목 코드 ${code}를 찾을 수 없습니다.`);
    }

    const lookbackFrom = new Date();
    lookbackFrom.setMonth(lookbackFrom.getMonth() - STRATEGY_LOOKBACK_MONTHS);

    const prices = await this.em.find(
      StockDailyPrice,
      {
        stock,
        date: { $gte: lookbackFrom },
      },
      { orderBy: { date: 'ASC' } },
    );

    if (prices.length === 0) {
      throw new NotFoundException(
        `종목 ${code}의 최근 ${STRATEGY_LOOKBACK_MONTHS}개월 가격 데이터가 없습니다.`,
      );
    }

    const candles: CandleData[] = prices
      .filter((p) => p.close != null)
      .map((p) => ({
        date: p.date,
        open: p.open ?? p.close!,
        high: p.high ?? p.close!,
        low: p.low ?? p.close!,
        close: p.close!,
        volume: p.volume ?? 0,
      }));

    return { stock, candles };
  }
}

function withStockCode<T extends StrategyAnalysisResult>(
  result: T,
  code: string,
): T {
  result.stockCode = code;
  return result;
}
