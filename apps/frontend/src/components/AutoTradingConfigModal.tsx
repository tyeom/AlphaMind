import { useState } from 'react';
import type { AddOnBuyMode, SessionEntryMode } from '../types/auto-trading';

export interface TradingConfigItem {
  stockCode: string;
  stockName: string;
  /** 추천/기본 전략 ID */
  strategyId: string;
  variant?: string;
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldingDays: number;
  /** 보유 종목에 추가 매수 신호 발생 시 동작 — 기본 'skip' */
  addOnBuyMode: AddOnBuyMode;
}

interface Props {
  items: TradingConfigItem[];
  onCancel: () => void;
  /**
   * 확정 콜백 — 두 번째 인자로 사용자가 선택한 진입 방식이 전달된다.
   * 수정 모드 등에서 entryMode가 불필요한 경우 무시 가능.
   */
  onConfirm: (items: TradingConfigItem[], entryMode: SessionEntryMode) => void;
  /** 모달 헤더 — 기본 "자동 매매 설정" */
  title?: string;
  /** 상단 안내 문구 — 기본: 신규 매매 시작 안내 */
  description?: string;
  /** 확정 버튼 레이블 — 기본 "매매 시작" */
  confirmLabel?: string;
  /** 진입 방식 선택 UI 노출 여부 — 기본 true (새 세션 생성 시). 수정 모드에서는 false 권장 */
  showEntryMode?: boolean;
  /** 초기 진입 방식 — 기본 'monitor' */
  initialEntryMode?: SessionEntryMode;
}

const STRATEGY_OPTIONS: { id: string; name: string }[] = [
  { id: '', name: '추천 (자동)' },
  { id: 'day-trading', name: '일간 모멘텀' },
  { id: 'mean-reversion', name: '평균회귀' },
  { id: 'infinity-bot', name: '무한매수봇' },
  { id: 'candle-pattern', name: '캔들 패턴' },
  { id: 'momentum-power', name: 'Momentum Power' },
  { id: 'momentum-surge', name: 'Momentum Surge' },
];

