import { useEffect, useRef, useCallback, useState } from 'react';

export type KisRealtimeType = 'execution' | 'orderbook' | 'notification';

export interface KisRealtimeExecution {
  stockCode: string;
  time: string;
  price: number;
  changeSign: string;
  change: number;
  changeRate: number;
  weightedAvgPrice: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  askPrice1: number;
  bidPrice1: number;
  executionVolume: number;
  cumulativeVolume: number;
  cumulativeAmount: number;
  executionStrength: number;
  executionType: string;
}

export interface KisRealtimeOrderbook {
  stockCode: string;
  time: string;
  askPrices: number[];
  bidPrices: number[];
  askVolumes: number[];
  bidVolumes: number[];
  totalAskVolume: number;
  totalBidVolume: number;
  expectedPrice: number;
  expectedVolume: number;
}

export interface KisRealtimeOrderNotification {
  accountNo: string;
  orderNo: string;
  originalOrderNo: string;
  orderType: string;
  modifyType: string;
  stockCode: string;
  executionQty: number;
  executionPrice: number;
  time: string;
  isRejected: boolean;
  isExecuted: boolean;
  orderQty: number;
  stockName: string;
  orderPrice: number;
}

interface UseKisWebSocketOptions {
  /** 자동 연결 여부 (기본 true) */
  autoConnect?: boolean;
  /** 재연결 딜레이 ms (기본 3000) */
  reconnectDelay?: number;
  /** WebSocket URL (기본: 현재 호스트 기준 자동 생성) */
  url?: string;
}

interface WsMessage {
  event: string;
  data: any;
}

type EventHandler = (data: any) => void;

export function useKisWebSocket(options: UseKisWebSocketOptions = {}) {
  const { autoConnect = true, reconnectDelay = 3000, url } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<EventHandler>>>(new Map());
  const subscriptionsRef = useRef<Set<string>>(new Set());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);

  const getWsUrl = useCallback(() => {
    if (url) return url;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws/kis`;
  }, [url]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      // 기존 구독 복원
      for (const key of subscriptionsRef.current) {
        const [type, stockCode] = key.split(':');
        ws.send(JSON.stringify({ event: 'subscribe', data: { type, stockCode } }));
      }
    };

    ws.onmessage = (evt) => {
      try {
        const msg: WsMessage = JSON.parse(evt.data);
        const handlers = handlersRef.current.get(msg.event);
        if (handlers) {
          handlers.forEach((fn) => fn(msg.data));
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectTimerRef.current = setTimeout(() => connect(), reconnectDelay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [getWsUrl, reconnectDelay]);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }, []);

  /** 이벤트 리스너 등록 */
  const on = useCallback((event: string, handler: EventHandler) => {
    if (!handlersRef.current.has(event)) {
      handlersRef.current.set(event, new Set());
    }
    handlersRef.current.get(event)!.add(handler);

    return () => {
      handlersRef.current.get(event)?.delete(handler);
    };
  }, []);

  /** 종목 실시간 데이터 구독 */
  const subscribe = useCallback(
    (type: KisRealtimeType, stockCode: string) => {
      const key = `${type}:${stockCode}`;
      subscriptionsRef.current.add(key);

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ event: 'subscribe', data: { type, stockCode } }),
        );
      }
    },
    [],
  );

  /** 종목 실시간 데이터 구독 해제 */
  const unsubscribe = useCallback(
    (type: KisRealtimeType, stockCode: string) => {
      const key = `${type}:${stockCode}`;
      subscriptionsRef.current.delete(key);

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ event: 'unsubscribe', data: { type, stockCode } }),
        );
      }
    },
    [],
  );

  useEffect(() => {
    if (autoConnect) connect();
    return () => disconnect();
  }, [autoConnect, connect, disconnect]);

  return { connected, connect, disconnect, subscribe, unsubscribe, on };
}
