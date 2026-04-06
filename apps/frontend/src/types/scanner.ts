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
