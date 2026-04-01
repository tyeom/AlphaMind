import { useConnectionStatus, type ConnectionQuality } from '../hooks/useConnectionStatus';

const labels: Record<ConnectionQuality, string> = {
  good: '접속 양호',
  unstable: '접속 불안',
  disconnected: '연결 끊김',
};

const colors: Record<ConnectionQuality, string> = {
  good: '#22c55e',
  unstable: '#eab308',
  disconnected: '#ef4444',
};

export function ConnectionIndicator() {
  const { quality, latency } = useConnectionStatus();

  return (
    <div
      className="connection-indicator"
      title={`${labels[quality]}${latency != null ? ` (${latency}ms)` : ''}`}
    >
      <span
        className="connection-dot"
        style={{ backgroundColor: colors[quality] }}
      />
      <span className="connection-label">{labels[quality]}</span>
    </div>
  );
}
