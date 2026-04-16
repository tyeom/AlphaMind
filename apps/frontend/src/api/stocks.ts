const MARKET_API_BASE = '/market-api';

export interface StockSearchItem {
  code: string;
  name: string;
  sector?: string;
}

async function marketRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = localStorage.getItem('access_token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${MARKET_API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body?.message) {
        message = typeof body.message === 'string' ? body.message : body.message.message;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const stocksApi = {
  searchStocks: (query: string, limit = 20) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return marketRequest<StockSearchItem[]>(`/stocks?${params}`);
  },
  triggerCollection: () => marketRequest<void>('/stocks/collect', { method: 'POST' }),
};
