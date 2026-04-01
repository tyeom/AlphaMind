import { api, setToken, clearToken } from './client';
import type { SignInRequest } from '../types/user';

interface SignInResponse {
  accessToken: string;
}

export async function signIn(dto: SignInRequest): Promise<string> {
  const res = await api.post<SignInResponse>('/auth/sign-in', dto);
  setToken(res.accessToken);
  return res.accessToken;
}

export async function signOut(): Promise<void> {
  try {
    await api.post('/auth/sign-out');
  } finally {
    clearToken();
  }
}
