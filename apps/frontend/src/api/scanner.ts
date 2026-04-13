import type { ScanResponse, AiStockScore } from '../types/scanner';

const MARKET_API = '/market-api';

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
}): Promise<ScanResponse> {
  const res = await fetch(`${MARKET_API}/strategies/scan`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      excludeCodes: params.excludeCodes ?? [],
      topN: params.topN ?? 10,
      investmentAmount: params.investmentAmount ?? 10_000_000,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message || res.statusText);
  }
  return res.json();
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

/**
 * SSE로 AI 점수를 스트리밍 수신합니다.
 * 종목별로 완료될 때마다 onScore가 호출됩니다.
 * 반환값: abort 함수
 */
export async function startAiSession(
  stocks: { stockCode: string; stockName: string; totalReturnPct: number; strategyName: string; strategyId?: string }[],
): Promise<{ sessionId: string }> {
  const res = await fetch(`${MARKET_API}/ai-scoring/session/start`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ stocks }),
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

export async function cancelAiSession(sessionId: string): Promise<{ cancelled: boolean }> {
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
      const res = await fetch(`${MARKET_API}/ai-scoring/session/${sessionId}/stream`, {
        headers: authHeaders(),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
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
            } catch { /* ignore parse errors */ }
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
  stocks: { stockCode: string; stockName: string; totalReturnPct: number; strategyName: string; strategyId?: string }[],
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
        const body = await res.json().catch(() => ({ message: res.statusText }));
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
            } catch { /* ignore parse errors */ }
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
