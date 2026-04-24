import { SignalDirection } from '@alpha-mind/strategies';

/** 백테스트 설정 */
export interface BacktestConfig {
  /** 전략 ID: day-trading, mean-reversion, infinity-bot, candle-pattern */
  strategyId: string;
  /** 전략 variant (선택) */
  variant?: string;
  /** 초기 투자 금액 */
  investmentAmount: number;
  /** 1회 매매 비율 % (기본 10) */
  tradeRatioPct: number;
  /** 매매 수수료율 % (기본 0.015) */
  commissionPct: number;
  /** 자동 익절 수익률 % (기본 2.5) */
  autoTakeProfitPct: number;
  /** 자동 손절 수익률 % (기본 -3) */
  autoStopLossPct: number;
  /** 최대 보유 거래일 수 (기본 7, 0 이하이면 비활성) */
  maxHoldingDays?: number;
  /** 보유 중 추가 매수 신호를 반영할지 여부 (기본은 전략별 설정) */
  allowAddOnBuy?: boolean;
  /** 매수 신호 최소 강도 (기본은 전략별 설정) */
  minBuySignalStrength?: number;
}

/** 개별 거래 기록 */
export interface BacktestTrade {
  date: Date;
  direction: SignalDirection.Buy | SignalDirection.Sell;
  price: number;
  quantity: number;
  amount: number;
  commission: number;
  reason: string;
  /** 매도 시 실현 손익 */
  realizedPnl?: number;
}

/** 백테스트 결과 */
export interface BacktestResult {
  /** 종목 코드 */
  stockCode: string;
  /** 종목명 */
  stockName: string;
  /** 사용된 전략 */
  strategyId: string;
  strategyName: string;
  variant?: string;
  /** 기간 */
  period: { from: Date; to: Date };
  /** 초기 투자 금액 */
  investmentAmount: number;
  /** 최종 포트폴리오 가치 (현금 + 보유주식 시가) */
  finalValue: number;
  /** 총 수익률 % */
  totalReturnPct: number;
  /** 총 실현 손익 */
  totalRealizedPnl: number;
  /** 미실현 손익 (잔여 보유분) */
  unrealizedPnl: number;
  /** 총 거래 횟수 */
  totalTrades: number;
  /** 승리 거래 횟수 */
  winTrades: number;
  /** 패배 거래 횟수 */
  lossTrades: number;
  /** 승률 % */
  winRate: number;
  /** 최대 낙폭 % (MDD) */
  maxDrawdownPct: number;
  /** 잔여 현금 */
  remainingCash: number;
  /** 잔여 보유 수량 */
  remainingQuantity: number;
  /** 거래 내역 */
  trades: BacktestTrade[];
}
