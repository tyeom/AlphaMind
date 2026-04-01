import { api } from './client';
import type {
  OrderCashRequest,
  OrderModifyRequest,
  OrderCancelRequest,
  BalanceResponse,
  StockPrice,
  DailyPrice,
  BuyableResponse,
  JournalResponse,
} from '../types/kis';

export async function buy(dto: OrderCashRequest) {
  return api.post('/kis/order/buy', dto);
}

export async function sell(dto: OrderCashRequest) {
  return api.post('/kis/order/sell', dto);
}

export async function modifyOrder(dto: OrderModifyRequest) {
  return api.post('/kis/order/modify', dto);
}

export async function cancelOrder(dto: OrderCancelRequest) {
  return api.post('/kis/order/cancel', dto);
}

export async function getBalance(): Promise<BalanceResponse> {
  return api.get<BalanceResponse>('/kis/balance');
}

export async function getBuyable(
  stockCode: string,
  price?: number,
  orderDvsn?: string,
): Promise<BuyableResponse> {
  const params = new URLSearchParams({ stockCode });
  if (price != null) params.set('price', String(price));
  if (orderDvsn) params.set('orderDvsn', orderDvsn);
  return api.get<BuyableResponse>(`/kis/buyable?${params}`);
}

export async function getCurrentPrice(stockCode: string): Promise<StockPrice> {
  return api.get<StockPrice>(`/kis/price?stockCode=${stockCode}`);
}

export async function getDailyPrice(
  stockCode: string,
  period?: string,
  adjusted?: boolean,
): Promise<DailyPrice[]> {
  const params = new URLSearchParams({ stockCode });
  if (period) params.set('period', period);
  if (adjusted !== undefined) params.set('adjusted', String(adjusted));
  return api.get<DailyPrice[]>(`/kis/price/daily?${params}`);
}

export async function getJournal(date?: string): Promise<JournalResponse> {
  const params = date ? `?date=${date}` : '';
  return api.get<JournalResponse>(`/kis/journal${params}`);
}

export async function getDailyOrders(
  startDate: string,
  endDate: string,
  orderType?: string,
  status?: string,
) {
  const params = new URLSearchParams({ startDate, endDate });
  if (orderType) params.set('orderType', orderType);
  if (status) params.set('status', status);
  return api.get(`/kis/orders?${params}`);
}
