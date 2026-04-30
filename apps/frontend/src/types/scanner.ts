export interface ScanResult {
  stockCode: string;
  stockName: string;
  bestStrategy: {
    strategyId: string;
    strategyName: string;
    variant?: string;
  };
  totalReturnPct: number;
  winRate: number;
  maxDrawdownPct: number;
  totalTrades: number;
  rankScore: number;
  volatilityPct?: number;
  profitFactor?: number;
  expectancyPct?: number;
  riskProfile?: {
    avgTurnover20?: number;
    sma20Slope5dPct?: number;
    priceFromSma20Pct?: number;
    priceFromSma60Pct?: number;
    recent5dReturnPct?: number;
  };
  /** 추천 근거 요약 */
  summary: string;
  /** 최신 신호 */
  currentSignal: {
    direction: string;
    strength: number;
    reason: string;
  };
  /** 전략별 핵심 지표 */
  indicators: Record<string, unknown>;
  /** 시장 경고 코드 — 01: 투자주의 / 02: 투자경고 / 03: 투자위험 (KIS 조회 후 채워짐) */
  mrktWarnClsCode?: string;
}

export interface ScanResponse {
  scannedStocks: number;
  eligibleStocks: number;
  excludedStocks: number;
  elapsedMs: number;
  results: ScanResult[];
}

export interface ExpertOpinion {
  recommendation: string;
  score: number;
  analysis: string;
  keyPoints: string[];
  concerns: string[];
  targetReturnPct: number;
  confidence: number;
}

export interface MeetingConclusion {
  finalScore: number;
  finalRecommendation: string;
  consensusPoints: string[];
  disagreements: string[];
  reasoning: string;
}

export interface NewsItem {
  title: string;
  url: string;
  summary: string;
  impact: 'positive' | 'negative' | 'neutral';
}

export interface AiStockScore {
  stockCode: string;
  stockName: string;
  score: number;
  reasoning: string;
  newsItems: NewsItem[];
  newsHighlights: string[];
  chartAnalysis: string;
  riskFactors: string[];
  expertDetail?: {
    traderOpinion: ExpertOpinion;
    economistOpinion: ExpertOpinion;
    conclusion: MeetingConclusion;
  };
}

export interface AiScoreResponse {
  scores: AiStockScore[];
  elapsedMs: number;
}
