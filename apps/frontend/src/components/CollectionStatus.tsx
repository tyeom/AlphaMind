import { useState, useEffect } from 'react';

interface Status {
  collecting: boolean;
  progress: { done: number; total: number } | null;
  lastCompletedAt: string | null;
}

export function CollectionStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const res = await fetch('/market-api/stocks/collection-status');
        if (!active) return;
        if (res.ok) {
          setStatus(await res.json());
          setError(false);
        } else {
          setError(true);
        }
      } catch {
        if (active) setError(true);
      }
    };

    poll();
    const id = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return (
      <div className="collection-status" title="Market Data 서비스 연결 실패">
        <span className="collection-dot" style={{ background: '#ef4444' }} />
        <span>수집 서버 연결 실패</span>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="collection-status" title="상태 확인 중">
        <span className="collection-dot idle" />
        <span>상태 확인 중...</span>
      </div>
    );
  }

  if (status.collecting && status.progress) {
    const pct = Math.round((status.progress.done / status.progress.total) * 100);
    return (
      <div className="collection-status" title="차트 데이터 수집 중">
        <span className="collection-dot collecting" />
        <span>
          수집 중 {status.progress.done}/{status.progress.total} ({pct}%)
        </span>
      </div>
    );
  }

  if (status.lastCompletedAt) {
    const d = new Date(status.lastCompletedAt);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return (
      <div className="collection-status" title={`마지막 수집 완료: ${status.lastCompletedAt}`}>
        <span className="collection-dot done" />
        <span>수집 완료 {hh}:{mm}</span>
      </div>
    );
  }

  return (
    <div className="collection-status" title="대기 중">
      <span className="collection-dot idle" />
      <span>대기</span>
    </div>
  );
}
