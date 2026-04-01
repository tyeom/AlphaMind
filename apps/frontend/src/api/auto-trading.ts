import { api } from './client';
import type {
  AutoTradingSession,
  StartSessionRequest,
  StartSessionsBatchRequest,
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

export async function stopSession(id: number): Promise<AutoTradingSession> {
  return api.delete<AutoTradingSession>(`/auto-trading/sessions/${id}`);
}
