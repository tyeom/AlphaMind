export type OrderDivision = '00' | '01';

export interface OrderCashRequest {
  stockCode: string;
  qty: number;
  price?: number;
  orderDvsn?: OrderDivision;
}

export interface OrderModifyRequest {
  originalOrderNo: string;
  stockCode: string;
  qty: number;
  price: number;
  orderDvsn?: OrderDivision;
  isAll?: boolean;
}

export interface OrderCancelRequest {
  originalOrderNo: string;
  stockCode: string;
  qty: number;
  isAll?: boolean;
}

export interface BalanceItem {
  stockCode: string;
  stockName: string;
  holdingQty: number;
  avgBuyPrice: number;
  currentPrice: number;
  evalAmount: number;
  profitLoss: number;
  profitLossRate: number;
}

export interface BalanceResponse {
  items: BalanceItem[];
  totalEvalAmount: number;
  totalPurchaseAmount: number;
  totalProfitLoss: number;
  totalProfitLossRate: number;
  cashBalance: number;
}

export interface StockPrice {
  stockCode: string;
  stockName: string;
  currentPrice: number;
  change: number;
  changeRate: number;
  changeSign: string;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  tradingValue: number;
}

export interface DailyPrice {
  date: string;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
  changeRate: number;
}

export interface BuyableResponse {
  buyableAmount: number;
  buyableQty: number;
  cashBalance: number;
}

export interface StockJournalSummary {
  stockCode: string;
  stockName: string;
  buyQty: number;
  buyAmount: number;
  sellQty: number;
  sellAmount: number;
  profitLoss: number;
  profitLossRate: number;
  holdingQty: number;
  avgBuyPrice: number;
  currentPrice: number;
  evalAmount: number;
  evalProfitLoss: number;
  evalProfitLossRate: number;
}

export interface JournalResponse {
  date: string;
  isAvailable: boolean;
  message?: string;
  stockSummaries: StockJournalSummary[];
  totalBuyAmount: number;
  totalSellAmount: number;
  realizedProfitLoss: number;
  totalEvalAmount: number;
  totalPurchaseAmount: number;
  totalEvalProfitLoss: number;
  totalProfitLossRate: number;
  cashBalance: number;
  previousDay?: {
    date: string;
    totalEvalAmount: number;
    totalProfitLossRate: number;
  };
  dayOverDayChange?: number;
}
