export interface ScanResult {
  stockCode: string;
  stockName: string;
  bestStrategy: {
    id: string;
    name: string;
    variant?: string;
  };
  totalReturnPct: number;
  winRate: number;
  maxDrawdownPct: number;
  totalTrades: number;
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
