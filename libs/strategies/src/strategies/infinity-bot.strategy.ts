import {
  CandleData,
  InfinityBotConfig,
  InfinityBotResult,
  RoundInfo,
  Signal,
  SignalDirection,
} from '../types/strategy.types';
import { calculateSMA } from '../indicators/technical-indicators';

const DEFAULT_CONFIG: InfinityBotConfig = {
  totalAmount: 10_000_000,
  maxRounds: 50,
  roundPct: 2,
  dipTriggerPct: 2,
  takeProfitPct: 3,
};

export function analyzeInfinityBot(
  candles: CandleData[],
  config: Partial<InfinityBotConfig> = {},
): InfinityBotResult {
  const cfg: InfinityBotConfig = { ...DEFAULT_CONFIG, ...config };
  const signals: Signal[] = [];
  const rounds: RoundInfo[] = [];

  let currentRound = 0;
  let totalQuantity = 0;
  let investedAmount = 0;
  let lastEntryPrice: number | null = null;
  let takeProfitTriggered = false;

  const roundAmount = (cfg.totalAmount * cfg.roundPct) / 100;

  // MA 계산 (20일)
  const closes = candles.map((c) => c.close);
  const ma20 = calculateSMA(closes, 20);

  for (let i = 0; i < candles.length; i++) {
    const price = candles[i].close;
    const avgPrice = totalQuantity > 0 ? investedAmount / totalQuantity : null;

    // 1. 익절 조건 확인
    if (avgPrice != null && totalQuantity > 0) {
      const returnPct = ((price - avgPrice) / avgPrice) * 100;

      if (returnPct >= cfg.takeProfitPct) {
        const profit = (price - avgPrice) * totalQuantity;

        signals.push({
          direction: SignalDirection.Sell,
          strength: 1.0,
          reason: `익절 (수익률=${returnPct.toFixed(1)}%, 평단=${avgPrice.toFixed(0)}, ${currentRound}라운드)`,
          date: candles[i].date,
          price,
          metadata: {
            action: 'take_profit',
            returnPct,
            avgPrice,
            rounds: currentRound,
            profit,
          },
        });

        takeProfitTriggered = true;
        // 상태 초기화
        currentRound = 0;
        totalQuantity = 0;
        investedAmount = 0;
        lastEntryPrice = null;
        rounds.length = 0;
        continue;
      }
    }

    // 2. 진입/물타기 조건 확인
    const canAdd = canAddPosition(
      price,
      lastEntryPrice,
      currentRound,
      cfg,
    );

    // MA 위에 있는지 확인 (진입 조건)
    const aboveMa = ma20[i] != null && price > ma20[i]!;
    const shouldEnter = lastEntryPrice == null ? true : aboveMa;

    if (canAdd && shouldEnter) {
      currentRound++;
      const quantity = price > 0 ? roundAmount / price : 0;

      totalQuantity += quantity;
      investedAmount += roundAmount;
      lastEntryPrice = price;

      const newAvgPrice = totalQuantity > 0 ? investedAmount / totalQuantity : null;

      rounds.push({
        round: currentRound,
        entryPrice: price,
        quantity,
        date: candles[i].date,
      });

      signals.push({
        direction: SignalDirection.Buy,
        strength: Math.min(currentRound / cfg.maxRounds + 0.3, 1),
        reason: `라운드 ${currentRound} 진입 (가격=${price.toFixed(0)}, 평단=${newAvgPrice?.toFixed(0) ?? '-'})`,
        date: candles[i].date,
        price,
        metadata: {
          action: 'round_entry',
          round: currentRound,
          quantity,
          avgPrice: newAvgPrice,
          investedAmount,
        },
      });
    }
  }

  const lastCandle = candles[candles.length - 1];
  const finalAvgPrice = totalQuantity > 0 ? investedAmount / totalQuantity : null;
  const currentReturn =
    finalAvgPrice != null ? ((lastCandle.close - finalAvgPrice) / finalAvgPrice) * 100 : null;

  const currentSignal: Signal =
    signals.length > 0
      ? signals[signals.length - 1]
      : {
          direction: SignalDirection.Neutral,
          strength: 0,
          reason: '신호 없음',
          date: lastCandle.date,
          price: lastCandle.close,
        };

  const buys = signals.filter((s) => s.direction === SignalDirection.Buy).length;
  const sells = signals.filter((s) => s.direction === SignalDirection.Sell).length;

  return {
    strategyName: '무한매수봇 (Infinity Bot)',
    stockCode: '',
    analyzedPeriod: { from: candles[0].date, to: lastCandle.date },
    currentSignal,
    signals,
    indicators: {
      totalAmount: cfg.totalAmount,
      maxRounds: cfg.maxRounds,
      roundPct: cfg.roundPct,
      dipTriggerPct: cfg.dipTriggerPct,
      takeProfitPct: cfg.takeProfitPct,
      roundAmount,
    },
    summary: `[무한매수봇] 총 ${signals.length}개 신호 (매수 ${buys}, 익절 ${sells}). 현재 ${currentRound}라운드, 평단=${finalAvgPrice?.toFixed(0) ?? '-'}, 수익률=${currentReturn?.toFixed(1) ?? '-'}%`,
    simulation: {
      rounds: [...rounds],
      currentRound,
      avgPrice: finalAvgPrice,
      totalQuantity,
      investedAmount,
      currentReturn,
      takeProfitTriggered,
    },
  };
}

function canAddPosition(
  currentPrice: number,
  lastEntryPrice: number | null,
  currentRound: number,
  cfg: InfinityBotConfig,
): boolean {
  if (currentRound >= cfg.maxRounds) return false;

  // 첫 진입
  if (lastEntryPrice == null) return true;

  // 마지막 진입가 대비 하락률 체크
  if (lastEntryPrice === 0) return false;
  const dropPct = ((lastEntryPrice - currentPrice) / lastEntryPrice) * 100;
  return dropPct >= cfg.dipTriggerPct;
}
