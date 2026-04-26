import type { ScanResponse, AiStockScore } from '../types/scanner';
import { marketRequest } from './market-client';

const MARKET_API = '/market-api';
export type AiMeetingProvider = 'claude' | 'gpt';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('access_token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function scanStocks(params: {
  excludeCodes?: string[];
  topN?: number;
  investmentAmount?: number;
  autoTakeProfitPct?: number;
  autoStopLossPct?: number;
  maxHoldingDays?: number;
}): Promise<ScanResponse> {
  // TP/SL/maxHoldingDays 는 undefined 면 객체에서 생략 (JSON.stringify 가 omit).
  // 그래야 backend 의 `?? optimal.tpPct` fallback 이 발동해 그리드 서치 결과가 적용된다.
  const body: Record<string, unknown> = {
    excludeCodes: params.excludeCodes ?? [],
    topN: params.topN ?? 10,
    investmentAmount: params.investmentAmount ?? 10_000_000,
  };
  if (params.autoTakeProfitPct !== undefined)
    body.autoTakeProfitPct = params.autoTakeProfitPct;
  if (params.autoStopLossPct !== undefined)
    body.autoStopLossPct = params.autoStopLossPct;
  if (params.maxHoldingDays !== undefined)
    body.maxHoldingDays = params.maxHoldingDays;

  return marketRequest<ScanResponse>('/strategies/scan', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

/**
 * 현재 적용 중인 단타 TP/SL 조회.
 * source='optimized' 면 그리드 서치 결과, 'default' 면 코드 기본값 (그리드 미실행).
 */
export interface OptimalShortTermTpSl {
  tpPct: number;
  slPct: number;
  source: 'optimized' | 'default';
  updatedAt?: string;
  score?: number;
  sampleSize?: number;
}

export async function getOptimalShortTermTpSl(): Promise<OptimalShortTermTpSl> {
  return marketRequest<OptimalShortTermTpSl>(
    '/strategies/optimal-params/short-term-tp-sl',
    { headers: authHeaders() },
  );
}

export interface SseProgress {
  current: number;
  total: number;
  stockCode: string;
  stockName: string;
  phase: string;
}

export interface AiScoreStreamCallbacks {
  onProgress: (progress: SseProgress) => void;
  onScore: (score: AiStockScore) => void;
  onDone: (info: { elapsedMs: number }) => void;
  onError: (message: string) => void;
  onCancelled?: (info: { elapsedMs: number; completedCount: number }) => void;
}

export interface AiSessionStock {
  stockCode: string;
  stockName: string;
  totalReturnPct?: number | null;
  strategyName: string;
  strategyId?: string;
}

/**
 * SSE로 AI 점수를 스트리밍 수신합니다.
 * 종목별로 완료될 때마다 onScore가 호출됩니다.
 * 반환값: abort 함수
 */
export async function startAiSession(
  stocks: AiSessionStock[],
  provider: AiMeetingProvider,
): Promise<{ sessionId: string }> {
  const res = await fetch(`${MARKET_API}/ai-scoring/session/start`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ stocks, provider }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message || res.statusText);
  }
  return res.json();
}

export async function getActiveAiSession(): Promise<{
  active: boolean;
  session?: {
    id: string;
    status: string;
    provider: AiMeetingProvider;
    stocks: any[];
    scores: AiStockScore[];
    progress: SseProgress | null;
    startedAt: number;
    elapsedMs: number;
  };
}> {
  const res = await fetch(`${MARKET_API}/ai-scoring/session/active`, {
    headers: authHeaders(),
  });
  if (!res.ok) return { active: false };
  return res.json();
}

export async function cancelAiSession(
  sessionId: string,
): Promise<{ cancelled: boolean }> {
  const res = await fetch(`${MARKET_API}/ai-scoring/session/${sessionId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) return { cancelled: false };
  const text = await res.text();
  if (!text) return { cancelled: true };
  return JSON.parse(text);
}

export function streamAiSession(
  sessionId: string,
  callbacks: AiScoreStreamCallbacks,
): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(
        `${MARKET_API}/ai-scoring/session/${sessionId}/stream`,
        {
          headers: authHeaders(),
          signal: controller.signal,
        },
      );

      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({ message: res.statusText }));
        callbacks.onError(body.message || res.statusText);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        callbacks.onError('스트림을 열 수 없습니다.');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ') && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));
              switch (currentEvent) {
                case 'progress':
                  callbacks.onProgress(data);
                  break;
                case 'score':
                  callbacks.onScore(data);
                  break;
                case 'done':
                  callbacks.onDone(data);
                  break;
                case 'cancelled':
                  callbacks.onCancelled?.(data);
                  break;
                case 'error':
                  callbacks.onError(data.message);
                  break;
              }
            } catch {
              /* ignore parse errors */
            }
            currentEvent = '';
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        callbacks.onError(err.message || 'SSE 연결 오류');
      }
    }
  })();

  return () => controller.abort();
}

export function streamAiScores(
  stocks: AiSessionStock[],
  callbacks: AiScoreStreamCallbacks,
): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${MARKET_API}/ai-scoring/score-stream`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ stocks }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({ message: res.statusText }));
        callbacks.onError(body.message || res.statusText);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        callbacks.onError('스트림을 열 수 없습니다.');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ') && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));
              switch (currentEvent) {
                case 'progress':
                  callbacks.onProgress(data);
                  break;
                case 'score':
                  callbacks.onScore(data);
                  break;
                case 'done':
                  callbacks.onDone(data);
                  break;
                case 'cancelled':
                  callbacks.onCancelled?.(data);
                  break;
                case 'error':
                  callbacks.onError(data.message);
                  break;
              }
            } catch {
              /* ignore parse errors */
            }
            currentEvent = '';
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        callbacks.onError(err.message || 'SSE 연결 오류');
      }
    }
  })();

  return () => controller.abort();
}
