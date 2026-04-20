import { ApiError } from './client';

const MARKET_API = '/market-api';

export const LOGIN_REQUIRED_MESSAGE = '로그인이 필요합니다. 로그인 후 다시 시도해 주세요.';

function getToken(): string | null {
  return localStorage.getItem('access_token');
}

function getErrorMessage(status: number, fallback: string, body: unknown): string {
  if (status === 401) {
    return LOGIN_REQUIRED_MESSAGE;
  }

  if (!body || typeof body !== 'object') {
    return fallback;
  }

  const payload = body as { message?: unknown };
  if (typeof payload.message === 'string') {
    return payload.message;
  }

  if (
    payload.message &&
    typeof payload.message === 'object' &&
    typeof (payload.message as { message?: unknown }).message === 'string'
  ) {
    return (payload.message as { message: string }).message;
  }

  return fallback;
}

export async function marketRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  const token = getToken();

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  if (options.body != null && !headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${MARKET_API}${path}`, {
    ...options,
    headers,
  });

  const text = await res.text();
  let body: unknown = undefined;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, getErrorMessage(res.status, res.statusText, body), body);
  }

  if (!text) {
    return undefined as T;
  }

  return body as T;
}
