import { useState } from 'react';
import type {
  SessionConflictAction,
  SessionConflictItem,
} from '../types/auto-trading';

interface Props {
  conflicts: SessionConflictItem[];
  onCancel: () => void;
  onConfirm: (actions: Record<string, SessionConflictAction>) => void;
}

const STRATEGY_NAMES: Record<string, string> = {
  'day-trading': '일간 모멘텀',
  'mean-reversion': '평균회귀',
  'infinity-bot': '무한매수봇',
  'candle-pattern': '캔들 패턴',
  'momentum-power': 'Momentum Power',
  'momentum-surge': 'Momentum Surge',
};

function strategyLabel(id: string): string {
  return STRATEGY_NAMES[id] || id;
}

export function SessionConflictModal({
  conflicts,
  onCancel,
  onConfirm,
}: Props) {
  const [actions, setActions] = useState<Record<string, SessionConflictAction>>(
    () => {
      // 기본값: 모두 제외 — 중복 종목은 제외 후 나머지만 시작하는 흐름을 우선
      const initial: Record<string, SessionConflictAction> = {};
      for (const c of conflicts) {
        initial[c.stockCode] = 'skip';
      }
      return initial;
    },
  );

  const setAction = (stockCode: string, action: SessionConflictAction) => {
    setActions((prev) => ({ ...prev, [stockCode]: action }));
  };

  const applyAll = (action: SessionConflictAction) => {
    const next: Record<string, SessionConflictAction> = {};
    for (const c of conflicts) {
      next[c.stockCode] = action;
    }
    setActions(next);
  };

  const updateCount = Object.values(actions).filter(
    (a) => a === 'update',
  ).length;
  const skipCount = Object.values(actions).filter((a) => a === 'skip').length;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>이미 자동매매 중인 종목 ({conflicts.length}개)</h3>
          <button className="btn btn-text modal-close" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <p className="text-muted modal-description">
            아래 종목들은 이미 활성 자동매매 세션이 있습니다. 기본값은 해당
            종목을
            <strong> 제외</strong>하고 나머지 종목만 자동 매매를 시작하는
            방식입니다. 필요하면 기존 세션을 새 설정으로{' '}
            <strong>업데이트</strong>할 수도 있습니다.
          </p>

          <div className="bulk-apply-row">
            <span className="bulk-apply-label">일괄 적용:</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => applyAll('skip')}
            >
              모두 제외
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => applyAll('update')}
            >
              모두 업데이트
            </button>
          </div>

          <div className="modal-table-container">
            <table className="data-table modal-table">
              <thead>
                <tr>
                  <th>종목</th>
                  <th>기존 전략</th>
                  <th className="text-right">기존 목표/손절</th>
                  <th>처리</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c) => {
                  const action = actions[c.stockCode] ?? 'update';
                  return (
                    <tr key={c.stockCode}>
                      <td>
                        <strong>{c.stockName}</strong>
                        <br />
                        <small className="text-muted">{c.stockCode}</small>
                      </td>
                      <td>{strategyLabel(c.existingSession.strategyId)}</td>
                      <td className="text-right">
                        +{c.existingSession.takeProfitPct}% /{' '}
                        {c.existingSession.stopLossPct}% /{' '}
                        {c.existingSession.maxHoldingDays}일
                      </td>
                      <td>
                        <div className="conflict-action-group">
                          <label className="conflict-action-option">
                            <input
                              type="radio"
                              name={`action-${c.stockCode}`}
                              checked={action === 'update'}
                              onChange={() => setAction(c.stockCode, 'update')}
                            />
                            업데이트
                          </label>
                          <label className="conflict-action-option">
                            <input
                              type="radio"
                              name={`action-${c.stockCode}`}
                              checked={action === 'skip'}
                              onChange={() => setAction(c.stockCode, 'skip')}
                            />
                            제외
                          </label>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>
            취소
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onConfirm(actions)}
          >
            중복 처리 후 진행 (제외 {skipCount} / 업데이트 {updateCount})
          </button>
        </div>
      </div>
    </div>
  );
}
