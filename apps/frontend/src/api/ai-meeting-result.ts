import { api } from './client';
import type { AiStockScore } from '../types/scanner';

export interface AiMeetingResult {
  id: number;
  stockCode: string;
  stockName: string;
  score: number;
  reasoning: string;
  data: AiStockScore;
  updatedAt: string;
}

export function saveAiMeetingResults(
  scores: AiStockScore[],
): Promise<AiMeetingResult[]> {
  return api.post<AiMeetingResult[]>('/ai-meeting-results', {
    scores: scores.map((s) => ({
      stockCode: s.stockCode,
      stockName: s.stockName,
      score: s.score,
      reasoning: s.reasoning,
      data: s,
    })),
  });
}

export function getAiMeetingResults(): Promise<AiMeetingResult[]> {
  return api.get<AiMeetingResult[]>('/ai-meeting-results');
}

export function getAiMeetingResult(
  stockCode: string,
): Promise<AiMeetingResult | null> {
  return api.get<AiMeetingResult | null>(`/ai-meeting-results/${stockCode}`);
}
