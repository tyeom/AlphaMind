import { api } from './client';
import type {
  AutoTradingSession,
  StartSessionRequest,
  StartSessionsBatchRequest,
  UpdateSessionRequest,
  ManualOrderRequest,
} from '../types/auto-trading';

export async function startSession(dto: StartSessionRequest): Promise<AutoTradingSession> {
  return api.post<AutoTradingSession>('/auto-trading/sessions', dto);
}

export async function startSessionsBatch(
  dto: StartSessionsBatchRequest,
): Promise<AutoTradingSession[]> {
  return api.post<AutoTradingSession[]>('/auto-trading/sessions/batch', dto);
}

export async function getSessions(): Promise<AutoTradingSession[]> {
  return api.get<AutoTradingSession[]>('/auto-trading/sessions');
}

export async function getSession(id: number): Promise<AutoTradingSession> {
  return api.get<AutoTradingSession>(`/auto-trading/sessions/${id}`);
}

export async function pauseSession(id: number): Promise<AutoTradingSession> {
  return api.patch<AutoTradingSession>(`/auto-trading/sessions/${id}/pause`);
}

export async function resumeSession(id: number): Promise<AutoTradingSession> {
  return api.patch<AutoTradingSession>(`/auto-trading/sessions/${id}/resume`);
}

export async function updateSession(
  id: number,
  dto: UpdateSessionRequest,
): Promise<AutoTradingSession> {
  return api.patch<AutoTradingSession>(`/auto-trading/sessions/${id}`, dto);
}

export async function stopSession(id: number): Promise<AutoTradingSession> {
  return api.delete<AutoTradingSession>(`/auto-trading/sessions/${id}`);
}

/** 수동 매수/매도 주문 */
export async function manualOrder(
  sessionId: number,
  dto: ManualOrderRequest,
): Promise<AutoTradingSession> {
  return api.post<AutoTradingSession>(
    `/auto-trading/sessions/${sessionId}/order`,
    dto,
  );
}

/** 완전 삭제 — 종료(STOPPED) 상태의 세션만 삭제 가능 */
export async function deleteSessionPermanent(
  id: number,
): Promise<{ id: number }> {
  return api.delete<{ id: number }>(`/auto-trading/sessions/${id}/permanent`);
}
