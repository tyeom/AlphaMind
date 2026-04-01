import { useEffect, useRef, useCallback, useState } from 'react';

interface WsMessage {
  event: string;
  data: any;
}

type EventHandler = (data: any) => void;

export interface PriceUpdate {
  stockCode: string;
  price: number;
  volume: number;
  timestamp: string;
}

export interface TradeExecuted {
  sessionId: number;
  stockCode: string;
  action: 'buy' | 'sell';
  quantity: number;
  price: number;
  reason?: string;
}

export function useAutoTradingWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<EventHandler>>>(new Map());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);

  const getWsUrl = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws/auto-trading`;
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (evt) => {
      try {
        const msg: WsMessage = JSON.parse(evt.data);
        const handlers = handlersRef.current.get(msg.event);
        if (handlers) {
          handlers.forEach((fn) => fn(msg.data));
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectTimerRef.current = setTimeout(() => connect(), 3000);
    };

    ws.onerror = () => ws.close();
  }, [getWsUrl]);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }, []);

  const on = useCallback((event: string, handler: EventHandler) => {
    if (!handlersRef.current.has(event)) {
      handlersRef.current.set(event, new Set());
    }
    handlersRef.current.get(event)!.add(handler);
    return () => {
      handlersRef.current.get(event)?.delete(handler);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return { connected, on };
}
