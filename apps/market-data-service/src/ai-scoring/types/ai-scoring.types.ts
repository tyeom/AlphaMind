export interface AiScoreRequestItem {
  stockCode: string;
  stockName: string;
  strategyId: string;
  strategyName: string;
  totalReturnPct?: number | null;
  sector?: string;
}

export type AiMeetingProvider = 'claude' | 'gpt';

export interface AiScoreRequest {
  stocks: AiScoreRequestItem[];
  provider?: AiMeetingProvider;
}

/** 개별 뉴스 아이템 */
export interface NewsItem {
  title: string;
  url: string;
  summary: string;
  impact: 'positive' | 'negative' | 'neutral';
}

/** 뉴스 에이전트 결과 */
export interface NewsAgentResult {
  newsItems: NewsItem[];
  newsHighlights: string[];
  sentiment: 'positive' | 'negative' | 'neutral';
  sentimentScore: number; // -1.0 ~ 1.0
  keyIssues: string[];
  riskFactors: string[];
}

/** 차트 에이전트 결과 */
export interface ChartAgentResult {
  chartAnalysis: string;
  technicalScore: number; // 1.00 ~ 10.00
  trendDirection: '상승' | '하락' | '횡보';
  supportLevel: number;
  resistanceLevel: number;
  momentum: '강함' | '보통' | '약함';
}

/** 전문가 에이전트 의견 */
export interface ExpertOpinion {
  recommendation: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
  score: number; // 1.00 ~ 10.00
  analysis: string;
  keyPoints: string[];
  concerns: string[];
  targetReturnPct: number;
  confidence: number; // 0.0 ~ 1.0
}

/** 회의 최종 결론 */
export interface MeetingConclusion {
  finalScore: number;
  finalRecommendation: string;
  consensusPoints: string[];
  disagreements: string[];
  reasoning: string;
}

/** 최종 AI 종목 점수 */
export interface AiStockScore {
  stockCode: string;
  stockName: string;
  score: number; // 1.00 ~ 10.00
  reasoning: string;
  newsItems: NewsItem[];
  newsHighlights: string[];
  chartAnalysis: string;
  riskFactors: string[];
  /** 전문가 회의 상세 (프론트엔드에서 펼쳐볼 수 있음) */
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
