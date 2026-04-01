import { useState, useEffect, useRef, useCallback } from 'react';

export type ConnectionQuality = 'good' | 'unstable' | 'disconnected';

interface ConnectionStatus {
  quality: ConnectionQuality;
  latency: number | null;
}

export function useConnectionStatus(
  pingInterval = 5000,
  unstableThreshold = 1000,
): ConnectionStatus {
  const [quality, setQuality] = useState<ConnectionQuality>('disconnected');
  const [latency, setLatency] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pongTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingStartRef = useRef<number>(0);

  const connect = useCallback(() => {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/kis`);
      wsRef.current = ws;

      ws.onopen = () => {
        setQuality('good');
        setLatency(0);

        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            pingStartRef.current = Date.now();
            ws.send(JSON.stringify({ event: 'ping' }));

            pongTimerRef.current = setTimeout(() => {
              setQuality('unstable');
            }, unstableThreshold);
          }
        }, pingInterval);
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.event === 'pong') {
            const rtt = Date.now() - pingStartRef.current;
            setLatency(rtt);
            setQuality(rtt > unstableThreshold ? 'unstable' : 'good');
            if (pongTimerRef.current) {
              clearTimeout(pongTimerRef.current);
              pongTimerRef.current = null;
            }
          }
        } catch {
          // ignore non-JSON
        }
      };

      ws.onclose = () => {
        setQuality('disconnected');
        setLatency(null);
        cleanup();
        setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      setQuality('disconnected');
      setTimeout(connect, 3000);
    }
  }, [pingInterval, unstableThreshold]);

  function cleanup() {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
    if (pongTimerRef.current) {
      clearTimeout(pongTimerRef.current);
      pongTimerRef.current = null;
    }
  }

  useEffect(() => {
    connect();
    return () => {
      cleanup();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { quality, latency };
}