export function AutoTradingConfigModal({
  items,
  onCancel,
  onConfirm,
  title,
  description,
  confirmLabel,
  showEntryMode = true,
  initialEntryMode = 'monitor',
}: Props) {
  const [configs, setConfigs] = useState<TradingConfigItem[]>(items);
  const [entryMode, setEntryMode] =
    useState<SessionEntryMode>(initialEntryMode);

  const updateItem = (index: number, patch: Partial<TradingConfigItem>) => {
    setConfigs((prev) =>
      prev.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  };

  const applyToAll = (patch: Partial<TradingConfigItem>) => {
    setConfigs((prev) => prev.map((item) => ({ ...item, ...patch })));
  };

  const handleConfirm = () => {
    // 유효성: takeProfit > 0, stopLoss < 0 권장이지만 강제하진 않음
    onConfirm(configs, entryMode);
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>
            {title ?? '자동 매매 설정'} ({configs.length}개 종목)
          </h3>
          <button className="btn btn-text modal-close" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <p className="text-muted modal-description">
            {description ??
              '각 종목별로 사용할 전략과 목표 수익/손절/최대 보유일을 설정하세요. 기본값은 백테스트 기반 추천 전략 및 +2.5% / -3% / 7일입니다.'}
          </p>

          {showEntryMode && (
            <div className="entry-mode-selector">
              <span className="entry-mode-title">진입 방식</span>
              <div className="entry-mode-options">
                <label>
                  <input
                    type="radio"
                    name="entry-mode"
                    value="monitor"
                    checked={entryMode === 'monitor'}
                    onChange={() => setEntryMode('monitor')}
                  />
                  <span>
                    모니터링
                    <small className="entry-mode-hint">
                      전략 매수 신호가 발생할 때까지 대기 후 매수
                    </small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="entry-mode"
                    value="immediate"
                    checked={entryMode === 'immediate'}
                    onChange={() => setEntryMode('immediate')}
                  />
                  <span>
                    바로 매수 후 운용
                    <small className="entry-mode-hint">
                      세션 생성 직후 시장가로 전액 매수, 이후 익절/손절 자동
                      운용
                    </small>
                  </span>
                </label>
              </div>
            </div>
          )}

          {configs.length > 1 && (
            <div className="bulk-apply-row">
              <span className="bulk-apply-label">일괄 적용:</span>
              <label>
                전략
                <select
                  defaultValue="__none__"
                  onChange={(e) => {
                    if (e.target.value !== '__none__') {
                      // 전략 변경 시 stale variant 방지를 위해 함께 비움
                      applyToAll({
                        strategyId: e.target.value,
                        variant: undefined,
                      });
                    }
                    e.target.value = '__none__';
                  }}
                >
                  <option value="__none__">선택</option>
                  {STRATEGY_OPTIONS.map((s) => (
                    <option key={s.id || '__auto__'} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                목표수익(%)
                <input
                  type="number"
                  step="0.5"
                  placeholder="2.5"
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) applyToAll({ takeProfitPct: v });
                    e.target.value = '';
                  }}
                />
              </label>
              <label>
                손절(%)
                <input
                  type="number"
                  step="0.5"
                  placeholder="-3"
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) applyToAll({ stopLossPct: v });
                    e.target.value = '';
                  }}
                />
              </label>
              <label>
                최대보유(일)
                <input
                  type="number"
                  step="1"
                  placeholder="7"
                  onBlur={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v)) applyToAll({ maxHoldingDays: v });
                    e.target.value = '';
                  }}
                />
              </label>
              <label>
                추가매수
                <select
                  defaultValue="__none__"
                  onChange={(e) => {
                    if (e.target.value !== '__none__') {
                      applyToAll({
                        addOnBuyMode: e.target.value as AddOnBuyMode,
                      });
                    }
                    e.target.value = '__none__';
                  }}
                >
                  <option value="__none__">선택</option>
                  <option value="skip">스킵</option>
                  <option value="add">추가매수</option>
                </select>
              </label>
            </div>
          )}

          <div className="modal-table-container">
            <table className="data-table modal-table">
              <thead>
                <tr>
                  <th>종목</th>
                  <th>전략</th>
                  <th className="text-right">목표수익(%)</th>
                  <th className="text-right">손절(%)</th>
                  <th className="text-right">최대보유</th>
                  <th>보유 시 매수신호</th>
                </tr>
              </thead>
              <tbody>
                {configs.map((item, i) => (
                  <tr key={item.stockCode}>
                    <td>
                      <strong>{item.stockName}</strong>
                      <br />
                      <small className="text-muted">{item.stockCode}</small>
                    </td>
                    <td>
                      <select
                        value={item.strategyId}
                        onChange={(e) =>
                          // 전략 변경 시 stale variant 방지를 위해 함께 비움
                          updateItem(i, {
                            strategyId: e.target.value,
                            variant: undefined,
                          })
                        }
                      >
                        {STRATEGY_OPTIONS.map((s) => (
                          <option key={s.id || '__auto__'} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="text-right">
                      <input
                        className="config-num-input"
                        type="number"
                        step="0.5"
                        value={item.takeProfitPct}
                        onChange={(e) =>
                          updateItem(i, {
                            takeProfitPct: parseFloat(e.target.value) || 0,
                          })
                        }
                      />
                    </td>
                    <td className="text-right">
                      <input
                        className="config-num-input"
                        type="number"
                        step="0.5"
                        value={item.stopLossPct}
                        onChange={(e) =>
                          updateItem(i, {
                            stopLossPct: parseFloat(e.target.value) || 0,
                          })
                        }
                      />
                    </td>
                    <td className="text-right">
                      <input
                        className="config-num-input"
                        type="number"
                        step="1"
                        min="0"
                        value={item.maxHoldingDays}
                        onChange={(e) =>
                          updateItem(i, {
                            maxHoldingDays: parseInt(e.target.value, 10) || 0,
                          })
                        }
                        title="0이면 최대 보유일 제한을 사용하지 않습니다"
                      />
                    </td>
                    <td>
                      <select
                        value={item.addOnBuyMode}
                        onChange={(e) =>
                          updateItem(i, {
                            addOnBuyMode: e.target.value as AddOnBuyMode,
                          })
                        }
                        title="보유 중인 종목에 매수 신호가 추가로 발생했을 때의 처리"
                      >
                        <option value="skip">스킵</option>
                        <option value="add">추가 매수</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>
            취소
          </button>
          <button className="btn btn-primary" onClick={handleConfirm}>
            {confirmLabel ?? '매매 시작'} ({configs.length}개)
          </button>
        </div>
      </div>
    </div>
  );
}
